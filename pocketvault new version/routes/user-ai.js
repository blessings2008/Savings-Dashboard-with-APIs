// PocketVault user-facing AI routes.
// Separate from admin AI: authenticated users can only ask about their
// own account context, and the endpoint is read-only in this first phase.
import express from 'express';
import { requireAuth, asyncHandler, getUserPlan, rateLimit } from '../core/middleware.js';
import {
  buildUserContext,
  callUserAI,
  consumeUserAIQuota,
  getUserAILimits,
  resolveUserAIProvider,
  userAISystemPrompt
} from '../core/user-ai.js';

const router = express.Router();

router.get('/api/ai/status', requireAuth, asyncHandler(async (req, res) => {
  const plan = await getUserPlan(req.user.uid);
  const limits = getUserAILimits(plan);
  res.json({
    success: true,
    configured: !!resolveUserAIProvider(),
    plan,
    dailyMessageLimit: limits.dailyMessages,
    historyDays: limits.historyDays,
    insights: limits.insights,
    actions: false,
    mode: 'read_only'
  });
}));

router.post('/api/ai/chat',
  requireAuth,
  rateLimit(30, 60 * 60 * 1000),
  asyncHandler(async (req, res) => {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ success: false, error: 'Message is required' });
    if (message.length > 1000) return res.status(400).json({ success: false, error: 'Message is too long' });

    const uid = req.user.uid;
    const plan = await getUserPlan(uid);
    const limits = getUserAILimits(plan);
    const quota = await consumeUserAIQuota(uid, plan);
    if (!quota.allowed) {
      return res.status(429).json({
        success: false,
        error: `You've reached your daily PocketVault AI limit of ${quota.limit} messages.`,
        code: 'AI_DAILY_LIMIT',
        plan,
        used: quota.used,
        limit: quota.limit,
        upgrade: plan === 'free'
      });
    }

    const context = await buildUserContext(uid, plan);
    const answer = await callUserAI(
      userAISystemPrompt(plan),
      `USER CONTEXT (trusted PocketVault data):\n${JSON.stringify(context)}\n\nUSER QUESTION:\n${message}`,
      plan === 'free' ? 450 : 700
    );

    res.json({
      success: true,
      answer: answer || 'I could not generate a response right now. Please try again.',
      usage: { used: quota.used, limit: limits.dailyMessages, remaining: Math.max(0, limits.dailyMessages - quota.used) },
      plan,
      mode: 'read_only'
    });
  })
);

export default router;
