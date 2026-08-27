// PocketVault admin API routes.
// Everything behind requireAdmin (x-admin-secret header): platform
// overview, user management, operations, revenue, admin messaging,
// error log review, and the full AI assistant subsystem (chat,
// insights, anomaly detection, message drafting, error analysis).
//
// The AI configuration and provider-call functions (callAnthropic,
// callGemini, callGroq, callAI, the tool-calling functions, AI_TOOLS,
// AI_ACTIONS) live in this file rather than in a shared core module
// because every one of them is used exclusively by the AI routes
// below — nothing outside admin.js ever touches them.
//
// Moved verbatim out of the old monolithic server.js — every
// app.get/post/patch/delete became router.get/post/patch/delete on
// an express.Router(), mounted in server.js. No route path, body
// shape, or business logic changed in this move.
import express from 'express';
import { db, FieldValue, adminAuth } from '../core/firebase.js';
import { AIRTEL, PAYCHANGU, PLANS, resolvePaymentProvider, FLOAT_THRESHOLD } from '../core/config.js';
import { cache, clearCache, airtelQueue, breakers } from '../core/state.js';
import { requireAdmin, asyncHandler, rateLimit, safeCompare } from '../core/middleware.js';
import { getAllBreakerStatuses } from '../core/circuit-breaker.js';
import {
  airtelBalance, fetchWithRetry, log, logSystemError, pushNotification, toMillis,
  ensureMerchantCode, deactivateMerchantCode, triggerFirestoreExport, listRecentBackupExports
} from '../helpers.js';
import { unfreezeGoalsOnRenewal } from '../jobs.js';

const router = express.Router();

// ----------------------------
// AI CONFIGURATION — MULTI-PROVIDER
// Powers all admin-facing intelligence features: chat assistant,
// anomaly detection, message drafting, insights, error analysis.
// All AI features are admin-only (requireAdmin).
//
// Supports BOTH Anthropic (Claude) and Google (Gemini) so you can
// switch providers with a single environment variable — no code
// changes needed. Set AI_PROVIDER to 'anthropic' or 'gemini'.
// If AI_PROVIDER is not set, it auto-picks whichever key is present
// (Anthropic first, then Gemini).
// ----------------------------
const AI = {
  PROVIDER: (process.env.AI_PROVIDER || '').toLowerCase(),
  ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY || null,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  GEMINI_KEY: process.env.GEMINI_API_KEY || null,
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  GROQ_KEY: process.env.GROQ_API_KEY || null,
  GROQ_MODEL: process.env.GROQ_MODEL || null,
};

// Resolve which provider is actually active right now
export function resolveAIProvider() {
  if (AI.PROVIDER === 'anthropic' && AI.ANTHROPIC_KEY) return 'anthropic';
  if (AI.PROVIDER === 'gemini' && AI.GEMINI_KEY) return 'gemini';
  if (AI.PROVIDER === 'groq' && AI.GROQ_KEY) return 'groq';
  // No explicit provider chosen — auto-pick whichever key exists
  if (AI.ANTHROPIC_KEY) return 'anthropic';
  if (AI.GEMINI_KEY) return 'gemini';
  if (AI.GROQ_KEY) return 'groq';
  return null;
}

async function callAnthropic(systemPrompt, userMessage, maxTokens) {
  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AI.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: AI.ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  }, { provider: 'anthropic' });
  if (res.status === 429) {
    const err = new Error('Anthropic rate limit reached. Please wait a moment before trying again.');
    err.isRateLimit = true;
    throw err;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Anthropic request failed: ${res.status} — ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const textBlock = data.content?.find(b => b.type === 'text');
  return textBlock?.text || '';
}

async function callGemini(systemPrompt, userMessage, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${AI.GEMINI_MODEL}:generateContent?key=${AI.GEMINI_KEY}`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: maxTokens }
    })
  }, { provider: 'gemini' });
  if (res.status === 429) {
    const err = new Error('Gemini free-tier limit reached for now. This resets automatically — try again in a few minutes, or check quota at aistudio.google.com.');
    err.isRateLimit = true;
    throw err;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Gemini request failed: ${res.status} — ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  return text;
}

async function callGroq(systemPrompt, userMessage, maxTokens) {
  const res = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI.GROQ_KEY}`
    },
    body: JSON.stringify({
      model: AI.GROQ_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  }, { provider: 'groq' });
  if (res.status === 429) {
    const err = new Error('Groq rate limit reached. Please wait a moment before trying again.');
    err.isRateLimit = true;
    throw err;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Groq request failed: ${res.status} — ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Single entry point used everywhere in the app — routes to
// whichever provider is configured. Callers never need to know
// which one is actually running underneath.
async function callAI(systemPrompt, userMessage, maxTokens = 1024) {
  const provider = resolveAIProvider();
  if (!provider) {
    throw new Error('AI features are not configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY in environment variables.');
  }
  if (provider === 'anthropic') return callAnthropic(systemPrompt, userMessage, maxTokens);
  if (provider === 'gemini') return callGemini(systemPrompt, userMessage, maxTokens);
  return callGroq(systemPrompt, userMessage, maxTokens);
}

// ============================================================
// AI DATA TOOLS
// On-demand data fetchers the assistant can call based on what's
// actually being asked, instead of always receiving the same
// fixed shallow snapshot. Each tool returns a plain object ready
// to be JSON-stringified into the AI's context.
// (Improvement #3 and #4 — richer data, fetched on demand)
// ============================================================

async function toolGetPlatformOverview() {
  const [usersSnap, feesSnap, goalsSnap, txSnap] = await Promise.all([
    db.collection('users').limit(500).get(),
    db.collection('platform_fees').limit(500).get(),
    db.collection('goals').limit(500).get(),
    db.collection('transactions').limit(300).get(),
  ]);
  const users = []; usersSnap.forEach(d => users.push({ id: d.id, ...d.data() }));
  const fees = []; feesSnap.forEach(d => fees.push(d.data()));
  const goals = []; goalsSnap.forEach(d => goals.push(d.data()));
  const transactions = []; txSnap.forEach(d => transactions.push(d.data()));

  const totalRevenue = fees.reduce((s, f) => s + (f.platformAmount ?? f.amount ?? 0), 0);
  const planCounts = { free: 0, pro: 0, business: 0 };
  users.forEach(u => { const p = u.plan || 'free'; if (planCounts[p] !== undefined) planCounts[p]++; });
  const activeGoals = goals.filter(g => !g.completed);
  const completedGoals = goals.filter(g => g.completed);
  const failedTx = transactions.filter(t => t.status === 'failed');
  const pendingTx = transactions.filter(t => t.status === 'pending');

  return {
    totalUsers: users.length,
    planCounts,
    totalRevenueMWK: totalRevenue,
    totalGoals: goals.length,
    activeGoals: activeGoals.length,
    completedGoals: completedGoals.length,
    transactionsSampled: transactions.length,
    failedTransactions: failedTx.length,
    pendingTransactions: pendingTx.length,
    suspendedUsers: users.filter(u => u.suspended).length,
    unverifiedKycUsers: users.filter(u => u.kycStatus !== 'verified' && u.kycStatus !== 'mock_verified').length,
    userList: users.map(u => ({
      uid: u.id, email: u.email || u.id, plan: u.plan || 'free',
      kycStatus: u.kycStatus || 'unverified', suspended: !!u.suspended,
      createdAt: u.createdAt || null, updatedAt: u.updatedAt || null,
    })),
  };
}

async function toolGetUserDetail(identifier) {
  // identifier can be a uid or an email — search both ways
  let userDoc = null;
  const byIdSnap = await db.collection('users').doc(identifier).get();
  if (byIdSnap.exists) {
    userDoc = { id: byIdSnap.id, ...byIdSnap.data() };
  } else {
    const byEmailSnap = await db.collection('users').where('email', '==', identifier).limit(1).get();
    if (!byEmailSnap.empty) {
      const d = byEmailSnap.docs[0];
      userDoc = { id: d.id, ...d.data() };
    }
  }
  if (!userDoc) return { found: false, identifier };

  const [goalsSnap, txSnap, feesSnap] = await Promise.all([
    db.collection('goals').where('uid', '==', userDoc.id).get(),
    db.collection('transactions').where('uid', '==', userDoc.id).limit(100).get(),
    db.collection('platform_fees').where('uid', '==', userDoc.id).get(),
  ]);
  const goals = []; goalsSnap.forEach(d => goals.push(d.data()));
  const transactions = []; txSnap.forEach(d => transactions.push(d.data()));
  const fees = []; feesSnap.forEach(d => fees.push(d.data()));

  return {
    found: true,
    uid: userDoc.id,
    email: userDoc.email,
    plan: userDoc.plan || 'free',
    kycStatus: userDoc.kycStatus || 'unverified',
    suspended: !!userDoc.suspended,
    createdAt: userDoc.createdAt || null,
    goals: goals.map(g => ({
      name: g.name, target: g.target, saved: g.saved, completed: !!g.completed,
      progressPercent: g.target > 0 ? Math.round((g.saved / g.target) * 100) : 0,
      lockType: g.lockType, deadline: g.deadline || null,
    })),
    totalFeesGenerated: fees.reduce((s, f) => s + (f.platformAmount ?? f.amount ?? 0), 0),
    transactionCount: transactions.length,
    recentTransactions: transactions
      .sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp))
      .slice(0, 15)
      .map(t => ({ type: t.type, amount: t.amount, status: t.status, timestamp: t.timestamp })),
  };
}

async function toolFindUsersByCriteria(criteria) {
  // criteria: { kycStatus?, plan?, suspended? }
  const snap = await db.collection('users').limit(500).get();
  let users = []; snap.forEach(d => users.push({ id: d.id, ...d.data() }));

  if (criteria.kycStatus === 'unverified') {
    users = users.filter(u => u.kycStatus !== 'verified' && u.kycStatus !== 'mock_verified');
  } else if (criteria.kycStatus) {
    users = users.filter(u => u.kycStatus === criteria.kycStatus);
  }
  if (criteria.plan) users = users.filter(u => (u.plan || 'free') === criteria.plan);
  if (criteria.suspended !== undefined) users = users.filter(u => !!u.suspended === criteria.suspended);

  return {
    count: users.length,
    users: users.map(u => ({ uid: u.id, email: u.email || u.id, plan: u.plan || 'free', kycStatus: u.kycStatus || 'unverified' })),
  };
}

async function toolGetGoalProgress() {
  const snap = await db.collection('goals').limit(500).get();
  const goals = []; snap.forEach(d => goals.push({ id: d.id, ...d.data() }));
  const withProgress = goals
    .filter(g => !g.completed && g.target > 0)
    .map(g => ({
      goalId: g.id, uid: g.uid, name: g.name,
      target: g.target, saved: g.saved,
      progressPercent: Math.round((g.saved / g.target) * 100),
      deadline: g.deadline || null,
    }))
    .sort((a, b) => b.progressPercent - a.progressPercent);
  return { totalActiveGoals: withProgress.length, closestToCompletion: withProgress.slice(0, 10) };
}

async function toolGetRevenueTrend() {
  const snap = await db.collection('platform_fees').limit(1000).get();
  const fees = []; snap.forEach(d => fees.push(d.data()));
  const now = Date.now();
  const buckets = { last7Days: 0, last30Days: 0, last90Days: 0, allTime: 0 };
  const byType = {};
  fees.forEach(f => {
    const ms = toMillis(f.timestamp);
    const amt = f.platformAmount ?? f.amount ?? 0;
    buckets.allTime += amt;
    if (now - ms < 7 * 86400000) buckets.last7Days += amt;
    if (now - ms < 30 * 86400000) buckets.last30Days += amt;
    if (now - ms < 90 * 86400000) buckets.last90Days += amt;
    byType[f.type || 'unknown'] = (byType[f.type || 'unknown'] || 0) + amt;
  });
  return { revenueMWK: buckets, revenueByType: byType, totalFeeEvents: fees.length };
}

async function toolSearchTransactions(args) {
  // args: { uid?, status?, type?, minAmount?, limit? }
  const snap = await db.collection('transactions').limit(500).get();
  let txs = []; snap.forEach(d => txs.push({ id: d.id, ...d.data() }));

  if (args.uid) txs = txs.filter(t => t.uid === args.uid);
  if (args.status) txs = txs.filter(t => t.status === args.status);
  if (args.type) txs = txs.filter(t => t.type === args.type);
  if (args.minAmount) txs = txs.filter(t => (t.amount || 0) >= args.minAmount);

  txs.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  const limited = txs.slice(0, args.limit || 25);

  return {
    matchCount: txs.length,
    transactions: limited.map(t => ({
      id: t.id, uid: t.uid, type: t.type, amount: t.amount, fee: t.fee,
      status: t.status, reference: t.reference, timestamp: t.timestamp
    })),
  };
}

async function toolGetNotificationHistory(args) {
  // args: { uid?, unreadOnly?, limit? }
  let query = db.collection('notifications').limit(300);
  const snap = await query.get();
  let notifs = []; snap.forEach(d => notifs.push({ id: d.id, ...d.data() }));

  if (args.uid) notifs = notifs.filter(n => n.uid === args.uid);
  if (args.unreadOnly) notifs = notifs.filter(n => !n.read);

  notifs.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  const limited = notifs.slice(0, args.limit || 25);

  return {
    matchCount: notifs.length,
    notifications: limited.map(n => ({
      uid: n.uid, type: n.type, message: n.message, topic: n.topic || null,
      read: !!n.read, timestamp: n.timestamp
    })),
  };
}

async function toolGetSystemErrors(args) {
  // args: { unreadOnly?, source?, limit? }
  const snap = await db.collection('system_errors').limit(200).get();
  let errors = []; snap.forEach(d => errors.push({ id: d.id, ...d.data() }));

  if (args.unreadOnly) errors = errors.filter(e => !e.read);
  if (args.source) errors = errors.filter(e => e.source === args.source);

  errors.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  const limited = errors.slice(0, args.limit || 20);

  return {
    matchCount: errors.length,
    errors: limited.map(e => ({
      id: e.id, source: e.source, message: e.message, read: !!e.read, timestamp: e.timestamp
    })),
  };
}

async function toolGetOperationalStatus() {
  const [floatSnap, pendingTxSnap, alertsSnap] = await Promise.all([
    db.collection('float_monitor').orderBy('timestamp', 'desc').limit(1).get().catch(() => ({ empty: true, docs: [] })),
    db.collection('transactions').where('status', '==', 'pending').limit(50).get(),
    db.collection('admin_alerts').where('resolved', '==', false).limit(50).get(),
  ]);

  const latestFloat = floatSnap.empty ? null : floatSnap.docs[0].data();
  const pendingTx = []; pendingTxSnap.forEach(d => pendingTx.push(d.data()));
  const alerts = []; alertsSnap.forEach(d => alerts.push({ id: d.id, ...d.data() }));

  return {
    paymentProvider: resolvePaymentProvider(),
    airtelConfigured: !!AIRTEL.CLIENT_ID,
    paychanguConfigured: !!PAYCHANGU.SECRET_KEY,
    // Circuit breaker status per external provider — 'open' means
    // that provider has failed repeatedly and calls are currently
    // being short-circuited without being attempted, until its
    // cooldown elapses. Surfaced here so the founder (or the AI
    // assistant answering "how is the system doing?") can see an
    // outage immediately rather than only inferring it from a spike
    // in failed transactions.
    circuitBreakers: getAllBreakerStatuses(breakers),
    float: latestFloat ? { balanceMWK: latestFloat.balance, threshold: latestFloat.threshold, status: latestFloat.status } : null,
    pendingTransactionCount: pendingTx.length,
    pendingTransactionsTotalMWK: pendingTx.reduce((s, t) => s + (t.amount || 0), 0),
    openAlerts: alerts.map(a => ({ id: a.id, message: a.message, type: a.type, timestamp: a.timestamp })),
  };
}

// Registry of tools the AI can invoke, with JSON-schema style
// descriptions used in the system prompt so the model knows
// what's available and when to reach for each one.
const AI_TOOLS = {
  get_platform_overview: {
    description: 'General platform-wide stats: user counts by plan, revenue total, goal counts, KYC status breakdown, and a list of all users with basic info.',
    fn: () => toolGetPlatformOverview(),
  },
  get_user_detail: {
    description: 'Full detail on ONE specific user by email or uid: their goals with progress, transaction history, total fees generated, KYC status.',
    fn: (args) => toolGetUserDetail(args.identifier),
  },
  find_users_by_criteria: {
    description: 'Search users by kycStatus ("unverified"|"verified"), plan ("free"|"pro"|"business"), or suspended (true|false).',
    fn: (args) => toolFindUsersByCriteria(args),
  },
  get_goal_progress: {
    description: 'All active goals ranked by completion percentage — use this for "who is closest to reaching their goal" type questions.',
    fn: () => toolGetGoalProgress(),
  },
  get_revenue_trend: {
    description: 'Revenue broken down by time window (7/30/90 days, all-time) and by fee type — use for revenue trend or growth questions.',
    fn: () => toolGetRevenueTrend(),
  },
  search_transactions: {
    description: 'Search/filter transactions by uid, status ("pending"|"completed"|"failed"|"mock"), type ("savings"|"withdrawal"|"subscription"|etc), or minimum amount. Use for "show me failed transactions" or "find large withdrawals" type questions.',
    fn: (args) => toolSearchTransactions(args || {}),
  },
  get_notification_history: {
    description: 'Recent notifications sent to users (system-generated or admin-sent). Filter by uid or unreadOnly. Use for "did this user see my message" or "what notifications went out recently" questions.',
    fn: (args) => toolGetNotificationHistory(args || {}),
  },
  get_system_errors: {
    description: 'Recent server errors logged by the platform. Filter by unreadOnly or source (e.g. "express", "webhook_security"). Use for "what errors happened" or "is anything broken" questions.',
    fn: (args) => toolGetSystemErrors(args || {}),
  },
  get_operational_status: {
    description: 'Current payment provider, corporate float balance, pending transaction count, and open admin alerts. Use for "is everything running ok" or "how much is stuck pending" type questions.',
    fn: () => toolGetOperationalStatus(),
  },
};

// ============================================================
// AI ACTIONS — propose, confirm, execute
// (Improvement #1 — the assistant can actually DO things, not
// just talk about them, but ONLY after the founder explicitly
// confirms. Nothing fires automatically from a chat message.)
//
// Flow:
//   1. Assistant decides an action is warranted, returns a
//      structured actionProposal instead of (or alongside) its
//      text answer.
//   2. Frontend renders the proposal as a card with a Confirm
//      button — never auto-executes.
//   3. Founder clicks Confirm -> POST /api/admin/ai/execute-action
//      with the exact proposal payload the AI generated.
//   4. Server re-validates the proposal server-side (never trusts
//      the client blindly) and performs the real action.
//   5. Every AI-initiated action is logged to ai_action_log,
//      separate from normal admin_messages, so there's a clear
//      audit trail of what the AI did versus what the founder did
//      directly. (Improvement #6)
// ============================================================

const AI_ACTIONS = {
  send_message: {
    description: 'Send a notification message to one or more specific users, or broadcast to all users.',
    execute: async (args, adminMeta) => {
      const { uids, message, topic, broadcast } = args;
      if (!message?.trim()) throw new Error('message is required');

      if (broadcast) {
        const list = await adminAuth.listUsers(1000);
        const batch = db.batch();
        let sent = 0;
        for (const user of list.users) {
          batch.set(db.collection('notifications').doc(), {
            uid: user.uid, type: 'admin_message', message: message.trim(),
            topic: topic?.trim() || null, senderName: 'PocketVault Admin', senderIcon: '🛡️',
            read: false, timestamp: FieldValue.serverTimestamp()
          });
          sent++;
        }
        await batch.commit();
        await logAIAction('send_message', { broadcast: true, sent, message, topic: topic?.trim() || null }, adminMeta);
        return { sent, broadcast: true };
      }

      if (!uids?.length) throw new Error('uids required when not broadcasting');
      const batch = db.batch();
      for (const uid of uids) {
        batch.set(db.collection('notifications').doc(), {
          uid, type: 'admin_message', message: message.trim(),
          topic: topic?.trim() || null, senderName: 'PocketVault Admin', senderIcon: '🛡️',
          read: false, timestamp: FieldValue.serverTimestamp()
        });
      }
      await batch.commit();
      await logAIAction('send_message', { uids, sent: uids.length, message, topic: topic?.trim() || null }, adminMeta);
      return { sent: uids.length, broadcast: false };
    },
  },
  suspend_user: {
    description: 'Suspend a user account (disables their Firebase login).',
    execute: async (args, adminMeta) => {
      const { uid, reason } = args;
      if (!uid) throw new Error('uid is required');
      await adminAuth.updateUser(uid, { disabled: true });
      await db.collection('users').doc(uid).set({
        suspended: true, suspendedReason: reason || 'Suspended via AI Assistant', suspendedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await pushNotification(uid, { type: 'account_suspended', message: 'Your account has been suspended. Contact support for assistance.' });
      await logAIAction('suspend_user', { uid, reason }, adminMeta);
      return { uid, suspended: true };
    },
  },
  change_user_plan: {
    description: 'Change a user\'s subscription plan to free, pro, or business. Use when explicitly asked to upgrade, downgrade, or comp a user\'s plan.',
    execute: async (args, adminMeta) => {
      const { uid, plan } = args;
      if (!uid) throw new Error('uid is required');
      if (!['free', 'pro', 'business'].includes(plan)) throw new Error('plan must be free, pro, or business');
      const updates = { plan, planUpdatedAt: FieldValue.serverTimestamp() };
      if (plan !== 'free') {
        updates.subscriptionActive = true;
        updates.subscriptionExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
      } else {
        updates.subscriptionActive = false;
      }
      await db.collection('users').doc(uid).set(updates, { merge: true });
      clearCache(`plan_${uid}`);
      await pushNotification(uid, { type: 'plan_changed', message: `Your plan has been updated to ${plan.charAt(0).toUpperCase() + plan.slice(1)} by PocketVault Admin.` });

      let merchantCode = null;
      if (plan === 'business') {
        merchantCode = await ensureMerchantCode(uid);
      } else {
        await deactivateMerchantCode(uid);
      }

      await logAIAction('change_user_plan', { uid, plan }, adminMeta);
      return { uid, plan, merchantCode };
    },
  },
  override_transaction_status: {
    description: 'Manually correct a stuck or incorrect transaction status. Use when explicitly asked to mark a transaction as completed or failed.',
    execute: async (args, adminMeta) => {
      const { transactionId, status } = args;
      if (!transactionId) throw new Error('transactionId is required');
      if (!['completed', 'failed', 'pending'].includes(status)) throw new Error('status must be completed, failed, or pending');
      const txRef = db.collection('transactions').doc(transactionId);
      const txSnap = await txRef.get();
      if (!txSnap.exists) throw new Error('Transaction not found');
      await txRef.update({ status, manualOverride: true, overriddenAt: FieldValue.serverTimestamp() });
      await logAIAction('override_transaction_status', { transactionId, status, previousStatus: txSnap.data().status }, adminMeta);
      return { transactionId, status };
    },
  },
  resolve_alert: {
    description: 'Mark an admin alert as resolved (e.g. a low-float warning that\'s been dealt with). Use when explicitly asked to dismiss, resolve, or clear an alert.',
    execute: async (args, adminMeta) => {
      const { alertId } = args;
      if (!alertId) throw new Error('alertId is required');
      const alertRef = db.collection('admin_alerts').doc(alertId);
      const alertSnap = await alertRef.get();
      if (!alertSnap.exists) throw new Error('Alert not found');
      await alertRef.update({ resolved: true, resolvedAt: FieldValue.serverTimestamp(), resolvedBy: 'ai_assistant' });
      await logAIAction('resolve_alert', { alertId, message: alertSnap.data().message }, adminMeta);
      return { alertId, resolved: true };
    },
  },
};

// Audit log — every action the AI actually executes gets recorded
// here, separately from normal admin activity, so there's always
// a clear record of "the AI did this" vs "I did this directly."
async function logAIAction(actionType, details, adminMeta) {
  // Firestore rejects `undefined` as a field value outright (it allows
  // `null`, but not `undefined`). Since `details` is a free-form object
  // built by each action's execute() function, strip any undefined
  // fields here as a safety net so no caller can accidentally crash
  // the write by forgetting to guard an optional field (e.g. topic).
  const cleanDetails = Object.fromEntries(
    Object.entries(details || {}).filter(([, v]) => v !== undefined)
  );
  await db.collection('ai_action_log').add({
    actionType, details: cleanDetails,
    executedAt: FieldValue.serverTimestamp(),
    triggeredBy: 'ai_assistant',
    ip: adminMeta?.ip || null,
  });
}

// ----------------------------
// AI RESPONSE CACHE
// Wraps callAI() with a cache keyed by feature + input, so
// repeatedly opening the same admin page (Insights, Anomaly scan,
// etc.) within the TTL window reuses the last answer instead of
// spending another API call. This is the main defense against
// burning through Gemini's tight free-tier quota from normal
// clicking around the admin panel.
// ----------------------------
async function callAICached(cacheKey, systemPrompt, userMessage, maxTokens = 1024, ttlMs = 5 * 60 * 1000) {
  const key = `ai_${cacheKey}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiry) {
    return { ...cached.data, cached: true };
  }
  const answer = await callAI(systemPrompt, userMessage, maxTokens);
  const result = { answer, cached: false };
  cache.set(key, { data: result, expiry: Date.now() + ttlMs });
  return result;
}

// ============================================================
// ADMIN API
// All routes below require the x-admin-secret header to match
// ADMIN_SECRET. This is separate from Firebase user auth —
// only the founder holds this secret.
// ============================================================

// ----------------------------
// ADMIN: LOGIN CHECK
// POST /api/admin/login
// Body: { secret }
// Frontend stores the secret in sessionStorage on success
// and sends it as x-admin-secret on every subsequent call.
// Rate limited to 5 attempts per 15 minutes (per IP).
// Uses crypto.timingSafeEqual to prevent timing side-channel attacks.
// ----------------------------
// Rate limit relaxed from 5/15min — that was tight enough to trip
// during completely normal use. 20/15min still makes brute-forcing
// a real ADMIN_SECRET impractical while not punishing legitimate use.
router.post('/api/admin/login', rateLimit(20, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const { secret } = req.body;
  if (!process.env.ADMIN_SECRET) {
    return res.status(503).json({ success: false, error: 'Admin access not configured on this server' });
  }
  if (!secret || !safeCompare(secret, process.env.ADMIN_SECRET)) {
    return res.status(401).json({ success: false, error: 'Incorrect password' });
  }
  res.json({ success: true });
}));

// ----------------------------
// ADMIN: OVERVIEW
// GET /api/admin/overview
// Revenue totals, plan counts, float status, open alerts
// ----------------------------
router.get('/api/admin/overview', requireAdmin, asyncHandler(async (req, res) => {
  // Revenue
  const feeSnap = await db.collection('platform_fees').limit(2000).get();
  let totalRevenue = 0, monthRevenue = 0, totalAirtelPassthrough = 0;
  const revenueByType = {};
  const revenueByPlan = {};
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  feeSnap.forEach(doc => {
    const fee = doc.data();
    // platformAmount is what PocketVault actually keeps; amount is
    // the gross figure charged to the user, which includes Airtel's
    // 1.5% pass-through. Older fee records predating this split
    // don't have platformAmount, so they fall back to the gross
    // amount — the best available number for pre-existing data.
    const amt = fee.platformAmount ?? fee.amount ?? 0;
    totalRevenue += amt;
    totalAirtelPassthrough += fee.airtelAmount || 0;
    revenueByType[fee.type] = (revenueByType[fee.type] || 0) + amt;
    revenueByPlan[fee.plan || 'unknown'] = (revenueByPlan[fee.plan || 'unknown'] || 0) + amt;
    if (toMillis(fee.timestamp) > monthStart.getTime()) monthRevenue += amt;
  });

  // Users by plan
  const usersSnap = await db.collection('users').get();
  const planCounts = { free: 0, pro: 0, business: 0 };
  usersSnap.forEach(doc => {
    const plan = doc.data().plan || 'free';
    if (planCounts[plan] !== undefined) planCounts[plan]++;
    else planCounts.free++;
  });

  // Total users from Firebase Auth (includes users with no Firestore doc yet)
  let totalAuthUsers = usersSnap.size;
  try {
    const list = await adminAuth.listUsers(1000);
    totalAuthUsers = list.users.length;
  } catch (e) {
    console.error('listUsers failed:', e.message);
  }

  // Float status (latest cached value)
  const floatCached = cache.get('corporate_float');
  let latestFloat = floatCached?.data ?? null;
  if (latestFloat === null) {
    const floatSnap = await db.collection('float_monitor').limit(50).get();
    let latest = null;
    floatSnap.forEach(doc => {
      const d = doc.data();
      if (!latest || toMillis(d.timestamp) > toMillis(latest.timestamp)) latest = d;
    });
    latestFloat = latest?.balance ?? null;
  }

  // Open alerts
  const alertsSnap = await db.collection('admin_alerts').get();
  let openAlerts = [];
  alertsSnap.forEach(doc => {
    const a = doc.data();
    if (!a.resolved) openAlerts.push({ id: doc.id, ...a });
  });
  openAlerts.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));

  res.json({
    success: true,
    revenue: {
      total: totalRevenue,
      month: monthRevenue,
      byType: revenueByType,
      byPlan: revenueByPlan,
      // Money passed through to Airtel (1.5% per transaction) —
      // not PocketVault's revenue, but useful for the founder to see
      // how much of what users are charged never actually reaches
      // the platform's own margin.
      airtelPassthrough: totalAirtelPassthrough
    },
    users: {
      total: totalAuthUsers,
      byPlan: planCounts
    },
    float: {
      balance: latestFloat,
      threshold: FLOAT_THRESHOLD,
      status: latestFloat === null ? 'unknown' : (latestFloat < FLOAT_THRESHOLD ? 'low' : 'ok')
    },
    alerts: openAlerts.slice(0, 10),
    airtelConfigured: !!AIRTEL.CLIENT_ID,
    paymentProvider: resolvePaymentProvider()
  });
}));

// ----------------------------
// ADMIN: LIST USERS
// GET /api/admin/users?q=search&plan=pro&limit=50
// ----------------------------
router.get('/api/admin/users', requireAdmin, asyncHandler(async (req, res) => {
  const { q, plan, limit } = req.query;
  const max = Math.min(parseInt(limit) || 100, 1000);

  // Get auth users (source of truth for email/displayName/createdAt)
  const authList = await adminAuth.listUsers(1000);

  // Get Firestore profile docs in one go
  const usersSnap = await db.collection('users').get();
  const profiles = {};
  usersSnap.forEach(doc => { profiles[doc.id] = doc.data(); });

  let users = authList.users.map(u => {
    const profile = profiles[u.uid] || {};
    return {
      uid: u.uid,
      email: u.email || null,
      displayName: u.displayName || profile.name || null,
      phone: profile.phone || null,
      phoneVerified: !!profile.phoneVerified,
      kycStatus: profile.kycStatus || 'unverified',
      plan: profile.plan || 'free',
      subscriptionActive: !!profile.subscriptionActive,
      subscriptionExpiry: profile.subscriptionExpiry || null,
      airtelBalance: profile.airtelBalance?.amount ?? null,
      createdAt: u.metadata?.creationTime || null,
      lastSignIn: u.metadata?.lastSignInTime || null,
    };
  });

  if (plan) users = users.filter(u => u.plan === plan);
  if (q) {
    const term = q.toLowerCase();
    users = users.filter(u =>
      (u.email && u.email.toLowerCase().includes(term)) ||
      (u.displayName && u.displayName.toLowerCase().includes(term)) ||
      (u.phone && u.phone.includes(term)) ||
      u.uid.toLowerCase().includes(term)
    );
  }

  users.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  users = users.slice(0, max);

  res.json({ success: true, users, total: users.length });
}));

// ----------------------------
// ADMIN: USER DETAIL
// GET /api/admin/users/:uid
// Full profile + goals + recent transactions + notifications
// ----------------------------
router.get('/api/admin/users/:uid', requireAdmin, asyncHandler(async (req, res) => {
  const { uid } = req.params;

  let authUser = null;
  try {
    authUser = await adminAuth.getUser(uid);
  } catch {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  const profileSnap = await db.collection('users').doc(uid).get();
  const profile = profileSnap.data() || {};

  const goalsSnap = await db.collection('goals').where('uid', '==', uid).get();
  const goals = [];
  goalsSnap.forEach(doc => goals.push({ id: doc.id, ...doc.data() }));
  goals.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  const txSnap = await db.collection('transactions').where('uid', '==', uid).get();
  let transactions = [];
  txSnap.forEach(doc => transactions.push({ id: doc.id, ...doc.data() }));
  transactions.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  transactions = transactions.slice(0, 50);

  const notifSnap = await db.collection('notifications').where('uid', '==', uid).get();
  let notifications = [];
  notifSnap.forEach(doc => notifications.push({ id: doc.id, ...doc.data() }));
  notifications.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  notifications = notifications.slice(0, 20);

  const totalSaved = goals.reduce((s, g) => s + (g.saved || 0), 0);
  const totalFees = transactions
    .filter(t => t.status !== 'failed')
    .reduce((s, t) => s + (t.fee || 0), 0);

  res.json({
    success: true,
    user: {
      uid,
      email: authUser.email,
      displayName: authUser.displayName || profile.name || null,
      createdAt: authUser.metadata?.creationTime || null,
      lastSignIn: authUser.metadata?.lastSignInTime || null,
      ...profile,
    },
    goals,
    transactions,
    notifications,
    stats: { totalSaved, totalFees, goalCount: goals.length, transactionCount: transactions.length }
  });
}));

// ----------------------------
// ADMIN: UPDATE USER
// PATCH /api/admin/users/:uid
// Manual overrides: plan, kycStatus, subscriptionActive/Expiry, phoneVerified
// ----------------------------
router.patch('/api/admin/users/:uid', requireAdmin, asyncHandler(async (req, res) => {
  const { uid } = req.params;
  const { plan, kycStatus, phoneVerified, subscriptionActive, subscriptionExpiryDays } = req.body;

  const updates = { updatedAt: FieldValue.serverTimestamp(), updatedByAdmin: true };

  if (plan) {
    if (!PLANS[plan]) return res.status(400).json({ success: false, error: 'Invalid plan' });
    updates.plan = plan;
    if (plan !== 'free') {
      updates.subscriptionActive = true;
      updates.subscriptionExpiry = Date.now() + (parseInt(subscriptionExpiryDays) || 30) * 24 * 60 * 60 * 1000;
    } else {
      updates.subscriptionActive = false;
    }
  }
  if (typeof kycStatus === 'string') updates.kycStatus = kycStatus;
  if (typeof phoneVerified === 'boolean') updates.phoneVerified = phoneVerified;
  if (typeof subscriptionActive === 'boolean' && !plan) updates.subscriptionActive = subscriptionActive;

  await db.collection('users').doc(uid).set(updates, { merge: true });
  clearCache(`plan_${uid}`, `profile_${uid}`);

  if (plan) {
    await pushNotification(uid, {
      type: 'subscription_success',
      message: `Your plan was updated to ${PLANS[plan].name} by support.`
    });
    if (plan !== 'free') {
      try {
        await unfreezeGoalsOnRenewal(uid);
      } catch (e) {
        logSystemError('goal_unfreeze_on_renewal', e.message, { uid, stack: e.stack });
      }
    }
  }

  res.json({ success: true });
}));

// ----------------------------
// ADMIN: OPERATIONS
// GET /api/admin/operations
// Float history, pending transactions, recent inbox activity
// ----------------------------
router.get('/api/admin/operations', requireAdmin, asyncHandler(async (req, res) => {
  // Float history (last 50, sorted)
  const floatSnap = await db.collection('float_monitor').limit(200).get();
  let floatHistory = [];
  floatSnap.forEach(doc => floatHistory.push(doc.data()));
  floatHistory.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  floatHistory = floatHistory.slice(0, 50);

  // Pending transactions across all users
  const txSnap = await db.collection('transactions').where('status', '==', 'pending').get();
  let pending = [];
  txSnap.forEach(doc => pending.push({ id: doc.id, ...doc.data() }));
  pending.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  pending = pending.slice(0, 50);

  // Recent inbox activity (Airtel webhooks)
  const inboxSnap = await db.collection('inbox').limit(200).get();
  let inbox = [];
  inboxSnap.forEach(doc => inbox.push({ id: doc.id, ...doc.data() }));
  inbox.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  inbox = inbox.slice(0, 20);

  // All alerts (resolved + unresolved)
  const alertsSnap = await db.collection('admin_alerts').get();
  let alerts = [];
  alertsSnap.forEach(doc => alerts.push({ id: doc.id, ...doc.data() }));
  alerts.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  alerts = alerts.slice(0, 30);

  res.json({
    success: true,
    floatHistory,
    pendingTransactions: pending,
    inbox,
    alerts,
    queueLength: airtelQueue.length,
    // Per-provider circuit breaker status (airtel, paychangu,
    // anthropic, gemini, groq, alert_webhook). 'open' means that
    // provider is currently being short-circuited after repeated
    // failures — see core/circuit-breaker.js.
    circuitBreakers: getAllBreakerStatuses(breakers)
  });
}));

// ----------------------------
// ADMIN: TRIGGER A MANUAL BACKUP EXPORT
// POST /api/admin/backups/export
// Starts an on-demand Firestore export to Cloud Storage, alongside
// (not instead of) whatever recurring schedule is configured in GCP
// — see docs/BACKUPS.md for setting up the recurring side, which is
// GCP console / Cloud Scheduler configuration rather than app code.
// Intended for on-demand snapshots — e.g. right before a risky
// deploy or data migration — not as the only backup mechanism.
// Body: { bucketUri: "gs://your-bucket/path", collectionIds?: [...] }
// Rate-limited: exports are heavyweight Google-side operations and
// shouldn't be triggerable in a tight loop.
// ----------------------------
router.post('/api/admin/backups/export',
  requireAdmin,
  rateLimit(5, 60 * 60 * 1000),
  asyncHandler(async (req, res) => {
    const { bucketUri, collectionIds } = req.body;
    if (!bucketUri || !bucketUri.startsWith('gs://')) {
      return res.status(400).json({ success: false, error: 'bucketUri is required and must start with gs://' });
    }
    try {
      const result = await triggerFirestoreExport({ bucketUri, collectionIds });
      log.info('Manual Firestore backup export triggered', result);
      res.json({ success: true, ...result, message: 'Export started — this runs asynchronously on Google\'s side and may take several minutes for a large database. Check /api/admin/backups/history for status.' });
    } catch (err) {
      logSystemError('backup_export', err.message, { stack: err.stack, bucketUri });
      res.status(500).json({ success: false, error: err.message });
    }
  })
);

// ----------------------------
// ADMIN: BACKUP EXPORT HISTORY
// GET /api/admin/backups/history
// ----------------------------
router.get('/api/admin/backups/history', requireAdmin, asyncHandler(async (req, res) => {
  const history = await listRecentBackupExports(20);
  res.json({ success: true, exports: history });
}));

// ----------------------------
// ADMIN: FLAGGED REFERRALS — LIST
// GET /api/admin/referrals/flagged
// Referrals held for review because the referrer and referred
// account shared a device fingerprint — see checkReferralCompletion()
// in helpers.js. No bonus has been paid yet for these.
// ----------------------------
router.get('/api/admin/referrals/flagged', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('referrals').where('status', '==', 'flagged_review').get();
  const entries = [];
  snap.forEach(d => entries.push({ id: d.id, ...d.data() }));
  entries.sort((a, b) => toMillis(b.flaggedAt) - toMillis(a.flaggedAt));
  res.json({ success: true, referrals: entries });
}));

// ----------------------------
// ADMIN: RESOLVE A FLAGGED REFERRAL
// PATCH /api/admin/referrals/:referralId
// action: 'approve' pays out both bonuses (same crediting logic as a
// normal completion) and increments the referrer's referralCount;
// action: 'deny' marks it denied with no payout. Either way this is
// a deliberate, one-time human decision — never automatic.
// Body: { action: 'approve' | 'deny' }
// ----------------------------
router.patch('/api/admin/referrals/:referralId', requireAdmin, asyncHandler(async (req, res) => {
  const { referralId } = req.params;
  const { action } = req.body;
  if (!['approve', 'deny'].includes(action)) {
    return res.status(400).json({ success: false, error: "action must be 'approve' or 'deny'" });
  }

  const refDoc = await db.collection('referrals').doc(referralId).get();
  const referral = refDoc.data();
  if (!referral) return res.status(404).json({ success: false, error: 'Referral not found' });
  if (referral.status !== 'flagged_review') {
    return res.status(400).json({ success: false, error: 'This referral is not pending review' });
  }

  if (action === 'deny') {
    await refDoc.ref.update({ status: 'denied', resolvedAt: FieldValue.serverTimestamp() });
    return res.json({ success: true, message: 'Referral denied — no bonus paid' });
  }

  // Approve: same crediting logic as a normal auto-completion
  await refDoc.ref.update({ status: 'completed', completedAt: FieldValue.serverTimestamp() });
  await db.collection('users').doc(referral.referrerUid).set({
    referralCount: FieldValue.increment(1)
  }, { merge: true });

  for (const targetUid of [referral.referrerUid, referral.referredUid]) {
    await db.collection('users').doc(targetUid).set({
      accountBalance: FieldValue.increment(referral.bonusAmount || 500)
    }, { merge: true });
    await pushNotification(targetUid, {
      type: 'referral_bonus',
      message: `🎁 You earned a MWK ${(referral.bonusAmount || 500).toLocaleString()} referral bonus, added to your account balance!`
    });
  }

  log.info('Flagged referral approved by admin', { referralId, referrerUid: referral.referrerUid, referredUid: referral.referredUid });
  res.json({ success: true, message: 'Referral approved — both bonuses paid' });
}));

// ----------------------------
// ADMIN: UNRESOLVED FUNDS LEDGER
// GET /api/admin/unresolved-funds
// Balances swept from deleted accounts that were never withdrawn or
// recovered within the 60-day window — see sweepUnresolvedFunds() in
// jobs.js. This is explicitly not revenue; it's an accounting record
// of unclaimed user money the platform is holding, kept separate
// from platform_fees so it's never mistaken for earnings.
// ----------------------------
router.get('/api/admin/unresolved-funds', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('unresolved_funds').orderBy('sweptAt', 'desc').limit(200).get();
  const entries = [];
  let total = 0;
  snap.forEach(d => {
    const data = d.data();
    entries.push({ id: d.id, ...data });
    if (!data.resolved) total += data.amount || 0;
  });
  res.json({ success: true, entries, totalUnresolved: total });
}));

// ----------------------------
// ADMIN: MARK AN UNRESOLVED FUNDS ENTRY RESOLVED
// PATCH /api/admin/unresolved-funds/:entryId
// For when an admin manually reconciles an entry — e.g. paying the
// original user back after identity verification via support, or
// deciding after a retention period to formally recognize it as
// platform revenue. This endpoint only marks the ledger entry;
// it does NOT move money anywhere automatically, since resolution
// could mean either outcome and that decision needs a human.
// Body: { resolution: string }
// ----------------------------
router.patch('/api/admin/unresolved-funds/:entryId', requireAdmin, asyncHandler(async (req, res) => {
  const { entryId } = req.params;
  const { resolution } = req.body;
  await db.collection('unresolved_funds').doc(entryId).set({
    resolved: true,
    resolution: resolution || null,
    resolvedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  res.json({ success: true });
}));

// ----------------------------
// ADMIN: RESOLVE ALERT
// PATCH /api/admin/alerts/:alertId
// ----------------------------
router.patch('/api/admin/alerts/:alertId', requireAdmin, asyncHandler(async (req, res) => {
  const { alertId } = req.params;
  await db.collection('admin_alerts').doc(alertId).set({
    resolved: true,
    resolvedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  res.json({ success: true });
}));

// ----------------------------
// ADMIN: REVENUE (legacy, kept for compatibility)
// GET /api/admin/revenue
// ----------------------------
router.get('/api/admin/revenue', requireAdmin, asyncHandler(async (req, res) => {
  const feeSnap = await db.collection('platform_fees').limit(1000).get();
  let totalRevenue = 0, totalAirtelPassthrough = 0;
  const revenueByType = {};
  const revenueByPlan = {};
  feeSnap.forEach(doc => {
    const fee = doc.data();
    // platformAmount is what PocketVault actually keeps after Airtel's
    // 1.5% cut; falls back to the gross amount for older fee records
    // that predate the split.
    const amt = fee.platformAmount ?? fee.amount ?? 0;
    totalRevenue += amt;
    totalAirtelPassthrough += fee.airtelAmount || 0;
    revenueByType[fee.type] = (revenueByType[fee.type] || 0) + amt;
    revenueByPlan[fee.plan || 'unknown'] = (revenueByPlan[fee.plan || 'unknown'] || 0) + amt;
  });
  const usersSnap = await db.collection('users').get();
  const planCounts = { free: 0, pro: 0, business: 0 };
  usersSnap.forEach(doc => {
    const plan = doc.data().plan || 'free';
    if (planCounts[plan] !== undefined) planCounts[plan]++;
  });
  res.json({
    success: true,
    revenue: { total: totalRevenue, byType: revenueByType, byPlan: revenueByPlan, airtelPassthrough: totalAirtelPassthrough },
    users: { total: usersSnap.size, byPlan: planCounts }
  });
}));

// ----------------------------
// ADMIN: SEND MESSAGE TO USER(S)
// POST /api/admin/messages
// Body: { uid?, message, type? }
// If uid is omitted → broadcast to ALL users
// ----------------------------
router.post('/api/admin/messages', requireAdmin, asyncHandler(async (req, res) => {
  const { uid, message, topic = '', type = 'admin_message' } = req.body;
  if (!message?.trim()) return res.status(400).json({ success: false, error: 'message required' });

  const notifBase = {
    type,
    message: message.trim(),
    topic: topic.trim() || null,
    senderName: 'PocketVault Admin',
    senderIcon: '🛡️',
    read: false,
    timestamp: FieldValue.serverTimestamp()
  };

  if (uid) {
    await db.collection('notifications').add({ ...notifBase, uid });
    await db.collection('admin_messages').add({
      uid, message: message.trim(), topic: topic.trim() || null, type,
      broadcast: false, timestamp: FieldValue.serverTimestamp()
    });
    return res.json({ success: true, sent: 1 });
  }

  // Broadcast to all users
  const list = await adminAuth.listUsers(1000);
  let sent = 0;
  const batch = db.batch();
  for (const user of list.users) {
    batch.set(db.collection('notifications').doc(), { ...notifBase, uid: user.uid });
    sent++;
  }
  await batch.commit();

  await db.collection('admin_messages').add({
    uid: null, message: message.trim(), topic: topic.trim() || null, type,
    broadcast: true, recipientCount: sent,
    timestamp: FieldValue.serverTimestamp()
  });

  res.json({ success: true, sent, broadcast: true });
}));

// ----------------------------
// ADMIN: GET MESSAGE HISTORY
// GET /api/admin/messages
// ----------------------------
router.get('/api/admin/messages', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('admin_messages').limit(100).get();
  let messages = [];
  snap.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
  messages.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  res.json({ success: true, messages });
}));

// ----------------------------
// ADMIN: SYSTEM ERRORS
// GET /api/admin/errors
// ----------------------------
router.get('/api/admin/errors', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('system_errors').limit(200).get();
  let errors = [];
  snap.forEach(doc => errors.push({ id: doc.id, ...doc.data() }));
  errors.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  const unread = errors.filter(e => !e.read).length;
  res.json({ success: true, errors: errors.slice(0, 100), unread });
}));

// ----------------------------
// ADMIN: MARK ERROR READ
// PATCH /api/admin/errors/:id
// ----------------------------
router.patch('/api/admin/errors/:id', requireAdmin, asyncHandler(async (req, res) => {
  await db.collection('system_errors').doc(req.params.id).update({ read: true });
  res.json({ success: true });
}));

// ----------------------------
// ADMIN: MARK ALL ERRORS READ
// POST /api/admin/errors/read-all
// ----------------------------
router.post('/api/admin/errors/read-all', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('system_errors').where('read', '==', false).get();
  const batch = db.batch();
  snap.forEach(doc => batch.update(doc.ref, { read: true }));
  await batch.commit();
  res.json({ success: true, marked: snap.size });
}));

// ----------------------------
// ADMIN: PLATFORM-WIDE NOTIFICATIONS FEED
// GET /api/admin/notifications
// Every notification sent to every user, not just one — the admin
// panel's Notifications page previously just redirected to Overview
// without ever actually fetching anything. Optional ?type= and
// ?uid= query params let the founder narrow the feed (e.g. all
// referral_bonus notifications, or everything sent to one user)
// without needing a composite Firestore index — same pattern as
// GET /api/admin/errors: fetch a bounded set, filter/sort in code.
// ----------------------------
router.get('/api/admin/notifications', requireAdmin, asyncHandler(async (req, res) => {
  const { type, uid } = req.query;
  const snap = await db.collection('notifications').limit(1000).get();
  let notifications = [];
  snap.forEach(doc => notifications.push({ id: doc.id, ...doc.data() }));

  if (type) notifications = notifications.filter(n => n.type === type);
  if (uid) notifications = notifications.filter(n => n.uid === uid);

  notifications.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  const types = [...new Set(notifications.map(n => n.type).filter(Boolean))].sort();

  res.json({ success: true, notifications: notifications.slice(0, 200), types, total: notifications.length });
}));

// ============================================================
// AI-POWERED ADMIN FEATURES
// All routes require requireAdmin. Uses the Anthropic API.
// If ANTHROPIC_API_KEY is not set, these return a clear 503
// error rather than failing silently.
// ============================================================

// ----------------------------
// AI: CHAT ASSISTANT (tool-calling architecture)
// POST /api/admin/ai/chat
//
// Unlike the old fixed-snapshot version, this endpoint lets the
// model decide WHAT data it needs by requesting one of the
// AI_TOOLS, and can propose a real ACTION (e.g. send a message)
// which the founder must explicitly confirm via a separate
// endpoint before anything actually happens.
//
// Works identically across Anthropic/Gemini/Groq by asking the
// model to respond in a strict JSON envelope rather than relying
// on any one provider's native function-calling format — keeps
// this portable across all three providers we support.
//
// Body: { question, history? }
// ----------------------------

// ============================================================
// AI MEMORY SYSTEM
// ============================================================

const AI_CONVERSATION_ID = 'default';

async function loadConversationHistory(limit = 20) {
  const snap = await db.collection('ai_conversations').doc(AI_CONVERSATION_ID)
    .collection('messages').orderBy('timestamp', 'desc').limit(limit).get();
  const messages = [];
  snap.forEach(d => messages.push(d.data()));
  return messages.reverse();
}

async function saveConversationTurn(role, content) {
  await db.collection('ai_conversations').doc(AI_CONVERSATION_ID)
    .collection('messages').add({ role, content, timestamp: FieldValue.serverTimestamp() });
}

async function loadLearnedNotes() {
  const snap = await db.collection('ai_memory_notes').orderBy('createdAt', 'desc').limit(30).get();
  const notes = [];
  snap.forEach(d => notes.push(d.data().note));
  return notes;
}

async function saveLearnedNote(note) {
  if (!note?.trim()) return;
  await db.collection('ai_memory_notes').add({ note: note.trim(), createdAt: FieldValue.serverTimestamp() });
}

router.post('/api/admin/ai/chat', requireAdmin, rateLimit(20, 60 * 1000), asyncHandler(async (req, res) => {
  const { question, history: clientHistory = [] } = req.body;
  if (!question?.trim()) return res.status(400).json({ success: false, error: 'question required' });

  const toolList = Object.entries(AI_TOOLS)
    .map(([name, t]) => `- ${name}: ${t.description}`).join('\n');
  const actionList = Object.entries(AI_ACTIONS)
    .map(([name, a]) => `- ${name}: ${a.description}`).join('\n');

  // Persistent memory: prefer server-stored history (survives page
  // refresh / returning later) over whatever the client sent, falling
  // back to client history only if server memory is somehow empty
  // (e.g. very first message, or memory was just cleared).
  let storedHistory = [];
  try { storedHistory = await loadConversationHistory(20); } catch {}
  const effectiveHistory = storedHistory.length > 0
    ? storedHistory
    : clientHistory.map(h => ({ role: h.role, content: h.content }));

  let learnedNotes = [];
  try { learnedNotes = await loadLearnedNotes(); } catch {}
  const notesBlock = learnedNotes.length > 0
    ? `\n\nThings you've learned from the founder in past conversations — treat these as standing instructions, don't ask about them again:\n${learnedNotes.map(n => `- ${n}`).join('\n')}`
    : '';

  const conversationText = effectiveHistory.length > 0
    ? effectiveHistory.map(h => `${h.role === 'user' ? 'Founder' : 'Assistant'}: ${h.content}`).join('\n') + `\nFounder: ${question}`
    : `Founder: ${question}`;

  const systemPrompt = `You are the AI assistant inside PocketVault's admin panel, a Malawian fintech savings app built on Airtel Money. You help the founder (a non-technical person) understand and manage their platform.

You respond ONLY in strict JSON, one of these four shapes — no markdown, no prose outside the JSON:

1. To fetch data before answering:
{"thinking":"your reasoning about what you need and why, written out step by step","type":"tool_call","tool":"<tool_name>","args":{...}}

Available tools:
${toolList}

2. To propose a real action (sending a message, suspending a user, etc) — ONLY do this when the founder has clearly asked for the action to be taken, not just discussed:
{"thinking":"your reasoning for why this action, with these exact args, is the right response","type":"action_proposal","action":"<action_name>","args":{...},"summary":"one sentence describing exactly what will happen, for the founder to confirm"}

Available actions:
${actionList}

3. To give a final plain-English answer (most common):
{"thinking":"walk through your reasoning here — what the data shows, how it answers the question, and anything you double-checked before committing to this answer","type":"answer","text":"your answer here"}

4. To remember something durable for future conversations — a correction, a standing preference, or context worth not forgetting (e.g. "Business-plan withdrawals over 500k aren't unusual, don't flag them"). Only use this for things genuinely worth remembering long-term, not routine facts:
{"thinking":"...","type":"answer","text":"your answer here","remember":"the specific thing to remember, written as a standalone fact"}

How to reason well (this is what separates a good answer from a shallow one):
- ALWAYS fill in "thinking" first, genuinely — work through the problem step by step in your own words before deciding what to do. Don't skip straight to an action. Treat it like you're thinking out loud to yourself, not writing a summary for someone else.
- Break multi-part questions into parts explicitly in your thinking (e.g. "This has two parts: (1) find unverified users, (2) check which of those have pending transactions. I need tool A first, then tool B filtered by the result.").
- When a tool result surprises you, or doesn't fully answer the question, say so in your thinking and decide whether you need another tool call rather than papering over the gap.
- Before finalizing an "answer", use your thinking to sanity-check it against the actual data you retrieved: does every number in your answer trace back to something a tool actually returned? If you're about to state something you don't have data for, that's a signal to make another tool_call instead.
- If a question has multiple reasonable interpretations, name them in your thinking and pick the most likely one explicitly, or ask a clarifying question if it genuinely matters which one.
- It's fine — expected, even — to take several tool_calls in sequence to fully answer something. Don't rush to a shallow answer just to finish quickly.

Critical rules:
- If the founder's request is ambiguous (e.g. "remind that user" with no clear single referent), respond with type "answer" and ASK a clarifying question. Never guess which user they mean.
- Only propose an action when explicitly asked to take one ("send it", "remind them", "suspend that user") — not when just discussing hypotheticals.
- Never invent numbers or user data. If you need data, request a tool_call first.
- Keep the final "text" concise and conversational — 2-5 sentences unless real detail was explicitly requested. Your "thinking" can be as long as it needs to be; "text" should read like a sharp, direct answer, not a report.
- Use MWK for currency.
- You have access to the full conversation history below, including anything from earlier today or previous sessions — use it, don't ask the founder to repeat context they already gave you.${notesBlock}`;

  // Tool-calling loop with genuine multi-step reasoning room. Raised
  // from 4 to 8 iterations — 4 was cutting off legitimate multi-part
  // questions right when they needed one more step. Token budget
  // raised similarly so the model has room for real "thinking" text
  // rather than truncating it.
  const MAX_ITERATIONS = 8;
  let workingContext = '';
  let finalResult = null;
  let lastThinking = '';
  const toolCallLog = []; // for the self-check pass and for debugging

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const prompt = `${workingContext}\n\nConversation so far:\n${conversationText}\n\nRespond with the JSON envelope now. Remember to genuinely reason in "thinking" before deciding the type.`;
      const raw = await callAI(systemPrompt, prompt, 1600);

      let parsed;
      try {
        parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch {
        // Model didn't follow the JSON format — treat the raw text as a plain answer
        finalResult = { type: 'answer', text: raw.trim() };
        break;
      }

      if (parsed.thinking) lastThinking = parsed.thinking;

      if (parsed.type === 'tool_call') {
        const tool = AI_TOOLS[parsed.tool];
        if (!tool) {
          workingContext += `\n\n[Tool "${parsed.tool}" does not exist. Available tools: ${Object.keys(AI_TOOLS).join(', ')}]`;
          continue;
        }
        try {
          const toolResult = await tool.fn(parsed.args || {});
          toolCallLog.push({ tool: parsed.tool, args: parsed.args, resultSummary: JSON.stringify(toolResult).slice(0, 200) });
          workingContext += `\n\n[Your reasoning was: ${parsed.thinking || '(none given)'}]\n[Result of ${parsed.tool}]:\n${JSON.stringify(toolResult).slice(0, 4000)}`;
        } catch (toolErr) {
          // Structured recovery: tell the model explicitly that this
          // path failed so it can try a different approach rather
          // than silently continuing and potentially inventing data.
          workingContext += `\n\n[Tool "${parsed.tool}" failed: ${toolErr.message}. Consider whether a different tool or different args would work, or explain this limitation in your final answer rather than inventing data.]`;
        }
        continue; // loop again so the model can use this data
      }

      if (parsed.type === 'action_proposal') {
        const action = AI_ACTIONS[parsed.action];
        if (!action) {
          workingContext += `\n\n[Action "${parsed.action}" does not exist. Available actions: ${Object.keys(AI_ACTIONS).join(', ')}]`;
          continue;
        }
        finalResult = {
          type: 'action_proposal',
          action: parsed.action,
          args: parsed.args || {},
          summary: parsed.summary || `Execute ${parsed.action}`,
          thinking: parsed.thinking || '',
        };
        break;
      }

      // type === 'answer' — genuine self-check pass: if any tool
      // calls were made, ask the model to verify its own draft
      // answer against what was actually retrieved before it ships.
      let finalText = parsed.text || raw.trim();
      if (toolCallLog.length > 0) {
        const verifyPrompt = `You drafted this answer: "${finalText}"\n\nHere is what you actually retrieved via tools during this conversation:\n${toolCallLog.map(t => `- ${t.tool}(${JSON.stringify(t.args)}) → ${t.resultSummary}`).join('\n')}\n\nCheck: does every specific number or fact in your draft answer genuinely trace back to this data? If the draft is accurate, respond with exactly the same text unchanged. If you spot something unsupported or wrong, respond with a corrected version. Respond with ONLY the final answer text, no JSON, no preamble.`;
        try {
          const verified = await callAI('You are fact-checking your own draft answer against retrieved data. Be strict — only pass through claims that are actually supported.', verifyPrompt, 500);
          if (verified?.trim()) finalText = verified.trim();
        } catch {
          // If the verification call itself fails, ship the original
          // draft rather than blocking the response entirely
        }
      }

      finalResult = { type: 'answer', text: finalText, remember: parsed.remember || null, thinking: parsed.thinking || lastThinking };
      break;
    }

    if (!finalResult) {
      finalResult = { type: 'answer', text: "This turned out to need more steps than I could work through in one go — try breaking it into a couple of smaller questions and I'll be able to go deeper on each." };
    }

    if (finalResult.type === 'action_proposal') {
      // Save the turn even for action proposals, so if the founder
      // comes back later and says "did that message ever go out?"
      // the assistant has this exchange in memory
      await saveConversationTurn('user', question).catch(() => {});
      await saveConversationTurn('assistant', finalResult.summary).catch(() => {});
      return res.json({
        success: true,
        answer: finalResult.summary,
        actionProposal: { action: finalResult.action, args: finalResult.args, summary: finalResult.summary, thinking: finalResult.thinking || null },
      });
    }

    await saveConversationTurn('user', question).catch(() => {});
    await saveConversationTurn('assistant', finalResult.text).catch(() => {});
    if (finalResult.remember) {
      await saveLearnedNote(finalResult.remember).catch(() => {});
    }

    res.json({ success: true, answer: finalResult.text, thinking: finalResult.thinking || null, remembered: !!finalResult.remember });
  } catch (err) {
    res.status(err.isRateLimit ? 429 : 503).json({ success: false, error: err.message, isRateLimit: !!err.isRateLimit });
  }
}));

// ----------------------------
// AI: EXECUTE ACTION
// POST /api/admin/ai/execute-action
// The founder clicks Confirm on an action proposal the assistant
// generated. This is the ONLY place an AI-proposed action actually
// runs — args are re-validated server-side, never trusted blindly
// from the client even though they originated from our own AI.
// Body: { action, args }
// ----------------------------

// ----------------------------
// AI MEMORY: VIEW LEARNED NOTES
// GET /api/admin/ai/memory
// ----------------------------
router.get('/api/admin/ai/memory', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('ai_memory_notes').orderBy('createdAt', 'desc').limit(50).get();
  const notes = [];
  snap.forEach(d => notes.push({ id: d.id, ...d.data() }));
  res.json({ success: true, notes });
}));

// ----------------------------
// AI MEMORY: FORGET A NOTE
// DELETE /api/admin/ai/memory/:noteId
// ----------------------------
router.delete('/api/admin/ai/memory/:noteId', requireAdmin, asyncHandler(async (req, res) => {
  await db.collection('ai_memory_notes').doc(req.params.noteId).delete();
  res.json({ success: true });
}));

// ----------------------------
// AI MEMORY: CLEAR CONVERSATION
// POST /api/admin/ai/clear-conversation
// Wipes the ongoing conversation history (not the learned notes —
// those are separate and meant to persist even across a fresh start).
// ----------------------------
router.post('/api/admin/ai/clear-conversation', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('ai_conversations').doc(AI_CONVERSATION_ID).collection('messages').get();
  const batch = db.batch();
  snap.forEach(d => batch.delete(d.ref));
  await batch.commit();
  res.json({ success: true, cleared: snap.size });
}));

router.post('/api/admin/ai/execute-action', requireAdmin, rateLimit(10, 60 * 1000), asyncHandler(async (req, res) => {
  const { action, args } = req.body;
  const actionDef = AI_ACTIONS[action];
  if (!actionDef) return res.status(400).json({ success: false, error: `Unknown action: ${action}` });

  try {
    const result = await actionDef.execute(args || {}, { ip: req.ip });
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}));

// ----------------------------
// AI: ACTION LOG
// GET /api/admin/ai/action-log
// Audit trail of every action the AI assistant has executed,
// separate from normal admin activity logs.
// ----------------------------
router.get('/api/admin/ai/action-log', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('ai_action_log').orderBy('executedAt', 'desc').limit(50).get().catch(async () => {
    // Fallback if composite index isn't available — fetch and sort in app code
    const s = await db.collection('ai_action_log').limit(200).get();
    return s;
  });
  const actions = [];
  snap.forEach(d => actions.push({ id: d.id, ...d.data() }));
  actions.sort((a, b) => toMillis(b.executedAt) - toMillis(a.executedAt));
  res.json({ success: true, actions: actions.slice(0, 50) });
}));


// ----------------------------
// AI: ANOMALY / FRAUD DETECTION
// GET /api/admin/ai/anomalies
// Scans recent transactions and user behavior for suspicious
// patterns and returns them as structured alerts.
// ----------------------------
router.get('/api/admin/ai/anomalies', requireAdmin, asyncHandler(async (req, res) => {
  const [txSnap, usersSnap] = await Promise.all([
    db.collection('transactions').limit(500).get(),
    db.collection('users').limit(500).get(),
  ]);

  const transactions = [];
  txSnap.forEach(d => transactions.push({ id: d.id, ...d.data() }));
  const users = {};
  usersSnap.forEach(d => { users[d.id] = d.data(); });

  transactions.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));

  // Rule-based pre-filter (fast, no AI cost) — only send genuinely
  // unusual patterns to the AI for explanation, not the whole dataset
  const byUser = {};
  transactions.forEach(t => {
    if (!byUser[t.uid]) byUser[t.uid] = [];
    byUser[t.uid].push(t);
  });

  const flagged = [];
  for (const [uid, txs] of Object.entries(byUser)) {
    const large = txs.filter(t => t.amount > 500000);
    const rapid = txs.filter((t, i) => {
      if (i === 0) return false;
      const gap = Math.abs(toMillis(t.timestamp) - toMillis(txs[i-1].timestamp));
      return gap < 5 * 60 * 1000; // under 5 minutes apart
    });
    const failedCount = txs.filter(t => t.status === 'failed').length;

    if (large.length > 0 || rapid.length >= 3 || failedCount >= 3) {
      flagged.push({
        uid,
        email: users[uid]?.email || uid,
        largeTransactions: large.length,
        rapidTransactions: rapid.length,
        failedTransactions: failedCount,
        totalTransactions: txs.length,
        kycStatus: users[uid]?.kycStatus || 'unverified'
      });
    }
  }

  if (flagged.length === 0) {
    return res.json({ success: true, anomalies: [], summary: 'No unusual patterns detected in recent transaction activity.' });
  }

  const systemPrompt = `You are a fraud-detection assistant for a Malawian fintech savings app admin panel. 
Given a list of flagged user activity patterns, explain in plain English which ones are most concerning and why, 
and give the founder a short prioritized action list. Be direct and practical, not alarmist. 
Output valid JSON only, no markdown, matching this shape:
{"summary": "one sentence overview", "items": [{"uid": "...", "email":"...", "risk": "high|medium|low", "reason": "plain english explanation", "suggestedAction": "what to do"}]}`;

  try {
    const cacheKey = `anomalies_${flagged.map(f => f.uid).sort().join(',').slice(0, 200)}`;
    const { answer: raw, cached } = await callAICached(cacheKey, systemPrompt, JSON.stringify(flagged.slice(0, 20)), 1200, 5 * 60 * 1000);
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      parsed = { summary: raw, items: [] };
    }
    res.json({ success: true, anomalies: parsed.items || [], summary: parsed.summary || '', cached });
  } catch (err) {
    if (err.isRateLimit) {
      return res.status(429).json({
        success: true, isRateLimit: true,
        anomalies: flagged.map(f => ({ ...f, risk: 'unknown', reason: 'AI explanation unavailable — rate limited', suggestedAction: 'Review manually' })),
        summary: err.message
      });
    }
    // Fall back to the rule-based flags without AI explanation if the API call fails
    res.json({
      success: true,
      anomalies: flagged.map(f => ({ ...f, risk: 'unknown', reason: 'AI explanation unavailable', suggestedAction: 'Review manually' })),
      summary: `AI analysis unavailable (${err.message}) — showing rule-based flags only.`
    });
  }
}));

// ----------------------------
// AI: DRAFT MESSAGE
// POST /api/admin/ai/draft-message
// Helps the founder write a message to send to a user or broadcast.
// Body: { intent, context? }
// ----------------------------
router.post('/api/admin/ai/draft-message', requireAdmin, rateLimit(20, 60 * 1000), asyncHandler(async (req, res) => {
  const { intent, context } = req.body;
  if (!intent?.trim()) return res.status(400).json({ success: false, error: 'intent required' });

  const systemPrompt = `You write short, warm, professional in-app notification messages for PocketVault, 
a Malawian savings app. Messages appear as push notifications inside the app, sent from "PocketVault Admin".
Keep it under 3 sentences. No markdown, no emoji spam (at most one relevant emoji). Return only the message text, 
and on a separate line starting with "TOPIC: " give a short 3-6 word subject line.`;

  const userPrompt = `Write a message for this purpose: ${intent}${context ? `\nAdditional context: ${context}` : ''}`;

  try {
    const raw = await callAI(systemPrompt, userPrompt, 300);
    const topicMatch = raw.match(/TOPIC:\s*(.+)/i);
    const topic = topicMatch ? topicMatch[1].trim() : '';
    const message = raw.replace(/TOPIC:\s*.+/i, '').trim();
    res.json({ success: true, message, topic });
  } catch (err) {
    res.status(err.isRateLimit ? 429 : 503).json({ success: false, error: err.message, isRateLimit: !!err.isRateLimit });
  }
}));

// ----------------------------
// AI: STATUS
// GET /api/admin/ai/status
// Tells the admin panel which AI provider is currently active,
// so the UI can show it without guessing.
// ----------------------------
router.get('/api/admin/ai/status', requireAdmin, asyncHandler(async (req, res) => {
  const provider = resolveAIProvider();
  const labels = { anthropic: 'Claude (Anthropic)', gemini: 'Gemini (Google)', groq: 'Groq (Llama)' };
  res.json({
    success: true,
    configured: !!provider,
    provider: provider || null,
    providerLabel: labels[provider] || null,
    anthropicAvailable: !!AI.ANTHROPIC_KEY,
    geminiAvailable: !!AI.GEMINI_KEY,
    groqAvailable: !!AI.GROQ_KEY,
  });
}));

// ----------------------------
// AI: CHAT HISTORY PERSISTENCE
// (Improvement #5 — memory across admin sessions, not just
// within one open tab. There's only one founder using this
// admin panel, so a single stored document is enough — no
// per-admin-user scoping needed.)
// ----------------------------
router.get('/api/admin/ai/chat-history', requireAdmin, asyncHandler(async (req, res) => {
  const doc = await db.collection('ai_chat_sessions').doc('founder').get();
  res.json({ success: true, history: doc.exists ? (doc.data().history || []) : [] });
}));

router.post('/api/admin/ai/chat-history', requireAdmin, asyncHandler(async (req, res) => {
  const { history } = req.body;
  if (!Array.isArray(history)) return res.status(400).json({ success: false, error: 'history must be an array' });
  // Keep only the most recent 40 messages to avoid unbounded document growth
  const trimmed = history.slice(-40);
  await db.collection('ai_chat_sessions').doc('founder').set({
    history: trimmed, updatedAt: FieldValue.serverTimestamp()
  });
  res.json({ success: true, saved: trimmed.length });
}));

router.delete('/api/admin/ai/chat-history', requireAdmin, asyncHandler(async (req, res) => {
  await db.collection('ai_chat_sessions').doc('founder').delete();
  res.json({ success: true });
}));

// ----------------------------
// AI: PLATFORM INSIGHTS
// GET /api/admin/ai/insights
// Weekly-style plain-English summary of revenue, growth, and
// risk signals across the whole platform.
// ----------------------------
router.get('/api/admin/ai/insights', requireAdmin, asyncHandler(async (req, res) => {
  const [usersSnap, feesSnap, goalsSnap] = await Promise.all([
    db.collection('users').limit(1000).get(),
    db.collection('platform_fees').limit(1000).get(),
    db.collection('goals').limit(1000).get(),
  ]);

  const users = [];
  usersSnap.forEach(d => users.push({ id: d.id, ...d.data() }));
  const fees = [];
  feesSnap.forEach(d => fees.push(d.data()));
  const goals = [];
  goalsSnap.forEach(d => goals.push(d.data()));

  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

  const revenueThisWeek = fees.filter(f => toMillis(f.timestamp) > weekAgo).reduce((s, f) => s + (f.platformAmount ?? f.amount ?? 0), 0);
  const revenueThisMonth = fees.filter(f => toMillis(f.timestamp) > monthAgo).reduce((s, f) => s + (f.platformAmount ?? f.amount ?? 0), 0);
  const totalRevenue = fees.reduce((s, f) => s + (f.platformAmount ?? f.amount ?? 0), 0);

  const newUsersThisWeek = users.filter(u => toMillis(u.createdAt) > weekAgo).length;
  const planCounts = { free: 0, pro: 0, business: 0 };
  users.forEach(u => { const p = u.plan || 'free'; if (planCounts[p] !== undefined) planCounts[p]++; });

  const inactiveUsers = users.filter(u => {
    const lastActivity = toMillis(u.updatedAt) || toMillis(u.createdAt);
    return lastActivity > 0 && lastActivity < monthAgo;
  }).length;

  const completedGoals = goals.filter(g => g.completed).length;
  const lockedGoals = goals.filter(g => g.locked && !g.completed).length;

  const stats = {
    totalUsers: users.length,
    newUsersThisWeek,
    planCounts,
    revenueThisWeek, revenueThisMonth, totalRevenue,
    totalGoals: goals.length, completedGoals, lockedGoals,
    inactiveUsers, suspendedUsers: users.filter(u => u.suspended).length,
  };

  const systemPrompt = `You are a business analyst for PocketVault, a Malawian fintech savings app. 
Given raw platform statistics, write a short, plain-English weekly-style insight report for the founder — 
a non-technical person. Cover: revenue trend, growth, and 1-2 risks or opportunities worth their attention. 
Use MWK for currency. 4-6 short sentences total, no markdown headers, conversational but professional tone.`;

  try {
    // Cache for 15 minutes — the underlying stats don't shift meaningfully
    // minute-to-minute, and this page tends to get opened repeatedly
    const { answer: insight, cached } = await callAICached('insights_weekly', systemPrompt, JSON.stringify(stats), 500, 15 * 60 * 1000);
    res.json({ success: true, insight, stats, cached });
  } catch (err) {
    res.status(err.isRateLimit ? 429 : 503).json({ success: false, error: err.message, isRateLimit: !!err.isRateLimit, stats });
  }
}));

// ----------------------------
// AI: ERROR ANALYSIS
// POST /api/admin/ai/analyze-errors
// Analyzes recent system_errors entries and explains likely
// causes and fixes in plain English.
// Body: { errorIds? } — if omitted, analyzes the 20 most recent unread errors
// ----------------------------
router.post('/api/admin/ai/analyze-errors', requireAdmin, rateLimit(10, 60 * 1000), asyncHandler(async (req, res) => {
  const { errorIds } = req.body;

  let errors = [];
  if (errorIds?.length) {
    const docs = await Promise.all(errorIds.map(id => db.collection('system_errors').doc(id).get()));
    docs.forEach(d => { if (d.exists) errors.push({ id: d.id, ...d.data() }); });
  } else {
    const snap = await db.collection('system_errors').where('read', '==', false).limit(20).get();
    snap.forEach(d => errors.push({ id: d.id, ...d.data() }));
  }

  if (errors.length === 0) {
    return res.json({ success: true, analysis: 'No unread errors to analyze. Everything looks clean.', groups: [] });
  }

  // Group identical error messages together so the AI isn't repeating itself
  const grouped = {};
  errors.forEach(e => {
    const key = `${e.source}:${(e.message || '').slice(0, 80)}`;
    if (!grouped[key]) grouped[key] = { source: e.source, message: e.message, stack: e.stack, count: 0, ids: [] };
    grouped[key].count++;
    grouped[key].ids.push(e.id);
  });
  const groupList = Object.values(grouped);

  const systemPrompt = `You are a senior backend engineer helping a non-technical founder understand server errors 
in their Node.js/Express/Firestore fintech app called PocketVault. Given a list of grouped error entries 
(source, message, stack trace, occurrence count), explain in PLAIN ENGLISH:
1. What likely caused each distinct error
2. Whether it's urgent, or safe to ignore
3. A concrete next step to fix or investigate it

Be concise. No jargon without explaining it. Format as a numbered list, one item per distinct error group.`;

  try {
    const cacheKey = `errors_${groupList.map(g => `${g.source}:${g.message}`).sort().join('|').slice(0, 300)}`;
    const { answer: analysis, cached } = await callAICached(cacheKey, systemPrompt, JSON.stringify(groupList), 1200, 10 * 60 * 1000);
    res.json({ success: true, analysis, groups: groupList.map(g => ({ source: g.source, message: g.message, count: g.count })), cached });
  } catch (err) {
    res.status(err.isRateLimit ? 429 : 503).json({ success: false, error: err.message, isRateLimit: !!err.isRateLimit });
  }
}));

// ----------------------------
// ADMIN: GLOBAL TRANSACTION SEARCH
// GET /api/admin/transactions?q=reference&uid=xxx&status=pending
// ----------------------------
router.get('/api/admin/transactions', requireAdmin, asyncHandler(async (req, res) => {
  const { q, uid, status, type } = req.query;
  const snap = await db.collection('transactions').limit(500).get();
  let txs = [];
  snap.forEach(doc => txs.push({ id: doc.id, ...doc.data() }));

  if (uid) txs = txs.filter(t => t.uid === uid);
  if (status) txs = txs.filter(t => t.status === status);
  if (type) txs = txs.filter(t => t.type === type);
  if (q) {
    const term = q.toLowerCase();
    txs = txs.filter(t =>
      (t.reference || '').toLowerCase().includes(term) ||
      (t.airtelTxnId || '').toLowerCase().includes(term) ||
      (t.phone || '').includes(term)
    );
  }

  txs.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  res.json({ success: true, transactions: txs.slice(0, 100), total: txs.length });
}));

// ----------------------------
// ADMIN: MANUAL TRANSACTION STATUS OVERRIDE
// PATCH /api/admin/transactions/:id
// Body: { status }
// ----------------------------
router.patch('/api/admin/transactions/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['completed', 'failed', 'pending'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }
  const snap = await db.collection('transactions').doc(req.params.id).get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'Transaction not found' });
  await snap.ref.update({ status, manualOverride: true, overriddenAt: FieldValue.serverTimestamp() });
  res.json({ success: true });
}));

// ----------------------------
// ADMIN: SUSPEND / UNSUSPEND USER
// PATCH /api/admin/users/:uid/suspend
// Body: { suspended: true/false, reason? }
// ----------------------------
router.patch('/api/admin/users/:uid/suspend', requireAdmin, asyncHandler(async (req, res) => {
  const { uid } = req.params;
  const { suspended, reason } = req.body;

  if (suspended) {
    await adminAuth.updateUser(uid, { disabled: true });
    await db.collection('users').doc(uid).set({ suspended: true, suspendedReason: reason || null, suspendedAt: FieldValue.serverTimestamp() }, { merge: true });
    await pushNotification(uid, { type: 'account_suspended', message: 'Your account has been suspended. Contact support for assistance.' });
  } else {
    await adminAuth.updateUser(uid, { disabled: false });
    await db.collection('users').doc(uid).set({ suspended: false, unsuspendedAt: FieldValue.serverTimestamp() }, { merge: true });
    await pushNotification(uid, { type: 'account_restored', message: 'Your account has been restored. Welcome back!' });
  }

  res.json({ success: true, suspended });
}));

// ----------------------------
// ADMIN: EXPORT A USER'S DATA
// GET /api/admin/users/:uid/export
// Mirrors GET /api/account/export exactly, but admin-authorized —
// used to pull a full copy of a user's data on their behalf (e.g.
// responding to a data request, or as the required first step
// before an admin-initiated deletion below). Every export is logged
// via `log.info` with the requesting admin action noted, since
// pulling a user's full data is itself a sensitive action worth an
// audit trail even though it doesn't change anything.
// ----------------------------
router.get('/api/admin/users/:uid/export', requireAdmin, asyncHandler(async (req, res) => {
  const { uid } = req.params;

  let authUser = null;
  try {
    authUser = await adminAuth.getUser(uid);
  } catch {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  const [userSnap, goalsSnap, txSnap, notifSnap, autosaveSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('goals').where('uid', '==', uid).get(),
    db.collection('transactions').where('uid', '==', uid).limit(1000).get(),
    db.collection('notifications').where('uid', '==', uid).limit(500).get(),
    db.collection('autosave_rules').where('uid', '==', uid).get(),
  ]);

  const goals = []; goalsSnap.forEach(d => goals.push({ id: d.id, ...d.data() }));
  const transactions = []; txSnap.forEach(d => transactions.push({ id: d.id, ...d.data() }));
  const notifications = []; notifSnap.forEach(d => notifications.push({ id: d.id, ...d.data() }));
  const autosaveRules = []; autosaveSnap.forEach(d => autosaveRules.push({ id: d.id, ...d.data() }));

  log.info('Admin exported user data', { uid, exportedVia: 'admin' });

  res.setHeader('Content-Disposition', `attachment; filename="pocketvault-data-export-${uid}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    exportedByAdmin: true,
    authAccount: { email: authUser.email, displayName: authUser.displayName || null, createdAt: authUser.metadata?.creationTime || null },
    profile: userSnap.data() || {},
    goals, transactions, notifications, autosaveRules
  });
}));

// ----------------------------
// ADMIN: DELETE A USER'S ACCOUNT
// POST /api/admin/users/:uid/delete
// Same shape as the user's own POST /api/account/delete — disables
// login, anonymizes PII on the users doc, deletes notifications and
// autosave rules, but DELIBERATELY RETAINS transactions, platform_fees,
// and goals (financial record-keeping — see the note on the
// user-facing endpoint for the reasoning). The one difference from
// the self-service version: this requires a `reason` for the audit
// trail, and it's logged distinctly from a user closing their own
// account so the two are never confused when reviewing history.
// Body: { confirmation: "DELETE", reason: string }
// ----------------------------
router.post('/api/admin/users/:uid/delete', requireAdmin, asyncHandler(async (req, res) => {
  const { uid } = req.params;
  const { confirmation, reason } = req.body;

  if (confirmation !== 'DELETE') {
    return res.status(400).json({ success: false, error: 'Send { confirmation: "DELETE", reason: "..." } to confirm account closure' });
  }
  if (!reason?.trim()) {
    return res.status(400).json({ success: false, error: 'A reason is required for admin-initiated account deletion' });
  }

  let authUser = null;
  try {
    authUser = await adminAuth.getUser(uid);
  } catch {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  await adminAuth.updateUser(uid, { disabled: true }).catch(() => {});

  // Admin-initiated deletion disables Firebase Auth login immediately
  // (unlike self-service deletion — see the note on POST
  // /api/account/delete for why that one deliberately doesn't), since
  // there's no "did the user come back and sign in" recovery signal
  // to wait for here. Still gets the same purgeDeadline for the
  // unresolved-funds sweep, and can still be restored by an admin
  // via POST /api/admin/users/:uid/restore within that window.
  const now = Date.now();
  await db.collection('users').doc(uid).set({
    name: null, phone: null, kycName: null,
    email: `deleted-${uid.slice(0, 8)}@pocketvault.mw`,
    accountDeleted: true,
    deletedAt: FieldValue.serverTimestamp(),
    deletedAtMillis: now,
    purgeDeadline: now + 60 * 24 * 60 * 60 * 1000,
    deletedByAdmin: true,
    deletionReason: reason.trim(),
    suspended: true,
    otpHash: null, pendingPhone: null, referredBy: null
  }, { merge: true });

  const [notifSnap, autosaveSnap] = await Promise.all([
    db.collection('notifications').where('uid', '==', uid).get(),
    db.collection('autosave_rules').where('uid', '==', uid).get(),
  ]);
  const batch = db.batch();
  notifSnap.forEach(d => batch.delete(d.ref));
  autosaveSnap.forEach(d => batch.delete(d.ref));
  await batch.commit();

  clearCache(`plan_${uid}`, `profile_${uid}`, `goals_${uid}`, `analytics_${uid}`);
  log.info('Account deleted by admin', { uid, reason: reason.trim(), originalEmail: authUser.email });

  res.json({ success: true, message: 'Account closed by admin. Transaction records are retained as required for financial record-keeping, with personal details removed.' });
}));

// ----------------------------
// ADMIN: RESTORE A DELETED ACCOUNT
// POST /api/admin/users/:uid/restore
// Covers the day-30-to-60 recovery window — past the point where a
// user's own sign-in auto-reactivates their account (see requireAuth
// in core/middleware.js), an admin can still bring it back manually
// up until the day-60 purge/sweep. After day 60, sweepUnresolvedFunds()
// (jobs.js) has already moved any remaining balance out to
// unresolved_funds, so restoring past that point brings the account
// back with a zero balance — the swept amount would need to be
// resolved separately via the unresolved_funds ledger, not silently
// re-credited here.
// ----------------------------
router.post('/api/admin/users/:uid/restore', requireAdmin, asyncHandler(async (req, res) => {
  const { uid } = req.params;

  let authUser = null;
  try {
    authUser = await adminAuth.getUser(uid);
  } catch {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  const userSnap = await db.collection('users').doc(uid).get();
  const userData = userSnap.data();
  if (!userData?.accountDeleted) {
    return res.status(400).json({ success: false, error: 'This account is not currently deleted' });
  }

  await adminAuth.updateUser(uid, { disabled: false }).catch(() => {});
  await db.collection('users').doc(uid).set({
    accountDeleted: false,
    suspended: false,
    deletedAt: null,
    deletedAtMillis: null,
    autoRecoveryDeadline: null,
    purgeDeadline: null,
    deletedByAdmin: null,
    deletionReason: null,
    restoredByAdmin: true,
    restoredAt: FieldValue.serverTimestamp()
  }, { merge: true });

  clearCache(`plan_${uid}`, `profile_${uid}`, `goals_${uid}`, `analytics_${uid}`);
  log.info('Account restored by admin', { uid, email: authUser.email });

  res.json({ success: true, message: 'Account restored. Note: if funds were already swept to unresolved_funds (past day 60), check the Unresolved Funds ledger to resolve them separately.' });
}));

// ----------------------------
// ADMIN: CUSTOMER CARE — SUPPORT QUEUE
// GET /api/admin/support/threads
// All threads, filterable by mode/status. Chat threads sort first
// within an equal status — chat implies the user expects an admin
// present right now, so those should surface above tickets of the
// same status at a glance.
// ----------------------------
router.get('/api/admin/support/threads', requireAdmin, asyncHandler(async (req, res) => {
  const { mode, status } = req.query;
  const snap = await db.collection('support_threads').limit(500).get();
  let threads = [];
  snap.forEach(d => threads.push({ id: d.id, ...d.data() }));

  if (mode) threads = threads.filter(t => t.mode === mode);
  if (status) threads = threads.filter(t => t.status === status);

  threads.sort((a, b) => {
    // Open chat threads first, then open tickets, then in_progress,
    // then resolved — each group sorted newest-message-first within
    // itself.
    const rank = t => t.status === 'resolved' ? 3 : t.status === 'in_progress' ? 2 : t.mode === 'chat' ? 0 : 1;
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    return toMillis(b.lastMessageAt) - toMillis(a.lastMessageAt);
  });

  res.json({ success: true, threads });
}));

// ----------------------------
// ADMIN: GET ONE SUPPORT THREAD
// GET /api/admin/support/threads/:threadId
// ----------------------------
router.get('/api/admin/support/threads/:threadId', requireAdmin, asyncHandler(async (req, res) => {
  const doc = await db.collection('support_threads').doc(req.params.threadId).get();
  if (!doc.exists) return res.status(404).json({ success: false, error: 'Thread not found' });
  res.json({ success: true, thread: { id: doc.id, ...doc.data() } });
}));

// ----------------------------
// ADMIN: REPLY TO A SUPPORT THREAD
// POST /api/admin/support/threads/:threadId/messages
// Replying auto-transitions status to 'in_progress' if it was 'open'
// — a reply is itself the signal that someone is now handling it.
// ----------------------------
router.post('/api/admin/support/threads/:threadId/messages', requireAdmin, asyncHandler(async (req, res) => {
  const { threadId } = req.params;
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ success: false, error: 'message is required' });

  const ref = db.collection('support_threads').doc(threadId);
  const doc = await ref.get();
  const thread = doc.data();
  if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

  await ref.update({
    messages: FieldValue.arrayUnion({ from: 'admin', text: message.trim(), at: Date.now() }),
    lastMessageAt: FieldValue.serverTimestamp(),
    lastMessageFrom: 'admin',
    status: thread.status === 'open' ? 'in_progress' : thread.status
  });

  await pushNotification(thread.uid, {
    type: 'support_reply',
    message: `💬 Support replied to your ${thread.mode === 'chat' ? 'chat' : 'ticket'}: "${message.trim().slice(0, 80)}${message.trim().length > 80 ? '…' : ''}"`
  });

  res.json({ success: true });
}));

// ----------------------------
// ADMIN: UPDATE SUPPORT THREAD STATUS
// PATCH /api/admin/support/threads/:threadId
// Body: { status: 'open' | 'in_progress' | 'resolved' }
// ----------------------------
router.patch('/api/admin/support/threads/:threadId', requireAdmin, asyncHandler(async (req, res) => {
  const { threadId } = req.params;
  const { status } = req.body;
  if (!['open', 'in_progress', 'resolved'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }
  await db.collection('support_threads').doc(threadId).update({
    status,
    resolvedAt: status === 'resolved' ? FieldValue.serverTimestamp() : null
  });
  res.json({ success: true });
}));


export default router;
