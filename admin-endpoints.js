/**
 * PocketVault — Admin Endpoints
 *
 * New routes for the admin dashboard (admin.html).
 * All routes here are protected by `requireAdminSecret`, the same pattern
 * used by the existing GET /api/admin/revenue endpoint:
 *
 *   function requireAdminSecret(req, res, next) {
 *     const provided = req.headers['x-admin-secret'];
 *     if (!provided || provided !== process.env.ADMIN_SECRET) {
 *       return res.status(401).json({ error: 'Unauthorized' });
 *     }
 *     next();
 *   }
 *
 * Mount everything below under that middleware, e.g.:
 *   const adminRouter = require('./admin-endpoints')(deps);
 *   app.use('/api/admin', requireAdminSecret, adminRouter);
 *
 * `deps` is an object containing references to things that already exist
 * in server.js, so this file doesn't redefine them:
 *   {
 *     db,                  // Firestore instance
 *     PLANS,               // plans config object
 *     toMillis,            // timestamp -> number helper
 *     sanitize,            // string sanitizer
 *     pushNotification,    // (uid, data) => writes to notifications
 *     logAdminAction,      // (action) => writes to admin_actions (new helper, defined below)
 *     clearPlanCache,      // (uid) => clears the 60s plan cache for a user
 *     runReconciliation,   // (referenceFilter?) => runs the reconciliation job, optionally for one tx
 *     checkAirtelTransactionStatus, // (reference) => calls Airtel Transaction Summary API
 *     getCachedFloat,      // () => last known float value + threshold
 *   }
 */

const express = require('express');

module.exports = function adminEndpoints(deps) {
  const {
    db,
    PLANS,
    toMillis,
    sanitize,
    pushNotification,
    logAdminAction,
    clearPlanCache,
    runReconciliation,
    checkAirtelTransactionStatus,
    getCachedFloat,
  } = deps;

  const router = express.Router();

  // Small helper to wrap async route handlers (mirrors the existing
  // asyncHandler pattern described in the backend blueprint).
  const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

  // ---------------------------------------------------------------------
  // OVERVIEW
  // ---------------------------------------------------------------------

  // GET /api/admin/overview
  // Quick summary stats for the Overview page: user counts by plan,
  // today's revenue, current float, recent unresolved alerts.
  router.get('/overview', asyncHandler(async (req, res) => {
    const usersSnap = await db.collection('users').get();

    const planCounts = { free: 0, pro: 0, business: 0 };
    usersSnap.forEach((doc) => {
      const plan = (doc.data().plan || 'free').toLowerCase();
      if (planCounts[plan] !== undefined) planCounts[plan] += 1;
      else planCounts.free += 1;
    });

    // Today's revenue: sum platform_fees created since midnight (server local time).
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const feesSnap = await db.collection('platform_fees').get();
    let todayRevenue = 0;
    let totalRevenue = 0;
    feesSnap.forEach((doc) => {
      const data = doc.data();
      const amount = Number(data.amount) || 0;
      totalRevenue += amount;
      if (toMillis(data.timestamp) >= startOfDay.getTime()) {
        todayRevenue += amount;
      }
    });

    const float = await getCachedFloat();

    const alertsSnap = await db
      .collection('admin_alerts')
      .where('resolved', '==', false)
      .get();

    res.json({
      mockMode: !process.env.AIRTEL_CLIENT_ID,
      userCounts: {
        total: usersSnap.size,
        ...planCounts,
      },
      revenue: {
        today: todayRevenue,
        allTime: totalRevenue,
      },
      float: {
        value: float.value,
        threshold: float.threshold,
        low: float.value < float.threshold,
        updatedAt: float.updatedAt || null,
      },
      unresolvedAlertCount: alertsSnap.size,
    });
  }));

  // ---------------------------------------------------------------------
  // REVENUE
  // ---------------------------------------------------------------------

  // GET /api/admin/revenue?period=today|7d|30d|all
  // Extends the original admin revenue summary with a date-range filter
  // and active-subscription counts, matching what admin.html's Revenue
  // page expects.
  router.get('/revenue', asyncHandler(async (req, res) => {
    const { period = '30d' } = req.query;

    const now = Date.now();
    let cutoff = 0;
    if (period === 'today') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      cutoff = start.getTime();
    } else if (period === '7d') {
      cutoff = now - 7 * 24 * 60 * 60 * 1000;
    } else if (period === '30d') {
      cutoff = now - 30 * 24 * 60 * 60 * 1000;
    } // 'all' -> cutoff stays 0

    const feesSnap = await db.collection('platform_fees').get();

    let allTimeTotal = 0;
    let periodTotal = 0;
    const byType = {};

    feesSnap.forEach((doc) => {
      const data = doc.data();
      const amount = Number(data.amount) || 0;
      const ts = toMillis(data.timestamp);
      const type = data.type || 'other';

      allTimeTotal += amount;

      if (!byType[type]) byType[type] = { count: 0, total: 0 };
      // byType reflects the selected period, not all-time.
      if (ts >= cutoff) {
        periodTotal += amount;
        byType[type].count += 1;
        byType[type].total += amount;
      }
    });

    // Revenue by plan: join users -> plan with their fee contributions.
    const usersSnap = await db.collection('users').get();
    const planByUid = {};
    const byPlan = { free: { userCount: 0, total: 0 }, pro: { userCount: 0, total: 0 }, business: { userCount: 0, total: 0 } };
    let activePro = 0;
    let activeBusiness = 0;

    usersSnap.forEach((doc) => {
      const data = doc.data();
      const plan = (data.plan || 'free').toLowerCase();
      planByUid[doc.id] = plan;
      if (byPlan[plan]) byPlan[plan].userCount += 1;
      if (plan === 'pro' && data.subscriptionActive) activePro += 1;
      if (plan === 'business' && data.subscriptionActive) activeBusiness += 1;
    });

    feesSnap.forEach((doc) => {
      const data = doc.data();
      const ts = toMillis(data.timestamp);
      if (ts < cutoff) return;
      const amount = Number(data.amount) || 0;
      const plan = planByUid[data.uid] || 'free';
      if (byPlan[plan]) byPlan[plan].total += amount;
    });

    res.json({
      period,
      periodTotal,
      allTimeTotal,
      byType,
      byPlan,
      activeSubscriptions: { pro: activePro, business: activeBusiness },
    });
  }));

  // ---------------------------------------------------------------------
  // USERS
  // ---------------------------------------------------------------------

  // GET /api/admin/users?search=&plan=&cursor=&limit=
  // Paginated user list. Search matches on displayName/email prefix
  // (Firestore range query); plan filters by exact plan value.
  // Pagination is cursor-based using the document ID for stability.
  router.get('/users', asyncHandler(async (req, res) => {
    const { search = '', plan = '', cursor = '', limit = '25' } = req.query;
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);

    let query = db.collection('users');

    if (plan) {
      query = query.where('plan', '==', plan.toLowerCase());
    }

    // Fetch a generous batch and filter/search in code, consistent with
    // the "sort/filter in JS, avoid composite indexes" approach used
    // elsewhere in the backend.
    const snap = await query.get();

    let users = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        uid: doc.id,
        displayName: data.displayName || '',
        email: data.email || '',
        plan: data.plan || 'free',
        subscriptionActive: !!data.subscriptionActive,
        subscriptionExpiry: data.subscriptionExpiry
          ? toMillis(data.subscriptionExpiry)
          : null,
        kycStatus: data.kycStatus || 'unverified',
        createdAt: data.createdAt ? toMillis(data.createdAt) : null,
        airtelBalanceCache: data.airtelBalanceCache ?? null,
      };
    });

    if (search) {
      const term = search.toLowerCase();
      users = users.filter(
        (u) =>
          u.displayName.toLowerCase().includes(term) ||
          u.email.toLowerCase().includes(term) ||
          u.uid.toLowerCase().includes(term)
      );
    }

    // Sort newest first by createdAt.
    users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // Cursor pagination over the in-memory array.
    let startIndex = 0;
    if (cursor) {
      const idx = users.findIndex((u) => u.uid === cursor);
      startIndex = idx >= 0 ? idx + 1 : 0;
    }

    const page = users.slice(startIndex, startIndex + pageSize);
    const nextCursor =
      startIndex + pageSize < users.length
        ? page[page.length - 1].uid
        : null;

    res.json({
      users: page,
      nextCursor,
      total: users.length,
    });
  }));

  // GET /api/admin/users/:uid
  // Full detail view: profile, goals, recent transactions, autosave rules.
  router.get('/users/:uid', asyncHandler(async (req, res) => {
    const { uid } = req.params;

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [goalsSnap, txSnap, rulesSnap] = await Promise.all([
      db.collection('goals').where('uid', '==', uid).get(),
      db.collection('transactions').where('uid', '==', uid).get(),
      db.collection('autosave_rules').where('uid', '==', uid).get(),
    ]);

    const goals = goalsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const transactions = txSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp))
      .slice(0, 20);

    const autosaveRules = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    res.json({
      uid,
      profile: userDoc.data(),
      goals,
      transactions,
      autosaveRules,
    });
  }));

  // PATCH /api/admin/users/:uid/plan
  // body: { plan: 'free'|'pro'|'business', expiryDate?: ISOString, note: string }
  // Admin override of a user's plan. Always logged to admin_actions.
  router.patch('/users/:uid/plan', asyncHandler(async (req, res) => {
    const { uid } = req.params;
    const { plan, expiryDate, note } = req.body;

    if (!plan || !PLANS[plan]) {
      return res.status(400).json({ error: 'Invalid plan name' });
    }
    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'A note is required for plan changes' });
    }

    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const before = {
      plan: userDoc.data().plan || 'free',
      subscriptionActive: !!userDoc.data().subscriptionActive,
      subscriptionExpiry: userDoc.data().subscriptionExpiry || null,
    };

    const update = {
      plan: plan.toLowerCase(),
      subscriptionActive: plan.toLowerCase() !== 'free',
    };

    if (plan.toLowerCase() === 'free') {
      update.subscriptionExpiry = null;
    } else {
      // Default to 30 days from now if no expiry given.
      const expiry = expiryDate
        ? new Date(expiryDate)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      update.subscriptionExpiry = expiry;
    }

    await userRef.update(update);
    clearPlanCache(uid);

    await logAdminAction({
      action: 'plan_override',
      targetUid: uid,
      before,
      after: { plan: update.plan, subscriptionActive: update.subscriptionActive, subscriptionExpiry: update.subscriptionExpiry },
      note: sanitize(note),
    });

    await pushNotification(uid, {
      type: 'admin_message',
      title: 'Your plan was updated',
      body: `Your PocketVault plan is now ${PLANS[update.plan].name || update.plan}.`,
    });

    res.json({ success: true, plan: update.plan });
  }));

  // PATCH /api/admin/users/:uid/kyc
  // body: { status: 'verified'|'failed'|'unverified', legalName?: string, note: string }
  router.patch('/users/:uid/kyc', asyncHandler(async (req, res) => {
    const { uid } = req.params;
    const { status, legalName, note } = req.body;

    const validStatuses = ['verified', 'failed', 'unverified'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid KYC status' });
    }
    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'A note is required for KYC overrides' });
    }

    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const before = {
      kycStatus: userDoc.data().kycStatus || 'unverified',
      legalName: userDoc.data().legalName || null,
    };

    const update = { kycStatus: status };
    if (legalName) update.legalName = sanitize(legalName);

    await userRef.update(update);

    await logAdminAction({
      action: 'kyc_override',
      targetUid: uid,
      before,
      after: { kycStatus: status, legalName: update.legalName ?? before.legalName },
      note: sanitize(note),
    });

    res.json({ success: true, kycStatus: status });
  }));

  // POST /api/admin/users/:uid/message
  // body: { title: string, body: string }
  // Sends a single notification to one user.
  router.post('/users/:uid/message', asyncHandler(async (req, res) => {
    const { uid } = req.params;
    const { title, body } = req.body;

    if (!title || !title.trim() || !body || !body.trim()) {
      return res.status(400).json({ error: 'Title and body are required' });
    }

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pushNotification(uid, {
      type: 'admin_message',
      title: sanitize(title),
      body: sanitize(body),
    });

    await logAdminAction({
      action: 'send_message',
      targetUid: uid,
      before: null,
      after: { title: sanitize(title), body: sanitize(body) },
      note: 'Direct message sent via admin dashboard',
    });

    res.json({ success: true });
  }));

  // ---------------------------------------------------------------------
  // BROADCAST MESSAGING
  // ---------------------------------------------------------------------

  // POST /api/admin/broadcast
  // body: { title: string, body: string, targetPlan?: 'free'|'pro'|'business'|'all' }
  // Sends a notification to all users matching the target. Runs in the
  // background and responds immediately with a queued status, since this
  // can be a large number of writes.
  router.post('/broadcast', asyncHandler(async (req, res) => {
    const { title, body, targetPlan = 'all' } = req.body;

    if (!title || !title.trim() || !body || !body.trim()) {
      return res.status(400).json({ error: 'Title and body are required' });
    }

    let query = db.collection('users');
    if (targetPlan !== 'all') {
      if (!PLANS[targetPlan]) {
        return res.status(400).json({ error: 'Invalid target plan' });
      }
      query = query.where('plan', '==', targetPlan.toLowerCase());
    }

    const snap = await query.get();
    const recipientCount = snap.size;

    const cleanTitle = sanitize(title);
    const cleanBody = sanitize(body);

    // Respond immediately, then send in the background.
    res.json({ success: true, status: 'queued', recipientCount });

    (async () => {
      for (const doc of snap.docs) {
        try {
          await pushNotification(doc.id, {
            type: 'admin_message',
            title: cleanTitle,
            body: cleanBody,
          });
        } catch (err) {
          console.error(`Broadcast failed for user ${doc.id}:`, err);
        }
      }

      await logAdminAction({
        action: 'broadcast_message',
        targetUid: null,
        before: null,
        after: { title: cleanTitle, body: cleanBody, targetPlan, recipientCount },
        note: `Broadcast sent to ${recipientCount} user(s) [${targetPlan}]`,
      });
    })().catch((err) => console.error('Broadcast background job error:', err));
  }));

  // ---------------------------------------------------------------------
  // TRANSACTIONS
  // ---------------------------------------------------------------------

  // GET /api/admin/transactions?type=&status=&plan=&limit=
  // Global transaction feed across all users.
  router.get('/transactions', asyncHandler(async (req, res) => {
    const { type = '', status = '', limit = '50' } = req.query;
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const snap = await db.collection('transactions').get();

    let transactions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (type) transactions = transactions.filter((t) => t.type === type);
    if (status) transactions = transactions.filter((t) => t.status === status);

    transactions.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
    transactions = transactions.slice(0, pageSize);

    res.json({ transactions });
  }));

  // POST /api/admin/transactions/:reference/recheck
  // Calls Airtel's Transaction Summary API for one reference and returns
  // the live status. Does not write anything by itself — reconciliation
  // is a separate explicit action.
  router.post('/transactions/:reference/recheck', asyncHandler(async (req, res) => {
    const { reference } = req.params;

    const txSnap = await db
      .collection('transactions')
      .where('reference', '==', reference)
      .limit(1)
      .get();

    if (txSnap.empty) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const result = await checkAirtelTransactionStatus(reference);

    res.json({
      reference,
      currentStatus: txSnap.docs[0].data().status,
      airtelStatus: result,
    });
  }));

  // POST /api/admin/reconcile
  // body: { reference?: string }
  // Triggers the reconciliation job immediately, either globally (for all
  // pending transactions older than 2 minutes) or for one specific
  // reference.
  router.post('/reconcile', asyncHandler(async (req, res) => {
    const { reference } = req.body || {};

    const result = await runReconciliation(reference || null);

    await logAdminAction({
      action: 'manual_reconciliation',
      targetUid: null,
      before: null,
      after: { reference: reference || 'all-pending', result },
      note: reference
        ? `Manual reconciliation triggered for ${reference}`
        : 'Manual reconciliation triggered for all pending transactions',
    });

    res.json({ success: true, result });
  }));

  // ---------------------------------------------------------------------
  // FLOAT & ALERTS
  // ---------------------------------------------------------------------

  // GET /api/admin/float-history?limit=
  router.get('/float-history', asyncHandler(async (req, res) => {
    const { limit = '50' } = req.query;
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const snap = await db.collection('float_monitor').get();

    const history = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp))
      .slice(0, pageSize);

    res.json({ history });
  }));

  // GET /api/admin/alerts?resolved=
  router.get('/alerts', asyncHandler(async (req, res) => {
    const { resolved } = req.query;

    let query = db.collection('admin_alerts');
    if (resolved === 'true' || resolved === 'false') {
      query = query.where('resolved', '==', resolved === 'true');
    }

    const snap = await query.get();

    const alerts = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));

    res.json({ alerts });
  }));

  // PATCH /api/admin/alerts/:alertId
  // body: { resolved: boolean }
  router.patch('/alerts/:alertId', asyncHandler(async (req, res) => {
    const { alertId } = req.params;
    const { resolved } = req.body;

    if (typeof resolved !== 'boolean') {
      return res.status(400).json({ error: '`resolved` must be a boolean' });
    }

    const alertRef = db.collection('admin_alerts').doc(alertId);
    const alertDoc = await alertRef.get();
    if (!alertDoc.exists) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    await alertRef.update({
      resolved,
      resolvedAt: resolved ? new Date() : null,
    });

    res.json({ success: true, resolved });
  }));

  return router;
};

/**
 * ---------------------------------------------------------------------
 * Supporting helper: logAdminAction
 * ---------------------------------------------------------------------
 * Add this alongside the other shared helper functions (Section 7 of the
 * backend blueprint). Writes an entry to a new `admin_actions` collection
 * for audit purposes whenever an admin makes a change that affects a
 * user's plan, KYC status, or sends a message.
 *
 *   async function logAdminAction({ action, targetUid, before, after, note }) {
 *     await db.collection('admin_actions').add({
 *       action,
 *       targetUid: targetUid || null,
 *       before: before || null,
 *       after: after || null,
 *       note: note || '',
 *       timestamp: admin.firestore.FieldValue.serverTimestamp(),
 *     });
 *   }
 *
 * ---------------------------------------------------------------------
 * Supporting helper: getCachedFloat
 * ---------------------------------------------------------------------
 * Reads the most recent float_monitor snapshot and FLOAT_THRESHOLD env var.
 *
 *   async function getCachedFloat() {
 *     const snap = await db.collection('float_monitor')
 *       .orderBy('timestamp', 'desc') // or fetch-all + sort in JS per existing pattern
 *       .limit(1).get();
 *     const latest = snap.docs[0]?.data();
 *     return {
 *       value: latest?.balance ?? 0,
 *       threshold: Number(process.env.FLOAT_THRESHOLD) || 50000,
 *       updatedAt: latest?.timestamp ? toMillis(latest.timestamp) : null,
 *     };
 *   }
 *
 * ---------------------------------------------------------------------
 * Supporting helper: runReconciliation(referenceFilter)
 * ---------------------------------------------------------------------
 * Refactor the existing reconciliation job (Section 9) into a callable
 * function so both the cron schedule and this manual endpoint can use it.
 * If `referenceFilter` is provided, only check that one transaction;
 * otherwise check all transactions with status: "pending" older than 2 min.
 * Returns a small summary object, e.g.:
 *   { checked: 3, updatedToCompleted: 1, updatedToFailed: 0 }
 *
 * ---------------------------------------------------------------------
 * Supporting helper: checkAirtelTransactionStatus(reference)
 * ---------------------------------------------------------------------
 * Thin wrapper around the existing Airtel Transaction Summary API call
 * used by GET /api/transactions/:reference/status — reused here so the
 * admin recheck endpoint doesn't duplicate that logic.
 */
