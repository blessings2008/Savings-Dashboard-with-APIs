import { auth } from "./firebase.js";

const BASE_URL = ""; // same origin
const DEFAULT_TIMEOUT_MS = 15000;

async function authHeader() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  };
}

// PRODUCTION FIX: previously a plain fetch() with no timeout at all —
// if a request to our own backend hung (bad network, server briefly
// unresponsive, or Render cold-starting after idle), the calling
// page just sat on its loading skeleton forever with no error and no
// way out. This is the actual cause of "loads forever, doesn't go
// anywhere" — not a code bug, a genuinely uncaught network hang.
// Every request now aborts after DEFAULT_TIMEOUT_MS and surfaces a
// clear, catchable error instead.
async function fetchWithTimeout(url, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("This is taking longer than expected. Check your connection and try again.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function request(method, path, body) {
  const headers = await authHeader();
  const res = await fetchWithTimeout(BASE_URL + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  patch: (path, body) => request("PATCH", path, body),

  // Convenience wrappers
  health: () => fetchWithTimeout(BASE_URL + "/api/health").then(r => r.json()),
  plans: () => fetchWithTimeout(BASE_URL + "/api/plans").then(r => r.json()),

  profile: (uid, data) => request("POST", "/api/profile", { uid, ...data }),
  // Note: legacy single-step /api/kyc endpoint was removed for security —
  // it bypassed OTP verification entirely. Use sendOtp + verifyOtp instead.

  balance: () => request("GET", "/api/airtel/balance"),

  goals: () => request("GET", "/api/goals"),
  createGoal: (uid, goal) => request("POST", "/api/goals", { uid, ...goal }),
  updateGoal: (goalId, data) => request("PATCH", `/api/goals/${goalId}`, data),

  save: (uid, data) => request("POST", "/api/save", { uid, ...data }),
  withdraw: (uid, data) => request("POST", "/api/withdraw", { uid, ...data }),
  roundup: (uid, data) => request("POST", "/api/roundup", { uid, ...data }),

  autosaveRules: () => request("GET", "/api/autosave/rules"),
  createAutosaveRule: (uid, rule) => request("POST", "/api/autosave/rules", { uid, ...rule }),
  toggleAutosaveRule: (ruleId, enabled) => request("PATCH", `/api/autosave/rules/${ruleId}`, { enabled }),

  transactions: (params = "") => request("GET", `/api/transactions${params}`),
  transactionStatus: (reference) => request("GET", `/api/transactions/${reference}/status`),

  analytics: () => request("GET", "/api/analytics"),

  notifications: () => request("GET", "/api/notifications"),
  markNotificationRead: (notifId) => request("PATCH", `/api/notifications/${notifId}`, {}),
  unreadCount: () => request("GET", "/api/notifications/unread-count"),

  subscribe: (uid, plan, phone) => request("POST", "/api/subscribe", { uid, plan, phone }),
  subscriptionStatus: () => request("GET", "/api/subscribe/status"),

  merchantCollect: (uid, data) => request("POST", "/api/merchant/collect", { uid, ...data }),
  merchantDisburse: (uid, data) => request("POST", "/api/merchant/disburse", { uid, ...data }),
  lookupMerchantCode: (code) => request("GET", `/api/merchant/lookup/${code}`),
  payMerchant: (uid, data) => request("POST", "/api/merchant/pay", { uid, ...data }),

  myReferralCode: () => request("GET", "/api/referrals/my-code"),
  applyReferralCode: (uid, code) => request("POST", "/api/referrals/apply", { uid, code }),
};
