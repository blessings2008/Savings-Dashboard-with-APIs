// PocketVault transactional email routes.
// Resend credentials stay server-side; these routes never accept an API key.
import express from 'express';
import { db, adminAuth } from '../core/firebase.js';
import { requireAuth, asyncHandler, rateLimit } from '../core/middleware.js';
import { sendEmail, getEmailStatus, buildWelcomeEmail, buildTransactionEmail, emailOtpStatus, sendEmailOtp, verifyEmailOtp } from '../services/email.js';

const router = express.Router();

async function getUserEmail(uid) {
  const user = await adminAuth.getUser(uid);
  if (!user.email) { const error = new Error('No email address is associated with this account.'); error.statusCode = 400; throw error; }
  return { user, email: user.email };
}

router.get('/api/email/status', requireAuth, (req, res) => res.json({ success: true, ...getEmailStatus() }));

router.get('/api/auth/email-otp/status', requireAuth, asyncHandler(async (req, res) => {
  res.json({ success: true, ...(await emailOtpStatus(req.user.uid)) });
}));

router.post('/api/auth/email-otp/send', requireAuth, rateLimit(5, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  res.json({ success: true, ...(await sendEmailOtp(req.user.uid)) });
}));

router.post('/api/auth/email-otp/verify', requireAuth, rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  res.json({ success: true, ...(await verifyEmailOtp(req.user.uid, req.body?.code)) });
}));

router.post('/api/email/welcome', requireAuth, rateLimit(2, 24 * 60 * 60 * 1000), asyncHandler(async (req, res) => {
  const uid = req.user.uid; const snap = await db.collection('users').doc(uid).get(); const data = snap.data() || {}; const { user, email } = await getUserEmail(uid);
  if (data.welcomeEmailSentAt) return res.json({ success: true, sent: false, reason: 'already_sent' });
  const result = await sendEmail({ to: email, subject: 'Welcome to PocketVault 🇲🇼', idempotencyKey: `welcome-user/${uid}`, tags: [{ name: 'category', value: 'welcome' }, { name: 'product', value: 'pocketvault' }], ...buildWelcomeEmail(data.name || user.displayName || 'there') });
  await db.collection('users').doc(uid).set({ welcomeEmailSentAt: new Date().toISOString(), welcomeEmailId: result?.id || null }, { merge: true });
  res.json({ success: true, sent: true, id: result?.id || null });
}));

router.post('/api/email/transaction', requireAuth, rateLimit(10, 60 * 60 * 1000), asyncHandler(async (req, res) => {
  const uid = req.user.uid; const { type, amount, status = 'completed', reference } = req.body;
  const allowedTypes = new Set(['savings', 'withdrawal', 'subscription', 'merchant_payment']);
  if (!allowedTypes.has(type)) return res.status(400).json({ success: false, error: 'Invalid transaction type' });
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });
  const { email } = await getUserEmail(uid); const rawStatus = String(status).trim().slice(0, 40) || 'completed'; const rawReference = reference ? String(reference).trim().slice(0, 100) : 'N/A';
  const result = await sendEmail({ to: email, subject: `${type.replace('_', ' ')} ${rawStatus} — PocketVault`, idempotencyKey: `transaction/${uid}/${type}/${rawReference}/${parsedAmount}/${rawStatus}`.slice(0, 256), tags: [{ name: 'category', value: 'transaction' }, { name: 'transaction_type', value: type }], ...buildTransactionEmail({ type, amount: parsedAmount, status: rawStatus, reference: rawReference }) });
  res.json({ success: true, sent: true, id: result?.id || null });
}));

export default router;
