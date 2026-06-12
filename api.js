import { auth } from "./firebase.js";

const BASE_URL = ""; // same origin

async function authHeader() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  };
}

async function request(method, path, body) {
  const headers = await authHeader();
  const res = await fetch(BASE_URL + path, {
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
  health: () => fetch(BASE_URL + "/api/health").then(r => r.json()),
  plans: () => fetch(BASE_URL + "/api/plans").then(r => r.json()),

  profile: (uid, data) => request("POST", "/api/profile", { uid, ...data }),
  kyc: (uid, phone) => request("POST", "/api/kyc", { uid, phone }),

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

  subscribe: (uid, plan, phone) => request("POST", "/api/subscribe", { uid, plan, phone }),
  subscriptionStatus: () => request("GET", "/api/subscribe/status"),

  merchantCollect: (uid, data) => request("POST", "/api/merchant/collect", { uid, ...data }),
  merchantDisburse: (uid, data) => request("POST", "/api/merchant/disburse", { uid, ...data }),
};
