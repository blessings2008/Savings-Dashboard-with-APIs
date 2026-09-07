import express from 'express';
import crypto from 'crypto';
import { db, FieldValue, adminAuth } from '../core/firebase.js';
import { requireAuth, asyncHandler, rateLimit, safeCompare } from '../core/middleware.js';
import { sendEmail } from '../services/email.js';

const router = express.Router();
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const OTP_SECRET = String(process.env.EMAIL_OTP_SECRET || process.env.FIREBASE_PROJECT_ID || 'pocketvault-otp-secret');

function hashOtp(uid, code) {
  return crypto.createHmac('sha256', OTP_SECRET).update(`${uid}:${code}`).digest('hex');
}

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

function otpEmail(code, expiresMinutes = 10) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#17202a"><div style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #e7ecea;border-radius:18px;overflow:hidden"><div style="padding:24px;background:#111827;color:#fff;font-size:19px;font-weight:800">PocketVault 🇲🇼</div><div style="padding:32px"><div style="font-size:12px;color:#64748b;font-weight:800;letter-spacing:.08em;text-transform:uppercase">Email verification</div><h1 style="font-size:27px;margin:8px 0 14px;color:#111827">Your verification code</h1><p style="font-size:15px;line-height:1.6;color:#475569">Use the one-time code below to finish signing in to PocketVault.</p><div style="margin:24px 0;padding:20px;text-align:center;background:#f0fdf4;border:1px solid #dcfce7;border-radius:14px;font-size:34px;letter-spacing:9px;font-weight:800;color:#166534">${code}</div><p style="font-size:13px;color:#64748b;line-height:1.6">This code expires in ${expiresMinutes} minutes. If you did not try to sign in, you can safely ignore this email.</p></div></div></body></html>`;
  return { html, text: `Your PocketVault verification code is ${code}. It expires in ${expiresMinutes} minutes.` };
}

async function getUser(uid) {
  const user = await adminAuth.getUser(uid);
  if (!user.email) {
    const error = new Error('Your account does not have an email address.');
    error.statusCode = 400;
    throw error;
  }
  return user;
}

router.get('/api/auth/email-otp/status', requireAuth, asyncHandler(async (req, res) => {
  const user = await getUser(req.user.uid);
  const snap = await db.collection('users').doc(req.user.uid).get();
  const data = snap.data() || {};
  const verified = Boolean(user.emailVerified || data.emailOtpVerifiedAt);
  res.json({ success: true, verified, email: user.email.replace(/^(.{2}).*(@.*)$/, '$1••••$2') });
}));

router.post('/api/auth/email-otp/send', requireAuth, rateLimit(5, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const user = await getUser(uid);
  if (user.emailVerified) return res.json({ success: true, verified: true, sent: false, reason: 'already_verified' });

  const ref = db.collection('email_otps').doc(uid);
  const existing = await ref.get();
  const current = existing.data() || {};
  if (current.lastSentAt && Date.now() - Number(current.lastSentAt) < RESEND_COOLDOWN_MS) {
    const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - Number(current.lastSentAt))) / 1000);
    return res.status(429).json({ success: false, error: `Please wait ${retryAfter}s before requesting another code.`, retryAfter });
  }

  const code = generateOtp();
  await ref.set({
    codeHash: hashOtp(uid, code),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: Date.now()
  });

  try {
    const template = otpEmail(code);
    const result = await sendEmail({
      to: user.email,
      subject: 'Your PocketVault verification code',
      idempotencyKey: `email-otp/${uid}/${Math.floor(Date.now() / RESEND_COOLDOWN_MS)}`,
      tags: [{ name: 'category', value: 'email_verification' }, { name: 'product', value: 'pocketvault' }],
      ...template
    });
    res.json({ success: true, verified: false, sent: true, id: result?.id || null, expiresIn: OTP_TTL_MS / 1000 });
  } catch (error) {
    await ref.delete();
    throw error;
  }
}));

router.post('/api/auth/email-otp/verify', requireAuth, rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ success: false, error: 'Enter the 6-digit verification code.' });

  const ref = db.collection('email_otps').doc(uid);
  const snap = await ref.get();
  const otp = snap.data();
  if (!otp) return res.status(400).json({ success: false, error: 'No active verification code. Request a new one.' });
  if (Number(otp.expiresAt) < Date.now()) { await ref.delete(); return res.status(400).json({ success: false, error: 'That code has expired. Request a new one.' }); }
  if (Number(otp.attempts || 0) >= MAX_ATTEMPTS) { await ref.delete(); return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Request a new code.' }); }

  const expected = hashOtp(uid, code);
  if (!safeCompare(expected, String(otp.codeHash || ''))) {
    await ref.update({ attempts: FieldValue.increment(1) });
    const remaining = Math.max(0, MAX_ATTEMPTS - Number(otp.attempts || 0) - 1);
    return res.status(400).json({ success: false, error: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` });
  }

  await adminAuth.updateUser(uid, { emailVerified: true });
  await db.collection('users').doc(uid).set({
    emailOtpVerifiedAt: FieldValue.serverTimestamp(),
    emailVerificationMethod: 'otp'
  }, { merge: true });
  await ref.delete();

  res.json({ success: true, verified: true });
}));

export default router;
