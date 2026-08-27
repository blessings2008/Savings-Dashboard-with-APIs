// PocketVault server entry point.
//
// This file used to contain everything — Firebase init, config,
// every route, every background job — in one ~6,000-line module.
// It's now split across core/, helpers.js, routes/, and jobs.js —
// this file's only job is app setup (security headers, structured
// request logging, CORS, static file serving), mounting the two
// route modules, wiring the catch-all route and global error
// handler, and scheduling the background jobs. See each imported
// module for the logic that used to live here inline.
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
import adminRoutes, { resolveAIProvider } from './routes/admin.js';

import {
  reconcilePendingTransactions, monitorFloat, checkExpiredSubscriptions,
  checkGoalDeadlines, checkFrozenGoalGracePeriod, runAutosaveRules,
  sweepUnresolvedFunds,
  checkTransactionSummaries, proactiveAnomalyCheck
} from './jobs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Boot-time environment validation — refuses to start if something
// genuinely required (ADMIN_SECRET) is missing. See core/firebase.js
// for the REQUIRED vs RECOMMENDED distinction.
validateEnvironment();

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.removeHeader('X-Powered-By');
  next();
});

// ----------------------------
// REQUEST ID MIDDLEWARE
// PRODUCTION FIX #7: every request gets a short random ID, exposed
// via the X-Request-Id response header, attached to req so any
// handler can include it in error responses or logs — turning "my
// save didn't work" into something traceable to one exact request.
// ----------------------------
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

// Raised from 100/15min — that ceiling applies globally across every
// /api/ route including admin panel page loads (which fire several
// calls each) and AI chat (which can chain multiple tool-call steps
// per question). Normal admin usage was tripping this.
app.use('/api/', rateLimit(300, 15 * 60 * 1000));
app.use('/api/save', rateLimit(10, 60 * 1000));
app.use('/api/withdraw', rateLimit(5, 60 * 1000));
app.use('/api/subscribe', rateLimit(5, 60 * 1000));
app.use('/api/merchant/collect', rateLimit(20, 60 * 1000));
app.use('/api/merchant/disburse', rateLimit(20, 60 * 1000));
app.use('/api/kyc', rateLimit(5, 60 * 1000));

// ----------------------------
// ROUTES
// User-facing routes (health, plans, subscribe, profile, KYC,
// referrals, goals, save/withdraw, autosave, merchant, transactions,
// analytics, notifications, webhooks) and admin routes (everything
// behind requireAdmin, including the AI subsystem) each own their
// full path — mounted at '/' since every route already declares its
// full /api/... path.
// ----------------------------
app.use('/', userRoutes);
app.use('/', adminRoutes);

// ----------------------------
// STATIC FILES
// /admin serves the separate admin panel (admin/index.html, admin/admin.js, etc).
// Everything else falls back to the main app's index.html (SPA routing).
// ----------------------------
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
      status: 'ok',
      app: 'PocketVault API',
      message: 'Backend running. No frontend deployed yet.',
      health: '/api/health'
    });
  }
});

// ----------------------------
// GLOBAL ERROR HANDLER
// ----------------------------
app.use((err, req, res, next) => {
  const message = err.message || 'Unknown error';
  log.error('Unhandled request error', { requestId: req.requestId, url: req.url, method: req.method, error: message, stack: err.stack });
  logSystemError('express', message, { stack: err.stack, url: req.url, method: req.method, requestId: req.requestId });

  // PRODUCTION FIX #8: Firestore/gRPC outages surface as specific
  // error codes (UNAVAILABLE, DEADLINE_EXCEEDED) rather than generic
  // JS errors. Recognizing these lets us tell the user "try again in
  // a moment" — an honest, actionable message — instead of the same
  // opaque "something went wrong" used for every other failure.
  const isFirestoreUnavailable = err.code === 14 || err.code === 4 ||
    /UNAVAILABLE|DEADLINE_EXCEEDED/i.test(message);
  if (isFirestoreUnavailable) {
    return res.status(503).json({
      success: false,
      error: 'Our database is temporarily unavailable. Please try again in a few moments.',
      requestId: req.requestId
    });
  }

  // Include the request ID in the response so a user reporting "it
  // didn't work" can hand you the exact ID to search logs for
  res.status(500).json({ success: false, error: 'Something went wrong. Please try again.', requestId: req.requestId });
});

// ----------------------------
// PROCESS SAFETY
// ----------------------------
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

// ----------------------------
// BACKGROUND JOBS
// ----------------------------
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

// ----------------------------
// START
// ----------------------------
const server = app.listen(PORT, () => {
  const _activePaymentProvider = resolvePaymentProvider();
  const _paymentProviderLabel = {
    airtel_direct: '✅ Airtel Direct',
    paychangu: '✅ PayChangu (bridge)',
    mock: '⏳ Mock mode — no provider configured'
  }[_activePaymentProvider];

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           💰 POCKETVAULT BACKEND v2.0 — READY 🚀               ║
╠══════════════════════════════════════════════════════════════╣
║  Port      : ${PORT}                                         ║
║  Database  : Firestore ✅                                    ║
║  Auth      : Firebase Token Verification ✅                  ║
║  Security  : Headers + CORS + Sanitizer + Rate limit ✅      ║
║  Payments  : ${_paymentProviderLabel}                        ║
║  Jobs      : Reconciler + Float monitor + Sub checker ✅     ║
╠══════════════════════════════════════════════════════════════╣
║  REVENUE STREAMS                                             ║
║  ✅ Transaction fees (plan-based: 0.5% - 1%)                 ║
║  ✅ Subscription plans (Free/Pro/Business)                   ║
║  ✅ Merchant collection & disbursement fees                  ║
║  ✅ Round-up savings fees                                    ║
║  ✅ Float monitoring for interest tracking                   ║
║  ✅ Admin revenue dashboard                                  ║
╠══════════════════════════════════════════════════════════════╣
║  PLANS                                                       ║
║  Free     : MWK 0    — 2 goals, 1% fee                      ║
║  Pro      : MWK 2,500 — 20 goals, 0.75% fee                 ║
║  Business : MWK 8,000 — 100 goals, 0.5% fee + merchant      ║
╚══════════════════════════════════════════════════════════════╝
  `);

  // ----------------------------
  // SECURITY STARTUP CHECKS
  // Loud, impossible-to-miss warnings for misconfigurations
  // that would leave the app exposed.
  // ----------------------------
  if (!process.env.ADMIN_SECRET) {
    console.warn('🚨 SECURITY WARNING: ADMIN_SECRET is not set. The admin panel is completely inaccessible until this is configured — set it in Render environment variables.');
  }
  if (_activePaymentProvider === 'airtel_direct' && !SECURITY.AIRTEL_WEBHOOK_SECRET) {
    console.warn('🚨 SECURITY WARNING: Airtel direct is active but AIRTEL_WEBHOOK_SECRET is NOT set. The webhook endpoint will accept unauthenticated requests. Set AIRTEL_WEBHOOK_SECRET before going live with real money.');
  }
  if (_activePaymentProvider === 'paychangu' && !PAYCHANGU.WEBHOOK_SECRET) {
    console.warn('🚨 SECURITY WARNING: PayChangu is active but PAYCHANGU_WEBHOOK_SECRET is NOT set. The PayChangu webhook endpoint will accept unauthenticated requests. Set PAYCHANGU_WEBHOOK_SECRET before going live with real money.');
  }
  if (_activePaymentProvider === 'mock') {
    console.log('ℹ️  Running in mock mode — no AIRTEL_CLIENT_ID or PAYCHANGU_SECRET_KEY configured yet. All payments will be simulated instantly.');
  }
  const activeProvider = resolveAIProvider();
  const providerNames = { anthropic: 'Anthropic (Claude)', gemini: 'Google (Gemini)', groq: 'Groq (Llama)' };
  if (!activeProvider) {
    console.log('ℹ️  No AI provider configured — set ANTHROPIC_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY to enable admin AI features (chat assistant, anomaly detection, message drafting, insights, error analysis).');
  } else {
    console.log(`✅ AI features configured — using ${providerNames[activeProvider]}. Chat assistant, anomaly detection, message drafting, insights, and error analysis are live.`);
  }
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  server.close(() => process.exit(0));
});

export default app;
