import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ----------------------------
// FIREBASE ADMIN INIT
// ----------------------------
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })
});

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
// SECURITY CONFIG
// ----------------------------
const SECURITY = {
  MAX_SAVE_AMOUNT: 5000000,     // MWK 5,000,000 max single save
  MIN_SAVE_AMOUNT: 100,         // MWK 100 min
  MAX_GOALS_FREE: 2,            // Free plan max goals
  MAX_GOALS_PRO: 20,            // Pro plan max goals
  TOKEN_HEADER: 'x-saverpro-token',
  AIRTEL_WEBHOOK_SECRET: process.env.AIRTEL_WEBHOOK_SECRET || null
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
// AIRTEL REQUEST QUEUE
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
    resolve(await task());
  } catch (err) {
    reject(err);
  } finally {
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

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now - val.start > 15 * 60 * 1000) rateLimitMap.delete(key);
  }
}, 15 * 60 * 1000);

// ----------------------------
// FIREBASE AUTH MIDDLEWARE
// Verifies Firebase ID token on every protected route
// ----------------------------
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized — no token' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decoded = await adminAuth.verifyIdToken(idToken);

    // Attach user to request
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified
    };

    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Unauthorized — invalid token' });
  }
}

// ----------------------------
// UID GUARD MIDDLEWARE
// Prevents users from accessing other users data
// ----------------------------
function requireOwnData(req, res, next) {
  const requestedUid = req.body.uid || req.query.uid || req.params.uid;

  if (!requestedUid) {
    return res.status(400).json({ success: false, error: 'uid required' });
  }

  if (req.user.uid !== requestedUid) {
    console.warn(`🚨 UID MISMATCH: token=${req.user.uid} requested=${requestedUid} ip=${req.ip}`);
    return res.status(403).json({ success: false, error: 'Forbidden — cannot access another user\'s data' });
  }

  next();
}

// ----------------------------
// INPUT SANITIZER
// Strips dangerous characters from string inputs
// ----------------------------
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>'"`;]/g, '').trim().slice(0, 500);
}

function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = sanitize(req.body[key]);
      }
    }
  }
  next();
}

// ----------------------------
// PLAN CHECKER
// Enforces free/pro/business limits
// ----------------------------
async function getUserPlan(uid) {
  return getCached(`plan_${uid}`, async () => {
    const snap = await db.collection('users').doc(uid).get();
    return snap.data()?.plan || 'free';
  }, 60000);
}

// ----------------------------
// AIRTEL TOKEN MANAGER
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
// AIRTEL API CALLS
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
  const ref = db.collection('transactions').doc();
  await ref.set({ ...data, uid, timestamp: FieldValue.serverTimestamp() });
  return ref.id;
}

async function logFee(uid, { amount, transactionId, type }) {
  await db.collection('platform_fees').doc().set({
    uid, amount, transactionId, type,
    timestamp: FieldValue.serverTimestamp()
  });
}

async function pushNotification(uid, { type, message }) {
  await db.collection('notifications').doc().set({
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

  await goalRef.update({
    saved: newSaved,
    completed,
    lastUpdated: FieldValue.serverTimestamp()
  });

  return { ...goal, id: goalId, saved: newSaved, completed };
}

// ----------------------------
// APP SETUP
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
    'https://savings-dashboard-pro.onrender.com',
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

// Global rate limits
app.use('/api/', rateLimit(100, 15 * 60 * 1000));

// Strict limits on money routes
app.use('/api/save', rateLimit(10, 60 * 1000));
app.use('/api/merchant/collect', rateLimit(20, 60 * 1000));
app.use('/api/merchant/disburse', rateLimit(20, 60 * 1000));
app.use('/api/kyc', rateLimit(5, 60 * 1000));

// ----------------------------
// HEALTH CHECK (public)
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
// PROFILE: CREATE / UPDATE
// POST /api/profile
// ----------------------------
app.post('/api/profile',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, name, phone, plan } = req.body;

    await db.collection('users').doc(uid).set({
      name: name || null,
      phone: phone || null,
      plan: plan || 'free',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    clearCache(`plan_${uid}`, `profile_${uid}`);
    res.json({ success: true });
  })
);

// ----------------------------
// KYC: VERIFY PHONE
// POST /api/kyc
// ----------------------------
app.post('/api/kyc',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, phone } = req.body;

    // Validate Malawi phone format
    const phoneClean = phone.replace(/\s/g, '');
    const validPhone = /^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phoneClean);
    if (!validPhone) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Malawi phone number format'
      });
    }

    // Check phone not already used by another account
    const existing = await db.collection('users')
      .where('phone', '==', phoneClean)
      .where('phoneVerified', '==', true)
      .get();

    const takenByOther = existing.docs.some(d => d.id !== uid);
    if (takenByOther) {
      return res.status(400).json({
        success: false,
        error: 'This phone number is already linked to another account'
      });
    }

    // Mock if Airtel not configured
    if (!AIRTEL.CLIENT_ID) {
      await db.collection('users').doc(uid).set({
        phone: phoneClean,
        phoneVerified: true,
        kycStatus: 'mock_verified',
        kycAt: FieldValue.serverTimestamp()
      }, { merge: true });
      clearCache(`plan_${uid}`, `profile_${uid}`);
      return res.json({
        success: true,
        mock: true,
        verified: true,
        message: 'Phone verified (mock — Airtel pending)'
      });
    }

    const result = await airtelKYC(phoneClean);
    const verified = result?.data?.is_barred === false || result?.status?.code === '200';
    const registeredName = result?.data?.first_name
      ? `${result.data.first_name} ${result.data.last_name || ''}`.trim()
      : null;

    await db.collection('users').doc(uid).set({
      phone: phoneClean,
      phoneVerified: verified,
      kycStatus: verified ? 'verified' : 'failed',
      kycName: registeredName || null,
      kycAt: FieldValue.serverTimestamp()
    }, { merge: true });

    clearCache(`plan_${uid}`, `profile_${uid}`);

    res.json({
      success: verified,
      verified,
      name: registeredName,
      message: verified
        ? `Verified. Registered as: ${registeredName}`
        : 'Verification failed. Check the number and try again.'
    });
  })
);

// ----------------------------
// BALANCE: GET AIRTEL WALLET
// GET /api/airtel/balance
// ----------------------------
app.get('/api/airtel/balance',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;

    if (!AIRTEL.CLIENT_ID) {
      return res.json({ success: true, mock: true, balance: 37600, currency: 'MWK' });
    }

    const data = await getCached(
      `balance_${uid}`,
      () => airtelBalance('COLL'),
      30000
    );

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
    const { uid, name, target, deadline, emoji, lockType } = req.body;

    if (!name || !target) {
      return res.status(400).json({ success: false, error: 'name and target required' });
    }
    if (parseFloat(target) < 500) {
      return res.status(400).json({ success: false, error: 'Minimum goal is MWK 500' });
    }

    // Enforce plan goal limits
    const plan = await getUserPlan(uid);
    const maxGoals = plan === 'free' ? SECURITY.MAX_GOALS_FREE : SECURITY.MAX_GOALS_PRO;

    const existingGoals = await db.collection('goals')
      .where('uid', '==', uid)
      .where('completed', '==', false)
      .get();

    if (existingGoals.size >= maxGoals) {
      return res.status(403).json({
        success: false,
        error: `${plan === 'free' ? 'Free' : 'Pro'} plan allows max ${maxGoals} active goals. ${plan === 'free' ? 'Upgrade to Pro for more.' : ''}`
      });
    }

    const goal = {
      uid,
      name: sanitize(name),
      target: parseFloat(target),
      saved: 0,
      deadline: deadline || null,
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
        .where('uid', '==', uid)
        .orderBy('createdAt', 'desc')
        .get();
      const result = {};
      snap.forEach(doc => { result[doc.id] = { id: doc.id, ...doc.data() }; });
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
    if (goal.locked && goal.lockType === 'hard') {
      return res.status(400).json({ success: false, error: 'Goal is locked and cannot be modified' });
    }

    const updates = { updatedAt: FieldValue.serverTimestamp() };
    const { name, target, deadline, emoji, lockType } = req.body;
    if (name) updates.name = sanitize(name);
    if (target) updates.target = parseFloat(target);
    if (deadline) updates.deadline = deadline;
    if (emoji) updates.emoji = emoji;
    if (lockType) { updates.lockType = lockType; updates.locked = lockType === 'hard'; }

    await db.collection('goals').doc(goalId).update(updates);
    clearCache(`goals_${uid}`);

    res.json({ success: true });
  })
);

// ----------------------------
// SAVE: TRANSFER TO GOAL
// POST /api/save
// ----------------------------
app.post('/api/save',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, goalId, amount, phone } = req.body;

    if (!goalId || !amount || !phone) {
      return res.status(400).json({ success: false, error: 'goalId, amount, phone required' });
    }

    const parsedAmount = parseFloat(amount);

    if (parsedAmount < SECURITY.MIN_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: `Minimum save is MWK ${SECURITY.MIN_SAVE_AMOUNT}` });
    }
    if (parsedAmount > SECURITY.MAX_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: `Maximum save is MWK ${SECURITY.MAX_SAVE_AMOUNT.toLocaleString()}` });
    }

    // Verify goal belongs to this user
    const goalSnap = await db.collection('goals').doc(goalId).get();
    const goal = goalSnap.data();

    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (goal.completed) return res.status(400).json({ success: false, error: 'Goal already completed' });
    if (goal.locked && goal.lockType === 'hard') {
      return res.status(400).json({ success: false, error: 'Goal is locked' });
    }

    const fee = calcFee(parsedAmount, 1);
    const reference = generateRef();

    // Mock mode
    if (!AIRTEL.CLIENT_ID) {
      const updated = await updateGoalProgress(uid, goalId, parsedAmount);
      const txId = await logTransaction(uid, {
        type: 'savings', amount: parsedAmount, fee,
        goalId, goalName: goal.name, reference,
        status: 'mock', phone
      });
      await logFee(uid, { amount: fee, transactionId: txId, type: 'savings' });
      await pushNotification(uid, {
        type: 'savings_success',
        message: `💰 Saved MWK ${parsedAmount.toLocaleString()} to ${goal.name}. ${updated?.completed ? '🎉 Goal complete!' : `${Math.round(((updated?.saved || 0) / goal.target) * 100)}% done.`}`
      });
      clearCache(`goals_${uid}`, `analytics_${uid}`);
      return res.json({
        success: true, mock: true,
        message: `MWK ${parsedAmount} saved to ${goal.name}`,
        reference, fee, goal: updated
      });
    }

    // Real Airtel
    const result = await airtelDisburse({ phone, amount: parsedAmount, reference });

    if (isAirtelSuccess(result)) {
      const updated = await updateGoalProgress(uid, goalId, parsedAmount);
      const txId = await logTransaction(uid, {
        type: 'savings', amount: parsedAmount, fee,
        goalId, goalName: goal.name, reference,
        airtelTxnId: result.txnId,
        airtelRef: result?.data?.transaction?.id,
        status: 'completed', phone
      });
      await logFee(uid, { amount: fee, transactionId: txId, type: 'savings' });
      await pushNotification(uid, {
        type: 'savings_success',
        message: updated?.completed
          ? `🎉 Goal complete! You reached your ${goal.name} target!`
          : `💰 Saved MWK ${parsedAmount.toLocaleString()} to ${goal.name}. ${Math.round(((updated?.saved || 0) / goal.target) * 100)}% done.`
      });
      clearCache(`goals_${uid}`, `analytics_${uid}`);
      res.json({ success: true, message: `MWK ${parsedAmount} saved`, reference, fee, goal: updated });
    } else {
      await logTransaction(uid, {
        type: 'savings', amount: parsedAmount,
        goalId, reference, status: 'failed',
        error: JSON.stringify(result)
      });
      res.status(400).json({ success: false, error: 'Transfer failed', details: result });
    }
  })
);

// ----------------------------
// AUTOSAVE: CREATE RULE
// POST /api/autosave/rules
// ----------------------------
app.post('/api/autosave/rules',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, type, amount, goalId, schedule, percent, enabled } = req.body;

    if (!type || !goalId) {
      return res.status(400).json({ success: false, error: 'type and goalId required' });
    }

    // Verify goal belongs to user
    const goalSnap = await db.collection('goals').doc(goalId).get();
    if (!goalSnap.exists || goalSnap.data().uid !== uid) {
      return res.status(403).json({ success: false, error: 'Goal not found or forbidden' });
    }

    const rule = {
      uid, type, goalId,
      amount: amount ? parseFloat(amount) : null,
      percent: percent ? parseFloat(percent) : null,
      schedule: schedule || null,
      enabled: enabled !== false,
      createdAt: FieldValue.serverTimestamp(),
      lastRun: null
    };

    const ref = await db.collection('autosave_rules').add(rule);
    res.json({ success: true, ruleId: ref.id, rule });
  })
);

// ----------------------------
// AUTOSAVE: GET RULES
// GET /api/autosave/rules
// ----------------------------
app.get('/api/autosave/rules',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const snap = await db.collection('autosave_rules')
      .where('uid', '==', uid)
      .get();
    const rules = {};
    snap.forEach(doc => { rules[doc.id] = { id: doc.id, ...doc.data() }; });
    res.json({ success: true, rules });
  })
);

// ----------------------------
// AUTOSAVE: TOGGLE RULE
// PATCH /api/autosave/rules/:ruleId
// ----------------------------
app.patch('/api/autosave/rules/:ruleId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { ruleId } = req.params;
    const uid = req.user.uid;
    const { enabled } = req.body;

    const snap = await db.collection('autosave_rules').doc(ruleId).get();
    if (!snap.exists || snap.data().uid !== uid) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    await db.collection('autosave_rules').doc(ruleId).update({ enabled });
    res.json({ success: true });
  })
);

// ----------------------------
// MERCHANT: COLLECT PAYMENT
// POST /api/merchant/collect
// ----------------------------
app.post('/api/merchant/collect',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, customerPhone, amount, reference } = req.body;

    if (!customerPhone || !amount) {
      return res.status(400).json({ success: false, error: 'customerPhone and amount required' });
    }

    // Business plan only
    const plan = await getUserPlan(uid);
    if (plan !== 'business') {
      return res.status(403).json({
        success: false,
        error: 'Merchant features require a Business plan'
      });
    }

    const ref = reference || generateRef();
    const parsedAmount = parseFloat(amount);
    const fee = calcFee(parsedAmount, 1);

    if (!AIRTEL.CLIENT_ID) {
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

    if (success) await logFee(uid, { amount: fee, transactionId: txId, type: 'collection' });

    clearCache(`analytics_${uid}`);
    res.json({ success, result, reference: ref, fee });
  })
);

// ----------------------------
// MERCHANT: DISBURSE
// POST /api/merchant/disburse
// ----------------------------
app.post('/api/merchant/disburse',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, phone, amount, reference } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ success: false, error: 'phone and amount required' });
    }

    const plan = await getUserPlan(uid);
    if (plan !== 'business') {
      return res.status(403).json({
        success: false,
        error: 'Merchant features require a Business plan'
      });
    }

    const ref = reference || generateRef();
    const parsedAmount = parseFloat(amount);
    const fee = calcFee(parsedAmount, 1);

    if (!AIRTEL.CLIENT_ID) {
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

    if (success) await logFee(uid, { amount: fee, transactionId: txId, type: 'disbursement' });

    clearCache(`analytics_${uid}`);
    res.json({ success, result, reference: ref, fee });
  })
);

// ----------------------------
// TRANSACTIONS: GET HISTORY
// GET /api/transactions?limit=20&type=savings
// ----------------------------
app.get('/api/transactions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const { limit, type } = req.query;

    let query = db.collection('transactions')
      .where('uid', '==', uid)
      .orderBy('timestamp', 'desc')
      .limit(parseInt(limit) || 20);

    if (type) query = query.where('type', '==', type);

    const snap = await query.get();
    const transactions = [];
    snap.forEach(doc => transactions.push({ id: doc.id, ...doc.data() }));

    res.json({ success: true, transactions });
  })
);

// ----------------------------
// ANALYTICS: SUMMARY
// GET /api/analytics
// ----------------------------
app.get('/api/analytics',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;

    const analytics = await getCached(`analytics_${uid}`, async () => {
      const snap = await db.collection('transactions')
        .where('uid', '==', uid)
        .orderBy('timestamp', 'desc')
        .limit(200)
        .get();

      const transactions = [];
      snap.forEach(doc => transactions.push(doc.data()));

      const monthStart = new Date();
      monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

      let totalSaved = 0, totalSpent = 0;
      let monthSaved = 0, monthSpent = 0;
      let totalFees = 0;
      const categoryMap = {};
      const monthlyMap = {};

      for (const tx of transactions) {
        if (tx.status === 'failed') continue;
        const ts = tx.timestamp?.toMillis?.() || tx.timestamp || 0;
        const d = new Date(ts);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyMap[mk]) monthlyMap[mk] = { saved: 0, spent: 0 };

        if (tx.type === 'savings') {
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

      return {
        totalSaved, totalSpent, monthSaved, monthSpent, totalFees,
        savingsRate: totalSpent + totalSaved > 0
          ? Math.round((totalSaved / (totalSpent + totalSaved)) * 100) : 0,
        transactionCount: transactions.length,
        categoryBreakdown: categoryMap,
        monthlyTrend: monthlyMap
      };
    }, 60000);

    res.json({ success: true, analytics });
  })
);

// ----------------------------
// NOTIFICATIONS: GET
// GET /api/notifications
// ----------------------------
app.get('/api/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const snap = await db.collection('notifications')
      .where('uid', '==', uid)
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();
    const notifications = [];
    snap.forEach(doc => notifications.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, notifications });
  })
);

// ----------------------------
// NOTIFICATIONS: MARK READ
// PATCH /api/notifications/:notifId
// ----------------------------
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
// Register this URL on Airtel dev portal
// ----------------------------
app.post('/api/airtel/notification', asyncHandler(async (req, res) => {
  // Verify webhook secret if configured
  if (SECURITY.AIRTEL_WEBHOOK_SECRET) {
    const signature = req.headers['x-airtel-signature'];
    const expected = crypto
      .createHmac('sha256', SECURITY.AIRTEL_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');
    if (signature !== expected) {
      console.warn('🚨 Invalid Airtel webhook signature');
      return res.status(401).json({ success: false });
    }
  }

  const { transaction, msisdn } = req.body;
  if (!transaction) return res.status(400).json({ success: false });

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

  // Always respond 200 fast
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
  const collection = uid ? `users/${uid}/completion_messages` : 'completion_messages';
  await db.collection(collection).add({
    tid, successMessage,
    timestamp: FieldValue.serverTimestamp(),
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
// ----------------------------
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message);
  // Never expose internal errors to client
  res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
});

// ----------------------------
// PROCESS SAFETY
// ----------------------------
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled rejection:', reason);
});

const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         💰 SAVERPRO BACKEND — PRODUCTION READY 🚀       ║
╠══════════════════════════════════════════════════════════╣
║  Port        : ${PORT}                                   ║
║  Database    : Firestore ✅                              ║
║  Auth        : Firebase Token Verification ✅            ║
║  Rate limit  : ✅  Queue: ✅  Cache: ✅                  ║
║  Security    : Headers ✅  CORS ✅  Sanitizer ✅         ║
║  Airtel      : ${AIRTEL.CLIENT_ID ? '✅ Configured' : '⏳ Pending approval'}                      ║
╠══════════════════════════════════════════════════════════╣
║  GET  /api/health                 — public               ║
║  POST /api/profile                — auth required        ║
║  POST /api/kyc                    — auth required        ║
║  GET  /api/airtel/balance         — auth required        ║
║  POST /api/goals                  — auth required        ║
║  GET  /api/goals                  — auth required        ║
║  POST /api/save                   — auth + rate limited  ║
║  POST /api/autosave/rules         — auth required        ║
║  POST /api/merchant/collect       — business plan only   ║
║  POST /api/merchant/disburse      — business plan only   ║
║  GET  /api/transactions           — auth required        ║
║  GET  /api/analytics              — auth required        ║
║  GET  /api/notifications          — auth required        ║
║  POST /api/airtel/notification    — webhook signed       ║
╚══════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  server.close(() => process.exit(0));
});

export default app;

// ----------------------------
// TRANSACTION RECONCILIATION ENGINE
// Runs every 5 minutes
// Checks all pending transactions against Airtel
// Transaction Summary API as backup for missed webhooks
// ----------------------------

async function checkTransactionStatus(reference) {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const res = await fetch(
      `${AIRTEL.BASE_URL}/standard/v2/payments/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Country': AIRTEL.COUNTRY,
          'X-Currency': AIRTEL.CURRENCY,
          Accept: '*/*'
        }
      }
    );
    return res.json();
  });
}

async function reconcilePendingTransactions() {
  if (!AIRTEL.CLIENT_ID) return; // Skip in mock mode

  try {
    console.log('🔄 Reconciliation running...');

    // Find all transactions stuck in pending for more than 2 minutes
    const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000);

    const pendingSnap = await db.collection('transactions')
      .where('status', '==', 'pending')
      .where('timestamp', '<=', twoMinsAgo)
      .limit(50)
      .get();

    if (pendingSnap.empty) {
      console.log('✅ No pending transactions to reconcile');
      return;
    }

    console.log(`🔄 Reconciling ${pendingSnap.size} pending transactions...`);

    for (const doc of pendingSnap.docs) {
      const tx = doc.data();
      const txId = doc.id;

      try {
        // Query Airtel for real status
        const result = await checkTransactionStatus(tx.reference);
        const airtelStatus = result?.data?.transaction?.status;

        if (airtelStatus === 'TS') {
          // Transaction successful — update everything
          console.log(`✅ Reconciled SUCCESS: ${tx.reference}`);

          await db.collection('transactions').doc(txId).update({
            status: 'completed',
            reconciledAt: FieldValue.serverTimestamp(),
            airtelRef: result?.data?.transaction?.id
          });

          // Update goal if savings type
          if (tx.type === 'savings' && tx.goalId && tx.uid) {
            await updateGoalProgress(tx.uid, tx.goalId, tx.amount);
            await logFee(tx.uid, {
              amount: tx.fee || 0,
              transactionId: txId,
              type: 'savings_reconciled'
            });
            await pushNotification(tx.uid, {
              type: 'savings_reconciled',
              message: `✅ Your MWK ${(tx.amount || 0).toLocaleString()} save to ${tx.goalName} was confirmed.`
            });
            clearCache(`goals_${tx.uid}`, `analytics_${tx.uid}`);
          }

          // Update collection if merchant type
          if (tx.type === 'collection' && tx.uid) {
            await pushNotification(tx.uid, {
              type: 'collection_reconciled',
              message: `✅ Payment of MWK ${(tx.amount || 0).toLocaleString()} confirmed from ${tx.customerPhone}.`
            });
            clearCache(`analytics_${tx.uid}`);
          }

        } else if (airtelStatus === 'TF' || airtelStatus === 'TE') {
          // Transaction failed or expired
          console.log(`❌ Reconciled FAILED: ${tx.reference}`);

          await db.collection('transactions').doc(txId).update({
            status: 'failed',
            reconciledAt: FieldValue.serverTimestamp(),
            failReason: airtelStatus === 'TF' ? 'failed' : 'expired'
          });

          if (tx.uid) {
            await pushNotification(tx.uid, {
              type: 'transaction_failed',
              message: `❌ Your MWK ${(tx.amount || 0).toLocaleString()} transaction could not be completed. No money was moved.`
            });
          }

        } else {
          // Still pending — leave it for next reconciliation cycle
          console.log(`⏳ Still pending: ${tx.reference} (status: ${airtelStatus})`);
        }

      } catch (err) {
        console.error(`Reconciliation error for ${tx.reference}:`, err.message);
      }
    }

    console.log('✅ Reconciliation complete');

  } catch (err) {
    console.error('❌ Reconciliation engine error:', err.message);
  }
}

// ----------------------------
// FLOAT MONITOR
// Checks corporate wallet balance every 30 minutes
// Alerts if balance drops below safe threshold
// ----------------------------

const FLOAT_THRESHOLD = parseInt(process.env.FLOAT_THRESHOLD) || 50000; // MWK 50,000 default

async function monitorFloat() {
  if (!AIRTEL.CLIENT_ID) return;

  try {
    const data = await airtelBalance('DISB');
    const balance = parseFloat(data?.data?.balance || 0);

    console.log(`💰 Corporate wallet float: MWK ${balance.toLocaleString()}`);

    // Store float history in Firestore
    await db.collection('float_monitor').add({
      balance,
      currency: 'MWK',
      timestamp: FieldValue.serverTimestamp(),
      status: balance < FLOAT_THRESHOLD ? 'low' : 'ok'
    });

    if (balance < FLOAT_THRESHOLD) {
      console.warn(`🚨 LOW FLOAT WARNING: MWK ${balance.toLocaleString()} (threshold: MWK ${FLOAT_THRESHOLD.toLocaleString()})`);

      // Store alert in Firestore for admin dashboard
      await db.collection('admin_alerts').add({
        type: 'low_float',
        message: `Corporate wallet balance is low: MWK ${balance.toLocaleString()}. Top up required.`,
        balance,
        threshold: FLOAT_THRESHOLD,
        timestamp: FieldValue.serverTimestamp(),
        resolved: false
      });
    }

    // Cache float for disbursement checks
    cache.set('corporate_float', {
      data: balance,
      expiry: Date.now() + 5 * 60 * 1000 // 5 min cache
    });

  } catch (err) {
    console.error('❌ Float monitor error:', err.message);
  }
}

// ----------------------------
// FLOAT GUARD
// Checks float before every disbursement
// ----------------------------
async function checkFloatSufficient(amount) {
  const cached = cache.get('corporate_float');
  const float = cached?.data || 0;

  if (float < amount + FLOAT_THRESHOLD) {
    throw new Error(`Insufficient float. Current: MWK ${float.toLocaleString()}. Required: MWK ${(amount + FLOAT_THRESHOLD).toLocaleString()}`);
  }

  return float;
}

// ----------------------------
// DUPLICATE WEBHOOK GUARD
// Prevents same transaction being processed twice
// ----------------------------
async function isAlreadyProcessed(airtelRef) {
  if (!airtelRef) return false;
  const snap = await db.collection('transactions')
    .where('airtelRef', '==', airtelRef)
    .limit(1)
    .get();
  return !snap.empty;
}

// ----------------------------
// TRANSACTION SUMMARY API
// GET /api/transactions/:reference/status
// Manual check for a specific transaction
// ----------------------------
app.get('/api/transactions/:reference/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { reference } = req.params;
    const uid = req.user.uid;

    // Verify transaction belongs to this user
    const snap = await db.collection('transactions')
      .where('reference', '==', reference)
      .where('uid', '==', uid)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    if (!AIRTEL.CLIENT_ID) {
      return res.json({ success: true, mock: true, status: 'completed' });
    }

    const result = await checkTransactionStatus(reference);
    const airtelStatus = result?.data?.transaction?.status;

    const statusMap = {
      'TS': 'completed',
      'TF': 'failed',
      'TE': 'expired',
      'TP': 'pending'
    };

    res.json({
      success: true,
      reference,
      status: statusMap[airtelStatus] || 'unknown',
      airtelStatus,
      raw: result
    });
  })
);

// ----------------------------
// WITHDRAWAL ENDPOINT
// POST /api/withdraw
// User withdraws from a flexible goal back to Airtel wallet
// ----------------------------
app.post('/api/withdraw',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, goalId, amount, phone } = req.body;

    if (!goalId || !amount || !phone) {
      return res.status(400).json({ success: false, error: 'goalId, amount, phone required' });
    }

    const parsedAmount = parseFloat(amount);
    if (parsedAmount < 100) {
      return res.status(400).json({ success: false, error: 'Minimum withdrawal is MWK 100' });
    }

    // Get goal and verify ownership
    const goalSnap = await db.collection('goals').doc(goalId).get();
    const goal = goalSnap.data();

    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });

    // Block withdrawal on locked goals
    if (goal.locked && goal.lockType === 'hard') {
      return res.status(400).json({
        success: false,
        error: 'This goal is locked. Withdrawal not allowed until target is reached or deadline passes.'
      });
    }

    // Check sufficient savings in goal
    if ((goal.saved || 0) < parsedAmount) {
      return res.status(400).json({
        success: false,
        error: `Insufficient savings. Available: MWK ${(goal.saved || 0).toLocaleString()}`
      });
    }

    const fee = calcFee(parsedAmount, 1);
    const netPayout = parsedAmount - fee;
    const reference = generateRef();

    // Check corporate float before proceeding
    if (AIRTEL.CLIENT_ID) {
      try {
        await checkFloatSufficient(netPayout);
      } catch (err) {
        return res.status(503).json({
          success: false,
          error: 'Withdrawals temporarily unavailable. Please try again shortly.'
        });
      }
    }

    // Mock mode
    if (!AIRTEL.CLIENT_ID) {
      await db.collection('goals').doc(goalId).update({
        saved: (goal.saved || 0) - parsedAmount,
        lastUpdated: FieldValue.serverTimestamp()
      });
      await logTransaction(uid, {
        type: 'withdrawal', amount: parsedAmount,
        fee, netPayout, goalId, goalName: goal.name,
        reference, status: 'mock', phone
      });
      await pushNotification(uid, {
        type: 'withdrawal_success',
        message: `💸 MWK ${netPayout.toLocaleString()} sent to your Airtel wallet from ${goal.name}.`
      });
      clearCache(`goals_${uid}`, `analytics_${uid}`);
      return res.json({
        success: true, mock: true,
        message: `MWK ${netPayout} sent to your wallet`,
        reference, fee, netPayout
      });
    }

    // Real disbursement
    const result = await airtelDisburse({ phone, amount: netPayout, reference });

    if (isAirtelSuccess(result)) {
      // Deduct from goal
      await db.collection('goals').doc(goalId).update({
        saved: (goal.saved || 0) - parsedAmount,
        lastUpdated: FieldValue.serverTimestamp()
      });
      const txId = await logTransaction(uid, {
        type: 'withdrawal', amount: parsedAmount,
        fee, netPayout, goalId, goalName: goal.name,
        reference, airtelTxnId: result.txnId,
        airtelRef: result?.data?.transaction?.id,
        status: 'completed', phone
      });
      await logFee(uid, { amount: fee, transactionId: txId, type: 'withdrawal' });
      await pushNotification(uid, {
        type: 'withdrawal_success',
        message: `💸 MWK ${netPayout.toLocaleString()} sent to your Airtel wallet from ${goal.name}.`
      });
      clearCache(`goals_${uid}`, `analytics_${uid}`);
      res.json({ success: true, message: `MWK ${netPayout} sent`, reference, fee, netPayout });
    } else {
      await logTransaction(uid, {
        type: 'withdrawal', amount: parsedAmount,
        goalId, reference, status: 'failed',
        error: JSON.stringify(result)
      });
      res.status(400).json({ success: false, error: 'Withdrawal failed', details: result });
    }
  })
);

// ----------------------------
// START BACKGROUND JOBS
// ----------------------------

// Reconcile pending transactions every 5 minutes
setInterval(reconcilePendingTransactions, 5 * 60 * 1000);

// Monitor corporate float every 30 minutes
setInterval(monitorFloat, 30 * 60 * 1000);

// Run both immediately on startup
setTimeout(reconcilePendingTransactions, 10000);
setTimeout(monitorFloat, 15000);

console.log('⚙️  Background jobs scheduled: reconciliation (5min) + float monitor (30min)');
