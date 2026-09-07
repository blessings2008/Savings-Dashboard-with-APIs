// PocketVault shared Express middleware.
import crypto from 'crypto';
import { db, adminAuth, FieldValue } from './firebase.js';
import { PLANS } from './config.js';
import { getCached, clearCache, rateLimitMap } from './state.js';

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function rateLimit(maxRequests = 100, windowMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    // Admin Firestore backup exports are intentionally protected, but
    // should not share the normal IP bucket. A shared/public IP (or a
    // reverse proxy) can otherwise exhaust the export allowance for the
    // administrator even when they only triggered a few exports.
    const isAdminBackupExport = req.path === '/api/admin/backups/export' && !!req.headers['x-admin-secret'];
    const key = isAdminBackupExport
      ? `admin-backup-export:${crypto.createHash('sha256').update(String(req.headers['x-admin-secret'])).digest('hex')}`
      : (req.ip || 'unknown');
    const effectiveMax = isAdminBackupExport ? Math.max(maxRequests, 20) : maxRequests;
    const recordKey = `${key}:${windowMs}`;
    const now = Date.now();
    const record = rateLimitMap.get(recordKey) || { count: 0, start: now };
    if (now - record.start > windowMs) { record.count = 1; record.start = now; } else record.count++;
    rateLimitMap.set(recordKey, record);
    if (record.count > effectiveMax) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - record.start)) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please slow down.',
        retryAfterSeconds
      });
    }
    next();
  };
}

export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const decoded = await adminAuth.verifyIdToken(authHeader.split('Bearer ')[1]);
    req.user = { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified };
    const verificationBootstrap = req.path.startsWith('/api/auth/email-otp/') || req.path === '/api/profile';
    if (!decoded.email_verified && !verificationBootstrap) return res.status(403).json({ success: false, error: 'Email verification required.', code: 'EMAIL_VERIFICATION_REQUIRED' });

    const userDoc = await getCached(`user_deletion_check_${decoded.uid}`, async () => {
      const snap = await db.collection('users').doc(decoded.uid).get();
      return snap.data() || null;
    }, 10000);
    if (userDoc?.accountDeleted) {
      if (userDoc?.autoRecoveryDeadline && Date.now() < userDoc.autoRecoveryDeadline) {
        await db.collection('users').doc(decoded.uid).set({ accountDeleted: false, suspended: false, deletedAt: null, deletedAtMillis: null, autoRecoveryDeadline: null, purgeDeadline: null, reactivatedAt: FieldValue.serverTimestamp() }, { merge: true });
        clearCache(`user_deletion_check_${decoded.uid}`);
      } else return res.status(403).json({ success: false, error: 'This account has been closed. Contact support to restore it.', accountDeleted: true });
    }
    next();
  } catch { return res.status(401).json({ success: false, error: 'Unauthorized - invalid token' }); }
}

export function requireOwnData(req, res, next) {
  const requestedUid = req.body.uid || req.query.uid || req.params.uid;
  if (!requestedUid) return res.status(400).json({ success: false, error: 'uid required' });
  if (req.user.uid !== requestedUid) { console.warn(`🚨 UID MISMATCH: token=${req.user.uid} requested=${requestedUid}`); return res.status(403).json({ success: false, error: 'Forbidden' }); }
  next();
}

export function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a.padEnd(256)); const bufB = Buffer.from(b.padEnd(256));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB) && a === b;
}

export function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET) return res.status(503).json({ success: false, error: 'Admin access not configured' });
  if (!secret || !safeCompare(secret, process.env.ADMIN_SECRET)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}

export function sanitize(str) { if (typeof str !== 'string') return str; return str.replace(/[<>'"`;]/g, '').trim().slice(0, 500); }
export function sanitizeBody(req, res, next) { if (req.body && typeof req.body === 'object') for (const key of Object.keys(req.body)) if (typeof req.body[key] === 'string') req.body[key] = sanitize(req.body[key]); next(); }

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

// Restrict routes to one or more subscription plans.
export function requirePlan(...allowedPlans) {
  return asyncHandler(async (req, res, next) => {
    const plan = await getUserPlan(req.user.uid);
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
