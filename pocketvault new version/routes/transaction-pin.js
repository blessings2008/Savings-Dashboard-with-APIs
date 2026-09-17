import express from 'express';
import { requireAuth, asyncHandler, rateLimit } from '../core/middleware.js';
import { db } from '../core/firebase.js';
import { setTransactionPin, verifyTransactionPin, validateTransactionPin, hasTransactionPin } from '../core/transaction-pin.js';

const router = express.Router();

router.get('/api/security/transaction-pin/status', requireAuth, asyncHandler(async (req, res) => {
  res.json({ success: true, configured: await hasTransactionPin(req.user.uid) });
}));

router.post('/api/security/transaction-pin/set', requireAuth, rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!validateTransactionPin(pin)) return res.status(400).json({ success: false, error: 'Transaction PIN must be exactly 6 digits.' });
  const snap = await db.collection('users').doc(req.user.uid).get();
  const existing = snap.data()?.transactionPin;
  if (existing?.hash && existing?.salt) {
    const currentPin = String(req.body?.currentPin || '');
    const check = await verifyTransactionPin(req.user.uid, currentPin);
    if (!check.ok) return res.status(check.code === 'PIN_LOCKED' ? 429 : 403).json({ success: false, ...check });
  }
  await setTransactionPin(req.user.uid, pin);
  res.json({ success: true, message: 'Transaction PIN set successfully.' });
}));

router.post('/api/security/transaction-pin/verify', requireAuth, rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const result = await verifyTransactionPin(req.user.uid, String(req.body?.pin || ''));
  if (!result.ok) return res.status(result.code === 'PIN_LOCKED' ? 429 : result.code === 'PIN_NOT_SET' ? 428 : 400).json({ success: false, ...result });
  res.json({ success: true, verified: true });
}));

export default router;
