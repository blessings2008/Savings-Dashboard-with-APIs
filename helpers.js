// PocketVault shared business-logic helpers.
// Used by both routes/user.js and routes/admin.js and jobs.js.
import crypto from 'crypto';
import { db, FieldValue, getGcpAccessToken, getFirebaseProjectId } from './core/firebase.js';
import { AIRTEL, PAYCHANGU, resolvePaymentProvider, FLOAT_THRESHOLD } from './core/config.js';
import { cache, airtelQueue, queueAirtelCall, getAirtelTokenState, setAirtelToken, setAirtelTokenRefreshing, breakers } from './core/state.js';
import { canCall, recordSuccess, recordFailure } from './core/circuit-breaker.js';

// ----------------------------
// STRUCTURED LOGGING
// PRODUCTION FIX #6: wraps every log line in a single JSON object
// (the format most log aggregators expect), tagged with a severity
// level and, when available, the requestId that ties it back to
// one specific HTTP request. New code uses log.info/warn/error;
// existing console.log calls continue to work as before.
// ----------------------------
function structuredLog(level, message, meta = {}) {
  const entry = { level, message, timestamp: new Date().toISOString(), ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
export const log = {
  info: (message, meta) => structuredLog('info', message, meta),
  warn: (message, meta) => structuredLog('warn', message, meta),
  error: (message, meta) => structuredLog('error', message, meta),
};

// ----------------------------
// ERROR LOGGING HELPER
// Called internally to log errors to system_errors collection
// ----------------------------
export async function logSystemError(source, message, extra = {}) {
  try {
    await db.collection('system_errors').add({
      source, message,
      stack: extra.stack || null,
      extra: JSON.stringify(extra).slice(0, 1000),
      read: false,
      timestamp: FieldValue.serverTimestamp()
    });
  } catch (e) {
    // Never let error logging crash the server
    console.error('Failed to log system error:', e.message);
  }
}

// ----------------------------
// EXTERNAL ALERTING
// PRODUCTION FIX #5: previously, if the server crashed entirely or
// Firestore became unreachable, NOTHING outside this app would know
// — the admin panel itself is part of the same app that's down, so
// you'd only find out when a user complained. This posts a message
// to an external webhook (Slack, Discord, or any generic webhook
// URL) for genuinely critical conditions, so something outside
// PocketVault itself tells you when it's in trouble.
//
// Deliberately conservative about when this fires — only for
// conditions that mean the app is actually broken for users, not
// routine warnings that already show up in the admin Errors page.
// No-ops cleanly if ALERT_WEBHOOK_URL isn't configured.
// ----------------------------
export async function sendExternalAlert(title, details) {
  if (!process.env.ALERT_WEBHOOK_URL) return;
  try {
    await fetchWithRetry(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🚨 PocketVault: ${title}\n${details}` })
    }, { timeoutMs: 5000, maxRetries: 1, provider: 'alert_webhook' });
  } catch (err) {
    console.error('Failed to send external alert:', err.message);
  }
}

// ----------------------------
// FETCH WITH TIMEOUT + RETRY
// PRODUCTION FIX #2 & #4: every external call to Airtel/PayChangu
// previously used bare fetch() with no timeout at all — a hung
// provider response would hang the request (and the user's screen)
// indefinitely, and a single transient network blip would fail an
// otherwise-fine payment with no retry.
//
// This wraps fetch with:
// - a hard timeout (default 15s) via AbortController, so a stuck
//   provider can never hang a request forever
// - automatic retry (default 2 retries, exponential backoff) ONLY
//   for network-level failures and 5xx responses — NEVER retried
//   for 4xx responses, since blindly retrying a rejected payment
//   request could double-charge someone
// - an optional circuit breaker, keyed by `provider` (e.g. 'airtel',
//   'paychangu', 'anthropic', 'gemini', 'groq', 'alert_webhook').
//   When the breaker for that provider is OPEN, this fails
//   immediately without attempting the network call at all — no
//   timeout wait, no retry delay. Only genuine failures (network
//   error, timeout, 5xx) count toward tripping; a 4xx never trips or
//   resets a breaker, since it means the provider is fine and the
//   request itself was bad. Callers that don't pass `provider` skip
//   the breaker entirely (e.g. one-off calls that don't map to a
//   tracked external dependency).
// ----------------------------
export async function fetchWithRetry(url, options = {}, { timeoutMs = 15000, maxRetries = 2, provider = null } = {}) {
  if (provider) {
    const gate = canCall(breakers, provider);
    if (!gate.allowed) {
      const err = new Error(gate.reason);
      err.isCircuitOpen = true;
      throw err;
    }
  }

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (res.status >= 500 && attempt < maxRetries) {
        lastErr = new Error(`Provider returned ${res.status}`);
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }
      // Record the breaker outcome based on the actual response,
      // then return it to the caller exactly as before — a 5xx on
      // the final attempt still gets handed back as a response
      // object (not thrown here), since existing callers like
      // callAnthropic()/callGroq() already check res.ok themselves
      // and throw their own descriptive error. What changes is only
      // that the breaker now correctly records this as a failure,
      // not a success, even though the response object is returned.
      if (provider) {
        if (res.status >= 500) {
          const { justOpened } = recordFailure(breakers, provider);
          if (justOpened) {
            logSystemError('circuit_breaker', `${provider} circuit breaker OPENED after repeated failures`, { provider });
            sendExternalAlert(`Circuit breaker opened: ${provider}`, `${provider} has failed repeatedly (last status ${res.status}) and calls will be short-circuited for a cooldown period.`);
          }
        } else {
          // Includes 4xx — a well-formed rejection from a reachable
          // provider never counts as a breaker failure.
          recordSuccess(breakers, provider);
        }
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === 'AbortError'
        ? new Error(`Request to ${new URL(url).hostname} timed out after ${timeoutMs}ms`)
        : err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }
    }
  }
  if (provider) {
    const { justOpened } = recordFailure(breakers, provider);
    if (justOpened) {
      logSystemError('circuit_breaker', `${provider} circuit breaker OPENED after repeated failures`, { provider });
      sendExternalAlert(`Circuit breaker opened: ${provider}`, `${provider} has failed repeatedly and calls will be short-circuited for a cooldown period. Last error: ${lastErr?.message}`);
    }
  }
  throw lastErr;
}

// ----------------------------
// AIRTEL TOKEN
// ----------------------------
export async function getAirtelToken() {
  const { token, expiry, refreshing } = getAirtelTokenState();
  if (token && expiry && Date.now() < expiry - 300000) return token;
  if (refreshing) {
    await new Promise(r => setTimeout(r, 500));
    return getAirtelToken();
  }
  setAirtelTokenRefreshing(true);
  try {
    const res = await fetchWithRetry(`${AIRTEL.BASE_URL}/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: AIRTEL.CLIENT_ID,
        client_secret: AIRTEL.CLIENT_SECRET,
        grant_type: 'client_credentials'
      })
    }, { provider: 'airtel' });
    const data = await res.json();
    if (!data.access_token) throw new Error('No token: ' + JSON.stringify(data));
    const newExpiry = Date.now() + (data.expires_in || 7200) * 1000;
    setAirtelToken(data.access_token, newExpiry);
    console.log('✅ Airtel token refreshed');
    return data.access_token;
  } catch (err) {
    console.error('❌ Token error:', err.message);
    throw err;
  } finally {
    setAirtelTokenRefreshing(false);
  }
}

// ----------------------------
// AIRTEL DIRECT API CALLS (private — routed to via public functions below)
// ----------------------------
async function _airtelBalanceDirect(type = 'COLL') {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const res = await fetchWithRetry(`${AIRTEL.BASE_URL}/standard/v2/users/balance/${type}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': AIRTEL.COUNTRY,
        'X-Currency': AIRTEL.CURRENCY,
        Accept: '*/*'
      }
    }, { provider: 'airtel' });
    return res.json();
  });
}

async function _airtelCollectDirect({ phone, amount, reference }) {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const txnId = `COLL_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const res = await fetchWithRetry(`${AIRTEL.BASE_URL}/merchant/v2/payments/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': AIRTEL.COUNTRY,
        'X-Currency': AIRTEL.CURRENCY,
        'Content-Type': 'application/json',
        Accept: '*/*'
      },
      body: JSON.stringify({
        reference,
        subscriber: { country: AIRTEL.COUNTRY, currency: AIRTEL.CURRENCY, msisdn: phone },
        transaction: { amount, country: AIRTEL.COUNTRY, currency: AIRTEL.CURRENCY, id: txnId }
      })
    }, { provider: 'airtel' });
    return { ...(await res.json()), txnId, _provider: 'airtel_direct' };
  });
}

async function _airtelDisburseDirect({ phone, amount, reference }) {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const txnId = `DISB_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const res = await fetchWithRetry(`${AIRTEL.BASE_URL}/standard/v2/disbursements/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': AIRTEL.COUNTRY,
        'X-Currency': AIRTEL.CURRENCY,
        'Content-Type': 'application/json',
        Accept: '*/*'
      },
      body: JSON.stringify({
        payee: { msisdn: phone },
        reference,
        pin: AIRTEL.PIN,
        transaction: { amount, id: txnId }
      })
    }, { provider: 'airtel' });
    return { ...(await res.json()), txnId, _provider: 'airtel_direct' };
  });
}

async function _airtelKYCDirect(phone) {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const res = await fetchWithRetry(`${AIRTEL.BASE_URL}/standard/v2/users/${phone}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': AIRTEL.COUNTRY,
        'X-Currency': AIRTEL.CURRENCY,
        Accept: '*/*'
      }
    }, { provider: 'airtel' });
    return res.json();
  });
}

async function _airtelTransactionStatusDirect(reference) {
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const res = await fetchWithRetry(`${AIRTEL.BASE_URL}/standard/v2/payments/${reference}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': AIRTEL.COUNTRY,
        'X-Currency': AIRTEL.CURRENCY,
        Accept: '*/*'
      }
    }, { provider: 'airtel' });
    return res.json();
  });
}

// ----------------------------
// AIRTEL TRANSACTION SUMMARY
// ----------------------------
export async function airtelTransactionSummary(phone, { sinceMinutes = 30 } = {}) {
  if (resolvePaymentProvider() !== 'airtel_direct') return [];
  return queueAirtelCall(async () => {
    const token = await getAirtelToken();
    const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
    const res = await fetchWithRetry(
      `${AIRTEL.BASE_URL}/standard/v1/users/${phone}/transactions?since=${encodeURIComponent(since)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Country': AIRTEL.COUNTRY,
          'X-Currency': AIRTEL.CURRENCY,
          Accept: '*/*'
        }
      },
      { provider: 'airtel' }
    );
    const data = await res.json();
    const rawList = data?.data?.transactions || data?.transactions || [];
    return rawList.map(tx => ({
      id: tx.id || tx.transaction_id || tx.reference,
      direction: (tx.type === 'credit' || tx.direction === 'credit' || tx.amount > 0) ? 'credit' : 'debit',
      amount: Math.abs(parseFloat(tx.amount) || 0),
      timestamp: tx.timestamp || tx.date || new Date().toISOString()
    })).filter(tx => tx.id && tx.amount > 0);
  }).catch(err => {
    logSystemError('airtel_transaction_summary', err.message, { phone, stack: err.stack });
    return [];
  });
}

// ----------------------------
// PAYCHANGU API CALLS (private — routed to via public functions below)
// ----------------------------
function _paychanguHeaders() {
  return {
    Authorization: `Bearer ${PAYCHANGU.SECRET_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

function detectOperatorNetwork(phone) {
  const clean = (phone || '').replace(/^\+?265/, '0').replace(/\s/g, '');
  const prefix = clean.slice(0, 3);
  if (['088', '099'].includes(prefix)) return 'airtel';
  if (['089', '098'].includes(prefix)) return 'tnm';
  return 'airtel';
}

async function resolveOperatorId(network) {
  if (PAYCHANGU.operatorIds[network]) return PAYCHANGU.operatorIds[network];
  const res = await fetchWithRetry(`${PAYCHANGU.BASE_URL}/mobile-money/operators`, {
    headers: _paychanguHeaders()
  }, { provider: 'paychangu' });
  const data = await res.json();
  const operators = data?.data || [];
  const match = operators.find(op =>
    (op.name || '').toLowerCase().includes(network === 'airtel' ? 'airtel' : 'tnm')
  );
  if (match) PAYCHANGU.operatorIds[network] = match.ref_id;
  return match?.ref_id || null;
}

async function _paychanguBalance() {
  return { available: false, note: 'PayChangu does not provide a balance API — check the PayChangu merchant dashboard directly.' };
}

async function _paychanguCollect({ phone, amount, reference }) {
  const network = detectOperatorNetwork(phone);
  const operatorRefId = await resolveOperatorId(network);
  const res = await fetchWithRetry(`${PAYCHANGU.BASE_URL}/mobile-money/payments/initialize`, {
    method: 'POST',
    headers: _paychanguHeaders(),
    body: JSON.stringify({
      mobile_money_operator_ref_id: operatorRefId,
      mobile: phone,
      amount,
      currency: PAYCHANGU.CURRENCY,
      charge_id: reference,
      email: `${phone}@pocketvault.mw`
    })
  }, { provider: 'paychangu' });
  const data = await res.json();
  return { ...data, txnId: data?.data?.trans_id || reference, _provider: 'paychangu' };
}

async function _paychanguDisburse({ phone, amount, reference }) {
  const network = detectOperatorNetwork(phone);
  const operatorRefId = await resolveOperatorId(network);
  const res = await fetchWithRetry(`${PAYCHANGU.BASE_URL}/mobile-money/payouts/initialize`, {
    method: 'POST',
    headers: _paychanguHeaders(),
    body: JSON.stringify({
      mobile_money_operator_ref_id: operatorRefId,
      mobile: phone,
      amount,
      currency: PAYCHANGU.CURRENCY,
      charge_id: reference
    })
  }, { provider: 'paychangu' });
  const data = await res.json();
  return { ...data, txnId: data?.data?.trans_id || reference, _provider: 'paychangu' };
}

async function _paychanguKYC(phone) {
  return { _provider: 'paychangu', _unsupported: true };
}

async function _paychanguTransactionStatus(reference) {
  const res = await fetchWithRetry(`${PAYCHANGU.BASE_URL}/mobile-money/payments/${reference}/verify`, {
    headers: _paychanguHeaders()
  }, { provider: 'paychangu' });
  return res.json();
}

// ----------------------------
// PUBLIC PAYMENT FUNCTIONS — PROVIDER ROUTERS
// ----------------------------
export async function airtelBalance(type = 'COLL') {
  const provider = resolvePaymentProvider();
  if (provider === 'paychangu') return _paychanguBalance();
  if (provider === 'airtel_direct') return _airtelBalanceDirect(type);
  return { mock: true };
}

export async function airtelCollect({ phone, amount, reference }) {
  const provider = resolvePaymentProvider();
  if (provider === 'paychangu') return _paychanguCollect({ phone, amount, reference });
  if (provider === 'airtel_direct') return _airtelCollectDirect({ phone, amount, reference });
  return { mock: true, _provider: 'mock' };
}

export async function airtelDisburse({ phone, amount, reference }) {
  const provider = resolvePaymentProvider();
  if (provider === 'paychangu') return _paychanguDisburse({ phone, amount, reference });
  if (provider === 'airtel_direct') return _airtelDisburseDirect({ phone, amount, reference });
  return { mock: true, _provider: 'mock' };
}

export async function airtelKYC(phone) {
  const provider = resolvePaymentProvider();
  if (provider === 'paychangu') return _paychanguKYC(phone);
  if (provider === 'airtel_direct') return _airtelKYCDirect(phone);
  return { mock: true };
}

export async function airtelTransactionStatus(reference) {
  const provider = resolvePaymentProvider();
  if (provider === 'paychangu') return _paychanguTransactionStatus(reference);
  if (provider === 'airtel_direct') return _airtelTransactionStatusDirect(reference);
  return { mock: true, status: 'completed' };
}

// ----------------------------
// HELPERS
// ----------------------------
export function generateRef() {
  return `SPR_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ----------------------------
// MERCHANT CODE ASSIGNMENT
// ----------------------------
export async function ensureMerchantCode(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.data() || {};

  if (user.merchantCode) {
    if (!user.merchantCodeActive) {
      await db.collection('users').doc(uid).update({ merchantCodeActive: true });
    }
    return user.merchantCode;
  }

  let code, attempts = 0;
  do {
    code = String(Math.floor(10000 + Math.random() * 90000));
    const existing = await db.collection('users').where('merchantCode', '==', code).limit(1).get();
    if (existing.empty) break;
    attempts++;
  } while (attempts < 10);

  if (attempts >= 10) {
    throw new Error('Could not generate a unique merchant code — please try again');
  }

  await db.collection('users').doc(uid).update({
    merchantCode: code,
    merchantCodeActive: true,
    merchantCodeCreatedAt: FieldValue.serverTimestamp()
  });
  return code;
}

export async function deactivateMerchantCode(uid) {
  await db.collection('users').doc(uid).update({ merchantCodeActive: false }).catch(() => {});
}

// ----------------------------
// IDEMPOTENCY PROTECTION
// ----------------------------
export async function withIdempotency(uid, idempotencyKey, handler) {
  if (!idempotencyKey) {
    return handler();
  }

  const lockRef = db.collection('idempotency_keys').doc(`${uid}_${idempotencyKey}`);

  try {
    await lockRef.create({
      uid, status: 'processing',
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });
  } catch (err) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      const snap = await lockRef.get();
      const data = snap.data();
      if (data?.status === 'completed') {
        return { ...data.result, _idempotentReplay: true };
      }
      if (data?.status === 'failed') {
        throw new Error(data.error || 'The original request with this idempotency key failed.');
      }
    }
    throw new Error('A request with this idempotency key is still processing. Please wait a moment and check your transaction history before retrying.');
  }

  try {
    const result = await handler();
    await lockRef.update({ status: 'completed', result, completedAt: FieldValue.serverTimestamp() });
    return result;
  } catch (err) {
    await lockRef.update({ status: 'failed', error: err.message, failedAt: FieldValue.serverTimestamp() }).catch(() => {});
    throw err;
  }
}

// ----------------------------
// FEE CALCULATION — PLATFORM + AIRTEL PASS-THROUGH
// Airtel charges PocketVault 1.5% on every collection AND
// disbursement — a cost that was previously not accounted for
// anywhere, meaning the platform's displayed fee rate was actually
// eating into margin rather than being pure revenue. The percentages
// in PLANS (transactionFeePercent / withdrawalFeePercent) are now
// the EFFECTIVE rate charged to the user, already inclusive of
// Airtel's 1.5% — see core/config.js for the updated numbers.
//
// calcFee() returns the full breakdown rather than a single number,
// so every call site can log platform revenue and the Airtel
// pass-through as separate figures instead of conflating them.
// AIRTEL_FEE_PERCENT is exported so admin reporting can show it
// without hardcoding 1.5 in multiple places.
// ----------------------------
export const AIRTEL_FEE_PERCENT = 1.5;

export function calcFee(amount, effectivePercent) {
  const total = Math.ceil(amount * (effectivePercent / 100));
  const airtelAmount = Math.ceil(amount * (AIRTEL_FEE_PERCENT / 100));
  // Platform keeps whatever's left after Airtel's cut — floored at 0
  // so a misconfigured plan (effective rate lower than 1.5%) never
  // reports negative platform revenue; it would instead show 0 and
  // is a sign the plan's rate needs revisiting, not a silent loss.
  const platformAmount = Math.max(0, total - airtelAmount);
  return { total, platformAmount, airtelAmount };
}

// ----------------------------
// SAFE AMOUNT PARSER
// ----------------------------
export function parseAmount(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts === 'number') return ts;
  if (ts._seconds) return ts._seconds * 1000;
  return new Date(ts).getTime() || 0;
}

// ----------------------------
// ISO WEEK NUMBER
// ----------------------------
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

export function weeksBetween(weekKeyA, weekKeyB) {
  const parse = (wk) => {
    const [y, w] = wk.split('-W').map(Number);
    const jan1 = new Date(Date.UTC(y, 0, 1));
    return new Date(jan1.getTime() + (w - 1) * 7 * 86400000);
  };
  const diffMs = Math.abs(parse(weekKeyB) - parse(weekKeyA));
  return Math.round(diffMs / (7 * 86400000));
}

// ----------------------------
// SAVINGS STREAK
// ----------------------------
export async function updateSavingsStreak(uid) {
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const user = userSnap.data() || {};

  const thisWeek = isoWeekKey(new Date());
  const lastWeek = user.lastSaveWeek || null;

  let newStreak;
  if (!lastWeek) {
    newStreak = 1;
  } else if (lastWeek === thisWeek) {
    newStreak = user.streakCount || 1;
  } else {
    const gap = weeksBetween(lastWeek, thisWeek);
    newStreak = gap === 1 ? (user.streakCount || 0) + 1 : 1;
  }

  const longestStreak = Math.max(newStreak, user.longestStreak || 0);
  const isNewMilestone = [4, 8, 12, 26, 52].includes(newStreak) && newStreak !== (user.streakCount || 0);

  await userRef.set({
    streakCount: newStreak,
    longestStreak,
    lastSaveWeek: thisWeek,
    lastSaveAt: FieldValue.serverTimestamp()
  }, { merge: true });

  if (isNewMilestone) {
    await pushNotification(uid, {
      type: 'streak_milestone',
      message: `🔥 ${newStreak}-week savings streak! You've saved something every week for ${newStreak} weeks straight. Keep it going!`
    });
  }

  return { streakCount: newStreak, longestStreak, isNewMilestone };
}

// ----------------------------
// GOAL MILESTONE CELEBRATION
// ----------------------------
export async function checkGoalMilestone(uid, goalBefore, goalAfter) {
  if (!goalBefore || !goalAfter || goalAfter.target <= 0) return null;
  const pctBefore = Math.floor((goalBefore.saved / goalAfter.target) * 100);
  const pctAfter = Math.floor((goalAfter.saved / goalAfter.target) * 100);

  const thresholds = [25, 50, 75, 100];
  const crossed = thresholds.find(t => pctBefore < t && pctAfter >= t);
  if (!crossed) return null;

  const messages = {
    25: `🌱 ${goalAfter.name} is 25% funded — off to a solid start!`,
    50: `⭐ ${goalAfter.name} is halfway there! MWK ${(goalAfter.target - goalAfter.saved).toLocaleString()} to go.`,
    75: `🚀 ${goalAfter.name} is 75% funded — almost at the finish line!`,
    100: `🎉 ${goalAfter.name} is fully funded! Goal complete!`
  };

  await pushNotification(uid, { type: 'goal_milestone', message: messages[crossed] });
  return { milestone: crossed };
}

// ----------------------------
// REFERRAL COMPLETION CHECK
// ----------------------------
export const REFERRAL_BONUS_MWK = 500;

export const REFERRAL_LIFETIME_CAP = 10;

export async function checkReferralCompletion(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.data();
  if (!user?.referredBy) return null;

  const referralSnap = await db.collection('referrals')
    .where('referredUid', '==', uid)
    .where('status', '==', 'pending')
    .limit(1).get();
  if (referralSnap.empty) return null;

  const referralDoc = referralSnap.docs[0];
  const referral = referralDoc.data();

  const isVerified = user.kycStatus === 'verified' || user.kycStatus === 'mock_verified';
  if (!isVerified) return null;

  const referrerId = referral.referrerUid;
  const referrerSnap = await db.collection('users').doc(referrerId).get();
  const referrer = referrerSnap.data() || {};

  // ----------------------------
  // ANTI-ABUSE: LIFETIME CAP
  // A referrer can only ever earn the bonus from REFERRAL_LIFETIME_CAP
  // completions. This is checked here (at completion time, not at
  // apply() time) because referralCount only increments on a genuine
  // completion — apply() itself is separately blocked once the cap
  // is hit (see POST /api/referrals/apply), so in practice this
  // branch is a safety net for any referral that was already pending
  // before the referrer hit the cap.
  // ----------------------------
  if ((referrer.referralCount || 0) >= REFERRAL_LIFETIME_CAP) {
    await referralDoc.ref.update({
      status: 'capped',
      note: `Referrer had already reached the ${REFERRAL_LIFETIME_CAP}-referral lifetime cap`,
      resolvedAt: FieldValue.serverTimestamp()
    });
    return null;
  }

  // ----------------------------
  // ANTI-ABUSE: DEVICE FINGERPRINT MATCH
  // If the referrer and the referred account share a device
  // fingerprint (see js/core/fingerprint.js), this is very likely
  // the same person self-referring rather than a genuine referral.
  // Rather than silently blocking it (which risks a false positive
  // for, say, a shared family device), the referral is flagged for
  // admin review — bonus held, not paid, until an admin approves or
  // denies it via the admin panel.
  // ----------------------------
  const fingerprintMatch = !!user.deviceFingerprint
    && !!referrer.deviceFingerprint
    && user.deviceFingerprint === referrer.deviceFingerprint;

  if (fingerprintMatch) {
    await referralDoc.ref.update({
      status: 'flagged_review',
      flaggedReason: 'device_fingerprint_match',
      flaggedAt: FieldValue.serverTimestamp(),
      bonusAmount: REFERRAL_BONUS_MWK
    });
    await db.collection('admin_alerts').add({
      message: `Referral flagged for review: referrer and referred user share a device fingerprint (possible self-referral).`,
      type: 'referral_flagged',
      referralId: referralDoc.id,
      referrerUid: referrerId,
      referredUid: uid,
      resolved: false,
      timestamp: FieldValue.serverTimestamp()
    });
    return { flagged: true, referrerId, referredUid: uid };
  }

  await referralDoc.ref.update({
    status: 'completed',
    completedAt: FieldValue.serverTimestamp(),
    bonusAmount: REFERRAL_BONUS_MWK
  });
  await db.collection('users').doc(referrerId).set({
    referralCount: FieldValue.increment(1)
  }, { merge: true });

  async function creditBonus(targetUid) {
    // Credits accountBalance directly — same as every other source of
    // funds since the balance-model migration (save, allocate,
    // transfer). Previously this credited a goal's `saved` field
    // directly, or did nothing at all if the user had no active goal
    // — a real bug where the bonus was silently lost for anyone
    // without an open goal at the moment their referral completed.
    await db.collection('users').doc(targetUid).set({
      accountBalance: FieldValue.increment(REFERRAL_BONUS_MWK)
    }, { merge: true });
    await logTransaction(targetUid, {
      type: 'referral_bonus', amount: REFERRAL_BONUS_MWK, fee: 0, feePercent: 0,
      reference: generateRef(), status: 'completed'
    });
    await pushNotification(targetUid, {
      type: 'referral_bonus',
      message: `🎁 You earned a MWK ${REFERRAL_BONUS_MWK.toLocaleString()} referral bonus, added to your account balance!`
    });
  }

  await creditBonus(referrerId);
  await creditBonus(uid);

  return { referrerId, referredUid: uid, bonusAmount: REFERRAL_BONUS_MWK };
}

export function isAirtelSuccess(result) {
  if (result?._provider === 'paychangu') {
    return result?.data?.status === 'success' || result?.status === 'success';
  }
  return (
    result?.status?.code === '200' ||
    result?.status?.success === true ||
    result?.data?.transaction?.status === 'TS'
  );
}

export async function logTransaction(uid, data) {
  const ref = db.collection('transactions').doc();
  await ref.set({ ...data, uid, timestamp: FieldValue.serverTimestamp() });
  return ref.id;
}

export async function logFee(uid, { amount, platformAmount, airtelAmount, transactionId, type, plan }) {
  await db.collection('platform_fees').add({
    uid,
    amount, // total charged to the user — unchanged meaning, kept for anything reading the gross figure
    platformAmount: platformAmount ?? amount, // what PocketVault actually keeps; falls back to `amount` for any caller not yet passing the split
    airtelAmount: airtelAmount ?? 0, // the pass-through cost to Airtel
    transactionId, type, plan,
    timestamp: FieldValue.serverTimestamp()
  });
}

export async function pushNotification(uid, { type, message }) {
  await db.collection('notifications').add({
    uid, type, message,
    read: false,
    timestamp: FieldValue.serverTimestamp()
  });
}

export async function updateGoalProgress(uid, goalId, amount) {
  const goalRef = db.collection('goals').doc(goalId);
  const snap = await goalRef.get();
  const goal = snap.data();
  if (!goal || goal.uid !== uid) return null;
  const newSaved = (goal.saved || 0) + amount;
  const completed = newSaved >= goal.target;
  await goalRef.update({ saved: newSaved, completed, lastUpdated: FieldValue.serverTimestamp() });
  return { ...goal, id: goalId, saved: newSaved, completed };
}

export async function checkFloatSufficient(amount) {
  const cached = cache.get('corporate_float');
  const float = cached?.data || 0;
  if (resolvePaymentProvider() === 'airtel_direct' && float < amount + FLOAT_THRESHOLD) {
    throw new Error(`Insufficient float. Available: MWK ${float.toLocaleString()}`);
  }
  return float;
}

export async function isAlreadyProcessed(airtelRef) {
  if (!airtelRef) return false;
  const snap = await db.collection('transactions')
    .where('airtelRef', '==', airtelRef)
    .limit(1).get();
  return !snap.empty;
}

// ----------------------------
// FIRESTORE BACKUP EXPORT
// Triggers Google's native Firestore managed export
// (google.firestore.admin.v1.FirestoreAdmin.ExportDocuments) via its
// REST endpoint, writing a full database snapshot to a Cloud Storage
// bucket. This is the same mechanism Google's own scheduled-export
// feature uses under the hood — calling it directly here is what
// makes an ADMIN-TRIGGERABLE on-demand backup possible, alongside
// (not instead of) a separately configured recurring schedule.
//
// Auth reuses the existing Firebase Admin service account via
// getGcpAccessToken() — no separate credentials or new dependency
// needed. The account must have the "Cloud Datastore Import Export
// Admin" IAM role (or a broader role that includes it) for this to
// succeed; see docs/BACKUPS.md for the one-time setup.
//
// Export is asynchronous on Google's side — this call starts the
// operation and returns its operation name immediately; it does not
// wait for the export to finish (that can take minutes for a large
// database). Progress can be checked via getFirestoreExportStatus().
// ----------------------------
export async function triggerFirestoreExport({ bucketUri, collectionIds } = {}) {
  if (!bucketUri) {
    throw new Error('bucketUri is required — e.g. gs://your-backup-bucket/firestore-backups');
  }
  const accessToken = await getGcpAccessToken();
  const projectId = getFirebaseProjectId();
  if (!projectId) {
    throw new Error('Could not determine Firebase project ID for the export request');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default):exportDocuments`;
  const body = { outputUriPrefix: bucketUri };
  if (collectionIds && collectionIds.length) body.collectionIds = collectionIds;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, { timeoutMs: 20000, maxRetries: 1 });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Firestore export request failed (${res.status})`);
  }

  // data.name is the long-running operation name, e.g.
  // "projects/x/databases/(default)/operations/ASA1..." — stored so
  // admin tooling can look up status/history later without needing
  // to keep the original response around.
  await db.collection('backup_exports').add({
    operationName: data.name || null,
    bucketUri,
    collectionIds: collectionIds || null,
    status: 'started',
    triggeredAt: FieldValue.serverTimestamp()
  });

  return { operationName: data.name || null, bucketUri };
}

// Lists recent backup export attempts (both manual and any recorded
// via the same collection) for admin visibility — GET
// /api/admin/backups/history reads this.
export async function listRecentBackupExports(limit = 20) {
  const snap = await db.collection('backup_exports')
    .orderBy('triggeredAt', 'desc')
    .limit(limit)
    .get();
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}
