import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { readFileSync, existsSync } from 'fs';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import crypto from 'crypto';

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

async function airtelTransactionStatus(reference) {
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
  const cached = cache.get('corporate_float');
  const float = cached?.data || 0;
  if (AIRTEL.CLIENT_ID && float < amount + FLOAT_THRESHOLD) {
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
    if (!AIRTEL.CLIENT_ID) {
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

    if (!AIRTEL.CLIENT_ID) {
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

    // OTP correct — now do Airtel KYC lookup
    let kycStatus = 'verified';
    let registeredName = null;

    if (AIRTEL.CLIENT_ID) {
      const result = await airtelKYC(phoneClean);
      const verified = result?.data?.is_barred === false || result?.status?.code === '200';
      registeredName = result?.data?.first_name
        ? `${result.data.first_name} ${result.data.last_name || ''}`.trim()
        : null;
      kycStatus = verified ? 'verified' : 'failed';
    }

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
    if (!AIRTEL.CLIENT_ID) {
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

    // Mock mode
    if (!AIRTEL.CLIENT_ID) {
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

    if (AIRTEL.CLIENT_ID) {
      try { await checkFloatSufficient(netPayout); }
      catch {
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
    const { uid, type, amount, goalId, schedule, percent, enabled } = req.body;
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

    const rule = {
      uid, type, goalId,
      amount: parsedRuleAmount,
      percent: parsedRulePercent,
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
    await db.collection('autosave_rules').doc(ruleId).update({ enabled: req.body.enabled });
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

    if (!AIRTEL.CLIENT_ID) {
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
    if (!AIRTEL.CLIENT_ID) return res.json({ success: true, mock: true, status: 'completed' });
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
    suspended: !!data.suspended
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
    airtelConfigured: !!AIRTEL.CLIENT_ID
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
  if (!AIRTEL.CLIENT_ID) return;
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
  if (!AIRTEL.CLIENT_ID) return;
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

setTimeout(reconcilePendingTransactions, 10000);
setTimeout(monitorFloat, 15000);
setTimeout(checkExpiredSubscriptions, 20000);
setTimeout(checkGoalDeadlines, 25000);

// ----------------------------
// START
// ----------------------------
const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           💰 POCKETVAULT BACKEND v2.0 — READY 🚀               ║
╠══════════════════════════════════════════════════════════════╣
║  Port      : ${PORT}                                         ║
║  Database  : Firestore ✅                                    ║
║  Auth      : Firebase Token Verification ✅                  ║
║  Security  : Headers + CORS + Sanitizer + Rate limit ✅      ║
║  Airtel    : ${AIRTEL.CLIENT_ID ? '✅ Configured' : '⏳ Pending approval'}                        ║
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
  if (AIRTEL.CLIENT_ID && !SECURITY.AIRTEL_WEBHOOK_SECRET) {
    console.warn('🚨 SECURITY WARNING: Airtel is configured but AIRTEL_WEBHOOK_SECRET is NOT set. The webhook endpoint will accept unauthenticated requests. Set AIRTEL_WEBHOOK_SECRET before going live with real money.');
  }
  if (!AIRTEL.CLIENT_ID) {
    console.log('ℹ️  Running in mock mode — AIRTEL_WEBHOOK_SECRET check skipped until Airtel credentials are configured.');
  }
  `);
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  server.close(() => process.exit(0));
});

export default app;
