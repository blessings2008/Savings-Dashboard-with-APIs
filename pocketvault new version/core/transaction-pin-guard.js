import { requireAuth } from './middleware.js';
import { verifyTransactionPin } from './transaction-pin.js';

// Authorization gate for money-moving endpoints. The existing route handlers
// still perform their own auth and ownership checks; this gate only adds the
// Transaction PIN requirement before business logic can run.
export function requireTransactionPin(req, res, next) {
  requireAuth(req, res, async () => {
    try {
      const result = await verifyTransactionPin(req.user.uid, String(req.body?.transactionPin || req.body?.pin || ''));
      if (!result.ok) return res.status(result.code === 'PIN_LOCKED' ? 429 : 403).json({ success: false, ...result });
      next();
    } catch (error) {
      next(error);
    }
  });
}
