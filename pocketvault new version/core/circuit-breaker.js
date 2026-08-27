// PocketVault circuit breaker.
//
// Sits in front of every call to an external provider (Airtel,
// PayChangu, Anthropic, Gemini, Groq, and the alert webhook) so a
// provider outage fails fast instead of every request separately
// paying the full fetchWithRetry timeout+retry cost. Without this,
// 50 requests hitting a downed Airtel API each wait ~15s+retries
// before failing — with it, request #6 onward fails in under a
// millisecond until the cooldown passes.
//
// Standard three-state model, one independent breaker per provider
// name (see core/state.js's `breakers` Map):
//
//   CLOSED     — normal operation, calls go through
//   OPEN       — tripped; calls fail immediately without being
//                attempted, until the cooldown elapses
//   HALF_OPEN  — cooldown has passed; exactly one call is let
//                through as a test. Success -> CLOSED. Failure -> OPEN
//                again with a fresh cooldown.
//
// Only genuine failures count toward tripping — network errors,
// timeouts, and 5xx responses. A 4xx means the provider is fine and
// the request itself was bad, so 4xx never trips or resets a breaker.
export const CLOSED = 'closed';
export const OPEN = 'open';
export const HALF_OPEN = 'half_open';

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30000;

// Per-provider overrides — AI provider outages and payment provider
// outages tend to resolve on different timescales, so cooldowns
// aren't forced to be identical across every breaker.
const PROVIDER_CONFIG = {
  airtel: { failureThreshold: 5, cooldownMs: 30000 },
  paychangu: { failureThreshold: 5, cooldownMs: 30000 },
  anthropic: { failureThreshold: 5, cooldownMs: 20000 },
  gemini: { failureThreshold: 5, cooldownMs: 20000 },
  groq: { failureThreshold: 5, cooldownMs: 20000 },
  alert_webhook: { failureThreshold: 3, cooldownMs: 60000 },
};

function configFor(name) {
  return PROVIDER_CONFIG[name] || { failureThreshold: DEFAULT_FAILURE_THRESHOLD, cooldownMs: DEFAULT_COOLDOWN_MS };
}

function getState(breakers, name) {
  let s = breakers.get(name);
  if (!s) {
    s = { status: CLOSED, consecutiveFailures: 0, openedAt: null, halfOpenInFlight: false };
    breakers.set(name, s);
  }
  return s;
}

// ----------------------------
// canCall(breakers, name)
// Checks whether a call to this provider should be attempted right
// now. Returns { allowed: true } or { allowed: false, reason }.
// Also handles the OPEN -> HALF_OPEN transition once the cooldown
// has elapsed, and ensures only one half-open test call is in
// flight at a time (a second caller arriving while the test is
// still pending is treated as still OPEN, rather than letting two
// test calls both through at once).
// ----------------------------
export function canCall(breakers, name) {
  const cfg = configFor(name);
  const s = getState(breakers, name);

  if (s.status === CLOSED) return { allowed: true };

  if (s.status === OPEN) {
    const elapsed = Date.now() - s.openedAt;
    if (elapsed < cfg.cooldownMs) {
      return { allowed: false, reason: `${name} is temporarily unavailable — retry in ${Math.ceil((cfg.cooldownMs - elapsed) / 1000)}s` };
    }
    // Cooldown elapsed — move to half-open and let this one call through as a test
    s.status = HALF_OPEN;
    s.halfOpenInFlight = true;
    return { allowed: true };
  }

  // HALF_OPEN
  if (s.halfOpenInFlight) {
    return { allowed: false, reason: `${name} is being retested after an outage — try again in a moment` };
  }
  s.halfOpenInFlight = true;
  return { allowed: true };
}

// ----------------------------
// recordSuccess / recordFailure
// Called after every call that canCall() allowed through. A success
// closes the breaker and resets the failure count. A failure either
// bumps the consecutive-failure count (from CLOSED) or immediately
// re-opens it with a fresh cooldown (from HALF_OPEN, since a failed
// test call means the provider is still down).
// ----------------------------
export function recordSuccess(breakers, name) {
  const s = getState(breakers, name);
  s.status = CLOSED;
  s.consecutiveFailures = 0;
  s.openedAt = null;
  s.halfOpenInFlight = false;
}

export function recordFailure(breakers, name) {
  const cfg = configFor(name);
  const s = getState(breakers, name);

  if (s.status === HALF_OPEN) {
    // The test call failed — still down, re-open with a fresh cooldown
    s.status = OPEN;
    s.openedAt = Date.now();
    s.halfOpenInFlight = false;
    return { justOpened: true };
  }

  s.consecutiveFailures++;
  if (s.consecutiveFailures >= cfg.failureThreshold) {
    s.status = OPEN;
    s.openedAt = Date.now();
    return { justOpened: true };
  }
  return { justOpened: false };
}

// ----------------------------
// getBreakerStatus(breakers, name)
// Read-only snapshot for the admin operations page — shows current
// status per provider without affecting state.
// ----------------------------
export function getBreakerStatus(breakers, name) {
  const s = breakers.get(name);
  if (!s) return { status: CLOSED, consecutiveFailures: 0 };
  return { status: s.status, consecutiveFailures: s.consecutiveFailures, openedAt: s.openedAt };
}

export function getAllBreakerStatuses(breakers) {
  const out = {};
  for (const name of Object.keys(PROVIDER_CONFIG)) {
    out[name] = getBreakerStatus(breakers, name);
  }
  return out;
}
