import express from 'express';
import { requireAuth, asyncHandler, rateLimit } from '../core/middleware.js';
import { setTransactionPin, verifyTransactionPin, validateTransactionPin } from '../core/transaction-pin.js';

const router = express.Router();

router.post('/api/security/transaction-pin/set', requireAuth, rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!validateTransactionPin(pin)) return res.status(400).json({ success: false, error: 'Transaction PIN must be exactly 6 digits.' });
  await setTransactionPin(req.user.uid, pin);
  res.json({ success: true, message: 'Transaction PIN set successfully.' });
}));

router.post('/api/security/transaction-pin/verify', requireAuth, rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const result = await verifyTransactionPin(req.user.uid, String(req.body?.pin || ''));
  if (!result.ok) return res.status(result.code === 'PIN_LOCKED' ? 429 : 400).json({ success: false, ...result });
  res.json({ success: true, verified: true });
}));

export default router;
