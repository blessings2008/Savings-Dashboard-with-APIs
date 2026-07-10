import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { readFileSync, existsSync } from 'fs';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import crypto from 'crypto';
// Note: fetch() is native in Node 20+, used below for Anthropic API calls

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ----------------------------
// FIREBASE ADMIN INIT
// ----------------------------
let firebaseCredential;

const SECRET_FILE_PATH = '/etc/secrets/serviceAccountKey.json';
const LOCAL_FILE_PATH = './serviceAccountKey.json';

// ----------------------------
// DEBUG: Show what credential sources are available
// ----------------------------
console.log('🔍 Checking Firebase credential sources:');
console.log('   /etc/secrets/serviceAccountKey.json exists:', existsSync(SECRET_FILE_PATH));
console.log('   ./serviceAccountKey.json exists:', existsSync(LOCAL_FILE_PATH));
console.log('   GOOGLE_APPLICATION_CREDENTIALS_JSON set:', !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
console.log('   FIREBASE_PROJECT_ID set:', !!process.env.FIREBASE_PROJECT_ID, process.env.FIREBASE_PROJECT_ID || '');
console.log('   FIREBASE_CLIENT_EMAIL set:', !!process.env.FIREBASE_CLIENT_EMAIL);
console.log('   FIREBASE_PRIVATE_KEY set:', !!process.env.FIREBASE_PRIVATE_KEY);
console.log('   FIREBASE_PRIVATE_KEY length:', (process.env.FIREBASE_PRIVATE_KEY || '').length);

// List what's actually in /etc/secrets if it exists
try {
  if (existsSync('/etc/secrets')) {
    const fs = await import('fs');
    const files = fs.readdirSync('/etc/secrets');
    console.log('   Files in /etc/secrets:', files);
  } else {
    console.log('   /etc/secrets directory does not exist');
  }
} catch (e) {
  console.log('   Could not read /etc/secrets:', e.message);
}

if (existsSync(SECRET_FILE_PATH)) {
  const raw = readFileSync(SECRET_FILE_PATH, 'utf8');
  const serviceAccount = JSON.parse(raw);
  console.log('   Loaded keys from secret file:', Object.keys(serviceAccount));
  if (!serviceAccount.private_key) {
    console.error('❌ Secret file is missing private_key field');
    process.exit(1);
  }
  firebaseCredential = cert(serviceAccount);
  console.log('✅ Firebase loaded from Render secret file');
} else if (existsSync(LOCAL_FILE_PATH)) {
  const serviceAccount = JSON.parse(readFileSync(LOCAL_FILE_PATH, 'utf8'));
  firebaseCredential = cert(serviceAccount);
  console.log('✅ Firebase loaded from local file');
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    console.log('   Loaded keys from env JSON:', Object.keys(serviceAccount));
    if (!serviceAccount.private_key) throw new Error('private_key missing from JSON');
    firebaseCredential = cert(serviceAccount);
    console.log('✅ Firebase loaded from env JSON');
  } catch (e) {
    console.error('❌ Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON:', e.message);
    process.exit(1);
  }
} else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
  firebaseCredential = cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  console.log('✅ Firebase loaded from individual env vars');
} else {
  console.error('❌ No valid Firebase credentials found.');
  console.error('   Either add a Secret File named "serviceAccountKey.json" on Render,');
  console.error('   or set FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY env vars.');
  process.exit(1);
}

initializeApp({ credential: firebaseCredential });
const db = getFirestore();
const adminAuth = getAuth();

// ----------------------------
// AIRTEL CONFIG
// ----------------------------
const AIRTEL = {
  BASE_URL: 'https://openapi.airtel.africa',
  CLIENT_ID: process.env.AIRTEL_CLIENT_ID,
  CLIENT_SECRET: process.env.AIRTEL_CLIENT_SECRET,
  PIN: process.env.AIRTEL_PIN,
  COUNTRY: 'MW',
  CURRENCY: 'MWK'
};

// ----------------------------
// PAYCHANGU CONFIGURATION
// PayChangu is an RBM-licensed Malawian payment aggregator that
// already supports Airtel Money AND TNM Mpamba collections/payouts
// today, without needing Airtel's own direct-API approval. Used as
// a bridge while waiting on that approval — see PAYMENT_PROVIDER
// below for how the two coexist.
// ----------------------------
const PAYCHANGU = {
  BASE_URL: 'https://api.paychangu.com',
  SECRET_KEY: process.env.PAYCHANGU_SECRET_KEY || null,
  WEBHOOK_SECRET: process.env.PAYCHANGU_WEBHOOK_SECRET || null,
  CURRENCY: 'MWK',
  // Mobile money operator reference IDs — PayChangu requires these
  // instead of accepting a raw phone number directly. Fetched once
  // via their "Get Operator ID" endpoint and cached here; if either
  // is ever null, resolveOperatorId() falls back to fetching fresh.
  operatorIds: { airtel: null, tnm: null }
};

// ----------------------------
// PAYMENT PROVIDER SELECTION
// Mirrors the exact same pattern used for AI_PROVIDER (Anthropic /
// Gemini / Groq) — one env var picks which payment rail is active,
// every call site in the app stays completely unchanged either way.
//
// 'airtel_direct' -> calls Airtel's Open API directly (needs Airtel's
//                    own merchant approval, which may take a while)
// 'paychangu'      -> routes through PayChangu instead (already live,
//                    covers both Airtel Money and TNM Mpamba, small
//                    per-transaction fee on top of your own platform fee)
//
// If PAYMENT_PROVIDER isn't set, auto-picks whichever is configured —
// Airtel direct first (since it's cheaper once approved), PayChangu
// as the fallback bridge.
// ----------------------------
function resolvePaymentProvider() {
  const explicit = (process.env.PAYMENT_PROVIDER || '').toLowerCase();
  if (explicit === 'airtel_direct' && AIRTEL.CLIENT_ID) return 'airtel_direct';
  if (explicit === 'paychangu' && PAYCHANGU.SECRET_KEY) return 'paychangu';
  if (AIRTEL.CLIENT_ID) return 'airtel_direct';
  if (PAYCHANGU.SECRET_KEY) return 'paychangu';
  return 'mock';
}

// True when NEITHER payment provider is configured — the app-wide
// signal for "behave as instant-success mock mode", used everywhere
// that previously checked `!AIRTEL.CLIENT_ID` directly. Replacing
// those checks with this function is what lets PayChangu (or any
// future provider) take over real payment processing without
// leaving the app stuck thinking it's still in mock mode.
function isMockMode() {
  return resolvePaymentProvider() === 'mock';
}


// ----------------------------
// PLANS & PRICING
// ----------------------------
const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    maxGoals: 2,
    maxAutoRules: 0,
    analytics: false,
    merchant: false,
    roundUp: false,
    aiInsights: false,
    savingsLock: false,
    transactionFeePercent: 1,
    withdrawalFeePercent: 1
  },
  pro: {
    name: 'Pro',
    price: 2500,
    maxGoals: 20,
    maxAutoRules: 10,
    analytics: true,
    merchant: false,
    roundUp: true,
    aiInsights: true,
    savingsLock: true,
    transactionFeePercent: 0.75, // discounted fee for pro
    withdrawalFeePercent: 0.75
  },
  business: {
    name: 'Business',
    price: 8000,
    maxGoals: 100,
    maxAutoRules: 50,
    analytics: true,
    merchant: true,
    roundUp: true,
    aiInsights: true,
    savingsLock: true,
    transactionFeePercent: 0.5, // best rate for business
    withdrawalFeePercent: 0.5
  }
};

// ----------------------------
// SECURITY CONFIG
// ----------------------------
const SECURITY = {
  MAX_SAVE_AMOUNT: 5000000,
  MIN_SAVE_AMOUNT: 100,
  AIRTEL_WEBHOOK_SECRET: process.env.AIRTEL_WEBHOOK_SECRET || null
};

const FLOAT_THRESHOLD = parseInt(process.env.FLOAT_THRESHOLD) || 50000;

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
  GROQ_MODEL: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
};

// Resolve which provider is actually active right now
function resolveAIProvider() {
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
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  });
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: maxTokens }
    })
  });
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
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
  });
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

  const totalRevenue = fees.reduce((s, f) => s + (f.amount || 0), 0);
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
    totalFeesGenerated: fees.reduce((s, f) => s + (f.amount || 0), 0),
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
    const amt = f.amount || 0;
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
      await logAIAction('change_user_plan', { uid, plan }, adminMeta);
      return { uid, plan };
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

// ----------------------------
// CACHE
// ----------------------------
const cache = new Map();

function getCached(key, fetchFn, ttlMs = 30000) {
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiry) return Promise.resolve(cached.data);
  return fetchFn().then(data => {
    cache.set(key, { data, expiry: Date.now() + ttlMs });
    return data;
  });
}

function clearCache(...keys) {
  keys.forEach(k => cache.delete(k));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of cache.entries()) {
    if (now > val.expiry) cache.delete(key);
  }
}, 5 * 60 * 1000);

// ----------------------------
// AIRTEL QUEUE
// ----------------------------
const airtelQueue = [];
let airtelProcessing = false;

function queueAirtelCall(task) {
  return new Promise((resolve, reject) => {
    airtelQueue.push({ task, resolve, reject });
    processAirtelQueue();
  });
}

async function processAirtelQueue() {
  if (airtelProcessing || airtelQueue.length === 0) return;
  airtelProcessing = true;
  const { task, resolve, reject } = airtelQueue.shift();
  try { resolve(await task()); }
  catch (err) { reject(err); }
  finally {
    airtelProcessing = false;
    setTimeout(processAirtelQueue, 200);
  }
}

// ----------------------------
// ASYNC HANDLER
// ----------------------------
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ----------------------------
// RATE LIMITER
// ----------------------------
const rateLimitMap = new Map();

function rateLimit(maxRequests = 100, windowMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const record = rateLimitMap.get(key) || { count: 0, start: now };
    if (now - record.start > windowMs) { record.count = 1; record.start = now; }
    else record.count++;
    rateLimitMap.set(key, record);
    if (record.count > maxRequests) {
      return res.status(429).json({ success: false, error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now - val.start > 15 * 60 * 1000) rateLimitMap.delete(key);
  }
}, 15 * 60 * 1000);

// ----------------------------
// AUTH MIDDLEWARE
// ----------------------------
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const decoded = await adminAuth.verifyIdToken(authHeader.split('Bearer ')[1]);
    req.user = { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified };
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Unauthorized - invalid token' });
  }
}

function requireOwnData(req, res, next) {
  const requestedUid = req.body.uid || req.query.uid || req.params.uid;
  if (!requestedUid) return res.status(400).json({ success: false, error: 'uid required' });
  if (req.user.uid !== requestedUid) {
    console.warn(`🚨 UID MISMATCH: token=${req.user.uid} requested=${requestedUid}`);
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  next();
}

// ----------------------------
// ADMIN AUTH MIDDLEWARE
// Separate from user auth — checks a shared secret header.
// Not a Firebase login; only the founder holds this secret.
// ----------------------------
// ----------------------------
// CONSTANT-TIME STRING COMPARISON
// Prevents timing side-channel attacks on secret comparisons
// (admin secret, webhook signatures). A plain !== comparison
// can leak timing information character-by-character.
// ----------------------------
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a.padEnd(256));
  const bufB = Buffer.from(b.padEnd(256));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB) && a === b;
}

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET) {
    return res.status(503).json({ success: false, error: 'Admin access not configured' });
  }
  if (!secret || !safeCompare(secret, process.env.ADMIN_SECRET)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ----------------------------
// INPUT SANITIZER
// ----------------------------
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>'"`;]/g, '').trim().slice(0, 500);
}

function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') req.body[key] = sanitize(req.body[key]);
    }
  }
  next();
}

// ----------------------------
// PLAN HELPERS
// ----------------------------
async function getUserPlan(uid) {
  return getCached(`plan_${uid}`, async () => {
    const snap = await db.collection('users').doc(uid).get();
    const plan = snap.data()?.plan || 'free';
    return PLANS[plan] ? plan : 'free';
  }, 60000);
}

async function getPlanConfig(uid) {
  const plan = await getUserPlan(uid);
  return { plan, config: PLANS[plan] };
}

function requirePlan(...allowedPlans) {
  return asyncHandler(async (req, res, next) => {
    const uid = req.user.uid;
    const plan = await getUserPlan(uid);
    if (!allowedPlans.includes(plan)) {
      return res.status(403).json({
        success: false,
        error: `This feature requires ${allowedPlans.join(' or ')} plan`,
        currentPlan: plan,
        upgrade: true
      });
    }
    next();
  });
}

// ----------------------------
// AIRTEL TOKEN
// ----------------------------
let _token = null;
let _tokenExpiry = null;
let _tokenRefreshing = false;

async function getAirtelToken() {
  if (_token && _tokenExpiry && Date.now() < _tokenExpiry - 300000) return _token;
  if (_tokenRefreshing) {
    await new Promise(r => setTimeout(r, 500));
    return getAirtelToken();
  }
  _tokenRefreshing = true;
  try {
    const res = await fetch(`${AIRTEL.BASE_URL}/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: AIRTEL.CLIENT_ID,
        client_secret: AIRTEL.CLIENT_SECRET,
        grant_type: 'client_credentials'
      })
    });
    const data = await res.json();
    if (!data.access_token) throw new Error('No token: ' + JSON.stringify(data));
    _token = data.access_token;
    _tokenExpiry = Date.now() + (data.expires_in || 7200) * 1000;
    console.log('✅ Airtel token refreshed');
    return _token;
  } catch (err) {
    console.error('❌ Token error:', err.message);
    throw err;
  } finally {
    _tokenRefreshing = false;
  }
}

// ----------------------------
// AIRTEL DIRECT API CALLS (private — routed to via public functions below)
// ----------------------------
async function _airtelBalanceDirect(type = 'COLL') {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const res = await fetch(`${AIRTEL.BASE_URL}/standard/v2/users/balance/${type}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': AIRTEL.COUNTRY,
        'X-Currency': AIRTEL.CURRENCY,
        Accept: '*/*'
      }
    });
    return res.json();
  });
}

async function _airtelCollectDirect({ phone, amount, reference }) {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const txnId = `COLL_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const res = await fetch(`${AIRTEL.BASE_URL}/merchant/v2/payments/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': AIRTEL.COUNTRY,
        'X-Currency': AIRTEL.CURRENCY,
        'Content-Type': 'application/json',
        Accept: '*/*'
      },
      body: JSON.stringify({
        reference,
        subscriber: { country: AIRTEL.COUNTRY, currency: AIRTEL.CURRENCY, msisdn: phone },
        transaction: { amount, country: AIRTEL.COUNTRY, currency: AIRTEL.CURRENCY, id: txnId }
      })
    });
    return { ...(await res.json()), txnId, _provider: 'airtel_direct' };
  });
}

async function _airtelDisburseDirect({ phone, amount, reference }) {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const txnId = `DISB_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const res = await fetch(`${AIRTEL.BASE_URL}/standard/v2/disbursements/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': AIRTEL.COUNTRY,
        'X-Currency': AIRTEL.CURRENCY,
        'Content-Type': 'application/json',
        Accept: '*/*'
      },
      body: JSON.stringify({
        payee: { msisdn: phone },
        reference,
        pin: AIRTEL.PIN,
        transaction: { amount, id: txnId }
      })
    });
    return { ...(await res.json()), txnId, _provider: 'airtel_direct' };
  });
}

async function _airtelKYCDirect(phone) {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const res = await fetch(`${AIRTEL.BASE_URL}/standard/v2/users/${phone}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': AIRTEL.COUNTRY,
        'X-Currency': AIRTEL.CURRENCY,
        Accept: '*/*'
      }
    });
    return res.json();
  });
}

async function _airtelTransactionStatusDirect(reference) {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const res = await fetch(`${AIRTEL.BASE_URL}/standard/v2/payments/${reference}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': AIRTEL.COUNTRY,
        'X-Currency': AIRTEL.CURRENCY,
        Accept: '*/*'
      }
    });
    return res.json();
  });
}

// ----------------------------
// AIRTEL TRANSACTION SUMMARY
// Airtel-direct-only capability — no equivalent exists on PayChangu,
// which only ever knows about transactions it processed on your
// behalf, not a user's whole wallet history. This is what makes it
// possible to react to REAL income arriving or REAL spending
// happening, instead of the declared-schedule/manual-report
// fallbacks used everywhere else in the app.
//
// Returns a normalized list regardless of Airtel's actual response
// shape, so callers (see checkTransactionSummaries() below) never
// need to know the raw API details — only { id, direction, amount,
// timestamp }. Exactly one place to update if Airtel's real response
// shape differs from what's assumed here once this is tested against
// live credentials.
// ----------------------------
async function airtelTransactionSummary(phone, { sinceMinutes = 30 } = {}) {
  if (resolvePaymentProvider() !== 'airtel_direct') return [];
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
    const res = await fetch(
      `${AIRTEL.BASE_URL}/standard/v1/users/${phone}/transactions?since=${encodeURIComponent(since)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Country': AIRTEL.COUNTRY,
          'X-Currency': AIRTEL.CURRENCY,
          Accept: '*/*'
        }
      }
    );
    const data = await res.json();
    const rawList = data?.data?.transactions || data?.transactions || [];
    return rawList.map(tx => ({
      id: tx.id || tx.transaction_id || tx.reference,
      direction: (tx.type === 'credit' || tx.direction === 'credit' || tx.amount > 0) ? 'credit' : 'debit',
      amount: Math.abs(parseFloat(tx.amount) || 0),
      timestamp: tx.timestamp || tx.date || new Date().toISOString()
    })).filter(tx => tx.id && tx.amount > 0);
  }).catch(err => {
    logSystemError('airtel_transaction_summary', err.message, { phone, stack: err.stack });
    return [];
  });
}

// ----------------------------
// PAYCHANGU API CALLS (private — routed to via public functions below)
// All requests authenticate with a single Bearer secret key (no
// separate OAuth token exchange needed, unlike Airtel direct).
// ----------------------------
function _paychanguHeaders() {
  return {
    Authorization: `Bearer ${PAYCHANGU.SECRET_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

// PayChangu requires a mobile_money_operator_ref_id instead of a raw
// phone number. Malawi phone prefixes: 08x/099 = Airtel, 089/098 = TNM.
// Cached after first lookup since operator IDs don't change.
function detectOperatorNetwork(phone) {
  const clean = (phone || '').replace(/^\+?265/, '0').replace(/\s/g, '');
  const prefix = clean.slice(0, 3);
  if (['088', '099'].includes(prefix)) return 'airtel';
  if (['089', '098'].includes(prefix)) return 'tnm';
  return 'airtel'; // default fallback — Airtel is the majority network
}

async function resolveOperatorId(network) {
  if (PAYCHANGU.operatorIds[network]) return PAYCHANGU.operatorIds[network];
  const res = await fetch(`${PAYCHANGU.BASE_URL}/mobile-money/operators`, {
    headers: _paychanguHeaders()
  });
  const data = await res.json();
  const operators = data?.data || [];
  const match = operators.find(op =>
    (op.name || '').toLowerCase().includes(network === 'airtel' ? 'airtel' : 'tnm')
  );
  if (match) PAYCHANGU.operatorIds[network] = match.ref_id;
  return match?.ref_id || null;
}

async function _paychanguBalance() {
  // PayChangu does not expose a merchant wallet balance endpoint the
  // same way Airtel does — balance/float visibility happens on their
  // own merchant dashboard instead. Returning a clearly-marked
  // unavailable response rather than pretending to have a number,
  // so callers (float monitor, /api/airtel/balance) can handle it
  // explicitly instead of silently showing a wrong figure.
  return { available: false, note: 'PayChangu does not provide a balance API — check the PayChangu merchant dashboard directly.' };
}

async function _paychanguCollect({ phone, amount, reference }) {
  const network = detectOperatorNetwork(phone);
  const operatorRefId = await resolveOperatorId(network);
  const res = await fetch(`${PAYCHANGU.BASE_URL}/mobile-money/payments/initialize`, {
    method: 'POST',
    headers: _paychanguHeaders(),
    body: JSON.stringify({
      mobile_money_operator_ref_id: operatorRefId,
      mobile: phone,
      amount,
      currency: PAYCHANGU.CURRENCY,
      charge_id: reference,
      email: `${phone}@pocketvault.mw` // PayChangu requires an email field even for mobile money
    })
  });
  const data = await res.json();
  return { ...data, txnId: data?.data?.trans_id || reference, _provider: 'paychangu' };
}

async function _paychanguDisburse({ phone, amount, reference }) {
  const network = detectOperatorNetwork(phone);
  const operatorRefId = await resolveOperatorId(network);
  const res = await fetch(`${PAYCHANGU.BASE_URL}/mobile-money/payouts/initialize`, {
    method: 'POST',
    headers: _paychanguHeaders(),
    body: JSON.stringify({
      mobile_money_operator_ref_id: operatorRefId,
      mobile: phone,
      amount,
      currency: PAYCHANGU.CURRENCY,
      charge_id: reference
    })
  });
  const data = await res.json();
  return { ...data, txnId: data?.data?.trans_id || reference, _provider: 'paychangu' };
}

async function _paychanguKYC(phone) {
  // PayChangu has no standalone identity/number-verification endpoint —
  // the only way to confirm a number is genuinely live is to actually
  // attempt a transaction against it. Returning a clear "not supported"
  // shape here rather than a fake success, so the caller (KYC verify-otp
  // endpoint) can fall back to trusting the OTP step alone, which is
  // independent of any payment provider and still proves phone ownership.
  return { _provider: 'paychangu', _unsupported: true };
}

async function _paychanguTransactionStatus(reference) {
  const res = await fetch(`${PAYCHANGU.BASE_URL}/mobile-money/payments/${reference}/verify`, {
    headers: _paychanguHeaders()
  });
  return res.json();
}

// ----------------------------
// PUBLIC PAYMENT FUNCTIONS — PROVIDER ROUTERS
// Every call site elsewhere in this file uses these five function
// names and isAirtelSuccess() exactly as before. Nothing about how
// /api/save, /api/withdraw, /api/roundup, /api/merchant/*, the
// reconciliation job, the float monitor, or the autosave job call
// these functions changes — only what happens INSIDE them, based on
// resolvePaymentProvider(). This is what makes PayChangu a true
// drop-in bridge rather than a parallel rebuild.
// ----------------------------
async function airtelBalance(type = 'COLL') {
  const provider = resolvePaymentProvider();
  if (provider === 'paychangu') return _paychanguBalance();
  if (provider === 'airtel_direct') return _airtelBalanceDirect(type);
  return { mock: true };
}

async function airtelCollect({ phone, amount, reference }) {
  const provider = resolvePaymentProvider();
  if (provider === 'paychangu') return _paychanguCollect({ phone, amount, reference });
  if (provider === 'airtel_direct') return _airtelCollectDirect({ phone, amount, reference });
  return { mock: true, _provider: 'mock' };
}

async function airtelDisburse({ phone, amount, reference }) {
  const provider = resolvePaymentProvider();
  if (provider === 'paychangu') return _paychanguDisburse({ phone, amount, reference });
  if (provider === 'airtel_direct') return _airtelDisburseDirect({ phone, amount, reference });
  return { mock: true, _provider: 'mock' };
}

async function airtelKYC(phone) {
  const provider = resolvePaymentProvider();
  if (provider === 'paychangu') return _paychanguKYC(phone);
  if (provider === 'airtel_direct') return _airtelKYCDirect(phone);
  return { mock: true };
}

async function airtelTransactionStatus(reference) {
  const provider = resolvePaymentProvider();
  if (provider === 'paychangu') return _paychanguTransactionStatus(reference);
  if (provider === 'airtel_direct') return _airtelTransactionStatusDirect(reference);
  return { mock: true, status: 'completed' };
}

// ----------------------------
// HELPERS
// ----------------------------
function generateRef() {
  return `SPR_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function calcFee(amount, percent) {
  return Math.ceil(amount * (percent / 100));
}

// ----------------------------
// SAFE AMOUNT PARSER
// parseFloat() lets NaN silently slip past min/max range checks
// (NaN < 100 and NaN > 5000000 both evaluate to false in JS),
// which would let a malformed amount like "abc" bypass validation
// entirely. This helper returns null for anything that isn't a
// genuine finite positive number, so callers can reject it
// explicitly with a clear error instead of let it slip through.
// ----------------------------
function parseAmount(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts === 'number') return ts;
  if (ts._seconds) return ts._seconds * 1000;
  return new Date(ts).getTime() || 0;
}

// ----------------------------
// ISO WEEK NUMBER
// Returns "YYYY-Www" e.g. "2026-W27". Used to compare whether a
// save happened in "this week" vs "last week" vs "further back",
// independent of which day of the week the user actually saves on.
// ----------------------------
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function weeksBetween(weekKeyA, weekKeyB) {
  // Rough-but-reliable: parse "YYYY-Www" back to an approximate date
  // and diff in weeks. Good enough for streak comparison purposes —
  // we only care whether it's 0, 1, or 2+ weeks apart.
  const parse = (wk) => {
    const [y, w] = wk.split('-W').map(Number);
    const jan1 = new Date(Date.UTC(y, 0, 1));
    return new Date(jan1.getTime() + (w - 1) * 7 * 86400000);
  };
  const diffMs = Math.abs(parse(weekKeyB) - parse(weekKeyA));
  return Math.round(diffMs / (7 * 86400000));
}

// ----------------------------
// SAVINGS STREAK
// Called after every successful save. Tracks consecutive WEEKS
// (not days, not logins) in which the user made at least one real
// save — this rewards the actual desired behavior rather than app
// engagement for its own sake. Deliberately not shown as a
// leaderboard anywhere — streaks are personal, not comparative.
// ----------------------------
async function updateSavingsStreak(uid) {
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const user = userSnap.data() || {};

  const thisWeek = isoWeekKey(new Date());
  const lastWeek = user.lastSaveWeek || null;

  let newStreak;
  if (!lastWeek) {
    newStreak = 1;
  } else if (lastWeek === thisWeek) {
    // Already saved this week — streak doesn't change, just confirms it's alive
    newStreak = user.streakCount || 1;
  } else {
    const gap = weeksBetween(lastWeek, thisWeek);
    newStreak = gap === 1 ? (user.streakCount || 0) + 1 : 1;
  }

  const longestStreak = Math.max(newStreak, user.longestStreak || 0);
  const isNewMilestone = [4, 8, 12, 26, 52].includes(newStreak) && newStreak !== (user.streakCount || 0);

  await userRef.set({
    streakCount: newStreak,
    longestStreak,
    lastSaveWeek: thisWeek,
    lastSaveAt: FieldValue.serverTimestamp()
  }, { merge: true });

  if (isNewMilestone) {
    await pushNotification(uid, {
      type: 'streak_milestone',
      message: `🔥 ${newStreak}-week savings streak! You've saved something every week for ${newStreak} weeks straight. Keep it going!`
    });
  }

  return { streakCount: newStreak, longestStreak, isNewMilestone };
}

// ----------------------------
// GOAL MILESTONE CELEBRATION
// Called after every successful save. Checks whether this save
// pushed the goal across a 25/50/75/100% threshold it hadn't
// crossed before, and fires a celebratory notification if so.
// Deliberately separate from the routine "you saved X" notification
// so milestone moments feel distinct rather than same-as-always.
// ----------------------------
async function checkGoalMilestone(uid, goalBefore, goalAfter) {
  if (!goalBefore || !goalAfter || goalAfter.target <= 0) return null;
  const pctBefore = Math.floor((goalBefore.saved / goalAfter.target) * 100);
  const pctAfter = Math.floor((goalAfter.saved / goalAfter.target) * 100);

  const thresholds = [25, 50, 75, 100];
  const crossed = thresholds.find(t => pctBefore < t && pctAfter >= t);
  if (!crossed) return null;

  const messages = {
    25: `🌱 ${goalAfter.name} is 25% funded — off to a solid start!`,
    50: `⭐ ${goalAfter.name} is halfway there! MWK ${(goalAfter.target - goalAfter.saved).toLocaleString()} to go.`,
    75: `🚀 ${goalAfter.name} is 75% funded — almost at the finish line!`,
    100: `🎉 ${goalAfter.name} is fully funded! Goal complete!`
  };

  await pushNotification(uid, { type: 'goal_milestone', message: messages[crossed] });
  return { milestone: crossed };
}

// ----------------------------
// REFERRAL COMPLETION CHECK
// Called after every successful save. A referral only pays out once
// the REFERRED user has (a) verified KYC and (b) completed their
// first real save — tying the reward to genuine Airtel-verified
// activity rather than just signing up, which is the main defense
// against fake-account farming of the bonus.
// ----------------------------
const REFERRAL_BONUS_MWK = 500;

async function checkReferralCompletion(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.data();
  if (!user?.referredBy) return null; // this user wasn't referred by anyone

  const referralSnap = await db.collection('referrals')
    .where('referredUid', '==', uid)
    .where('status', '==', 'pending')
    .limit(1).get();
  if (referralSnap.empty) return null; // already completed, or no matching record

  const referralDoc = referralSnap.docs[0];
  const referral = referralDoc.data();

  const isVerified = user.kycStatus === 'verified' || user.kycStatus === 'mock_verified';
  if (!isVerified) return null; // wait until KYC is done too

  // This is genuinely the referred user's first completed save AND they're verified — pay out both sides
  const referrerId = referral.referrerUid;

  await referralDoc.ref.update({
    status: 'completed',
    completedAt: FieldValue.serverTimestamp(),
    bonusAmount: REFERRAL_BONUS_MWK
  });

  // Credit both users' default/first active goal if they have one, otherwise just log it
  // as unassigned bonus balance they can see and manually apply.
  async function creditBonus(targetUid) {
    const goalsSnap = await db.collection('goals')
      .where('uid', '==', targetUid)
      .where('completed', '==', false)
      .limit(1).get();
    if (!goalsSnap.empty) {
      const goalDoc = goalsSnap.docs[0];
      await goalDoc.ref.update({
        saved: FieldValue.increment(REFERRAL_BONUS_MWK),
        lastUpdated: FieldValue.serverTimestamp()
      });
      await logTransaction(targetUid, {
        type: 'referral_bonus', amount: REFERRAL_BONUS_MWK, fee: 0, feePercent: 0,
        goalId: goalDoc.id, goalName: goalDoc.data().name,
        reference: generateRef(), status: 'completed'
      });
    } else {
      // No active goal yet — log as a standalone bonus transaction so it's
      // still visible in transaction history even with nowhere to deposit it
      await logTransaction(targetUid, {
        type: 'referral_bonus', amount: REFERRAL_BONUS_MWK, fee: 0, feePercent: 0,
        reference: generateRef(), status: 'completed', note: 'No active goal — create one to apply this bonus'
      });
    }
    await pushNotification(targetUid, {
      type: 'referral_bonus',
      message: `🎁 You earned a MWK ${REFERRAL_BONUS_MWK.toLocaleString()} referral bonus!`
    });
  }

  await creditBonus(referrerId);
  await creditBonus(uid);

  return { referrerId, referredUid: uid, bonusAmount: REFERRAL_BONUS_MWK };
}


// Handles both providers' response shapes. PayChangu can return
// "pending" on the initial call (the user hasn't approved the
// prompt on their phone yet) — that's deliberately NOT treated as
// success here, since crediting a goal before the money has actually
// moved would be wrong. A "pending" PayChangu response instead relies
// on the existing reconciliation job / webhook to confirm later,
// exactly the same pattern already used for delayed Airtel confirmations.
function isAirtelSuccess(result) {
  if (result?._provider === 'paychangu') {
    return result?.data?.status === 'success' || result?.status === 'success';
  }
  return (
    result?.status?.code === '200' ||
    result?.status?.success === true ||
    result?.data?.transaction?.status === 'TS'
  );
}

async function logTransaction(uid, data) {
  const ref = db.collection('transactions').doc();
  await ref.set({ ...data, uid, timestamp: FieldValue.serverTimestamp() });
  return ref.id;
}

async function logFee(uid, { amount, transactionId, type, plan }) {
  await db.collection('platform_fees').add({
    uid, amount, transactionId, type, plan,
    timestamp: FieldValue.serverTimestamp()
  });
}

async function pushNotification(uid, { type, message }) {
  await db.collection('notifications').add({
    uid, type, message,
    read: false,
    timestamp: FieldValue.serverTimestamp()
  });
}

async function updateGoalProgress(uid, goalId, amount) {
  const goalRef = db.collection('goals').doc(goalId);
  const snap = await goalRef.get();
  const goal = snap.data();
  if (!goal || goal.uid !== uid) return null;
  const newSaved = (goal.saved || 0) + amount;
  const completed = newSaved >= goal.target;
  await goalRef.update({ saved: newSaved, completed, lastUpdated: FieldValue.serverTimestamp() });
  return { ...goal, id: goalId, saved: newSaved, completed };
}

async function checkFloatSufficient(amount) {
  // Float/balance visibility only exists via Airtel's direct API —
  // PayChangu doesn't expose a merchant wallet balance endpoint (see
  // _paychanguBalance() above), so this check is intentionally
  // Airtel-direct-only and simply doesn't run under PayChangu.
  const cached = cache.get('corporate_float');
  const float = cached?.data || 0;
  if (resolvePaymentProvider() === 'airtel_direct' && float < amount + FLOAT_THRESHOLD) {
    throw new Error(`Insufficient float. Available: MWK ${float.toLocaleString()}`);
  }
  return float;
}

async function isAlreadyProcessed(airtelRef) {
  if (!airtelRef) return false;
  const snap = await db.collection('transactions')
    .where('airtelRef', '==', airtelRef)
    .limit(1).get();
  return !snap.empty;
}

// ----------------------------
// APP
// ----------------------------
const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.removeHeader('X-Powered-By');
  next();
});

app.use(cors({
  origin: [
    `https://${process.env.APP_DOMAIN || 'savings-dashboard-with-apis-2-0.onrender.com'}`,
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(sanitizeBody);
app.use(express.static(__dirname));
app.set('trust proxy', 1);

app.use('/api/', rateLimit(100, 15 * 60 * 1000));
app.use('/api/save', rateLimit(10, 60 * 1000));
app.use('/api/withdraw', rateLimit(5, 60 * 1000));
app.use('/api/subscribe', rateLimit(5, 60 * 1000));
app.use('/api/merchant/collect', rateLimit(20, 60 * 1000));
app.use('/api/merchant/disburse', rateLimit(20, 60 * 1000));
app.use('/api/kyc', rateLimit(5, 60 * 1000));

// ----------------------------
// HEALTH CHECK
// ----------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'PocketVault',
    version: '2.0',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    airtel: AIRTEL.CLIENT_ID ? 'configured' : 'pending_approval',
    paymentProvider: resolvePaymentProvider(),
    queue: airtelQueue.length,
    cache: cache.size,
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
  });
});

// ----------------------------
// PLANS: GET ALL PLANS
// GET /api/plans (public)
// ----------------------------
app.get('/api/plans', (req, res) => {
  res.json({ success: true, plans: PLANS });
});

// ----------------------------
// SUBSCRIPTION: SUBSCRIBE TO PLAN
// POST /api/subscribe
// Body: { uid, plan, phone }
// Flow: collect subscription fee via Airtel then upgrade plan
// ----------------------------
app.post('/api/subscribe',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, plan, phone } = req.body;

    if (!plan || !PLANS[plan]) {
      return res.status(400).json({ success: false, error: 'Invalid plan' });
    }
    if (plan === 'free') {
      // Downgrade to free — no payment needed
      await db.collection('users').doc(uid).set({
        plan: 'free',
        planUpdatedAt: FieldValue.serverTimestamp(),
        subscriptionActive: false
      }, { merge: true });
      clearCache(`plan_${uid}`);
      return res.json({ success: true, message: 'Downgraded to free plan' });
    }

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone required for payment' });
    }

    const planConfig = PLANS[plan];
    const reference = generateRef();

    // Mock mode
    if (isMockMode()) {
      await db.collection('users').doc(uid).set({
        plan,
        planUpdatedAt: FieldValue.serverTimestamp(),
        subscriptionActive: true,
        subscriptionExpiry: Date.now() + 30 * 24 * 60 * 60 * 1000,
        lastPaymentRef: reference
      }, { merge: true });

      await logTransaction(uid, {
        type: 'subscription',
        amount: planConfig.price,
        plan,
        reference,
        status: 'mock',
        phone
      });

      await db.collection('platform_fees').add({
        uid, type: 'subscription',
        amount: planConfig.price,
        plan,
        reference,
        timestamp: FieldValue.serverTimestamp()
      });

      await pushNotification(uid, {
        type: 'subscription_success',
        message: `🎉 Welcome to ${planConfig.name} plan! All features are now unlocked.`
      });

      clearCache(`plan_${uid}`);
      return res.json({
        success: true, mock: true,
        message: `Upgraded to ${planConfig.name} plan`,
        plan, reference
      });
    }

    // Real: collect subscription fee
    const result = await airtelCollect({
      phone,
      amount: planConfig.price,
      reference
    });

    if (isAirtelSuccess(result)) {
      const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

      await db.collection('users').doc(uid).set({
        plan,
        planUpdatedAt: FieldValue.serverTimestamp(),
        subscriptionActive: true,
        subscriptionExpiry: expiry,
        lastPaymentRef: reference
      }, { merge: true });

      await logTransaction(uid, {
        type: 'subscription',
        amount: planConfig.price,
        plan, reference,
        airtelTxnId: result.txnId,
        status: 'completed', phone
      });

      await db.collection('platform_fees').add({
        uid, type: 'subscription',
        amount: planConfig.price,
        plan, reference,
        airtelTxnId: result.txnId,
        timestamp: FieldValue.serverTimestamp()
      });

      await pushNotification(uid, {
        type: 'subscription_success',
        message: `🎉 Welcome to ${planConfig.name} plan! All features unlocked for 30 days.`
      });

      clearCache(`plan_${uid}`);
      res.json({
        success: true,
        message: `Upgraded to ${planConfig.name} plan`,
        plan, reference,
        expiry: new Date(expiry).toISOString()
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Payment failed. Please try again.',
        details: result
      });
    }
  })
);

// ----------------------------
// SUBSCRIPTION: CHECK STATUS
// GET /api/subscribe/status
// ----------------------------
app.get('/api/subscribe/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const snap = await db.collection('users').doc(uid).get();
    const user = snap.data() || {};
    const plan = user.plan || 'free';
    const config = PLANS[plan] || PLANS.free;

    // Check if subscription expired
    if (plan !== 'free' && user.subscriptionExpiry) {
      if (Date.now() > user.subscriptionExpiry) {
        // Auto downgrade
        await db.collection('users').doc(uid).set({
          plan: 'free',
          subscriptionActive: false
        }, { merge: true });
        clearCache(`plan_${uid}`);
        return res.json({
          success: true,
          plan: 'free',
          config: PLANS.free,
          expired: true,
          message: 'Your subscription has expired. You have been moved to the free plan.'
        });
      }
    }

    res.json({
      success: true,
      plan,
      config,
      subscriptionActive: user.subscriptionActive || plan === 'free',
      subscriptionExpiry: user.subscriptionExpiry || null,
      daysRemaining: user.subscriptionExpiry
        ? Math.max(0, Math.ceil((user.subscriptionExpiry - Date.now()) / (24 * 60 * 60 * 1000)))
        : null
    });
  })
);

// ----------------------------
// PROFILE: CREATE / UPDATE
// POST /api/profile
// ----------------------------
app.post('/api/profile',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, name, phone } = req.body;
    await db.collection('users').doc(uid).set({
      name: name || null,
      phone: phone || null,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    clearCache(`plan_${uid}`, `profile_${uid}`);
    res.json({ success: true });
  })
);

// ============================================================
// REFERRAL SYSTEM
// Flat MWK 500 bonus to both referrer and referred user, but only
// once the referred user has verified KYC AND completed their
// first real save (see checkReferralCompletion() above). Tying
// the payout to genuine Airtel-verified activity — not just
// signup — is the main defense against fake-account farming.
// ============================================================

// ----------------------------
// GET MY REFERRAL CODE + STATS
// GET /api/referrals/my-code
// The code is just the first 8 chars of the user's own UID —
// simple, unique by construction (Firebase UIDs are already
// unique), no separate code-generation or collision-checking needed.
// ----------------------------
app.get('/api/referrals/my-code', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const code = uid.slice(0, 8).toUpperCase();

  const [pendingSnap, completedSnap] = await Promise.all([
    db.collection('referrals').where('referrerUid', '==', uid).where('status', '==', 'pending').get(),
    db.collection('referrals').where('referrerUid', '==', uid).where('status', '==', 'completed').get(),
  ]);

  let totalEarned = 0;
  completedSnap.forEach(d => { totalEarned += d.data().bonusAmount || 0; });

  res.json({
    success: true,
    code,
    pendingReferrals: pendingSnap.size,
    completedReferrals: completedSnap.size,
    totalEarned,
    bonusAmount: REFERRAL_BONUS_MWK
  });
}));

// ----------------------------
// APPLY A REFERRAL CODE
// POST /api/referrals/apply
// Called once, right after account creation on the frontend.
// Body: { uid, code }
// ----------------------------
app.post('/api/referrals/apply',
  requireAuth,
  requireOwnData,
  rateLimit(5, 60 * 1000),
  asyncHandler(async (req, res) => {
    const { uid, code } = req.body;
    if (!code?.trim()) return res.status(400).json({ success: false, error: 'Referral code required' });

    const userSnap = await db.collection('users').doc(uid).get();
    const user = userSnap.data() || {};
    if (user.referredBy) {
      return res.status(400).json({ success: false, error: 'A referral code has already been applied to this account' });
    }

    // Find the referrer by matching the first 8 chars of their UID.
    // This requires a scan since Firestore can't query on a substring
    // of the document ID directly — acceptable at PocketVault's current
    // scale, and can be optimized later with a dedicated lookup
    // collection if the user base grows large enough to matter.
    const codeUpper = code.trim().toUpperCase();
    const usersSnap = await db.collection('users').limit(2000).get();
    let referrerUid = null;
    usersSnap.forEach(d => {
      if (d.id.slice(0, 8).toUpperCase() === codeUpper) referrerUid = d.id;
    });

    if (!referrerUid) return res.status(404).json({ success: false, error: 'Referral code not found' });
    if (referrerUid === uid) return res.status(400).json({ success: false, error: 'You cannot refer yourself' });

    await db.collection('users').doc(uid).set({ referredBy: referrerUid }, { merge: true });
    await db.collection('referrals').add({
      referrerUid, referredUid: uid,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: 'Referral code applied! Complete KYC and your first save to unlock both bonuses.' });
  })
);

// ----------------------------
// KYC STEP 1: SEND OTP
// POST /api/kyc/send-otp
// Body: { uid, phone }
// Generates a 6-digit OTP, stores it hashed in Firestore,
// and sends it via Airtel Collection USSD prompt (or notification in mock mode)
// ----------------------------
app.post('/api/kyc/send-otp',
  requireAuth,
  requireOwnData,
  rateLimit(5, 60 * 1000),
  asyncHandler(async (req, res) => {
    const { uid, phone } = req.body;
    const phoneClean = phone?.replace(/\s/g, '');
    const validPhone = /^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phoneClean);
    if (!validPhone) {
      return res.status(400).json({ success: false, error: 'Invalid Malawi phone number' });
    }

    // Check phone not already linked to another account
    const existing = await db.collection('users')
      .where('phone', '==', phoneClean)
      .where('phoneVerified', '==', true)
      .get();
    if (existing.docs.some(d => d.id !== uid)) {
      return res.status(400).json({ success: false, error: 'This number is already linked to another account' });
    }

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = crypto.createHash('sha256').update(otp + uid).digest('hex');
    const otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP hash (never store plaintext OTP)
    await db.collection('users').doc(uid).set({
      pendingPhone: phoneClean,
      otpHash,
      otpExpiry,
      otpAttempts: 0
    }, { merge: true });

    if (isMockMode()) {
      // Mock: push OTP as a notification so it can be seen in-app for testing
      await pushNotification(uid, {
        type: 'otp',
        topic: 'Phone Verification Code',
        message: `Your PocketVault verification code is: ${otp}. Valid for 10 minutes. Do not share this with anyone.`,
        senderName: 'PocketVault System',
        senderIcon: '🔐'
      });
      return res.json({
        success: true,
        mock: true,
        message: 'OTP sent to your Notifications (mock mode — check the bell icon)'
      });
    }

    // Real: In production, send OTP via SMS using Airtel's messaging or USSD
    // For now we use a notification push as Airtel SMS API is pending
    await pushNotification(uid, {
      type: 'otp',
      topic: 'Phone Verification Code',
      message: `Your PocketVault verification code is: ${otp}. Valid for 10 minutes. Do not share this with anyone.`,
      senderName: 'PocketVault System',
      senderIcon: '🔐'
    });

    res.json({ success: true, message: `Verification code sent to your notifications. Check the bell icon.` });
  })
);

// ----------------------------
// KYC STEP 2: VERIFY OTP
// POST /api/kyc/verify-otp
// Body: { uid, phone, otp }
// ----------------------------
app.post('/api/kyc/verify-otp',
  requireAuth,
  requireOwnData,
  rateLimit(10, 60 * 1000),
  asyncHandler(async (req, res) => {
    const { uid, phone, otp } = req.body;
    const phoneClean = phone?.replace(/\s/g, '');

    if (!otp || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ success: false, error: 'Enter the 6-digit code' });
    }

    const userSnap = await db.collection('users').doc(uid).get();
    const userData = userSnap.data() || {};

    // Check OTP exists and not expired
    if (!userData.otpHash || !userData.otpExpiry) {
      return res.status(400).json({ success: false, error: 'No OTP found. Please request a new code.' });
    }
    if (Date.now() > userData.otpExpiry) {
      return res.status(400).json({ success: false, error: 'Code expired. Please request a new one.' });
    }
    if (userData.pendingPhone !== phoneClean) {
      return res.status(400).json({ success: false, error: 'Phone number mismatch. Start verification again.' });
    }

    // Rate limit OTP attempts (max 5)
    const attempts = (userData.otpAttempts || 0) + 1;
    if (attempts > 5) {
      await db.collection('users').doc(uid).update({ otpHash: null, otpExpiry: null });
      return res.status(429).json({ success: false, error: 'Too many attempts. Request a new code.' });
    }
    await db.collection('users').doc(uid).update({ otpAttempts: attempts });

    // Verify hash
    const inputHash = crypto.createHash('sha256').update(otp + uid).digest('hex');
    if (inputHash !== userData.otpHash) {
      const remaining = 5 - attempts;
      return res.status(400).json({
        success: false,
        error: `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
      });
    }

    // OTP correct — now do additional provider-side verification if available.
    // The OTP step above already proves phone ownership regardless of
    // payment provider — this second check is an extra confirmation that
    // the number is specifically registered with Airtel Money, which is
    // only possible when talking to Airtel's API directly. PayChangu has
    // no equivalent lookup, so on that provider we rely on the OTP alone.
    let kycStatus = 'verified';
    let registeredName = null;

    const provider = resolvePaymentProvider();
    if (provider === 'airtel_direct') {
      const result = await airtelKYC(phoneClean);
      const verified = result?.data?.is_barred === false || result?.status?.code === '200';
      registeredName = result?.data?.first_name
        ? `${result.data.first_name} ${result.data.last_name || ''}`.trim()
        : null;
      kycStatus = verified ? 'verified' : 'failed';
    }
    // provider === 'paychangu' or 'mock' -> kycStatus stays 'verified'
    // based on the OTP check alone, since neither has a standalone
    // number-verification endpoint to double-check against.

    // Clear OTP, save verified phone
    await db.collection('users').doc(uid).set({
      phone: phoneClean,
      phoneVerified: kycStatus === 'verified',
      kycStatus,
      kycName: registeredName || null,
      kycAt: FieldValue.serverTimestamp(),
      pendingPhone: null,
      otpHash: null,
      otpExpiry: null,
      otpAttempts: null
    }, { merge: true });

    clearCache(`plan_${uid}`, `profile_${uid}`);

    if (kycStatus === 'verified') {
      await pushNotification(uid, {
        type: 'kyc_verified',
        topic: 'Phone Verified',
        message: `✅ Your phone ${phoneClean} has been verified successfully. You can now save and withdraw money.`,
        senderName: 'PocketVault System',
        senderIcon: '🔐'
      });
    }

    res.json({
      success: kycStatus === 'verified',
      verified: kycStatus === 'verified',
      name: registeredName,
      message: kycStatus === 'verified'
        ? `Phone verified${registeredName ? ` as ${registeredName}` : ''}!`
        : 'Airtel verification failed. Ensure this number is registered with Airtel Money.'
    });
  })
);

// ----------------------------
// KYC: ADMIN OVERRIDE ONLY
// POST /api/admin/kyc-override
// The OLD unauthenticated /api/kyc endpoint has been REMOVED —
// it allowed any logged-in user to instantly verify any phone
// with zero OTP confirmation, completely bypassing the OTP flow.
// Admins can still manually verify a user from the admin panel,
// but that now goes through PATCH /api/admin/users/:uid instead,
// which is already behind requireAdmin.
// ----------------------------

// ----------------------------
// BALANCE: AIRTEL WALLET
// GET /api/airtel/balance
// ----------------------------
app.get('/api/airtel/balance',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    if (isMockMode()) {
      return res.json({ success: true, mock: true, balance: 37600, currency: 'MWK' });
    }
    const data = await getCached(`balance_${uid}`, () => airtelBalance('COLL'), 30000);
    const balance = parseFloat(data?.data?.balance || 0);
    await db.collection('users').doc(uid).set({
      airtelBalance: { amount: balance, currency: 'MWK', lastSync: FieldValue.serverTimestamp() }
    }, { merge: true });
    res.json({ success: true, balance, currency: 'MWK' });
  })
);

// ----------------------------
// GOALS: CREATE
// POST /api/goals
// ----------------------------
app.post('/api/goals',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, name, target, deadline, emoji, lockType, deadlineBehavior } = req.body;
    if (!name || !target) return res.status(400).json({ success: false, error: 'name and target required' });
    if (parseFloat(target) < 500) return res.status(400).json({ success: false, error: 'Minimum goal is MWK 500' });

    const { plan, config } = await getPlanConfig(uid);
    const existing = await db.collection('goals')
      .where('uid', '==', uid).where('completed', '==', false).get();

    if (existing.size >= config.maxGoals) {
      return res.status(403).json({
        success: false,
        error: `${config.name} plan allows max ${config.maxGoals} active goals.`,
        upgrade: true, currentPlan: plan
      });
    }

    // Savings lock requires pro or business
    if (lockType === 'hard' && !config.savingsLock) {
      return res.status(403).json({
        success: false,
        error: 'Savings lock requires Pro or Business plan',
        upgrade: true
      });
    }

    // Validate deadlineBehavior — only meaningful for locked goals with a deadline
    const validBehaviors = ['stay_locked', 'auto_unlock', 'ask_me'];
    let finalBehavior = null;
    if (lockType === 'hard' && deadline) {
      finalBehavior = validBehaviors.includes(deadlineBehavior) ? deadlineBehavior : 'ask_me';
    }

    const goal = {
      uid, name: sanitize(name),
      target: parseFloat(target), saved: 0,
      deadline: deadline || null,
      deadlineBehavior: finalBehavior,
      deadlinePassed: false,
      deadlineDecisionPending: false,
      emoji: emoji || '🎯',
      lockType: lockType || 'flexible',
      locked: lockType === 'hard',
      completed: false,
      createdAt: FieldValue.serverTimestamp()
    };

    const ref = await db.collection('goals').add(goal);
    clearCache(`goals_${uid}`);
    res.json({ success: true, goalId: ref.id, goal });
  })
);

// ----------------------------
// GOALS: GET ALL
// GET /api/goals
// ----------------------------
app.get('/api/goals',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const goals = await getCached(`goals_${uid}`, async () => {
      const snap = await db.collection('goals')
        .where('uid', '==', uid).get();
      const docs = [];
      snap.forEach(doc => docs.push({ id: doc.id, ...doc.data() }));
      docs.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      const result = {};
      docs.forEach(d => { result[d.id] = d; });
      return result;
    }, 15000);
    res.json({ success: true, goals });
  })
);

// ----------------------------
// GOALS: UPDATE
// PATCH /api/goals/:goalId
// ----------------------------
app.patch('/api/goals/:goalId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { goalId } = req.params;
    const uid = req.user.uid;
    const snap = await db.collection('goals').doc(goalId).get();
    const goal = snap.data();
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (goal.completed) return res.status(400).json({ success: false, error: 'Cannot edit completed goal' });

    const { name, target, deadline, emoji, lockType, deadlineBehavior } = req.body;

    // Locked goals can still have their deadline extended / behavior changed —
    // that's the whole point of the deadline-passed decision flow.
    // But name/target/lockType changes are blocked while hard-locked.
    const isDeadlineOnlyEdit = (deadline !== undefined || deadlineBehavior !== undefined)
      && name === undefined && target === undefined && lockType === undefined && emoji === undefined;

    if (goal.locked && goal.lockType === 'hard' && !isDeadlineOnlyEdit) {
      return res.status(400).json({ success: false, error: 'Goal is locked. You can only extend its deadline.' });
    }

    const updates = { updatedAt: FieldValue.serverTimestamp() };
    if (name) updates.name = sanitize(name);
    if (target) {
      const parsedTarget = parseAmount(target);
      if (parsedTarget === null || parsedTarget < 500) {
        return res.status(400).json({ success: false, error: 'Minimum target is MWK 500' });
      }
      updates.target = parsedTarget;
    }
    if (deadline) {
      updates.deadline = deadline;
      updates.deadlinePassed = false;
      updates.deadlineDecisionPending = false;
    }
    if (emoji) updates.emoji = emoji;
    if (lockType) {
      // Prevent Free-plan users upgrading to 'hard' lock via PATCH
      // (same check as goal creation — lockType 'hard' is Pro/Business only)
      if (lockType === 'hard') {
        const { config } = await getPlanConfig(uid);
        if (!config.savingsLock) {
          return res.status(403).json({
            success: false,
            error: 'Savings lock requires Pro or Business plan',
            upgrade: true
          });
        }
      }
      updates.lockType = lockType;
      updates.locked = lockType === 'hard';
    }
    if (deadlineBehavior && ['stay_locked','auto_unlock','ask_me'].includes(deadlineBehavior)) {
      updates.deadlineBehavior = deadlineBehavior;
    }

    await db.collection('goals').doc(goalId).update(updates);
    clearCache(`goals_${uid}`);
    res.json({ success: true });
  })
);

// ----------------------------
// GOALS: DEADLINE DECISION
// PATCH /api/goals/:goalId/deadline-decision
// For 'ask_me' goals once the deadline has passed —
// user chooses to unlock now or extend the deadline.
// Body: { action: 'unlock' | 'extend', newDeadline? }
// ----------------------------
app.patch('/api/goals/:goalId/deadline-decision',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { goalId } = req.params;
    const uid = req.user.uid;
    const { action, newDeadline } = req.body;

    const snap = await db.collection('goals').doc(goalId).get();
    const goal = snap.data();
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (!goal.deadlineDecisionPending) {
      return res.status(400).json({ success: false, error: 'No pending decision for this goal' });
    }

    if (action === 'unlock') {
      await snap.ref.update({
        locked: false,
        lockType: 'flexible',
        deadlineDecisionPending: false,
        deadlinePassed: false,
        updatedAt: FieldValue.serverTimestamp()
      });
      await pushNotification(uid, {
        type: 'goal_unlocked',
        topic: 'Goal Unlocked',
        message: `🔓 "${goal.name}" is now unlocked. You can withdraw your MWK ${(goal.saved||0).toLocaleString()} savings anytime.`
      });
      return res.json({ success: true, locked: false });
    }

    if (action === 'extend') {
      if (!newDeadline) return res.status(400).json({ success: false, error: 'newDeadline required' });
      await snap.ref.update({
        deadline: newDeadline,
        deadlinePassed: false,
        deadlineDecisionPending: false,
        updatedAt: FieldValue.serverTimestamp()
      });
      await pushNotification(uid, {
        type: 'goal_extended',
        topic: 'Deadline Extended',
        message: `📅 "${goal.name}" deadline extended to ${newDeadline}. Keep saving — you've got this!`
      });
      return res.json({ success: true, deadline: newDeadline });
    }

    return res.status(400).json({ success: false, error: 'action must be unlock or extend' });
  })
);

// ----------------------------
// SAVE: COLLECT FROM USER WALLET
// POST /api/save
// Body: { uid, goalId, amount, phone }
// ----------------------------
app.post('/api/save',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, goalId, amount, phone } = req.body;
    if (!goalId || !amount || !phone) {
      return res.status(400).json({ success: false, error: 'goalId, amount, phone required' });
    }
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (parsedAmount < SECURITY.MIN_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: `Minimum save is MWK ${SECURITY.MIN_SAVE_AMOUNT}` });
    }
    if (parsedAmount > SECURITY.MAX_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: 'Amount exceeds maximum limit' });
    }

    const goalSnap = await db.collection('goals').doc(goalId).get();
    const goal = goalSnap.data();
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (goal.completed) return res.status(400).json({ success: false, error: 'Goal already completed' });

    const { plan, config } = await getPlanConfig(uid);
    const fee = calcFee(parsedAmount, config.transactionFeePercent);
    const reference = generateRef();

    // ----------------------------
    // Shared post-success hook — runs after EITHER mock or real save
    // succeeds. Keeps streaks/milestones/referrals in exactly one
    // place instead of duplicated in both branches below.
    // Deliberately fire-and-log rather than fire-and-fail: none of
    // these three should ever be able to break the save response
    // itself if something in here throws.
    // ----------------------------
    async function afterSuccessfulSave(goalBefore, goalAfter) {
      try {
        await updateSavingsStreak(uid);
      } catch (e) {
        logSystemError('savings_streak', e.message, { uid, stack: e.stack });
      }
      try {
        await checkGoalMilestone(uid, goalBefore, goalAfter);
      } catch (e) {
        logSystemError('goal_milestone', e.message, { uid, stack: e.stack });
      }
      try {
        await checkReferralCompletion(uid);
      } catch (e) {
        logSystemError('referral_completion', e.message, { uid, stack: e.stack });
      }
    }

    // Mock mode
    if (isMockMode()) {
      const goalBefore = { ...goal };
      const updated = await updateGoalProgress(uid, goalId, parsedAmount);
      const txId = await logTransaction(uid, {
        type: 'savings', amount: parsedAmount, fee, feePercent: config.transactionFeePercent,
        goalId, goalName: goal.name, reference, status: 'mock', phone, plan
      });
      await logFee(uid, { amount: fee, transactionId: txId, type: 'savings', plan });
      await pushNotification(uid, {
        type: 'savings_success',
        message: `💰 Saved MWK ${parsedAmount.toLocaleString()} to ${goal.name}. ${updated?.completed ? '🎉 Goal complete!' : `${Math.round(((updated?.saved || 0) / goal.target) * 100)}% done.`}`
      });
      await afterSuccessfulSave(goalBefore, updated);
      clearCache(`goals_${uid}`, `analytics_${uid}`);
      return res.json({
        success: true, mock: true,
        message: `MWK ${parsedAmount} saved to ${goal.name}`,
        reference, fee, feePercent: config.transactionFeePercent, goal: updated
      });
    }

    // Real: collect from user wallet
    const result = await airtelCollect({ phone, amount: parsedAmount, reference });

    if (isAirtelSuccess(result)) {
      const goalBefore = { ...goal };
      const updated = await updateGoalProgress(uid, goalId, parsedAmount);
      const txId = await logTransaction(uid, {
        type: 'savings', amount: parsedAmount, fee, feePercent: config.transactionFeePercent,
        goalId, goalName: goal.name, reference,
        airtelTxnId: result.txnId,
        airtelRef: result?.data?.transaction?.id,
        status: 'completed', phone, plan
      });
      await logFee(uid, { amount: fee, transactionId: txId, type: 'savings', plan });
      await pushNotification(uid, {
        type: 'savings_success',
        message: updated?.completed
          ? `🎉 Goal complete! You reached your ${goal.name} target!`
          : `💰 Saved MWK ${parsedAmount.toLocaleString()} to ${goal.name}. ${Math.round(((updated?.saved || 0) / goal.target) * 100)}% done.`
      });
      await afterSuccessfulSave(goalBefore, updated);
      clearCache(`goals_${uid}`, `analytics_${uid}`);
      res.json({ success: true, message: `MWK ${parsedAmount} saved`, reference, fee, goal: updated });
    } else {
      await logTransaction(uid, {
        type: 'savings', amount: parsedAmount, goalId,
        reference, status: 'failed', error: JSON.stringify(result)
      });
      res.status(400).json({ success: false, error: 'Transfer failed', details: result });
    }
  })
);

// ----------------------------
// WITHDRAW: SEND BACK TO USER WALLET
// POST /api/withdraw
// Body: { uid, goalId, amount, phone }
// ----------------------------
app.post('/api/withdraw',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, goalId, amount, phone } = req.body;
    if (!goalId || !amount || !phone) {
      return res.status(400).json({ success: false, error: 'goalId, amount, phone required' });
    }
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (parsedAmount < 100) return res.status(400).json({ success: false, error: 'Minimum withdrawal is MWK 100' });

    const goalSnap = await db.collection('goals').doc(goalId).get();
    const goal = goalSnap.data();
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (goal.locked && goal.lockType === 'hard') {
      return res.status(400).json({ success: false, error: 'Goal is locked until target is reached' });
    }
    if ((goal.saved || 0) < parsedAmount) {
      return res.status(400).json({
        success: false,
        error: `Insufficient savings. Available: MWK ${(goal.saved || 0).toLocaleString()}`
      });
    }

    const { plan, config } = await getPlanConfig(uid);
    const fee = calcFee(parsedAmount, config.withdrawalFeePercent);
    const netPayout = parsedAmount - fee;
    const reference = generateRef();

    // Float check only applies under Airtel direct — PayChangu has no
    // balance API to check against (see checkFloatSufficient() above)
    if (resolvePaymentProvider() === 'airtel_direct') {
      try { await checkFloatSufficient(netPayout); }
      catch {
        return res.status(503).json({
          success: false,
          error: 'Withdrawals temporarily unavailable. Please try again shortly.'
        });
      }
    }

    // Mock mode
    if (isMockMode()) {
      await db.collection('goals').doc(goalId).update({
        saved: (goal.saved || 0) - parsedAmount,
        lastUpdated: FieldValue.serverTimestamp()
      });
      const txId = await logTransaction(uid, {
        type: 'withdrawal', amount: parsedAmount, fee,
        feePercent: config.withdrawalFeePercent,
        netPayout, goalId, goalName: goal.name,
        reference, status: 'mock', phone, plan
      });
      await logFee(uid, { amount: fee, transactionId: txId, type: 'withdrawal', plan });
      await pushNotification(uid, {
        type: 'withdrawal_success',
        message: `💸 MWK ${netPayout.toLocaleString()} sent to your Airtel wallet from ${goal.name}.`
      });
      clearCache(`goals_${uid}`, `analytics_${uid}`);
      return res.json({ success: true, mock: true, message: `MWK ${netPayout} sent`, reference, fee, netPayout });
    }

    const result = await airtelDisburse({ phone, amount: netPayout, reference });
    if (isAirtelSuccess(result)) {
      await db.collection('goals').doc(goalId).update({
        saved: (goal.saved || 0) - parsedAmount,
        lastUpdated: FieldValue.serverTimestamp()
      });
      const txId = await logTransaction(uid, {
        type: 'withdrawal', amount: parsedAmount, fee,
        feePercent: config.withdrawalFeePercent,
        netPayout, goalId, goalName: goal.name,
        reference, airtelTxnId: result.txnId,
        airtelRef: result?.data?.transaction?.id,
        status: 'completed', phone, plan
      });
      await logFee(uid, { amount: fee, transactionId: txId, type: 'withdrawal', plan });
      await pushNotification(uid, {
        type: 'withdrawal_success',
        message: `💸 MWK ${netPayout.toLocaleString()} sent to your Airtel wallet from ${goal.name}.`
      });
      clearCache(`goals_${uid}`, `analytics_${uid}`);
      res.json({ success: true, message: `MWK ${netPayout} sent`, reference, fee, netPayout });
    } else {
      await logTransaction(uid, {
        type: 'withdrawal', amount: parsedAmount,
        goalId, reference, status: 'failed', error: JSON.stringify(result)
      });
      res.status(400).json({ success: false, error: 'Withdrawal failed', details: result });
    }
  })
);

// ----------------------------
// AUTO-SAVE: CREATE RULE
// POST /api/autosave/rules
// Pro and Business only
// ----------------------------
app.post('/api/autosave/rules',
  requireAuth,
  requireOwnData,
  requirePlan('pro', 'business'),
  asyncHandler(async (req, res) => {
    const { uid, type, amount, goalId, schedule, percent, enabled, declaredIncome, incomeDay } = req.body;
    if (!type || !goalId) return res.status(400).json({ success: false, error: 'type and goalId required' });

    const { config } = await getPlanConfig(uid);
    const existing = await db.collection('autosave_rules')
      .where('uid', '==', uid).where('enabled', '==', true).get();
    if (existing.size >= config.maxAutoRules) {
      return res.status(403).json({
        success: false,
        error: `Your plan allows max ${config.maxAutoRules} auto-save rules`
      });
    }

    const goalSnap = await db.collection('goals').doc(goalId).get();
    if (!goalSnap.exists || goalSnap.data().uid !== uid) {
      return res.status(403).json({ success: false, error: 'Goal not found or forbidden' });
    }

    const parsedRuleAmount = amount ? parseAmount(amount) : null;
    const parsedRulePercent = percent ? parseAmount(percent) : null;

    if (amount && parsedRuleAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (percent && (parsedRulePercent === null || parsedRulePercent > 100)) {
      return res.status(400).json({ success: false, error: 'Percentage must be between 1 and 100' });
    }

    // ----------------------------
    // income_percent rules need to know WHEN income arrives and
    // HOW MUCH it typically is, since neither Airtel's nor PayChangu's
    // API can tell us that automatically today — there is no live
    // feed of money entering a user's wallet from a third party like
    // an employer. The user declares their own pay day and typical
    // income; the auto-save job (below) triggers a normal collection
    // on that day for percent% of the declared amount.
    //
    // This is deliberately built so the ONLY thing that changes when
    // Airtel's Transaction Summary API becomes available is HOW the
    // job decides a payday happened — see resolveIncomeTrigger()
    // below, which is the single swappable seam. The collection
    // call itself, goal crediting, fee logging, and notifications
    // are completely unaffected either way.
    // ----------------------------
    let parsedDeclaredIncome = null;
    let parsedIncomeDay = null;
    if (type === 'income_percent') {
      if (!percent) return res.status(400).json({ success: false, error: 'percent is required for income_percent rules' });
      parsedDeclaredIncome = declaredIncome ? parseAmount(declaredIncome) : null;
      if (declaredIncome && parsedDeclaredIncome === null) {
        return res.status(400).json({ success: false, error: 'Enter a valid declared income amount' });
      }
      if (!parsedDeclaredIncome) {
        return res.status(400).json({ success: false, error: 'declaredIncome is required for income_percent rules' });
      }
      parsedIncomeDay = parseInt(incomeDay, 10);
      if (!Number.isInteger(parsedIncomeDay) || parsedIncomeDay < 1 || parsedIncomeDay > 31) {
        return res.status(400).json({ success: false, error: 'incomeDay must be a day of the month between 1 and 31' });
      }
    }

    const rule = {
      uid, type, goalId,
      amount: parsedRuleAmount,
      percent: parsedRulePercent,
      schedule: schedule || null,
      declaredIncome: parsedDeclaredIncome,
      incomeDay: parsedIncomeDay,
      enabled: enabled !== false,
      createdAt: FieldValue.serverTimestamp(),
      lastRun: null,
      lastRunResult: null
    };

    const ref = await db.collection('autosave_rules').add(rule);
    res.json({ success: true, ruleId: ref.id, rule });
  })
);

// ----------------------------
// AUTO-SAVE: GET RULES
// GET /api/autosave/rules
// ----------------------------
app.get('/api/autosave/rules',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const snap = await db.collection('autosave_rules').where('uid', '==', uid).get();
    const rules = {};
    snap.forEach(doc => { rules[doc.id] = { id: doc.id, ...doc.data() }; });
    res.json({ success: true, rules });
  })
);

// ----------------------------
// AUTO-SAVE: TOGGLE RULE
// PATCH /api/autosave/rules/:ruleId
// ----------------------------
app.patch('/api/autosave/rules/:ruleId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { ruleId } = req.params;
    const uid = req.user.uid;
    const snap = await db.collection('autosave_rules').doc(ruleId).get();
    if (!snap.exists || snap.data().uid !== uid) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const rule = snap.data();
    const updates = {};
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;

    // Only income_percent rules accept these fields — silently
    // ignored for other rule types to avoid confusing partial state
    if (rule.type === 'income_percent') {
      if (req.body.declaredIncome !== undefined) {
        const parsed = parseAmount(req.body.declaredIncome);
        if (parsed === null) return res.status(400).json({ success: false, error: 'Enter a valid declared income amount' });
        updates.declaredIncome = parsed;
      }
      if (req.body.incomeDay !== undefined) {
        const day = parseInt(req.body.incomeDay, 10);
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          return res.status(400).json({ success: false, error: 'incomeDay must be a day of the month between 1 and 31' });
        }
        updates.incomeDay = day;
      }
      if (req.body.percent !== undefined) {
        const pct = parseAmount(req.body.percent);
        if (pct === null || pct > 100) return res.status(400).json({ success: false, error: 'Percentage must be between 1 and 100' });
        updates.percent = pct;
      }
    }

    await db.collection('autosave_rules').doc(ruleId).update(updates);
    res.json({ success: true });
  })
);

// ----------------------------
// ROUND-UP: PROCESS A SPEND
// POST /api/roundup
// Pro and Business only
// Body: { uid, spendAmount, goalId, phone }
// ----------------------------
app.post('/api/roundup',
  requireAuth,
  requireOwnData,
  requirePlan('pro', 'business'),
  asyncHandler(async (req, res) => {
    const { uid, spendAmount, goalId, phone } = req.body;
    if (!spendAmount || !goalId || !phone) {
      return res.status(400).json({ success: false, error: 'spendAmount, goalId, phone required' });
    }

    const parsed = parseAmount(spendAmount);
    if (parsed === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid spend amount' });
    }
    const roundedUp = Math.ceil(parsed / 500) * 500;
    const roundUpAmount = roundedUp - parsed;

    if (roundUpAmount < 10) {
      return res.json({ success: true, message: 'Round-up too small to process', roundUpAmount: 0 });
    }

    const goalSnap = await db.collection('goals').doc(goalId).get();
    const goal = goalSnap.data();
    if (!goal || goal.uid !== uid) {
      return res.status(403).json({ success: false, error: 'Goal not found or forbidden' });
    }

    const reference = generateRef();

    if (isMockMode()) {
      const updated = await updateGoalProgress(uid, goalId, roundUpAmount);
      await logTransaction(uid, {
        type: 'roundup', amount: roundUpAmount,
        spendAmount: parsed, roundedUp,
        goalId, goalName: goal.name,
        reference, status: 'mock', phone
      });
      await pushNotification(uid, {
        type: 'roundup_success',
        message: `🔄 MWK ${roundUpAmount} round-up saved to ${goal.name}.`
      });
      clearCache(`goals_${uid}`, `analytics_${uid}`);
      return res.json({ success: true, mock: true, roundUpAmount, reference, goal: updated });
    }

    const result = await airtelCollect({ phone, amount: roundUpAmount, reference });
    if (isAirtelSuccess(result)) {
      const updated = await updateGoalProgress(uid, goalId, roundUpAmount);
      await logTransaction(uid, {
        type: 'roundup', amount: roundUpAmount,
        spendAmount: parsed, roundedUp,
        goalId, goalName: goal.name,
        reference, airtelTxnId: result.txnId,
        status: 'completed', phone
      });
      await pushNotification(uid, {
        type: 'roundup_success',
        message: `🔄 MWK ${roundUpAmount} round-up saved to ${goal.name}.`
      });
      clearCache(`goals_${uid}`, `analytics_${uid}`);
      res.json({ success: true, roundUpAmount, reference, goal: updated });
    } else {
      res.status(400).json({ success: false, error: 'Round-up failed' });
    }
  })
);

// ----------------------------
// MERCHANT: COLLECT
// POST /api/merchant/collect
// Business only
// ----------------------------
app.post('/api/merchant/collect',
  requireAuth,
  requireOwnData,
  requirePlan('business'),
  asyncHandler(async (req, res) => {
    const { uid, customerPhone, amount, reference } = req.body;
    if (!customerPhone || !amount) {
      return res.status(400).json({ success: false, error: 'customerPhone and amount required' });
    }
    const ref = reference || generateRef();
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (parsedAmount > SECURITY.MAX_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: 'Amount exceeds maximum limit' });
    }
    const fee = calcFee(parsedAmount, PLANS.business.transactionFeePercent);

    if (isMockMode()) {
      await logTransaction(uid, {
        type: 'collection', amount: parsedAmount,
        fee, customerPhone, reference: ref, status: 'mock'
      });
      return res.json({ success: true, mock: true, reference: ref, fee });
    }

    const result = await airtelCollect({ phone: customerPhone, amount: parsedAmount, reference: ref });
    const success = isAirtelSuccess(result);
    const txId = await logTransaction(uid, {
      type: 'collection', amount: parsedAmount,
      fee, customerPhone, reference: ref,
      airtelTxnId: result.txnId,
      status: success ? 'pending_customer' : 'failed'
    });
    if (success) await logFee(uid, { amount: fee, transactionId: txId, type: 'collection', plan: 'business' });
    clearCache(`analytics_${uid}`);
    res.json({ success, result, reference: ref, fee });
  })
);

// ----------------------------
// MERCHANT: DISBURSE
// POST /api/merchant/disburse
// Business only
// ----------------------------
app.post('/api/merchant/disburse',
  requireAuth,
  requireOwnData,
  requirePlan('business'),
  asyncHandler(async (req, res) => {
    const { uid, phone, amount, reference } = req.body;
    if (!phone || !amount) {
      return res.status(400).json({ success: false, error: 'phone and amount required' });
    }
    const ref = reference || generateRef();
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (parsedAmount > SECURITY.MAX_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: 'Amount exceeds maximum limit' });
    }
    const fee = calcFee(parsedAmount, PLANS.business.transactionFeePercent);

    if (isMockMode()) {
      await logTransaction(uid, {
        type: 'disbursement', amount: parsedAmount,
        fee, phone, reference: ref, status: 'mock'
      });
      return res.json({ success: true, mock: true, reference: ref, fee });
    }

    const result = await airtelDisburse({ phone, amount: parsedAmount, reference: ref });
    const success = isAirtelSuccess(result);
    const txId = await logTransaction(uid, {
      type: 'disbursement', amount: parsedAmount,
      fee, phone, reference: ref,
      airtelTxnId: result.txnId,
      status: success ? 'completed' : 'failed'
    });
    if (success) await logFee(uid, { amount: fee, transactionId: txId, type: 'disbursement', plan: 'business' });
    clearCache(`analytics_${uid}`);
    res.json({ success, result, reference: ref, fee });
  })
);

// ----------------------------
// TRANSACTIONS: GET HISTORY
// GET /api/transactions
// Uses a single where() filter (uid only) then sorts/filters
// in application code — avoids requiring a Firestore composite
// index for the uid + type + timestamp combination.
// ----------------------------
app.get('/api/transactions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const { limit, type } = req.query;

    const snap = await db.collection('transactions')
      .where('uid', '==', uid)
      .get();

    let transactions = [];
    snap.forEach(doc => transactions.push({ id: doc.id, ...doc.data() }));

    if (type) transactions = transactions.filter(t => t.type === type);

    transactions.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
    transactions = transactions.slice(0, parseInt(limit) || 20);

    res.json({ success: true, transactions });
  })
);

// ----------------------------
// TRANSACTION: STATUS CHECK
// GET /api/transactions/:reference/status
// ----------------------------
app.get('/api/transactions/:reference/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { reference } = req.params;
    const uid = req.user.uid;
    const snap = await db.collection('transactions')
      .where('reference', '==', reference)
      .where('uid', '==', uid).limit(1).get();
    if (snap.empty) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (isMockMode()) return res.json({ success: true, mock: true, status: 'completed' });
    const result = await airtelTransactionStatus(reference);
    const statusMap = { 'TS': 'completed', 'TF': 'failed', 'TE': 'expired', 'TP': 'pending' };
    res.json({
      success: true, reference,
      status: statusMap[result?.data?.transaction?.status] || 'unknown',
      raw: result
    });
  })
);

// ----------------------------
// ANALYTICS: SUMMARY
// GET /api/analytics
// Pro and Business get full analytics
// ----------------------------
app.get('/api/analytics',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const { plan, config } = await getPlanConfig(uid);

    const analytics = await getCached(`analytics_${uid}`, async () => {
      const snap = await db.collection('transactions')
        .where('uid', '==', uid).get();

      let transactions = [];
      snap.forEach(doc => transactions.push(doc.data()));
      transactions.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
      transactions = transactions.slice(0, 500);

      const monthStart = new Date();
      monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

      let totalSaved = 0, totalSpent = 0, monthSaved = 0, monthSpent = 0, totalFees = 0;
      const categoryMap = {};
      const monthlyMap = {};

      for (const tx of transactions) {
        if (tx.status === 'failed') continue;
        const ts = tx.timestamp?.toMillis?.() || tx.timestamp || 0;
        const d = new Date(ts);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyMap[mk]) monthlyMap[mk] = { saved: 0, spent: 0 };

        if (['savings', 'roundup'].includes(tx.type)) {
          totalSaved += tx.amount || 0;
          totalFees += tx.fee || 0;
          monthlyMap[mk].saved += tx.amount || 0;
          if (ts > monthStart.getTime()) monthSaved += tx.amount || 0;
        }
        if (['expense', 'gambling', 'airtime', 'collection', 'disbursement'].includes(tx.type)) {
          totalSpent += tx.amount || 0;
          monthlyMap[mk].spent += tx.amount || 0;
          if (ts > monthStart.getTime()) monthSpent += tx.amount || 0;
          const cat = tx.category || tx.type || 'other';
          categoryMap[cat] = (categoryMap[cat] || 0) + (tx.amount || 0);
        }
      }

      const savingsRate = totalSpent + totalSaved > 0
        ? Math.round((totalSaved / (totalSpent + totalSaved)) * 100) : 0;

      // Basic analytics for everyone
      const basic = { totalSaved, monthSaved, savingsRate, transactionCount: transactions.length };

      // Full analytics for pro and business
      const full = {
        ...basic,
        totalSpent, monthSpent, totalFees,
        categoryBreakdown: categoryMap,
        monthlyTrend: monthlyMap,
        // AI insight generation
        aiInsight: generateInsight({ totalSaved, totalSpent, monthSaved, monthSpent, categoryMap, savingsRate })
      };

      return { basic, full };
    }, 60000);

    res.json({
      success: true,
      analytics: config.analytics ? analytics.full : analytics.basic,
      plan,
      fullAnalyticsAvailable: config.analytics
    });
  })
);

// ----------------------------
// AI INSIGHT GENERATOR
// ----------------------------
function generateInsight({ totalSaved, totalSpent, monthSaved, monthSpent, categoryMap, savingsRate }) {
  const insights = [];

  if (savingsRate >= 30) insights.push('🔥 Excellent savings rate. You are in the top tier of savers.');
  else if (savingsRate >= 15) insights.push('📊 Good savings rate. Small improvements could make a big difference.');
  else insights.push('⚠️ Low savings rate. Try setting up auto-save rules to improve consistency.');

  const topCategory = Object.entries(categoryMap).sort((a, b) => b[1] - a[1])[0];
  if (topCategory) {
    const reduction = Math.floor(topCategory[1] * 0.2);
    insights.push(`💡 You spent most on ${topCategory[0]}. Reducing this by 20% would save MWK ${reduction.toLocaleString()} extra.`);
  }

  if (monthSaved > monthSpent) insights.push('✅ This month you saved more than you spent. Keep it up!');
  else if (monthSpent > 0) {
    const ratio = Math.round((monthSaved / monthSpent) * 100);
    insights.push(`📈 You saved ${ratio}% of what you spent this month. Target 30% for financial health.`);
  }

  return insights;
}

// ----------------------------
// NOTIFICATIONS
// ----------------------------
app.get('/api/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const snap = await db.collection('notifications')
      .where('uid', '==', uid).get();
    let notifications = [];
    snap.forEach(doc => notifications.push({ id: doc.id, ...doc.data() }));
    notifications.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
    notifications = notifications.slice(0, 20);
    res.json({ success: true, notifications });
  })
);

app.patch('/api/notifications/:notifId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { notifId } = req.params;
    const uid = req.user.uid;
    const snap = await db.collection('notifications').doc(notifId).get();
    if (!snap.exists || snap.data().uid !== uid) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    await db.collection('notifications').doc(notifId).update({ read: true });
    res.json({ success: true });
  })
);

// ----------------------------
// AIRTEL WEBHOOK
// POST /api/airtel/notification
// Rate limited to prevent flooding. Signature verification is
// enforced whenever AIRTEL_WEBHOOK_SECRET is configured — see the
// startup warning below if it's missing in a live environment.
// ----------------------------
app.post('/api/airtel/notification', rateLimit(60, 60 * 1000), asyncHandler(async (req, res) => {
  if (SECURITY.AIRTEL_WEBHOOK_SECRET) {
    const signature = req.headers['x-airtel-signature'];
    const expected = crypto
      .createHmac('sha256', SECURITY.AIRTEL_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body)).digest('hex');
    if (!signature || !safeCompare(signature, expected)) {
      console.warn('🚨 Invalid webhook signature — request rejected');
      return res.status(401).json({ success: false });
    }
  } else {
    // No secret configured — this should never happen once Airtel
    // is live in production. Logged loudly so it's impossible to miss,
    // but the request is still allowed through to avoid breaking the
    // app during initial setup before the secret has been added.
    console.warn('⚠️  AIRTEL_WEBHOOK_SECRET is not set — webhook signature is NOT being verified. Set this env var before going live.');
    logSystemError('webhook_security', 'AIRTEL_WEBHOOK_SECRET missing — webhook accepted unauthenticated request', { headers: req.headers });
  }

  const { transaction, msisdn } = req.body;
  if (!transaction) return res.status(400).json({ success: false });

  // Prevent duplicates
  if (await isAlreadyProcessed(transaction.id)) {
    return res.json({ success: true, note: 'already processed' });
  }

  console.log('📲 Airtel notification:', JSON.stringify(req.body));

  await db.collection('inbox').add({
    message: `Received MWK ${transaction.amount} from ${msisdn}. TID: ${transaction.id}`,
    amount: transaction.amount,
    sender: msisdn,
    tid: transaction.id?.replace(/[.#$[\]]/g, '_'),
    type: 'income',
    source: 'airtel-webhook',
    timestamp: FieldValue.serverTimestamp(),
    processed: false
  });

  res.json({ success: true });
}));

// ----------------------------
// PAYCHANGU WEBHOOK
// POST /api/paychangu/notification
// Separate route from the Airtel webhook above since PayChangu's
// payload shape (event_type, data.charge_id, data.status) is
// completely different from Airtel's — kept as its own handler
// rather than trying to merge two different payload shapes into
// one function. Signature verification uses PayChangu's own
// HMAC scheme; same safeCompare() constant-time comparison as
// the Airtel webhook uses.
// ----------------------------
app.post('/api/paychangu/notification', rateLimit(60, 60 * 1000), asyncHandler(async (req, res) => {
  if (PAYCHANGU.WEBHOOK_SECRET) {
    const signature = req.headers['signature'] || req.headers['x-paychangu-signature'];
    const expected = crypto
      .createHmac('sha256', PAYCHANGU.WEBHOOK_SECRET)
      .update(JSON.stringify(req.body)).digest('hex');
    if (!signature || !safeCompare(signature, expected)) {
      console.warn('🚨 Invalid PayChangu webhook signature — request rejected');
      return res.status(401).json({ success: false });
    }
  } else {
    console.warn('⚠️  PAYCHANGU_WEBHOOK_SECRET is not set — PayChangu webhook signature is NOT being verified. Set this env var before going live.');
    logSystemError('webhook_security', 'PAYCHANGU_WEBHOOK_SECRET missing — webhook accepted unauthenticated request', { headers: req.headers });
  }

  const { event_type, data } = req.body;
  if (!data?.charge_id) return res.status(400).json({ success: false });

  // Prevent duplicates — same pattern as the Airtel webhook, keyed
  // on PayChangu's charge_id instead of Airtel's transaction id
  const alreadyDone = await db.collection('transactions')
    .where('reference', '==', data.charge_id)
    .where('status', 'in', ['completed', 'failed'])
    .limit(1).get();
  if (!alreadyDone.empty) {
    return res.json({ success: true, note: 'already processed' });
  }

  console.log('📲 PayChangu notification:', JSON.stringify(req.body));

  await db.collection('inbox').add({
    message: `PayChangu ${event_type || 'event'}: MWK ${data.amount || '?'} — ${data.status || 'unknown'} (charge ${data.charge_id})`,
    amount: data.amount || null,
    sender: data.mobile || null,
    tid: (data.charge_id || '').replace(/[.#$[\]]/g, '_'),
    type: 'income',
    source: 'paychangu-webhook',
    timestamp: FieldValue.serverTimestamp(),
    processed: false
  });

  // Unlike the Airtel webhook (which relies entirely on the polling
  // reconciliation job to update transaction status), PayChangu's
  // webhook payload already tells us the final status directly — so
  // we can update the matching transaction immediately here rather
  // than waiting for the next reconciliation cycle.
  if (data.status === 'success' || data.status === 'failed') {
    const txSnap = await db.collection('transactions')
      .where('reference', '==', data.charge_id)
      .limit(1).get();
    if (!txSnap.empty) {
      const txDoc = txSnap.docs[0];
      const tx = txDoc.data();
      const newStatus = data.status === 'success' ? 'completed' : 'failed';
      if (tx.status === 'pending') {
        await txDoc.ref.update({ status: newStatus, reconciledAt: FieldValue.serverTimestamp() });
        if (newStatus === 'completed' && tx.goalId) {
          await updateGoalProgress(tx.uid, tx.goalId, tx.amount);
        }
        await pushNotification(tx.uid, {
          type: newStatus === 'completed' ? 'savings_success' : 'transaction_failed',
          message: newStatus === 'completed'
            ? `💰 Your MWK ${tx.amount?.toLocaleString()} payment was confirmed.`
            : `⚠ Your MWK ${tx.amount?.toLocaleString()} payment could not be completed. Please try again.`
        });
      }
    }
  }

  res.json({ success: true });
}));

// ----------------------------
// MACRODROID FALLBACK — REMOVED
// This endpoint accepted an arbitrary uid in the request body
// with zero authentication, letting anyone write into any
// user's data. It was legacy from before Airtel integration
// existed and nothing in the current app calls it. Removed.
// ----------------------------

// ----------------------------
// USER PROFILE DATA
// GET /api/user/profile
// Lightweight — returns KYC status, phone, plan for app initialization
// ----------------------------
app.get('/api/user/profile', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const snap = await db.collection('users').doc(uid).get();
  const data = snap.data() || {};
  res.json({
    success: true,
    uid,
    kycStatus: data.kycStatus || 'unverified',
    phone: data.phone || null,
    phoneVerified: !!data.phoneVerified,
    kycName: data.kycName || null,
    plan: data.plan || 'free',
    name: data.name || null,
    suspended: !!data.suspended,
    streakCount: data.streakCount || 0,
    longestStreak: data.longestStreak || 0,
    lastSaveWeek: data.lastSaveWeek || null,
    referredBy: data.referredBy || null
  });
}));

// ----------------------------
// NOTIFICATIONS: UNREAD COUNT
// GET /api/notifications/unread-count
// ----------------------------
app.get('/api/notifications/unread-count', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const snap = await db.collection('notifications').where('uid', '==', uid).where('read', '==', false).get();
  res.json({ success: true, count: snap.size });
}));

// ----------------------------
// NOTIFICATIONS: MARK ALL READ
// POST /api/notifications/read-all
// ----------------------------
app.post('/api/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const snap = await db.collection('notifications').where('uid', '==', uid).where('read', '==', false).get();
  const batch = db.batch();
  snap.forEach(doc => batch.update(doc.ref, { read: true }));
  await batch.commit();
  res.json({ success: true, marked: snap.size });
}));

// ----------------------------
// ERROR LOGGING HELPER
// Called internally to log errors to system_errors collection
// ----------------------------
async function logSystemError(source, message, extra = {}) {
  try {
    await db.collection('system_errors').add({
      source, message,
      stack: extra.stack || null,
      extra: JSON.stringify(extra).slice(0, 1000),
      read: false,
      timestamp: FieldValue.serverTimestamp()
    });
  } catch (e) {
    // Never let error logging crash the server
    console.error('Failed to log system error:', e.message);
  }
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
app.post('/api/admin/login', rateLimit(5, 15 * 60 * 1000), asyncHandler(async (req, res) => {
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
app.get('/api/admin/overview', requireAdmin, asyncHandler(async (req, res) => {
  // Revenue
  const feeSnap = await db.collection('platform_fees').limit(2000).get();
  let totalRevenue = 0, monthRevenue = 0;
  const revenueByType = {};
  const revenueByPlan = {};
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  feeSnap.forEach(doc => {
    const fee = doc.data();
    const amt = fee.amount || 0;
    totalRevenue += amt;
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
      byPlan: revenueByPlan
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
app.get('/api/admin/users', requireAdmin, asyncHandler(async (req, res) => {
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
app.get('/api/admin/users/:uid', requireAdmin, asyncHandler(async (req, res) => {
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
app.patch('/api/admin/users/:uid', requireAdmin, asyncHandler(async (req, res) => {
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
  }

  res.json({ success: true });
}));

// ----------------------------
// ADMIN: OPERATIONS
// GET /api/admin/operations
// Float history, pending transactions, recent inbox activity
// ----------------------------
app.get('/api/admin/operations', requireAdmin, asyncHandler(async (req, res) => {
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
    queueLength: airtelQueue.length
  });
}));

// ----------------------------
// ADMIN: RESOLVE ALERT
// PATCH /api/admin/alerts/:alertId
// ----------------------------
app.patch('/api/admin/alerts/:alertId', requireAdmin, asyncHandler(async (req, res) => {
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
app.get('/api/admin/revenue', requireAdmin, asyncHandler(async (req, res) => {
  const feeSnap = await db.collection('platform_fees').limit(1000).get();
  let totalRevenue = 0;
  const revenueByType = {};
  const revenueByPlan = {};
  feeSnap.forEach(doc => {
    const fee = doc.data();
    totalRevenue += fee.amount || 0;
    revenueByType[fee.type] = (revenueByType[fee.type] || 0) + (fee.amount || 0);
    revenueByPlan[fee.plan || 'unknown'] = (revenueByPlan[fee.plan || 'unknown'] || 0) + (fee.amount || 0);
  });
  const usersSnap = await db.collection('users').get();
  const planCounts = { free: 0, pro: 0, business: 0 };
  usersSnap.forEach(doc => {
    const plan = doc.data().plan || 'free';
    if (planCounts[plan] !== undefined) planCounts[plan]++;
  });
  res.json({
    success: true,
    revenue: { total: totalRevenue, byType: revenueByType, byPlan: revenueByPlan },
    users: { total: usersSnap.size, byPlan: planCounts }
  });
}));

// ----------------------------
// ADMIN: SEND MESSAGE TO USER(S)
// POST /api/admin/messages
// Body: { uid?, message, type? }
// If uid is omitted → broadcast to ALL users
// ----------------------------
app.post('/api/admin/messages', requireAdmin, asyncHandler(async (req, res) => {
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
app.get('/api/admin/messages', requireAdmin, asyncHandler(async (req, res) => {
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
app.get('/api/admin/errors', requireAdmin, asyncHandler(async (req, res) => {
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
app.patch('/api/admin/errors/:id', requireAdmin, asyncHandler(async (req, res) => {
  await db.collection('system_errors').doc(req.params.id).update({ read: true });
  res.json({ success: true });
}));

// ----------------------------
// ADMIN: MARK ALL ERRORS READ
// POST /api/admin/errors/read-all
// ----------------------------
app.post('/api/admin/errors/read-all', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('system_errors').where('read', '==', false).get();
  const batch = db.batch();
  snap.forEach(doc => batch.update(doc.ref, { read: true }));
  await batch.commit();
  res.json({ success: true, marked: snap.size });
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

app.post('/api/admin/ai/chat', requireAdmin, rateLimit(20, 60 * 1000), asyncHandler(async (req, res) => {
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
{"type":"tool_call","tool":"<tool_name>","args":{...}}

Available tools:
${toolList}

2. To propose a real action (sending a message, suspending a user, etc) — ONLY do this when the founder has clearly asked for the action to be taken, not just discussed:
{"type":"action_proposal","action":"<action_name>","args":{...},"summary":"one sentence describing exactly what will happen, for the founder to confirm"}

Available actions:
${actionList}

3. To give a final plain-English answer (most common):
{"type":"answer","text":"your answer here"}

4. To remember something durable for future conversations — a correction, a standing preference, or context worth not forgetting (e.g. "Business-plan withdrawals over 500k aren't unusual, don't flag them"). Only use this for things genuinely worth remembering long-term, not routine facts:
{"type":"answer","text":"your answer here","remember":"the specific thing to remember, written as a standalone fact"}

Critical rules:
- If the founder's request is ambiguous (e.g. "remind that user" with no clear single referent), respond with type "answer" and ASK a clarifying question. Never guess which user they mean.
- Only propose an action when explicitly asked to take one ("send it", "remind them", "suspend that user") — not when just discussing hypotheticals.
- Never invent numbers or user data. If you need data, request a tool_call first.
- Keep "answer" text concise — 2-4 sentences unless detail was explicitly requested.
- Use MWK for currency.
- You may need multiple tool_calls in sequence before you have enough to answer — that's fine, request one at a time.
- You have access to the full conversation history below, including anything from earlier today or previous sessions — use it, don't ask the founder to repeat context they already gave you.${notesBlock}`;

  // Tool-calling loop: model may request data 1+ times before
  // giving a final answer or proposing an action. Cap iterations
  // to prevent runaway loops burning through API quota.
  const MAX_ITERATIONS = 4;
  let workingContext = '';
  let finalResult = null;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const prompt = `${workingContext}\n\nConversation so far:\n${conversationText}\n\nRespond with the JSON envelope now.`;
      const raw = await callAI(systemPrompt, prompt, 900);

      let parsed;
      try {
        parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch {
        // Model didn't follow the JSON format — treat the raw text as a plain answer
        finalResult = { type: 'answer', text: raw.trim() };
        break;
      }

      if (parsed.type === 'tool_call') {
        const tool = AI_TOOLS[parsed.tool];
        if (!tool) {
          workingContext += `\n\n[Tool "${parsed.tool}" does not exist. Available tools: ${Object.keys(AI_TOOLS).join(', ')}]`;
          continue;
        }
        try {
          const toolResult = await tool.fn(parsed.args || {});
          workingContext += `\n\n[Result of ${parsed.tool}]:\n${JSON.stringify(toolResult).slice(0, 4000)}`;
        } catch (toolErr) {
          workingContext += `\n\n[Tool "${parsed.tool}" failed: ${toolErr.message}]`;
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
        };
        break;
      }

      // type === 'answer' or anything else — treat as final
      finalResult = { type: 'answer', text: parsed.text || raw.trim(), remember: parsed.remember || null };
      break;
    }

    if (!finalResult) {
      finalResult = { type: 'answer', text: "I wasn't able to work through that in the allotted steps — try rephrasing or breaking it into a simpler question." };
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
        actionProposal: { action: finalResult.action, args: finalResult.args, summary: finalResult.summary },
      });
    }

    await saveConversationTurn('user', question).catch(() => {});
    await saveConversationTurn('assistant', finalResult.text).catch(() => {});
    if (finalResult.remember) {
      await saveLearnedNote(finalResult.remember).catch(() => {});
    }

    res.json({ success: true, answer: finalResult.text, remembered: !!finalResult.remember });
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
app.get('/api/admin/ai/memory', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('ai_memory_notes').orderBy('createdAt', 'desc').limit(50).get();
  const notes = [];
  snap.forEach(d => notes.push({ id: d.id, ...d.data() }));
  res.json({ success: true, notes });
}));

// ----------------------------
// AI MEMORY: FORGET A NOTE
// DELETE /api/admin/ai/memory/:noteId
// ----------------------------
app.delete('/api/admin/ai/memory/:noteId', requireAdmin, asyncHandler(async (req, res) => {
  await db.collection('ai_memory_notes').doc(req.params.noteId).delete();
  res.json({ success: true });
}));

// ----------------------------
// AI MEMORY: CLEAR CONVERSATION
// POST /api/admin/ai/clear-conversation
// Wipes the ongoing conversation history (not the learned notes —
// those are separate and meant to persist even across a fresh start).
// ----------------------------
app.post('/api/admin/ai/clear-conversation', requireAdmin, asyncHandler(async (req, res) => {
  const snap = await db.collection('ai_conversations').doc(AI_CONVERSATION_ID).collection('messages').get();
  const batch = db.batch();
  snap.forEach(d => batch.delete(d.ref));
  await batch.commit();
  res.json({ success: true, cleared: snap.size });
}));

app.post('/api/admin/ai/execute-action', requireAdmin, rateLimit(10, 60 * 1000), asyncHandler(async (req, res) => {
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
app.get('/api/admin/ai/action-log', requireAdmin, asyncHandler(async (req, res) => {
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
app.get('/api/admin/ai/anomalies', requireAdmin, asyncHandler(async (req, res) => {
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
app.post('/api/admin/ai/draft-message', requireAdmin, rateLimit(20, 60 * 1000), asyncHandler(async (req, res) => {
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
app.get('/api/admin/ai/status', requireAdmin, asyncHandler(async (req, res) => {
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
app.get('/api/admin/ai/chat-history', requireAdmin, asyncHandler(async (req, res) => {
  const doc = await db.collection('ai_chat_sessions').doc('founder').get();
  res.json({ success: true, history: doc.exists ? (doc.data().history || []) : [] });
}));

app.post('/api/admin/ai/chat-history', requireAdmin, asyncHandler(async (req, res) => {
  const { history } = req.body;
  if (!Array.isArray(history)) return res.status(400).json({ success: false, error: 'history must be an array' });
  // Keep only the most recent 40 messages to avoid unbounded document growth
  const trimmed = history.slice(-40);
  await db.collection('ai_chat_sessions').doc('founder').set({
    history: trimmed, updatedAt: FieldValue.serverTimestamp()
  });
  res.json({ success: true, saved: trimmed.length });
}));

app.delete('/api/admin/ai/chat-history', requireAdmin, asyncHandler(async (req, res) => {
  await db.collection('ai_chat_sessions').doc('founder').delete();
  res.json({ success: true });
}));

// ----------------------------
// AI: PLATFORM INSIGHTS
// GET /api/admin/ai/insights
// Weekly-style plain-English summary of revenue, growth, and
// risk signals across the whole platform.
// ----------------------------
app.get('/api/admin/ai/insights', requireAdmin, asyncHandler(async (req, res) => {
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

  const revenueThisWeek = fees.filter(f => toMillis(f.timestamp) > weekAgo).reduce((s, f) => s + (f.amount || 0), 0);
  const revenueThisMonth = fees.filter(f => toMillis(f.timestamp) > monthAgo).reduce((s, f) => s + (f.amount || 0), 0);
  const totalRevenue = fees.reduce((s, f) => s + (f.amount || 0), 0);

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
app.post('/api/admin/ai/analyze-errors', requireAdmin, rateLimit(10, 60 * 1000), asyncHandler(async (req, res) => {
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
app.get('/api/admin/transactions', requireAdmin, asyncHandler(async (req, res) => {
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
app.patch('/api/admin/transactions/:id', requireAdmin, asyncHandler(async (req, res) => {
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
app.patch('/api/admin/users/:uid/suspend', requireAdmin, asyncHandler(async (req, res) => {
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
// ADMIN: OVERVIEW v2 (includes error badge counts)
// ----------------------------

// ----------------------------
// RECONCILIATION ENGINE
// ----------------------------
async function reconcilePendingTransactions() {
  if (isMockMode()) return;
  try {
    console.log('🔄 Reconciliation running...');
    const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000);
    const pendingSnap = await db.collection('transactions')
      .where('status', '==', 'pending')
      .where('timestamp', '<=', twoMinsAgo)
      .limit(50).get();

    if (pendingSnap.empty) { console.log('✅ No pending transactions'); return; }

    for (const doc of pendingSnap.docs) {
      const tx = doc.data();
      try {
        const result = await airtelTransactionStatus(tx.reference);
        const airtelStatus = result?.data?.transaction?.status;

        if (airtelStatus === 'TS') {
          await db.collection('transactions').doc(doc.id).update({
            status: 'completed', reconciledAt: FieldValue.serverTimestamp()
          });
          if (tx.type === 'savings' && tx.goalId && tx.uid) {
            await updateGoalProgress(tx.uid, tx.goalId, tx.amount);
            await logFee(tx.uid, { amount: tx.fee || 0, transactionId: doc.id, type: 'savings_reconciled', plan: tx.plan });
            await pushNotification(tx.uid, {
              type: 'savings_reconciled',
              message: `✅ Your MWK ${(tx.amount || 0).toLocaleString()} save to ${tx.goalName} was confirmed.`
            });
            clearCache(`goals_${tx.uid}`, `analytics_${tx.uid}`);
          }
        } else if (['TF', 'TE'].includes(airtelStatus)) {
          await db.collection('transactions').doc(doc.id).update({
            status: 'failed', reconciledAt: FieldValue.serverTimestamp()
          });
          if (tx.uid) {
            await pushNotification(tx.uid, {
              type: 'transaction_failed',
              message: `❌ Your MWK ${(tx.amount || 0).toLocaleString()} transaction failed. No money was moved.`
            });
          }
        }
      } catch (err) {
        console.error(`Reconciliation error for ${tx.reference}:`, err.message);
      }
    }
    console.log('✅ Reconciliation complete');
  } catch (err) {
    console.error('❌ Reconciliation error:', err.message);
  }
}

// ----------------------------
// FLOAT MONITOR
// ----------------------------
async function monitorFloat() {
  // Float monitoring is genuinely Airtel-direct-only — PayChangu has
  // no merchant balance endpoint to poll (see _paychanguBalance()).
  // Skips cleanly rather than erroring when running under PayChangu.
  if (resolvePaymentProvider() !== 'airtel_direct') return;
  try {
    const data = await airtelBalance('DISB');
    const balance = parseFloat(data?.data?.balance || 0);
    console.log(`💰 Float: MWK ${balance.toLocaleString()}`);
    await db.collection('float_monitor').add({
      balance, currency: 'MWK',
      timestamp: FieldValue.serverTimestamp(),
      status: balance < FLOAT_THRESHOLD ? 'low' : 'ok'
    });
    if (balance < FLOAT_THRESHOLD) {
      console.warn(`🚨 LOW FLOAT: MWK ${balance.toLocaleString()}`);
      await db.collection('admin_alerts').add({
        type: 'low_float',
        message: `Float is low: MWK ${balance.toLocaleString()}. Top up required.`,
        balance, threshold: FLOAT_THRESHOLD,
        timestamp: FieldValue.serverTimestamp(),
        resolved: false
      });
    }
    cache.set('corporate_float', { data: balance, expiry: Date.now() + 5 * 60 * 1000 });
  } catch (err) {
    console.error('❌ Float monitor error:', err.message);
    logSystemError('float_monitor', err.message, { stack: err.stack });
  }
}

// ----------------------------
// SUBSCRIPTION EXPIRY CHECKER
// Runs daily — auto-downgrades expired subscriptions
// ----------------------------
async function checkExpiredSubscriptions() {
  try {
    console.log('🔄 Checking expired subscriptions...');
    const snap = await db.collection('users')
      .where('subscriptionActive', '==', true)
      .where('subscriptionExpiry', '<=', Date.now())
      .get();

    for (const doc of snap.docs) {
      const user = doc.data();
      if (user.plan === 'free') continue;
      await db.collection('users').doc(doc.id).set({
        plan: 'free', subscriptionActive: false
      }, { merge: true });
      clearCache(`plan_${doc.id}`);
      await pushNotification(doc.id, {
        type: 'subscription_expired',
        message: `Your ${user.plan} plan has expired. Renew to keep access to all features.`
      });
      console.log(`⬇️ Downgraded ${doc.id} from ${user.plan} to free`);
    }
    console.log('✅ Subscription check complete');
  } catch (err) {
    console.error('❌ Subscription check error:', err.message);
    logSystemError('subscription_checker', err.message, { stack: err.stack });
  }
}

// ----------------------------
// GOAL DEADLINE CHECKER
// Runs daily — handles locked goals whose deadline has passed
// without reaching the savings target.
//
// Behavior depends on goal.deadlineBehavior:
//   stay_locked  -> do nothing except notify (informational only)
//   auto_unlock  -> unlock the goal automatically, notify user
//   ask_me       -> flag deadlineDecisionPending, notify user to choose
// ----------------------------
async function checkGoalDeadlines() {
  try {
    console.log('🔄 Checking goal deadlines...');
    const todayStr = new Date().toISOString().split('T')[0];

    // Only locked, incomplete goals with a deadline can be affected
    const snap = await db.collection('goals')
      .where('locked', '==', true)
      .where('completed', '==', false)
      .get();

    let processed = 0;
    for (const doc of snap.docs) {
      const goal = doc.data();
      if (!goal.deadline || goal.deadlinePassed) continue;
      if (goal.deadline > todayStr) continue; // deadline still in the future

      const behavior = goal.deadlineBehavior || 'ask_me';
      const pct = goal.target > 0 ? Math.round(((goal.saved || 0) / goal.target) * 100) : 0;

      if (behavior === 'auto_unlock') {
        await doc.ref.update({
          locked: false,
          lockType: 'flexible',
          deadlinePassed: true,
          updatedAt: FieldValue.serverTimestamp()
        });
        await pushNotification(goal.uid, {
          type: 'goal_auto_unlocked',
          topic: 'Goal Deadline Reached',
          message: `🔓 "${goal.name}" reached its deadline at ${pct}% saved and has been automatically unlocked. Withdraw anytime.`
        });
      } else if (behavior === 'stay_locked') {
        await doc.ref.update({
          deadlinePassed: true,
          updatedAt: FieldValue.serverTimestamp()
        });
        await pushNotification(goal.uid, {
          type: 'goal_deadline_passed',
          topic: 'Goal Deadline Passed',
          message: `📌 "${goal.name}" passed its deadline at ${pct}% saved. It stays locked until you reach your MWK ${goal.target.toLocaleString()} target, as you chose.`
        });
      } else {
        // ask_me — flag for user decision, don't change lock state yet
        await doc.ref.update({
          deadlinePassed: true,
          deadlineDecisionPending: true,
          updatedAt: FieldValue.serverTimestamp()
        });
        await pushNotification(goal.uid, {
          type: 'goal_deadline_decision',
          topic: 'Decision Needed',
          message: `⏰ "${goal.name}" passed its deadline at ${pct}% saved. Open the goal to unlock it or extend the deadline.`
        });
      }
      processed++;
    }
    console.log(`✅ Goal deadline check complete — ${processed} goal(s) processed`);
  } catch (err) {
    console.error('❌ Goal deadline check error:', err.message);
    logSystemError('goal_deadline_checker', err.message, { stack: err.stack });
  }
}

// ----------------------------
// AUTO-SAVE: INCOME TRIGGER RESOLUTION
// Determines whether an income_percent rule should fire, and how
// much to base the percentage on.
//
// PayChangu path (unchanged, per explicit product decision): stays
// on the declared payday + declared income amount, since PayChangu
// has no way to see real wallet activity.
//
// Airtel-direct path (new): uses REAL incoming transactions from
// airtelTransactionSummary() instead of trusting a declared date —
// this is the "only act on money the user actually received" design.
// ----------------------------
async function resolveIncomeTrigger(rule, todayDate, user) {
  const provider = resolvePaymentProvider();

  if (provider !== 'airtel_direct') {
    // PayChangu / mock — declared payday behavior, exactly as before
    if (!rule.incomeDay || !rule.declaredIncome) return null;
    if (todayDate.getDate() !== rule.incomeDay) return null;
    return { amountBase: rule.declaredIncome, source: 'declared' };
  }

  // Airtel direct — check real recent incoming transactions
  if (!user?.phone) return null;
  const recent = await airtelTransactionSummary(user.phone, { sinceMinutes: 30 });
  const credits = recent.filter(tx => tx.direction === 'credit' && tx.amount >= 5000);
  if (credits.length === 0) return null;

  // Only react to credits we haven't already processed for this rule —
  // prevents charging the same incoming payment twice across job runs
  const unprocessed = [];
  for (const tx of credits) {
    const seenSnap = await db.collection('seen_wallet_transactions').doc(tx.id).get();
    if (!seenSnap.exists) unprocessed.push(tx);
  }
  if (unprocessed.length === 0) return null;

  // Take the largest unprocessed credit as "the income event" —
  // reasonable heuristic since salary payments are typically the
  // largest single credit in a short window
  const biggest = unprocessed.reduce((max, tx) => tx.amount > max.amount ? tx : max, unprocessed[0]);
  return { amountBase: biggest.amount, source: 'airtel_transaction_summary', txId: biggest.id, allCredits: unprocessed };
}

// ----------------------------
// AUTO-SAVE: ROUNDUP TRIGGER RESOLUTION (Airtel-direct only)
// Same real-transaction-based approach as income above, but for
// outgoing spends instead of incoming credits. PayChangu/mock users
// keep using the manual POST /api/roundup endpoint, which is
// untouched by any of this.
// ----------------------------
async function resolveRoundupTrigger(rule, user) {
  if (resolvePaymentProvider() !== 'airtel_direct') return null;
  if (!user?.phone) return null;

  const recent = await airtelTransactionSummary(user.phone, { sinceMinutes: 30 });
  const debits = recent.filter(tx => tx.direction === 'debit' && tx.amount > 0);
  if (debits.length === 0) return null;

  const unprocessed = [];
  for (const tx of debits) {
    const seenSnap = await db.collection('seen_wallet_transactions').doc(tx.id).get();
    if (!seenSnap.exists) unprocessed.push(tx);
  }
  return unprocessed.length > 0 ? unprocessed : null;
}

// ----------------------------
// TRANSACTION SUMMARY POLLER (Airtel-direct only)
// Runs frequently (every 5 minutes) as a safety net that catches
// real income and real spending as close to "the moment it happens"
// as a polling approach allows, per the product decision to react
// "before the user thinks of spending it" rather than waiting for a
// slow daily cycle. If Airtel's API later exposes a genuine webhook
// for wallet activity, that would notify us instantly instead — this
// polling loop would then just become the backup safety net rather
// than the primary mechanism, with zero changes needed to the trigger
// resolution functions above.
//
// Marks every transaction it looks at as "seen" regardless of whether
// a rule acted on it, so the same wallet activity is never evaluated
// twice — whether or not it happened to match a rule this time.
// ----------------------------

// ----------------------------
// PROACTIVE ANOMALY MONITOR (Improvement #4 — noticing on its own)
// Runs the same rule-based flagging used by the on-demand anomaly
// scan, but automatically on a schedule, and only creates an
// admin_alert (and thus interrupts the founder) for genuinely NEW
// high-risk findings — not re-alerting on the same user every run.
// ----------------------------
async function proactiveAnomalyCheck() {
  try {
    const [txSnap, usersSnap] = await Promise.all([
      db.collection('transactions').limit(500).get(),
      db.collection('users').limit(500).get(),
    ]);
    const transactions = []; txSnap.forEach(d => transactions.push({ id: d.id, ...d.data() }));
    const users = {}; usersSnap.forEach(d => { users[d.id] = d.data(); });

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
        const gap = Math.abs(toMillis(t.timestamp) - toMillis(txs[i - 1].timestamp));
        return gap < 5 * 60 * 1000;
      });
      const failedCount = txs.filter(t => t.status === 'failed').length;
      if (large.length > 0 || rapid.length >= 3 || failedCount >= 3) {
        flagged.push({ uid, email: users[uid]?.email || uid, largeTransactions: large.length, rapidTransactions: rapid.length, failedTransactions: failedCount });
      }
    }

    if (flagged.length === 0) return;

    // Only alert on users we haven't already raised an unresolved
    // alert for — prevents the same pattern re-notifying every run
    const existingAlertsSnap = await db.collection('admin_alerts')
      .where('type', '==', 'ai_anomaly').where('resolved', '==', false).get();
    const alreadyAlertedUids = new Set();
    existingAlertsSnap.forEach(d => { if (d.data().uid) alreadyAlertedUids.add(d.data().uid); });

    const newlyFlagged = flagged.filter(f => !alreadyAlertedUids.has(f.uid));
    if (newlyFlagged.length === 0) return;

    for (const f of newlyFlagged) {
      const reasonParts = [];
      if (f.largeTransactions) reasonParts.push(`${f.largeTransactions} large transaction(s)`);
      if (f.rapidTransactions >= 3) reasonParts.push(`${f.rapidTransactions} rapid-fire transactions`);
      if (f.failedTransactions >= 3) reasonParts.push(`${f.failedTransactions} failed transactions`);

      await db.collection('admin_alerts').add({
        type: 'ai_anomaly',
        uid: f.uid,
        message: `Unusual activity: ${f.email} — ${reasonParts.join(', ')}. Ask the AI Assistant for details.`,
        timestamp: FieldValue.serverTimestamp(),
        resolved: false
      });
    }
    console.log(`🔎 Proactive anomaly check: ${newlyFlagged.length} new pattern(s) flagged`);
  } catch (err) {
    console.error('❌ Proactive anomaly check error:', err.message);
    logSystemError('proactive_anomaly_check', err.message, { stack: err.stack });
  }
}

async function checkTransactionSummaries() {
  if (resolvePaymentProvider() !== 'airtel_direct') return; // no-op on PayChangu/mock, by design
  try {
    console.log('🔄 Checking live transaction summaries...');
    const rulesSnap = await db.collection('autosave_rules')
      .where('enabled', '==', true)
      .where('type', 'in', ['income_percent', 'roundup'])
      .get();

    if (rulesSnap.empty) { console.log('✅ No income/roundup rules to check'); return; }

    // Group rules by user so we only fetch each user's transaction
    // summary once per run, even if they have multiple rules
    const rulesByUid = {};
    rulesSnap.forEach(doc => {
      const rule = { id: doc.id, ...doc.data() };
      if (!rulesByUid[rule.uid]) rulesByUid[rule.uid] = [];
      rulesByUid[rule.uid].push(rule);
    });

    let triggered = 0;

    for (const [uid, rules] of Object.entries(rulesByUid)) {
      const userSnap = await db.collection('users').doc(uid).get();
      const user = userSnap.data();
      if (!user?.phone) continue;
      const isVerified = user.kycStatus === 'verified' || user.kycStatus === 'mock_verified';
      if (!isVerified) continue;

      const incomeRules = rules.filter(r => r.type === 'income_percent');
      const roundupRules = rules.filter(r => r.type === 'roundup');

      // --- Income rules: real credit detected ---
      for (const rule of incomeRules) {
        const trigger = await resolveIncomeTrigger(rule, new Date(), user);
        if (!trigger || trigger.source !== 'airtel_transaction_summary') continue;

        const amountToSave = Math.round(trigger.amountBase * (rule.percent / 100));
        if (amountToSave < SECURITY.MIN_SAVE_AMOUNT) continue;

        const executed = await executeAutosaveCollection(rule, user, amountToSave,
          `↻ Income detected — saved ${rule.percent}% (MWK ${amountToSave.toLocaleString()}) automatically.`);
        if (executed) triggered++;

        // Mark every credit we looked at as seen, whether or not it
        // ended up being the one we acted on, so it's never re-evaluated
        for (const tx of trigger.allCredits) {
          await db.collection('seen_wallet_transactions').doc(tx.id).set({
            uid, direction: 'credit', amount: tx.amount,
            seenAt: FieldValue.serverTimestamp()
          });
        }
      }

      // --- Roundup rules: real spend detected ---
      for (const rule of roundupRules) {
        const debits = await resolveRoundupTrigger(rule, user);
        if (!debits) continue;

        for (const tx of debits) {
          const roundedUp = Math.ceil(tx.amount / 500) * 500;
          const roundUpAmount = roundedUp - tx.amount;

          if (roundUpAmount >= 10) {
            const executed = await executeAutosaveCollection(rule, user, roundUpAmount,
              `🔄 Round-up: MWK ${roundUpAmount.toLocaleString()} saved automatically from a MWK ${tx.amount.toLocaleString()} spend.`,
              { type: 'roundup', spendAmount: tx.amount, roundedUp });
            if (executed) triggered++;
          }

          await db.collection('seen_wallet_transactions').doc(tx.id).set({
            uid, direction: 'debit', amount: tx.amount,
            seenAt: FieldValue.serverTimestamp()
          });
        }
      }
    }

    console.log(`✅ Transaction summary check complete — ${triggered} auto-save(s) triggered`);
  } catch (err) {
    console.error('❌ Transaction summary check error:', err.message);
    logSystemError('transaction_summary_poller', err.message, { stack: err.stack });
  }
}

// ----------------------------
// SHARED COLLECTION EXECUTOR
// Used by both the scheduled runAutosaveRules() job (weekly/monthly/
// declared-income) and the new checkTransactionSummaries() poller
// (real income/real spend) so there is exactly one code path that
// actually calls the payment provider and credits a goal — avoiding
// two subtly different implementations of "what happens when an
// auto-save succeeds".
// ----------------------------
async function executeAutosaveCollection(rule, user, amountToSave, notifyMessage, extraTxFields = {}) {
  try {
    const goalSnap = await db.collection('goals').doc(rule.goalId).get();
    const goal = goalSnap.data();
    if (!goal || goal.completed) return false;

    const { plan, config } = await getPlanConfig(rule.uid);
    const fee = calcFee(amountToSave, config.transactionFeePercent);
    const reference = generateRef();

    let succeeded = false;
    if (isMockMode()) {
      succeeded = true;
    } else {
      const result = await airtelCollect({ phone: user.phone, amount: amountToSave, reference });
      succeeded = isAirtelSuccess(result);
    }

    if (!succeeded) {
      await pushNotification(rule.uid, {
        type: 'autosave_failed',
        message: `⚠ Auto-save for ${goal.name} couldn't go through this time. Check your Airtel Money balance.`
      });
      return false;
    }

    await updateGoalProgress(rule.uid, rule.goalId, amountToSave);
    const txId = await logTransaction(rule.uid, {
      type: 'savings', amount: amountToSave, fee, feePercent: config.transactionFeePercent,
      goalId: rule.goalId, goalName: goal.name, reference,
      status: isMockMode() ? 'mock' : 'completed', phone: user.phone, plan,
      source: 'autosave_rule', ruleId: rule.id, ...extraTxFields
    });
    await logFee(rule.uid, { amount: fee, transactionId: txId, type: 'savings', plan });
    await pushNotification(rule.uid, { type: 'autosave_success', message: notifyMessage });
    await db.collection('autosave_rules').doc(rule.id).update({
      lastRun: FieldValue.serverTimestamp(), lastRunResult: 'success'
    });
    return true;
  } catch (err) {
    console.error(`❌ Auto-save execution failed for rule ${rule.id}:`, err.message);
    logSystemError('autosave_execution', err.message, { ruleId: rule.id, uid: rule.uid, stack: err.stack });
    await db.collection('autosave_rules').doc(rule.id).update({
      lastRun: FieldValue.serverTimestamp(), lastRunResult: 'error'
    }).catch(() => {});
    return false;
  }
}

// ----------------------------
// AUTO-SAVE: RULE EXECUTION
// Runs daily. Processes weekly, monthly, and income_percent rules
// (roundup rules are triggered directly from /api/roundup when a
// spend happens, not on a schedule, so they're not handled here).
//
// Reuses the exact same collection path as a manual save — same
// airtelCollect()/isAirtelSuccess() calls, same updateGoalProgress(),
// logTransaction(), logFee(), pushNotification() — so switching the
// underlying payment provider (Airtel direct vs PayChangu) requires
// zero changes here; that swap only ever happens inside airtelCollect()
// itself.
// ----------------------------
async function runAutosaveRules() {
  try {
    console.log('🔄 Running auto-save rules (weekly / monthly / declared-income)...');
    const today = new Date();
    const todayDow = today.getDay(); // 0=Sun..6=Sat
    const todayDate = today.getDate();
    const provider = resolvePaymentProvider();

    const snap = await db.collection('autosave_rules').where('enabled', '==', true).get();
    let processed = 0, skipped = 0, failed = 0;

    for (const doc of snap.docs) {
      const rule = { id: doc.id, ...doc.data() };

      // Avoid double-running the same rule twice in one calendar day
      // if the job ever gets triggered more than once (e.g. manual re-run)
      const lastRunDay = rule.lastRun ? new Date(toMillis(rule.lastRun)).toDateString() : null;
      if (lastRunDay === today.toDateString()) { skipped++; continue; }

      let amountToSave = null;
      let ruleLabel = '';

      if (rule.type === 'weekly') {
        // schedule stores which day of week, e.g. "MON".."SUN" — default Monday
        const days = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
        const targetDow = days[(rule.schedule || 'MON').toUpperCase()] ?? 1;
        if (todayDow !== targetDow) continue;
        amountToSave = rule.amount;
        ruleLabel = 'Weekly auto-save';
      } else if (rule.type === 'monthly') {
        // schedule stores day-of-month as a string, e.g. "1"
        const targetDate = parseInt(rule.schedule, 10) || 1;
        if (todayDate !== targetDate) continue;
        amountToSave = rule.amount;
        ruleLabel = 'Monthly auto-save';
      } else if (rule.type === 'income_percent' && provider !== 'airtel_direct') {
        // On Airtel direct, income_percent is handled by
        // checkTransactionSummaries() reacting to real incoming money —
        // this daily job only covers the PayChangu/mock declared-date path
        const userSnap = await db.collection('users').doc(rule.uid).get();
        const trigger = await resolveIncomeTrigger(rule, today, userSnap.data());
        if (!trigger) continue;
        amountToSave = Math.round(trigger.amountBase * (rule.percent / 100));
        ruleLabel = `Income auto-save (${rule.percent}% of declared income)`;
      } else {
        continue; // roundup, or income_percent already covered by the live poller
      }

      if (!amountToSave || amountToSave < SECURITY.MIN_SAVE_AMOUNT) { skipped++; continue; }

      const userSnap = await db.collection('users').doc(rule.uid).get();
      const user = userSnap.data();

      if (!user) { skipped++; continue; }
      const isVerified = user.kycStatus === 'verified' || user.kycStatus === 'mock_verified';
      if (!isVerified || !user.phone) {
        await doc.ref.update({ lastRun: FieldValue.serverTimestamp(), lastRunResult: 'skipped_kyc_required' });
        skipped++; continue;
      }

      const executed = await executeAutosaveCollection(rule, user, amountToSave,
        `↻ ${ruleLabel}: MWK ${amountToSave.toLocaleString()} saved automatically.`);
      if (executed) processed++; else failed++;
    }

    console.log(`✅ Auto-save run complete — ${processed} saved, ${skipped} skipped, ${failed} failed`);
  } catch (err) {
    console.error('❌ Auto-save job error:', err.message);
    logSystemError('autosave_job', err.message, { stack: err.stack });
  }
}

// ----------------------------
// STATIC FILES
// /admin serves the separate admin panel (admin/index.html, admin/admin.js, etc).
// Everything else falls back to the main app's index.html (SPA routing).
// ----------------------------
app.use('/admin', express.static(join(__dirname, 'admin')));

app.get('*', (req, res) => {
  if (req.path.startsWith('/admin')) {
    const adminIndex = join(__dirname, 'admin', 'index.html');
    if (existsSync(adminIndex)) return res.sendFile(adminIndex);
    return res.status(404).json({ success: false, error: 'Admin panel not deployed' });
  }

  const indexPath = join(__dirname, 'index.html');
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).json({
      status: 'ok',
      app: 'PocketVault API',
      message: 'Backend running. No frontend deployed yet.',
      health: '/api/health'
    });
  }
});


// ----------------------------
// GLOBAL ERROR HANDLER
// ----------------------------
app.use((err, req, res, next) => {
  const message = err.message || 'Unknown error';
  console.error('❌ Unhandled error:', message);
  logSystemError('express', message, { stack: err.stack, url: req.url, method: req.method });
  res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
});

// ----------------------------
// PROCESS SAFETY
// ----------------------------
process.on('uncaughtException', err => {
  console.error('💥 Uncaught:', err.message);
  logSystemError('uncaughtException', err.message, { stack: err.stack });
});
process.on('unhandledRejection', reason => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('💥 Rejection:', message);
  logSystemError('unhandledRejection', message, { stack: reason?.stack });
});

// ----------------------------
// BACKGROUND JOBS
// ----------------------------
setInterval(reconcilePendingTransactions, 5 * 60 * 1000);
setInterval(monitorFloat, 30 * 60 * 1000);
setInterval(checkExpiredSubscriptions, 24 * 60 * 60 * 1000);
setInterval(checkGoalDeadlines, 24 * 60 * 60 * 1000);
setInterval(runAutosaveRules, 24 * 60 * 60 * 1000);
setInterval(checkTransactionSummaries, 5 * 60 * 1000);
setInterval(proactiveAnomalyCheck, 15 * 60 * 1000);

setTimeout(reconcilePendingTransactions, 10000);
setTimeout(monitorFloat, 15000);
setTimeout(checkExpiredSubscriptions, 20000);
setTimeout(checkGoalDeadlines, 25000);
setTimeout(runAutosaveRules, 30000);
setTimeout(checkTransactionSummaries, 35000);
setTimeout(proactiveAnomalyCheck, 40000);

// ----------------------------
// START
// ----------------------------
const server = app.listen(PORT, () => {
  const _activePaymentProvider = resolvePaymentProvider();
  const _paymentProviderLabel = {
    airtel_direct: '✅ Airtel Direct',
    paychangu: '✅ PayChangu (bridge)',
    mock: '⏳ Mock mode — no provider configured'
  }[_activePaymentProvider];

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           💰 POCKETVAULT BACKEND v2.0 — READY 🚀               ║
╠══════════════════════════════════════════════════════════════╣
║  Port      : ${PORT}                                         ║
║  Database  : Firestore ✅                                    ║
║  Auth      : Firebase Token Verification ✅                  ║
║  Security  : Headers + CORS + Sanitizer + Rate limit ✅      ║
║  Payments  : ${_paymentProviderLabel}                        ║
║  Jobs      : Reconciler + Float monitor + Sub checker ✅     ║
╠══════════════════════════════════════════════════════════════╣
║  REVENUE STREAMS                                             ║
║  ✅ Transaction fees (plan-based: 0.5% - 1%)                 ║
║  ✅ Subscription plans (Free/Pro/Business)                   ║
║  ✅ Merchant collection & disbursement fees                  ║
║  ✅ Round-up savings fees                                    ║
║  ✅ Float monitoring for interest tracking                   ║
║  ✅ Admin revenue dashboard                                  ║
╠══════════════════════════════════════════════════════════════╣
║  PLANS                                                       ║
║  Free     : MWK 0    — 2 goals, 1% fee                      ║
║  Pro      : MWK 2,500 — 20 goals, 0.75% fee                 ║
║  Business : MWK 8,000 — 100 goals, 0.5% fee + merchant      ║
╚══════════════════════════════════════════════════════════════╝
  `);

  // ----------------------------
  // SECURITY STARTUP CHECKS
  // Loud, impossible-to-miss warnings for misconfigurations
  // that would leave the app exposed.
  // ----------------------------
  if (!process.env.ADMIN_SECRET) {
    console.warn('🚨 SECURITY WARNING: ADMIN_SECRET is not set. The admin panel is completely inaccessible until this is configured — set it in Render environment variables.');
  }
  if (_activePaymentProvider === 'airtel_direct' && !SECURITY.AIRTEL_WEBHOOK_SECRET) {
    console.warn('🚨 SECURITY WARNING: Airtel direct is active but AIRTEL_WEBHOOK_SECRET is NOT set. The webhook endpoint will accept unauthenticated requests. Set AIRTEL_WEBHOOK_SECRET before going live with real money.');
  }
  if (_activePaymentProvider === 'paychangu' && !PAYCHANGU.WEBHOOK_SECRET) {
    console.warn('🚨 SECURITY WARNING: PayChangu is active but PAYCHANGU_WEBHOOK_SECRET is NOT set. The PayChangu webhook endpoint will accept unauthenticated requests. Set PAYCHANGU_WEBHOOK_SECRET before going live with real money.');
  }
  if (_activePaymentProvider === 'mock') {
    console.log('ℹ️  Running in mock mode — no AIRTEL_CLIENT_ID or PAYCHANGU_SECRET_KEY configured yet. All payments will be simulated instantly.');
  }
  const activeProvider = resolveAIProvider();
  const providerNames = { anthropic: 'Anthropic (Claude)', gemini: 'Google (Gemini)', groq: 'Groq (Llama)' };
  if (!activeProvider) {
    console.log('ℹ️  No AI provider configured — set ANTHROPIC_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY to enable admin AI features (chat assistant, anomaly detection, message drafting, insights, error analysis).');
  } else {
    console.log(`✅ AI features configured — using ${providerNames[activeProvider]}. Chat assistant, anomaly detection, message drafting, insights, and error analysis are live.`);
  }
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  server.close(() => process.exit(0));
});

export default app;
