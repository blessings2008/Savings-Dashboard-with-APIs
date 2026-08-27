// PocketVault shared in-memory runtime state.
//
// These MUST be true singletons — every file that needs the cache,
// the Airtel call queue, the rate limiter, or the cached Airtel auth
// token imports the same instances from here. Do not let any other
// module create its own `new Map()` for these; that would silently
// split state (e.g. two different rate-limit counters, two different
// cache stores) with no error, just quietly wrong behavior.
// ----------------------------

// ----------------------------
// GENERIC CACHE (plan lookups, AI response cache, etc.)
// ----------------------------
export const cache = new Map();

export function getCached(key, fetchFn, ttlMs = 30000) {
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiry) return Promise.resolve(cached.data);
  return fetchFn().then(data => {
    cache.set(key, { data, expiry: Date.now() + ttlMs });
    return data;
  });
}

export function clearCache(...keys) {
  keys.forEach(k => cache.delete(k));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of cache.entries()) {
    if (now > val.expiry) cache.delete(key);
  }
}, 5 * 60 * 1000);

// ----------------------------
// AIRTEL QUEUE
// ----------------------------
export const airtelQueue = [];
let airtelProcessing = false;

export function queueAirtelCall(task) {
  return new Promise((resolve, reject) => {
    airtelQueue.push({ task, resolve, reject });
    processAirtelQueue();
  });
}

async function processAirtelQueue() {
  if (airtelProcessing || airtelQueue.length === 0) return;
  airtelProcessing = true;
  const { task, resolve, reject } = airtelQueue.shift();
  try { resolve(await task()); }
  catch (err) { reject(err); }
  finally {
    airtelProcessing = false;
    setTimeout(processAirtelQueue, 200);
  }
}

// ----------------------------
// RATE LIMITER STATE
// The rateLimit() middleware factory itself lives in
// core/middleware.js — this file only owns the shared Map it reads
// and writes, so every route mounted anywhere shares one limiter.
// ----------------------------
export const rateLimitMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now - val.start > 15 * 60 * 1000) rateLimitMap.delete(key);
  }
}, 15 * 60 * 1000);

// ----------------------------
// AIRTEL TOKEN CACHE
// Mutable token state, exposed via get/set functions rather than
// raw exported `let` bindings — ES module live bindings do
// technically allow exporting a mutable `let`, but get/set functions
// keep the read/write contract explicit and match how the token
// refresh logic in helpers.js already guards concurrent refreshes
// with _tokenRefreshing.
// ----------------------------
let _token = null;
let _tokenExpiry = null;
let _tokenRefreshing = false;

export function getAirtelTokenState() {
  return { token: _token, expiry: _tokenExpiry, refreshing: _tokenRefreshing };
}
export function setAirtelToken(token, expiry) {
  _token = token;
  _tokenExpiry = expiry;
}
export function setAirtelTokenRefreshing(val) {
  _tokenRefreshing = val;
}

// ----------------------------
// CIRCUIT BREAKER STATE
// One breaker per external provider (airtel, paychangu, anthropic,
// gemini, groq, alert_webhook) — each tracked independently, since
// one provider being down should never affect the others. Behavior
// (when to trip, when to allow a half-open test call) lives in
// core/circuit-breaker.js; this is just the shared Map every part
// of the app reads/writes through those functions, so — same
// principle as cache/rateLimitMap above — nothing else should ever
// create its own separate breaker state.
// ----------------------------
export const breakers = new Map();

