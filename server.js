import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ----------------------------
// FIREBASE ADMIN
// ----------------------------
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
});
const db = getDatabase();

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
// IN-MEMORY CACHE
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

function clearCache(key) {
  cache.delete(key);
}

// Auto-clean cache every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of cache.entries()) {
    if (now > val.expiry) cache.delete(key);
  }
}, 5 * 60 * 1000);

// ----------------------------
// AIRTEL REQUEST QUEUE
// Prevents hitting Airtel rate limits
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
  try {
    const result = await task();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    airtelProcessing = false;
    // Small delay between Airtel calls
    setTimeout(processAirtelQueue, 200);
  }
}

// ----------------------------
// ASYNC ERROR HANDLER
// Catches errors without crashing server
// ----------------------------
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ----------------------------
// RATE LIMITER (no extra package)
// ----------------------------
const rateLimitMap = new Map();

function rateLimit(maxRequests = 100, windowMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const record = rateLimitMap.get(key) || { count: 0, start: now };

    if (now - record.start > windowMs) {
      record.count = 1;
      record.start = now;
    } else {
      record.count++;
    }

    rateLimitMap.set(key, record);

    if (record.count > maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please slow down.'
      });
    }

    next();
  };
}

// Clean rate limit map every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now - val.start > 15 * 60 * 1000) rateLimitMap.delete(key);
  }
}, 15 * 60 * 1000);

// ----------------------------
// AIRTEL TOKEN MANAGER
// Auto-refreshes before expiry
// ----------------------------
let _token = null;
let _tokenExpiry = null;
let _tokenRefreshing = false;

async function getAirtelToken() {
  // Return cached token if valid (5 min buffer)
  if (_token && _tokenExpiry && Date.now() < _tokenExpiry - 300000) {
    return _token;
  }

  // Prevent multiple simultaneous refresh calls
  if (_tokenRefreshing) {
    await new Promise(r => setTimeout(r, 500));
    return getAirtelToken();
  }

  _tokenRefreshing = true;

  try {
    console.log('🔑 Refreshing Airtel token...');
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
    if (!data.access_token) throw new Error('No token returned: ' + JSON.stringify(data));

    _token = data.access_token;
    _tokenExpiry = Date.now() + (data.expires_in || 7200) * 1000;
    console.log('✅ Airtel token refreshed');
    return _token;

  } catch (err) {
    console.error('❌ Token refresh failed:', err.message);
    throw err;
  } finally {
    _tokenRefreshing = false;
  }
}

// ----------------------------
// AIRTEL API CALLS
// All go through the queue
// ----------------------------
async function airtelBalance(type = 'COLL') {
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

async function airtelDisburse({ phone, amount, reference }) {
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
    return { ...(await res.json()), txnId };
  });
}

async function airtelCollect({ phone, amount, reference }) {
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
    return { ...(await res.json()), txnId };
  });
}

async function airtelKYC(phone) {
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

// ----------------------------
// HELPERS
// ----------------------------
function generateRef() {
  return `SPR_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function calcFee(amount, percent = 1) {
  return Math.ceil(amount * (percent / 100));
}

function isAirtelSuccess(result) {
  return (
    result?.status?.code === '200' ||
    result?.status?.success === true ||
    result?.data?.transaction?.status === 'TS'
  );
}

async function logTransaction(uid, data) {
  return db.ref(`users/${uid}/transactions`).push({
    ...data,
    timestamp: Date.now()
  });
}

async function updateGoalProgress(uid, goalId, amount) {
  const goalRef = db.ref(`users/${uid}/goals/${goalId}`);
  const snap = await goalRef.get();
  const goal = snap.val();
  if (!goal) return null;
  const newSaved = (goal.saved || 0) + amount;
  const completed = newSaved >= goal.target;
  await goalRef.update({ saved: newSaved, completed, lastUpdated: Date.now() });
  return { ...goal, saved: newSaved, completed };
}

async function pushNotification(uid, { type, message }) {
  return db.ref(`users/${uid}/notifications`).push({
    type, message,
    timestamp: Date.now(),
    read: false
  });
}

// ----------------------------
// APP SETUP
// ----------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));
app.set('trust proxy', 1);

// Apply rate limiting to all API routes
app.use('/api/', rateLimit(100, 15 * 60 * 1000));

// Stricter limit for Airtel money actions
app.use('/api/save', rateLimit(10, 60 * 1000));
app.use('/api/merchant/collect', rateLimit(20, 60 * 1000));
app.use('/api/merchant/disburse', rateLimit(20, 60 * 1000));

// ----------------------------
// HEALTH CHECK
// Set this as Render health check URL
// ----------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'SaverPro',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    airtel: AIRTEL.CLIENT_ID ? 'configured' : 'pending_approval',
    queue: airtelQueue.length,
    cache: cache.size,
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
  });
});

// ----------------------------
// USER: ONBOARD / UPDATE PROFILE
// POST /api/profile
// ----------------------------
app.post('/api/profile', asyncHandler(async (req, res) => {
  const { uid, name, phone, plan } = req.body;
  if (!uid) return res.status(400).json({ success: false, error: 'uid required' });

  await db.ref(`users/${uid}/profile`).update({
    name: name || null,
    phone: phone || null,
    plan: plan || 'free',
    updatedAt: Date.now()
  });

  clearCache(`profile_${uid}`);
  res.json({ success: true });
}));

// ----------------------------
// USER: KYC — VERIFY PHONE NUMBER
// POST /api/kyc
// Body: { uid, phone }
// ----------------------------
app.post('/api/kyc', asyncHandler(async (req, res) => {
  const { uid, phone } = req.body;
  if (!uid || !phone) {
    return res.status(400).json({ success: false, error: 'uid and phone required' });
  }

  // Mock if Airtel not configured
  if (!AIRTEL.CLIENT_ID) {
    await db.ref(`users/${uid}/profile`).update({
      phone,
      phoneVerified: true,
      kycStatus: 'mock_verified',
      kycAt: Date.now()
    });
    return res.json({
      success: true,
      mock: true,
      message: 'Phone verified (mock mode — Airtel pending)',
      name: 'Verified User'
    });
  }

  const result = await airtelKYC(phone);
  const verified = result?.data?.is_barred === false || result?.status?.code === '200';
  const registeredName = result?.data?.first_name
    ? `${result.data.first_name} ${result.data.last_name || ''}`.trim()
    : null;

  await db.ref(`users/${uid}/profile`).update({
    phone,
    phoneVerified: verified,
    kycStatus: verified ? 'verified' : 'failed',
    kycName: registeredName || null,
    kycAt: Date.now()
  });

  clearCache(`profile_${uid}`);

  res.json({
    success: verified,
    verified,
    name: registeredName,
    message: verified
      ? `Phone verified. Registered name: ${registeredName}`
      : 'Phone verification failed'
  });
}));

// ----------------------------
// BALANCE: GET AIRTEL WALLET BALANCE
// GET /api/airtel/balance?uid=xxx
// ----------------------------
app.get('/api/airtel/balance', asyncHandler(async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ success: false, error: 'uid required' });

  // Mock if Airtel not ready
  if (!AIRTEL.CLIENT_ID) {
    return res.json({ success: true, mock: true, balance: 37600, currency: 'MWK' });
  }

  // Cache balance per user for 30 seconds
  const data = await getCached(
    `balance_${uid}`,
    () => airtelBalance('COLL'),
    30000
  );

  const balance = parseFloat(data?.data?.balance || 0);

  // Update Firebase so dashboard gets real-time update
  await db.ref(`users/${uid}/airtelBalance`).set({
    amount: balance,
    currency: data?.data?.currency || 'MWK',
    status: data?.data?.account_status,
    lastSync: Date.now()
  });

  res.json({ success: true, balance, currency: 'MWK', raw: data });
}));

// ----------------------------
// GOALS: CREATE
// POST /api/goals
// Body: { uid, name, target, deadline, emoji, lockType }
// ----------------------------
app.post('/api/goals', asyncHandler(async (req, res) => {
  const { uid, name, target, deadline, emoji, lockType } = req.body;
  if (!uid || !name || !target) {
    return res.status(400).json({ success: false, error: 'uid, name, target required' });
  }
  if (parseFloat(target) < 500) {
    return res.status(400).json({ success: false, error: 'Minimum goal target is MWK 500' });
  }

  const goal = {
    name,
    target: parseFloat(target),
    saved: 0,
    deadline: deadline || null,
    emoji: emoji || '🎯',
    lockType: lockType || 'flexible',
    locked: lockType === 'hard',
    completed: false,
    createdAt: Date.now()
  };

  const ref = await db.ref(`users/${uid}/goals`).push(goal);
  clearCache(`goals_${uid}`);

  res.json({ success: true, goalId: ref.key, goal });
}));

// ----------------------------
// GOALS: GET ALL
// GET /api/goals?uid=xxx
// ----------------------------
app.get('/api/goals', asyncHandler(async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ success: false, error: 'uid required' });

  const goals = await getCached(
    `goals_${uid}`,
    async () => {
      const snap = await db.ref(`users/${uid}/goals`).get();
      return snap.val() || {};
    },
    15000 // Cache goals for 15 seconds
  );

  res.json({ success: true, goals });
}));

// ----------------------------
// GOALS: UPDATE
// PATCH /api/goals/:goalId
// ----------------------------
app.patch('/api/goals/:goalId', asyncHandler(async (req, res) => {
  const { uid, name, target, deadline, emoji, lockType } = req.body;
  const { goalId } = req.params;
  if (!uid || !goalId) return res.status(400).json({ success: false, error: 'uid and goalId required' });

  const snap = await db.ref(`users/${uid}/goals/${goalId}`).get();
  const goal = snap.val();
  if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
  if (goal.completed) return res.status(400).json({ success: false, error: 'Cannot edit completed goal' });

  const updates = {};
  if (name) updates.name = name;
  if (target) updates.target = parseFloat(target);
  if (deadline) updates.deadline = deadline;
  if (emoji) updates.emoji = emoji;
  if (lockType) { updates.lockType = lockType; updates.locked = lockType === 'hard'; }
  updates.updatedAt = Date.now();

  await db.ref(`users/${uid}/goals/${goalId}`).update(updates);
  clearCache(`goals_${uid}`);

  res.json({ success: true });
}));

// ----------------------------
// SAVE: TRANSFER MONEY TO GOAL
// POST /api/save
// Body: { uid, goalId, amount, phone }
// ----------------------------
app.post('/api/save', asyncHandler(async (req, res) => {
  const { uid, goalId, amount, phone } = req.body;

  // Validate
  if (!uid || !goalId || !amount || !phone) {
    return res.status(400).json({ success: false, error: 'uid, goalId, amount, phone required' });
  }
  if (parseFloat(amount) < 100) {
    return res.status(400).json({ success: false, error: 'Minimum save amount is MWK 100' });
  }

  // Get goal
  const goalSnap = await db.ref(`users/${uid}/goals/${goalId}`).get();
  const goal = goalSnap.val();
  if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
  if (goal.completed) return res.status(400).json({ success: false, error: 'Goal already completed' });
  if (goal.locked && goal.lockType === 'hard') {
    return res.status(400).json({ success: false, error: 'Goal is locked' });
  }

  const parsedAmount = parseFloat(amount);
  const fee = calcFee(parsedAmount, 1);
  const reference = generateRef();

  // Mock mode
  if (!AIRTEL.CLIENT_ID) {
    const updated = await updateGoalProgress(uid, goalId, parsedAmount);
    await logTransaction(uid, {
      type: 'savings', amount: parsedAmount, fee,
      goalId, goalName: goal.name, reference,
      status: 'mock', note: 'Airtel pending approval'
    });
    await pushNotification(uid, {
      type: 'savings_success',
      message: `💰 Saved MWK ${parsedAmount.toLocaleString()} to ${goal.name}. Progress: ${Math.round((updated.saved / updated.target) * 100)}%`
    });
    clearCache(`goals_${uid}`);
    return res.json({
      success: true, mock: true,
      message: `MWK ${parsedAmount} queued for ${goal.name}`,
      reference, fee, goal: updated
    });
  }

  // Real Airtel disbursement
  const result = await airtelDisburse({ phone, amount: parsedAmount, reference });

  if (isAirtelSuccess(result)) {
    const updated = await updateGoalProgress(uid, goalId, parsedAmount);
    await logTransaction(uid, {
      type: 'savings', amount: parsedAmount, fee,
      goalId, goalName: goal.name, reference,
      airtelTxnId: result.txnId,
      airtelRef: result?.data?.transaction?.id,
      status: 'completed'
    });
    await pushNotification(uid, {
      type: 'savings_success',
      message: updated.completed
        ? `🎉 Goal complete! You reached your ${goal.name} target!`
        : `💰 Saved MWK ${parsedAmount.toLocaleString()} to ${goal.name}. ${Math.round((updated.saved / updated.target) * 100)}% done.`
    });
    clearCache(`goals_${uid}`);
    res.json({ success: true, message: `MWK ${parsedAmount} saved`, reference, fee, goal: updated });
  } else {
    await logTransaction(uid, {
      type: 'savings', amount: parsedAmount, goalId,
      reference, status: 'failed', error: JSON.stringify(result)
    });
    res.status(400).json({ success: false, error: 'Transfer failed', details: result });
  }
}));

// ----------------------------
// AUTOSAVE: CREATE RULE
// POST /api/autosave/rules
// Body: { uid, type, amount, goalId, schedule, percent }
// ----------------------------
app.post('/api/autosave/rules', asyncHandler(async (req, res) => {
  const { uid, type, amount, goalId, schedule, percent, enabled } = req.body;
  if (!uid || !type || !goalId) {
    return res.status(400).json({ success: false, error: 'uid, type, goalId required' });
  }

  const rule = {
    type, goalId,
    amount: amount ? parseFloat(amount) : null,
    percent: percent ? parseFloat(percent) : null,
    schedule: schedule || null,
    enabled: enabled !== false,
    createdAt: Date.now(),
    lastRun: null
  };

  const ref = await db.ref(`users/${uid}/autosave_rules`).push(rule);
  res.json({ success: true, ruleId: ref.key, rule });
}));

// ----------------------------
// AUTOSAVE: GET RULES
// GET /api/autosave/rules?uid=xxx
// ----------------------------
app.get('/api/autosave/rules', asyncHandler(async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ success: false, error: 'uid required' });

  const snap = await db.ref(`users/${uid}/autosave_rules`).get();
  res.json({ success: true, rules: snap.val() || {} });
}));

// ----------------------------
// AUTOSAVE: TOGGLE RULE
// PATCH /api/autosave/rules/:ruleId
// ----------------------------
app.patch('/api/autosave/rules/:ruleId', asyncHandler(async (req, res) => {
  const { uid, enabled } = req.body;
  const { ruleId } = req.params;
  if (!uid) return res.status(400).json({ success: false, error: 'uid required' });

  await db.ref(`users/${uid}/autosave_rules/${ruleId}`).update({ enabled });
  res.json({ success: true });
}));

// ----------------------------
// MERCHANT: COLLECT PAYMENT
// POST /api/merchant/collect
// ----------------------------
app.post('/api/merchant/collect', asyncHandler(async (req, res) => {
  const { uid, customerPhone, amount, reference } = req.body;
  if (!uid || !customerPhone || !amount) {
    return res.status(400).json({ success: false, error: 'uid, customerPhone, amount required' });
  }

  const ref = reference || generateRef();
  const fee = calcFee(parseFloat(amount), 1);

  if (!AIRTEL.CLIENT_ID) {
    await logTransaction(uid, {
      type: 'collection', amount: parseFloat(amount),
      fee, customerPhone, reference: ref, status: 'mock'
    });
    return res.json({ success: true, mock: true, reference: ref, fee });
  }

  const result = await airtelCollect({ phone: customerPhone, amount: parseFloat(amount), reference: ref });
  const success = isAirtelSuccess(result);

  await logTransaction(uid, {
    type: 'collection', amount: parseFloat(amount),
    fee, customerPhone, reference: ref,
    airtelTxnId: result.txnId,
    status: success ? 'pending_customer' : 'failed'
  });

  res.json({ success, result, reference: ref, fee });
}));

// ----------------------------
// MERCHANT: DISBURSE
// POST /api/merchant/disburse
// ----------------------------
app.post('/api/merchant/disburse', asyncHandler(async (req, res) => {
  const { uid, phone, amount, reference } = req.body;
  if (!uid || !phone || !amount) {
    return res.status(400).json({ success: false, error: 'uid, phone, amount required' });
  }

  const ref = reference || generateRef();
  const fee = calcFee(parseFloat(amount), 1);

  if (!AIRTEL.CLIENT_ID) {
    await logTransaction(uid, {
      type: 'disbursement', amount: parseFloat(amount),
      fee, phone, reference: ref, status: 'mock'
    });
    return res.json({ success: true, mock: true, reference: ref, fee });
  }

  const result = await airtelDisburse({ phone, amount: parseFloat(amount), reference: ref });
  const success = isAirtelSuccess(result);

  await logTransaction(uid, {
    type: 'disbursement', amount: parseFloat(amount),
    fee, phone, reference: ref,
    airtelTxnId: result.txnId,
    status: success ? 'completed' : 'failed'
  });

  res.json({ success, result, reference: ref, fee });
}));

// ----------------------------
// TRANSACTIONS: GET HISTORY
// GET /api/transactions?uid=xxx&limit=20&type=savings
// ----------------------------
app.get('/api/transactions', asyncHandler(async (req, res) => {
  const { uid, limit, type } = req.query;
  if (!uid) return res.status(400).json({ success: false, error: 'uid required' });

  const snap = await db.ref(`users/${uid}/transactions`)
    .orderByChild('timestamp')
    .limitToLast(parseInt(limit) || 20)
    .get();

  let transactions = Object.entries(snap.val() || {})
    .map(([id, tx]) => ({ id, ...tx }))
    .sort((a, b) => b.timestamp - a.timestamp);

  if (type) transactions = transactions.filter(tx => tx.type === type);

  res.json({ success: true, transactions });
}));

// ----------------------------
// ANALYTICS: SUMMARY
// GET /api/analytics?uid=xxx
// ----------------------------
app.get('/api/analytics', asyncHandler(async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ success: false, error: 'uid required' });

  // Cache analytics for 60 seconds
  const analytics = await getCached(`analytics_${uid}`, async () => {
    const snap = await db.ref(`users/${uid}/transactions`).get();
    const transactions = Object.values(snap.val() || {});

    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    let totalSaved = 0, totalSpent = 0;
    let monthSaved = 0, monthSpent = 0;
    let totalFees = 0;
    const categoryMap = {};
    const monthlyMap = {};

    for (const tx of transactions) {
      if (tx.status === 'failed') continue;
      const d = new Date(tx.timestamp);
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthlyMap[mk]) monthlyMap[mk] = { saved: 0, spent: 0 };

      if (tx.type === 'savings') {
        totalSaved += tx.amount || 0;
        totalFees += tx.fee || 0;
        monthlyMap[mk].saved += tx.amount || 0;
        if (tx.timestamp > monthStart.getTime()) monthSaved += tx.amount || 0;
      }

      if (['expense', 'gambling', 'airtime', 'collection', 'disbursement'].includes(tx.type)) {
        totalSpent += tx.amount || 0;
        monthlyMap[mk].spent += tx.amount || 0;
        if (tx.timestamp > monthStart.getTime()) monthSpent += tx.amount || 0;
        const cat = tx.category || tx.type || 'other';
        categoryMap[cat] = (categoryMap[cat] || 0) + (tx.amount || 0);
      }
    }

    const savingsRate = totalSpent + totalSaved > 0
      ? Math.round((totalSaved / (totalSpent + totalSaved)) * 100) : 0;

    return {
      totalSaved, totalSpent, monthSaved, monthSpent,
      savingsRate, totalFees,
      transactionCount: transactions.length,
      categoryBreakdown: categoryMap,
      monthlyTrend: monthlyMap
    };
  }, 60000);

  res.json({ success: true, analytics });
}));

// ----------------------------
// NOTIFICATIONS: GET
// GET /api/notifications?uid=xxx
// ----------------------------
app.get('/api/notifications', asyncHandler(async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ success: false, error: 'uid required' });

  const snap = await db.ref(`users/${uid}/notifications`)
    .orderByChild('timestamp')
    .limitToLast(20)
    .get();

  const notifications = Object.entries(snap.val() || {})
    .map(([id, n]) => ({ id, ...n }))
    .sort((a, b) => b.timestamp - a.timestamp);

  res.json({ success: true, notifications });
}));

// ----------------------------
// NOTIFICATIONS: MARK READ
// PATCH /api/notifications/:notifId
// ----------------------------
app.patch('/api/notifications/:notifId', asyncHandler(async (req, res) => {
  const { uid } = req.body;
  const { notifId } = req.params;
  if (!uid) return res.status(400).json({ success: false, error: 'uid required' });
  await db.ref(`users/${uid}/notifications/${notifId}`).update({ read: true });
  res.json({ success: true });
}));

// ----------------------------
// AIRTEL NOTIFICATION WEBHOOK
// POST /api/airtel/notification
// Register on Airtel dev portal
// ----------------------------
app.post('/api/airtel/notification', asyncHandler(async (req, res) => {
  const body = req.body;
  console.log('📲 Airtel notification:', JSON.stringify(body));

  const { transaction, msisdn } = body;
  if (!transaction) return res.status(400).json({ success: false });

  await db.ref('inbox').push({
    message: `Received MWK ${transaction.amount} from ${msisdn}. TID: ${transaction.id}`,
    amount: transaction.amount,
    sender: msisdn,
    tid: transaction.id?.replace(/[.#$[\]]/g, '_'),
    type: 'income',
    source: 'airtel-webhook',
    timestamp: Date.now(),
    processed: false
  });

  // Always respond 200 fast — Airtel retries if it doesn't get a response
  res.json({ success: true });
}));

// ----------------------------
// MACRODROID FALLBACK
// POST /api/macrodroid-proof
// ----------------------------
app.post('/api/macrodroid-proof', asyncHandler(async (req, res) => {
  const { tid, successMessage, uid } = req.body;
  if (!tid || !successMessage?.trim()) {
    return res.status(400).json({ success: false, error: 'tid and successMessage required' });
  }
  const path = uid
    ? `users/${uid}/completion_messages`
    : 'completion_messages';
  await db.ref(path).push({
    tid, successMessage,
    timestamp: Date.now(),
    processed: false,
    source: 'macrodroid'
  });
  res.json({ success: true, tid });
}));

// ----------------------------
// STATIC FILES
// ----------------------------
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// ----------------------------
// GLOBAL ERROR HANDLER
// Catches anything that slips through asyncHandler
// ----------------------------
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ----------------------------
// GRACEFUL SHUTDOWN
// Lets current requests finish before closing
// ----------------------------
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received — shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception:', err.message);
  // Don't crash — log and continue
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled rejection:', reason);
  // Don't crash — log and continue
});

// ----------------------------
// START SERVER
// ----------------------------
const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║              💰 SAVERPRO BACKEND READY 🚀               ║
╠══════════════════════════════════════════════════════════╣
║  Port      : ${PORT}                                     ║
║  Firebase  : ✅ Admin SDK                                ║
║  Airtel    : ${AIRTEL.CLIENT_ID ? '✅ Configured' : '⏳ Pending approval'}                      ║
║  Rate limit: ✅ Active                                   ║
║  Queue     : ✅ Active                                   ║
║  Cache     : ✅ Active                                   ║
║  Crash safe: ✅ Active                                   ║
╠══════════════════════════════════════════════════════════╣
║  GET  /api/health                                        ║
║  POST /api/profile                                       ║
║  POST /api/kyc                                           ║
║  GET  /api/airtel/balance                                ║
║  POST /api/goals                                         ║
║  GET  /api/goals                                         ║
║  POST /api/save                                          ║
║  POST /api/autosave/rules                                ║
║  POST /api/merchant/collect                              ║
║  POST /api/merchant/disburse                             ║
║  GET  /api/transactions                                  ║
║  GET  /api/analytics                                     ║
║  GET  /api/notifications                                 ║
║  POST /api/airtel/notification  ← Register on Airtel    ║
╚══════════════════════════════════════════════════════════╝
  `);
});

export default app;
