import { auth } from "./firebase.js";

const BASE_URL = "";
const DEFAULT_TIMEOUT_MS = 15000;

async function authHeader() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();
  return { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
}

async function fetchWithTimeout(url, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (err) { if (err.name === "AbortError") throw new Error("This is taking longer than expected. Check your connection and try again."); throw err; }
  finally { clearTimeout(timer); }
}

async function request(method, path, body) {
  const headers = await authHeader();
  const res = await fetchWithTimeout(BASE_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.data = data; err.status = res.status; throw err; }
  return data;
}

function transactionPinModal({ setup = false, message = "" } = {}) {
  return new Promise((resolve, reject) => {
    const old = document.getElementById("pv-transaction-pin-modal"); if (old) old.remove();
    const el = document.createElement("div"); el.id = "pv-transaction-pin-modal";
    el.innerHTML = `<div style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px"><form id="pv-pin-form" style="width:min(380px,100%);background:var(--surface,#fff);color:var(--text,#17201c);border:1px solid var(--border,#d9dfdc);border-radius:12px;padding:24px;box-shadow:0 16px 48px rgba(0,0,0,.22)"><h3 style="margin:0 0 7px">${setup ? "Set Transaction PIN" : "Confirm transaction"}</h3><p style="margin:0 0 18px;color:var(--muted,#6b746f);font-size:14px">${setup ? "Create a 6-digit PIN. You will use it to authorize money movements." : "Enter your 6-digit Transaction PIN to authorize this transaction."}</p>${message ? `<div style="margin:0 0 14px;padding:10px;border-radius:8px;background:#fff3cd;color:#664d03;font-size:13px">${String(message).replace(/[<>]/g,"")}</div>` : ""}<input id="pv-pin-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" type="password" placeholder="6-digit PIN" style="width:100%;box-sizing:border-box;padding:12px;border:1px solid var(--border,#d9dfdc);border-radius:8px;background:var(--surface,#fff);color:inherit;font-size:20px;letter-spacing:5px;text-align:center" required>${setup ? `<input id="pv-pin-confirm" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" type="password" placeholder="Confirm PIN" style="width:100%;box-sizing:border-box;margin-top:10px;padding:12px;border:1px solid var(--border,#d9dfdc);border-radius:8px;background:var(--surface,#fff);color:inherit;font-size:20px;letter-spacing:5px;text-align:center" required>` : ""}<div id="pv-pin-error" style="min-height:20px;margin-top:8px;color:#b42318;font-size:13px"></div><div style="display:flex;gap:8px;margin-top:12px"><button type="button" id="pv-pin-cancel" style="flex:1;padding:11px;border:1px solid var(--border,#d9dfdc);border-radius:8px;background:transparent;color:inherit">Cancel</button><button type="submit" style="flex:1;padding:11px;border:0;border-radius:8px;background:var(--green,#1f9d63);color:#fff;font-weight:700">${setup ? "Set PIN" : "Confirm"}</button></div></form></div>`;
    document.body.appendChild(el);
    const form = el.querySelector("#pv-pin-form"), input = el.querySelector("#pv-pin-input"), error = el.querySelector("#pv-pin-error");
    const close = () => el.remove();
    el.querySelector("#pv-pin-cancel").onclick = () => { close(); reject(new Error("Transaction cancelled.")); };
    form.onsubmit = e => { e.preventDefault(); const pin = input.value; if (!/^\d{6}$/.test(pin)) { error.textContent = "Enter exactly 6 digits."; return; } if (setup && el.querySelector("#pv-pin-confirm").value !== pin) { error.textContent = "The PINs do not match."; return; } close(); resolve(pin); };
    input.focus();
  });
}

async function withTransactionPin(path, body) {
  let pin = await transactionPinModal();
  try { return await request("POST", path, { ...body, transactionPin: pin }); }
  catch (err) {
    if (err?.data?.code === "PIN_NOT_SET") {
      const newPin = await transactionPinModal({ setup: true, message: "A Transaction PIN is required before you can move money." });
      await request("POST", "/api/security/transaction-pin/set", { pin: newPin });
      return request("POST", path, { ...body, transactionPin: newPin });
    }
    throw err;
  }
}

export async function downloadAuthenticatedPdf(path, filename) {
  const headers = await authHeader(); const res = await fetchWithTimeout(BASE_URL + path, { method: "GET", headers });
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || `Report download failed (${res.status})`); }
  const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const api = {
  get: (path) => request("GET", path), post: (path, body) => request("POST", path, body), patch: (path, body) => request("PATCH", path, body),
  health: () => fetchWithTimeout(BASE_URL + "/api/health").then(r => r.json()), plans: () => fetchWithTimeout(BASE_URL + "/api/plans").then(r => r.json()),
  profile: (uid, data) => request("POST", "/api/profile", { uid, ...data }), balance: () => request("GET", "/api/airtel/balance"), goals: () => request("GET", "/api/goals"),
  createGoal: (uid, goal) => request("POST", "/api/goals", { uid, ...goal }), updateGoal: (goalId, data) => request("PATCH", `/api/goals/${goalId}`, data), save: (uid, data) => request("POST", "/api/save", { uid, ...data }),
  withdraw: (uid, data) => withTransactionPin("/api/withdraw", { uid, ...data }),
  allocate: (uid, goalId, data) => request("POST", `/api/goals/${goalId}/allocate`, { uid, ...data }), deallocate: (uid, goalId, data) => request("POST", `/api/goals/${goalId}/deallocate`, { uid, ...data }),
  transfer: (uid, data) => withTransactionPin("/api/transfer", { uid, ...data }),
  accountExport: () => request("GET", "/api/account/export"), deleteAccount: () => request("POST", "/api/account/delete", { confirmation: "DELETE" }), roundup: (uid, data) => request("POST", "/api/roundup", { uid, ...data }),
  autosaveRules: () => request("GET", "/api/autosave/rules"), createAutosaveRule: (uid, rule) => request("POST", "/api/autosave/rules", { uid, ...rule }), toggleAutosaveRule: (ruleId, enabled) => request("PATCH", `/api/autosave/rules/${ruleId}`, { enabled }),
  transactions: (params = "") => request("GET", `/api/transactions${params}`), transactionStatus: (reference) => request("GET", `/api/transactions/${reference}/status`),
  analytics: () => request("GET", "/api/analytics"), notifications: () => request("GET", "/api/notifications"), markNotificationRead: (notifId) => request("PATCH", `/api/notifications/${notifId}`, {}), unreadCount: () => request("GET", "/api/notifications/unread-count"),
  subscribe: (uid, plan, data = {}) => request("POST", "/api/subscribe", { uid, plan, ...data }), subscriptionStatus: () => request("GET", "/api/subscribe/status"), merchantCollect: (uid, data) => request("POST", "/api/merchant/collect", { uid, ...data }),
  merchantDisburse: (uid, data) => withTransactionPin("/api/merchant/disburse", { uid, ...data }), lookupMerchantCode: (code) => request("GET", `/api/merchant/lookup/${code}`),
  payMerchant: (uid, data) => withTransactionPin("/api/merchant/pay", { uid, ...data }), myReferralCode: () => request("GET", "/api/referrals/my-code"), applyReferralCode: (uid, code) => request("POST", "/api/referrals/apply", { uid, code }),
  startSupportThread: (data) => request("POST", "/api/support/threads", data), mySupportThreads: () => request("GET", "/api/support/threads"), getSupportThread: (threadId) => request("GET", `/api/support/threads/${threadId}`), replySupportThread: (threadId, message) => request("POST", `/api/support/threads/${threadId}/messages`, { message }),
  aiStatus: () => request("GET", "/api/ai/status"), aiInsights: () => request("GET", "/api/ai/insights"), aiChat: (message) => request("POST", "/api/ai/chat", { message }),
  setTransactionPin: (pin) => request("POST", "/api/security/transaction-pin/set", { pin }), verifyTransactionPin: (pin) => request("POST", "/api/security/transaction-pin/verify", { pin })
};
