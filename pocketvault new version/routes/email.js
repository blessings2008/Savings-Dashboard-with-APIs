// PocketVault transactional email routes.
// Resend credentials stay server-side; these routes never accept an API key.
import express from 'express';
import { db, adminAuth } from '../core/firebase.js';
import { requireAuth, asyncHandler, rateLimit } from '../core/middleware.js';
import { sendEmail, isEmailConfigured } from '../services/email.js';

const router = express.Router();

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

async function getUserEmail(uid) {
  const user = await adminAuth.getUser(uid);
  if (!user.email) {
    const error = new Error('No email address is associated with this account.');
    error.statusCode = 400;
    throw error;
  }
  return { user, email: user.email };
}

router.get('/api/email/status', requireAuth, (req, res) => {
  res.json({ success: true, configured: isEmailConfigured() });
});

router.post('/api/email/welcome',
  requireAuth,
  rateLimit(2, 24 * 60 * 60 * 1000),
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const snap = await db.collection('users').doc(uid).get();
    const data = snap.data() || {};
    const { user, email } = await getUserEmail(uid);

    if (data.welcomeEmailSentAt) {
      return res.json({ success: true, sent: false, reason: 'already_sent' });
    }

    const name = data.name || user.displayName || 'there';
    const result = await sendEmail({
      to: email,
      subject: 'Welcome to PocketVault 🇲🇼',
      idempotencyKey: `welcome-user/${uid}`,
      text: `Hi ${name},\n\nWelcome to PocketVault. Your account is ready. Start building your savings goals and track your money smarter.\n\n— PocketVault`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;line-height:1.6;color:#17202a"><h2>Welcome to PocketVault 🇲🇼</h2><p>Hi ${escapeHtml(name)},</p><p>Your PocketVault account is ready.</p><p>Start building savings goals, tracking your money and making progress toward what matters to you.</p><p>— PocketVault</p></div>`
    });

    await db.collection('users').doc(uid).set({
      welcomeEmailSentAt: new Date().toISOString(),
      welcomeEmailId: result?.id || null
    }, { merge: true });

    res.json({ success: true, sent: true, id: result?.id || null });
  })
);

router.post('/api/email/transaction',
  requireAuth,
  rateLimit(10, 60 * 60 * 1000),
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const { type, amount, status = 'completed', reference } = req.body;
    const allowedTypes = new Set(['savings', 'withdrawal', 'subscription', 'merchant_payment']);
    if (!allowedTypes.has(type)) return res.status(400).json({ success: false, error: 'Invalid transaction type' });

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const { email } = await getUserEmail(uid);
    const label = {
      savings: 'Savings',
      withdrawal: 'Withdrawal',
      subscription: 'Subscription',
      merchant_payment: 'Merchant payment'
    }[type];

    const safeStatus = String(status).slice(0, 40);
    const safeReference = reference ? String(reference).slice(0, 100) : 'N/A';
    const formatted = `MWK ${parsedAmount.toLocaleString()}`;

    const result = await sendEmail({
      to: email,
      subject: `${label} ${safeStatus} — PocketVault`,
      idempotencyKey: `transaction/${uid}/${safeReference}/${type}`,
      text: `${label} ${safeStatus}.\nAmount: ${formatted}\nReference: ${safeReference}\n\n— PocketVault`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;line-height:1.6;color:#17202a"><h2>${escapeHtml(label)} ${escapeHtml(safeStatus)}</h2><p><strong>Amount:</strong> ${escapeHtml(formatted)}</p><p><strong>Reference:</strong> ${escapeHtml(safeReference)}</p><p>— PocketVault</p></div>`
    });

    res.json({ success: true, sent: true, id: result?.id || null });
  })
);

export default router;
