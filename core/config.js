// PocketVault shared configuration.
// AI config (AI object, callAnthropic/callGemini/callGroq, tool
// definitions) is NOT here — it's admin-only and lives entirely in
// routes/admin.js alongside the AI routes that use it, since nothing
// outside that file ever touches it.
export { db, FieldValue } from './firebase.js';

// ----------------------------
// AIRTEL CONFIG
// ----------------------------
export const AIRTEL = {
  BASE_URL: 'https://openapi.airtel.africa',
  CLIENT_ID: process.env.AIRTEL_CLIENT_ID,
  CLIENT_SECRET: process.env.AIRTEL_CLIENT_SECRET,
  PIN: process.env.AIRTEL_PIN,
  COUNTRY: 'MW',
  CURRENCY: 'MWK'
};

// ----------------------------
// PAYCHANGU CONFIGURATION
// PayChangu is an RBM-licensed Malawian payment aggregator that
// already supports Airtel Money AND TNM Mpamba collections/payouts
// today, without needing Airtel's own direct-API approval. Used as
// a bridge while waiting on that approval — see PAYMENT_PROVIDER
// below for how the two coexist.
// ----------------------------
export const PAYCHANGU = {
  BASE_URL: 'https://api.paychangu.com',
  SECRET_KEY: process.env.PAYCHANGU_SECRET_KEY || null,
  WEBHOOK_SECRET: process.env.PAYCHANGU_WEBHOOK_SECRET || null,
  CURRENCY: 'MWK',
  // Mobile money operator reference IDs — PayChangu requires these
  // instead of accepting a raw phone number directly. Fetched once
  // via their "Get Operator ID" endpoint and cached here; if either
  // is ever null, resolveOperatorId() falls back to fetching fresh.
  operatorIds: { airtel: null, tnm: null }
};

// ----------------------------
// PAYMENT PROVIDER SELECTION
// Mirrors the exact same pattern used for AI_PROVIDER (Anthropic /
// Gemini / Groq) — one env var picks which payment rail is active,
// every call site in the app stays completely unchanged either way.
//
// 'airtel_direct' -> calls Airtel's Open API directly (needs Airtel's
//                    own merchant approval, which may take a while)
// 'paychangu'      -> routes through PayChangu instead (already live,
//                    covers both Airtel Money and TNM Mpamba, small
//                    per-transaction fee on top of your own platform fee)
//
// If PAYMENT_PROVIDER isn't set, auto-picks whichever is configured —
// Airtel direct first (since it's cheaper once approved), PayChangu
// as the fallback bridge.
// ----------------------------
export function resolvePaymentProvider() {
  const explicit = (process.env.PAYMENT_PROVIDER || '').toLowerCase();
  if (explicit === 'airtel_direct' && AIRTEL.CLIENT_ID) return 'airtel_direct';
  if (explicit === 'paychangu' && PAYCHANGU.SECRET_KEY) return 'paychangu';
  if (AIRTEL.CLIENT_ID) return 'airtel_direct';
  if (PAYCHANGU.SECRET_KEY) return 'paychangu';
  return 'mock';
}

// True when NEITHER payment provider is configured — the app-wide
// signal for "behave as instant-success mock mode", used everywhere
// that previously checked `!AIRTEL.CLIENT_ID` directly. Replacing
// those checks with this function is what lets PayChangu (or any
// future provider) take over real payment processing without
// leaving the app stuck thinking it's still in mock mode.
export function isMockMode() {
  return resolvePaymentProvider() === 'mock';
}

// ----------------------------
// PLANS & PRICING
// ----------------------------
export const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    maxGoals: 2,
    maxAutoRules: 0,
    analytics: false,
    merchant: false,
    roundUp: false,
    aiInsights: false,
    savingsLock: false,
    // Effective rate charged to the user — inclusive of Airtel's 1.5%
    // pass-through cost (see helpers.js AIRTEL_FEE_PERCENT). Old rate
    // was 1%, which is what PocketVault actually keeps as revenue;
    // raised to 2.5% so that 1% margin is preserved rather than eaten
    // by Airtel's cut.
    transactionFeePercent: 2.5,
    withdrawalFeePercent: 2.5
  },
  pro: {
    name: 'Pro',
    price: 2500,
    maxGoals: 20,
    maxAutoRules: 10,
    analytics: true,
    merchant: false,
    roundUp: true,
    aiInsights: true,
    savingsLock: true,
    // Was 0.75% platform margin — raised to 2.25% effective (0.75% + 1.5% Airtel)
    transactionFeePercent: 2.25,
    withdrawalFeePercent: 2.25
  },
  business: {
    name: 'Business',
    price: 8000,
    maxGoals: 100,
    maxAutoRules: 50,
    analytics: true,
    merchant: true,
    roundUp: true,
    aiInsights: true,
    savingsLock: true,
    // Was 0.5% platform margin — raised to 2% effective (0.5% + 1.5% Airtel)
    transactionFeePercent: 2,
    withdrawalFeePercent: 2
  }
};

// ----------------------------
// SECURITY CONFIG
// ----------------------------
export const SECURITY = {
  MAX_SAVE_AMOUNT: 5000000,
  MIN_SAVE_AMOUNT: 100,
  AIRTEL_WEBHOOK_SECRET: process.env.AIRTEL_WEBHOOK_SECRET || null
};

export const FLOAT_THRESHOLD = parseInt(process.env.FLOAT_THRESHOLD) || 50000;

// Bump this string whenever the actual Terms & Conditions text
// changes, so termsVersion on a user's record reflects exactly
// which version they agreed to.
export const CURRENT_TERMS_VERSION = '2026-06-01';
