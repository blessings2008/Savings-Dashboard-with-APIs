// PocketVault email, verification and report routes.
import express from 'express';
import { db, adminAuth } from '../core/firebase.js';
import { requireAuth, requireAdmin, asyncHandler, rateLimit } from '../core/middleware.js';
import { sendEmail, getEmailStatus, buildWelcomeEmail, buildTransactionEmail, emailOtpStatus, sendEmailOtp, verifyEmailOtp } from '../services/email.js';
import { createUserTransactionPdf, sendUserTransactionPdf, sendMonthlyAdminReport } from '../services/reports.js';

const router = express.Router();

async function getUserEmail(uid) {
  const user = await adminAuth.getUser(uid);
  if (!user.email) { const error = new Error('No email address is associated with this account.'); error.statusCode = 400; throw error; }
  return { user, email: user.email };
}

router.get('/api/email/status', requireAuth, (req, res) => res.json({ success: true, ...getEmailStatus() }));

// ---------------- EMAIL OTP ----------------
router.get('/api/auth/email-otp/status', requireAuth, asyncHandler(async (req, res) => res.json({ success: true, ...(await emailOtpStatus(req.user.uid)) })));
router.post('/api/auth/email-otp/send', requireAuth, rateLimit(5, 15 * 60 * 1000), asyncHandler(async (req, res) => res.json({ success: true, ...(await sendEmailOtp(req.user.uid)) })));
router.post('/api/auth/email-otp/verify', requireAuth, rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => res.json({ success: true, ...(await verifyEmailOtp(req.user.uid, req.body?.code)) })));

// ---------------- USER EMAILS ----------------
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

// ---------------- USER PDF REPORTS ----------------
router.get('/api/reports/transactions.pdf', requireAuth, rateLimit(10, 60 * 60 * 1000), asyncHandler(async (req, res) => {
  const { pdf } = await createUserTransactionPdf(req.user.uid, { from: req.query.from, to: req.query.to, limit: req.query.limit });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="pocketvault-transaction-history.pdf"', 'Cache-Control': 'private, no-store' });
  res.send(pdf);
}));

router.post('/api/reports/transactions/email', requireAuth, rateLimit(5, 24 * 60 * 60 * 1000), asyncHandler(async (req, res) => {
  const result = await sendUserTransactionPdf(req.user.uid, { from: req.body?.from, to: req.body?.to, limit: req.body?.limit });
  res.json({ success: true, sent: true, emailId: result.emailId, transactionCount: result.transactions.length });
}));

// ---------------- ADMIN MONTHLY PDF ----------------
router.post('/api/admin/reports/monthly/email', requireAdmin, rateLimit(3, 24 * 60 * 60 * 1000), asyncHandler(async (req, res) => {
  const now = new Date();
  let year = Number(req.body?.year || now.getFullYear());
  let month = Number(req.body?.month || now.getMonth());
  // Default is the previous calendar month, not the current partial month.
  if (!req.body?.year && !req.body?.month) { const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1); year = previous.getFullYear(); month = previous.getMonth() + 1; }
  if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) return res.status(400).json({ success: false, error: 'Invalid report month.' });
  const result = await sendMonthlyAdminReport({ year, month, to: req.body?.to || process.env.ADMIN_REPORT_EMAIL || req.user.email });
  res.json({ success: true, sent: true, emailId: result.emailId, recipient: result.recipient, month: result.monthLabel, metrics: result.metrics });
}));

export default router;
