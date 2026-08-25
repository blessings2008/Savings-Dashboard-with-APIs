// PocketVault shared Express middleware.
import crypto from 'crypto';
import { db, adminAuth, FieldValue } from './firebase.js';
import { PLANS } from './config.js';
import { getCached, clearCache, rateLimitMap } from './state.js';

// ----------------------------
// ASYNC HANDLER
// ----------------------------
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ----------------------------
// RATE LIMITER
// ----------------------------
export function rateLimit(maxRequests = 100, windowMs = 15 * 60 * 1000) {
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

// ----------------------------
// AUTH MIDDLEWARE
// ----------------------------
export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const decoded = await adminAuth.verifyIdToken(authHeader.split('Bearer ')[1]);
    req.user = { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified };

    // ----------------------------
    // ACCOUNT DELETION — RECOVERY WINDOW ENFORCEMENT
    // If this user soft-deleted their account (see POST
    // /api/account/delete or the admin equivalent), this is where
    // that actually gets enforced for every authenticated route:
    //
    //   Days 0-30  — a successful sign-in (reaching this point with a
    //                valid Firebase token) is exactly the "user came
    //                back" signal the recovery window exists to
    //                catch. Reactivate automatically and let the
    //                request through.
    //   Days 30-60 — auto-reactivation no longer applies. The request
    //                is blocked with 403 until an admin restores the
    //                account via POST /api/admin/users/:uid/restore.
    //   Day 60+    — same block; sweepUnresolvedFunds() (jobs.js) has
    //                by now moved any remaining accountBalance to the
    //                unresolved_funds ledger.
    //
    // Firebase Auth login itself stays enabled through all of this
    // (see the note on POST /api/account/delete for why) — this
    // check is what actually gates app access, not Firebase disabling
    // the account.
    // ----------------------------
    const userDoc = await getCached(`user_deletion_check_${decoded.uid}`, async () => {
      const snap = await db.collection('users').doc(decoded.uid).get();
      return snap.data() || null;
    }, 10000);

    if (userDoc?.accountDeleted) {
      if (userDoc?.autoRecoveryDeadline && Date.now() < userDoc.autoRecoveryDeadline) {
        // Within the 30-day auto-recovery window — reactivate and
        // let this request (and all future ones) through normally.
        await db.collection('users').doc(decoded.uid).set({
          accountDeleted: false,
          suspended: false,
          deletedAt: null,
          deletedAtMillis: null,
          autoRecoveryDeadline: null,
          purgeDeadline: null,
          reactivatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        clearCache(`user_deletion_check_${decoded.uid}`);
      } else {
        // Past auto-recovery (days 30-60) or past purge (60+) — the
        // account is still genuinely deleted and only an admin
        // action (POST /api/admin/users/:uid/restore) can bring it
        // back. Block here rather than letting every downstream
        // route independently guess whether a deleted account should
        // still work — most don't check this at all today.
        return res.status(403).json({
          success: false,
          error: 'This account has been closed. Contact support to restore it.',
          accountDeleted: true
        });
      }
    }

    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Unauthorized - invalid token' });
  }
}

export function requireOwnData(req, res, next) {
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
export function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a.padEnd(256));
  const bufB = Buffer.from(b.padEnd(256));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB) && a === b;
}

export function requireAdmin(req, res, next) {
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
export function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>'"`;]/g, '').trim().slice(0, 500);
}

export function sanitizeBody(req, res, next) {
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
export async function getUserPlan(uid) {
  return getCached(`plan_${uid}`, async () => {
    const snap = await db.collection('users').doc(uid).get();
    const plan = snap.data()?.plan || 'free';
    return PLANS[plan] ? plan : 'free';
  }, 60000);
}

export async function getPlanConfig(uid) {
  const plan = await getUserPlan(uid);
  return { plan, config: PLANS[plan] };
}

export function requirePlan(...allowedPlans) {
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
