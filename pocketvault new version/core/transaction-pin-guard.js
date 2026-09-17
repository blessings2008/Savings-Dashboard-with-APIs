import { requireAuth } from './middleware.js';
import { verifyTransactionPin } from './transaction-pin.js';

// Authorization gate for money-moving endpoints. Existing route handlers still
// perform their own auth and ownership checks; this gate adds the PIN requirement
// before business logic can run.
export function requireTransactionPin(req, res, next) {
  requireAuth(req, res, async () => {
    try {
      const result = await verifyTransactionPin(
        req.user.uid,
        String(req.body?.transactionPin || req.body?.pin || '')
      );
      if (!result.ok) {
        const status = result.code === 'PIN_NOT_SET' ? 428 : result.code === 'PIN_LOCKED' ? 429 : 403;
        return res.status(status).json({ success: false, ...result });
      }
      next();
    } catch (error) {
      next(error);
    }
  });
}
