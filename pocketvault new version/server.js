// PocketVault server entry point.
//
// This file used to contain everything — Firebase init, config,
// every route, every background job — in one ~6,000-line module.
// It's now split across core/, helpers.js, routes/, and jobs.js —
// this file's only job is app setup (security headers, structured
// request logging, CORS, static file serving), mounting the route
// modules, wiring the catch-all route and global error handler, and
// scheduling the background jobs.
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import crypto from 'crypto';

import { validateEnvironment } from './core/firebase.js';
import { AIRTEL, PAYCHANGU, SECURITY, resolvePaymentProvider } from './core/config.js';
import { sanitizeBody, rateLimit } from './core/middleware.js';
import { log, logSystemError, sendExternalAlert, fetchWithRetry } from './helpers.js';

import userRoutes from './routes/user.js';
import userAIRoutes from './routes/user-ai.js';
import userAIInsightRoutes from './routes/user-ai-insights.js';
import adminRoutes, { resolveAIProvider } from './routes/admin.js';

import {
  reconcilePendingTransactions, monitorFloat, checkExpiredSubscriptions,
  checkGoalDeadlines, checkFrozenGoalGracePeriod, runAutosaveRules,
  sweepUnresolvedFunds,
  checkTransactionSummaries, proactiveAnomalyCheck
} from './jobs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

validateEnvironment();

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.removeHeader('X-Powered-By');
  next();
});

app.use((req, res, next) => {
  req.requestId = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

app.use(cors({
  origin: [
    `https://${process.env.APP_DOMAIN || 'savings-dashboard-with-apis-2-0.onrender.com'}`,
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(sanitizeBody);
app.use(express.static(__dirname));
app.set('trust proxy', 1);

app.use('/api/', rateLimit(300, 15 * 60 * 1000));
app.use('/api/save', rateLimit(10, 60 * 1000));
app.use('/api/withdraw', rateLimit(5, 60 * 1000));
app.use('/api/subscribe', rateLimit(5, 60 * 1000));
app.use('/api/merchant/collect', rateLimit(20, 60 * 1000));
app.use('/api/merchant/disburse', rateLimit(20, 60 * 1000));
app.use('/api/kyc', rateLimit(5, 60 * 1000));

app.use('/', userRoutes);
app.use('/', userAIRoutes);
app.use('/', userAIInsightRoutes);
app.use('/', adminRoutes);

app.use('/admin', express.static(join(__dirname, 'admin')));

app.get('*', (req, res) => {
  if (req.path.startsWith('/admin')) {
    const adminIndex = join(__dirname, 'admin', 'index.html');
    if (existsSync(adminIndex)) return res.sendFile(adminIndex);
    return res.status(404).json({ success: false, error: 'Admin panel not deployed' });
  }

  const indexPath = join(__dirname, 'index.html');
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).json({
      status: 'ok', app: 'PocketVault API',
      message: 'Backend running. No frontend deployed yet.', health: '/api/health'
    });
  }
});

app.use((err, req, res, next) => {
  const message = err.message || 'Unknown error';
  log.error('Unhandled request error', { requestId: req.requestId, url: req.url, method: req.method, error: message, stack: err.stack });
  logSystemError('express', message, { stack: err.stack, url: req.url, method: req.method, requestId: req.requestId });

  const isFirestoreUnavailable = err.code === 14 || err.code === 4 || /UNAVAILABLE|DEADLINE_EXCEEDED/i.test(message);
  if (isFirestoreUnavailable) {
    return res.status(503).json({ success: false, error: 'Our database is temporarily unavailable. Please try again in a few moments.', requestId: req.requestId });
  }

  res.status(500).json({ success: false, error: 'Something went wrong. Please try again.', requestId: req.requestId });
});

process.on('uncaughtException', err => {
  console.error('💥 Uncaught:', err.message);
  logSystemError('uncaughtException', err.message, { stack: err.stack });
  sendExternalAlert('Uncaught exception', `${err.message}\n${(err.stack || '').slice(0, 500)}`);
});
process.on('unhandledRejection', reason => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('💥 Rejection:', message);
  logSystemError('unhandledRejection', message, { stack: reason?.stack });
  sendExternalAlert('Unhandled promise rejection', message);
});

setInterval(reconcilePendingTransactions, 5 * 60 * 1000);
setInterval(monitorFloat, 30 * 60 * 1000);
setInterval(checkExpiredSubscriptions, 24 * 60 * 60 * 1000);
setInterval(checkGoalDeadlines, 24 * 60 * 60 * 1000);
setInterval(checkFrozenGoalGracePeriod, 24 * 60 * 60 * 1000);
setInterval(sweepUnresolvedFunds, 24 * 60 * 60 * 1000);
setInterval(runAutosaveRules, 24 * 60 * 60 * 1000);
setInterval(checkTransactionSummaries, 5 * 60 * 1000);
setInterval(proactiveAnomalyCheck, 15 * 60 * 1000);

setTimeout(reconcilePendingTransactions, 10000);
setTimeout(monitorFloat, 15000);
setTimeout(checkExpiredSubscriptions, 20000);
setTimeout(checkGoalDeadlines, 25000);
setTimeout(checkFrozenGoalGracePeriod, 27000);
setTimeout(sweepUnresolvedFunds, 29000);
setTimeout(runAutosaveRules, 30000);
setTimeout(checkTransactionSummaries, 35000);
setTimeout(proactiveAnomalyCheck, 40000);

const server = app.listen(PORT, () => {
  const _activePaymentProvider = resolvePaymentProvider();
  const _paymentProviderLabel = {
    airtel_direct: '✅ Airtel Direct',
    paychangu: '✅ PayChangu (bridge)',
    mock: '⏳ Mock mode — no provider configured'
  }[_activePaymentProvider];

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           💰 POCKETVAULT BACKEND v2.0 — READY 🚀           ║
╠══════════════════════════════════════════════════════════════╣
║  Port      : ${PORT}                                         ║
║  Database  : Firestore ✅                                    ║
║  Auth      : Firebase Token Verification ✅                  ║
║  Security  : Headers + CORS + Sanitizer + Rate limit ✅      ║
║  Payments  : ${_paymentProviderLabel}                        ║
║  Jobs      : Reconciler + Float monitor + Sub checker ✅     ║
║  AI        : ${resolveAIProvider() ? `Admin ${resolveAIProvider()} + User AI` : 'Not configured'}                    ║
╚══════════════════════════════════════════════════════════════╝
`);
});

export default app;
