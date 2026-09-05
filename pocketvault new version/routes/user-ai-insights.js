// Read-only proactive financial insights for the authenticated user.
import express from 'express';
import { requireAuth, asyncHandler, getUserPlan } from '../core/middleware.js';
import { buildUserInsights } from '../core/user-insights.js';

const router = express.Router();

router.get('/api/ai/insights', requireAuth, asyncHandler(async (req, res) => {
  const plan = await getUserPlan(req.user.uid);
  const result = await buildUserInsights(req.user.uid, plan);
  res.json({ success: true, ...result });
}));

export default router;
