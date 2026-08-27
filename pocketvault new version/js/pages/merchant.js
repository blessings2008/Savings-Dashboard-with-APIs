// PocketVault merchant page — Business-plan merchant dashboard, plus
// the "Pay a Merchant" modal available to every user regardless of
// plan (that's the payer's side of the feature, not merchant
// management, but it lives here since it's merchant-code logic).
import { api } from "../../api.js";
import { state } from "../core/state.js";
import { fmt, escapeHTML, formatDate, toMillis } from "../core/utils.js";
import { bindNavLinks, txRowHTML } from "../core/render-helpers.js";
import { loadPlan } from "../services/plan.js";
import { toast } from "../components/toast.js";
import { closeModal, showModalError } from "../components/modal.js";
import { openWithdrawModal } from "./goals.js";

// ----------------------------
// PAY A MERCHANT BY CODE
// Available to every user regardless of plan — this is the payer's
// side of the merchant code feature. Two steps: enter the 5-digit
// code and confirm who you're paying (lookupMerchantCode), then
// enter an amount and pay (payMerchant). Splitting into two steps
// means the payer always sees the merchant's name before any money
// moves, rather than trusting a code they may have mistyped.
// ----------------------------
export function openPayMerchantModal(navigate) {
  const kyc = state.user?.kycStatus;
  if (kyc !== "verified" && kyc !== "mock_verified") {
    toast("Verify your phone number first to pay a merchant", "error");
    return navigate("account");
  }

  const root = document.getElementById("modal-root");

  function renderCodeStep() {
    root.innerHTML = `
      <div class="modal">
        <h3>💳 Pay from Airtel Wallet</h3>
        <p class="modal-sub">Pulls money from your Airtel Money balance via USSD prompt. Enter the merchant's 5-digit code.</p>

        <div class="input-group">
          <label class="input-label">Merchant code</label>
          <input class="input" id="pm-code" type="text" inputmode="numeric" maxlength="5" placeholder="e.g. 84729" style="font-size:24px;letter-spacing:6px;text-align:center;font-family:monospace">
        </div>

        <div id="pm-code-error" class="auth-error" style="display:none"></div>

        <p style="font-size:11.5px;color:var(--muted);margin-top:4px">
          Want to pay from your PocketVault balance instead — no Airtel fee? Use <strong>Transfer</strong> instead.
        </p>

        <div class="modal-actions">
          <button class="btn btn-outline" id="pm-cancel">Cancel</button>
          <button class="btn btn-primary" id="pm-lookup">Continue</button>
        </div>
      </div>
    `;
    root.classList.add("open");
    root.querySelector("#pm-cancel").onclick = closeModal;
    root.addEventListener("click", e => { if (e.target === root) closeModal(); });

    const codeInput = document.getElementById("pm-code");
    codeInput.focus();
    codeInput.addEventListener("input", () => {
      codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 5);
    });

    async function doLookup() {
      const code = codeInput.value.trim();
      const errBox = document.getElementById("pm-code-error");
      const btn = document.getElementById("pm-lookup");
      if (!/^\d{5}$/.test(code)) return showModalError(errBox, "Enter a valid 5-digit code");

      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
      try {
        const res = await api.lookupMerchantCode(code);
        renderAmountStep(code, res.merchant.name);
      } catch (e) {
        showModalError(errBox, e.data?.error || e.message);
        btn.disabled = false; btn.textContent = "Continue";
      }
    }
    document.getElementById("pm-lookup").onclick = doLookup;
    codeInput.addEventListener("keydown", e => { if (e.key === "Enter") doLookup(); });
  }

  function renderAmountStep(code, merchantName) {
    // Generated once per pay attempt, same reasoning as save/withdraw —
    // must not regenerate inside the click handler or a double-tap
    // protection is defeated.
    const idempotencyKey = crypto.randomUUID();

    root.innerHTML = `
      <div class="modal">
        <h3>💳 Pay ${escapeHTML(merchantName)}</h3>
        <p class="modal-sub">Code ${code} · confirmed merchant</p>

        <div class="input-group">
          <label class="input-label">Amount (MWK)</label>
          <input class="input" id="pm-amount" type="number" placeholder="e.g. 5000" min="100">
        </div>

        <div class="input-group">
          <label class="input-label">Airtel Money number</label>
          <input class="input" id="pm-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.phone || state.user.profilePhone || ""}" ${state.user.phone ? "readonly" : ""}>
        </div>

        <div id="pm-amount-error" class="auth-error" style="display:none"></div>

        <div class="modal-info">
          A USSD prompt will appear on this number to confirm.
        </div>

        <div class="modal-actions">
          <button class="btn btn-outline" id="pm-back">Back</button>
          <button class="btn btn-primary" id="pm-pay">Pay ${escapeHTML(merchantName)}</button>
        </div>
      </div>
    `;
    root.querySelector("#pm-back").onclick = renderCodeStep;
    document.getElementById("pm-amount").focus();

    root.querySelector("#pm-pay").onclick = async () => {
      const amount = document.getElementById("pm-amount").value;
      const phone = document.getElementById("pm-phone").value.trim();
      const errBox = document.getElementById("pm-amount-error");
      const btn = root.querySelector("#pm-pay");

      if (!amount || parseFloat(amount) < 100) return showModalError(errBox, "Minimum payment is MWK 100");
      if (!/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) return showModalError(errBox, "Enter a valid Malawi Airtel number");

      if (btn.disabled) return;
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
      try {
        const res = await api.payMerchant(state.user.uid, { merchantCode: code, amount, phone, idempotencyKey });
        closeModal();
        toast(res.message || "Payment sent!");
        navigate(state.currentPage);
      } catch (e) {
        showModalError(errBox, e.data?.error || e.message);
        btn.disabled = false; btn.textContent = `Pay ${merchantName}`;
      }
    };
  }

  renderCodeStep();
}

// ----------------------------
// INTERNAL TRANSFER TO A MERCHANT
// PocketVault-to-PocketVault only — sends from the payer's account
// balance directly into a Business-plan merchant's account balance,
// with no Airtel call and no phone number needed (unlike Pay a
// Merchant above, which pulls from the payer's external Airtel
// wallet). Uses the old, lower fee rates since there's no Airtel
// cost to pass through — see INTERNAL_TRANSFER_FEE_PERCENT in
// routes/user.js.
// ----------------------------
export function openTransferModal(navigate) {
  const kyc = state.user?.kycStatus;
  if (kyc !== "verified" && kyc !== "mock_verified") {
    toast("Verify your phone number first to send a transfer", "error");
    return navigate("account");
  }
  const available = state.user?.accountBalance || 0;
  if (available <= 0) {
    toast("Your account balance is empty — add funds first", "error");
    return;
  }

  const root = document.getElementById("modal-root");

  function renderCodeStep() {
    root.innerHTML = `
      <div class="modal">
        <h3>💸 Pay from Balance</h3>
        <p class="modal-sub">Pays straight from your PocketVault balance — no Airtel fee, no phone prompt. Enter the merchant's code.</p>

        <div class="input-group">
          <label class="input-label">Merchant code</label>
          <input class="input" id="tr-code" type="text" inputmode="numeric" maxlength="5" placeholder="e.g. 84729" style="font-size:24px;letter-spacing:6px;text-align:center;font-family:monospace">
        </div>

        <div id="tr-code-error" class="auth-error" style="display:none"></div>

        <div class="modal-actions">
          <button class="btn btn-outline" id="tr-cancel">Cancel</button>
          <button class="btn btn-primary" id="tr-lookup">Continue</button>
        </div>
      </div>
    `;
    root.classList.add("open");
    root.querySelector("#tr-cancel").onclick = closeModal;
    root.addEventListener("click", e => { if (e.target === root) closeModal(); });

    const codeInput = document.getElementById("tr-code");
    codeInput.focus();
    codeInput.addEventListener("input", () => {
      codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 5);
    });

    async function doLookup() {
      const code = codeInput.value.trim();
      const errBox = document.getElementById("tr-code-error");
      const btn = document.getElementById("tr-lookup");
      if (!/^\d{5}$/.test(code)) return showModalError(errBox, "Enter a valid 5-digit code");

      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
      try {
        const res = await api.lookupMerchantCode(code);
        renderAmountStep(code, res.merchant.name);
      } catch (e) {
        showModalError(errBox, e.data?.error || e.message);
        btn.disabled = false; btn.textContent = "Continue";
      }
    }
    document.getElementById("tr-lookup").onclick = doLookup;
    codeInput.addEventListener("keydown", e => { if (e.key === "Enter") doLookup(); });
  }

  function renderAmountStep(code, merchantName) {
    const idempotencyKey = crypto.randomUUID();

    root.innerHTML = `
      <div class="modal">
        <h3>💸 Pay ${escapeHTML(merchantName)} from Balance</h3>
        <p class="modal-sub">Code ${code} · confirmed merchant</p>

        <div class="modal-info" style="margin-bottom:14px">
          Available in balance: <strong>MWK ${fmt(available)}</strong>
        </div>

        <div class="input-group">
          <label class="input-label">Amount (MWK)</label>
          <input class="input" id="tr-amount" type="number" placeholder="e.g. 5000" min="100" max="${available}">
        </div>

        <div id="tr-amount-error" class="auth-error" style="display:none"></div>

        <div class="modal-info">
          No fee — paying from your balance doesn't touch Airtel at all.
        </div>

        <div class="modal-actions">
          <button class="btn btn-outline" id="tr-back">Back</button>
          <button class="btn btn-primary" id="tr-send">Send to ${escapeHTML(merchantName)}</button>
        </div>
      </div>
    `;
    root.querySelector("#tr-back").onclick = renderCodeStep;
    document.getElementById("tr-amount").focus();

    root.querySelector("#tr-send").onclick = async () => {
      const amount = document.getElementById("tr-amount").value;
      const errBox = document.getElementById("tr-amount-error");
      const btn = root.querySelector("#tr-send");

      if (!amount || parseFloat(amount) < 100) return showModalError(errBox, "Minimum transfer is MWK 100");
      if (parseFloat(amount) > available) return showModalError(errBox, `Only MWK ${fmt(available)} available in your balance`);

      if (btn.disabled) return;
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
      try {
        const res = await api.transfer(state.user.uid, { merchantCode: code, amount, idempotencyKey });
        closeModal();
        toast(res.message || "Transfer sent!");
        navigate(state.currentPage);
      } catch (e) {
        showModalError(errBox, e.data?.error || e.message);
        btn.disabled = false; btn.textContent = `Send to ${merchantName}`;
      }
    };
  }

  renderCodeStep();
}

// ----------------------------
// MERCHANT DASHBOARD
// Restructured per the "real business dashboard, not a stretched
// user dashboard" spec: balance as the single hero figure, a real
// revenue chart and stats computed from actual transaction history,
// and separate Transactions / Account tabs instead of one long page
// with two standalone forms competing for attention.
//
// Deliberately scoped down from the original design brief — no
// Customers page (would need a real backend aggregation feature,
// not a UI reshuffle), no team members / API keys / transaction
// limits (none of those concepts exist anywhere else in the app
// yet). What's here is a genuine redesign of what already exists.
// ----------------------------
export async function renderMerchantPage(main, navigate, tab = "overview") {
  await loadPlan({ api, state, toast });

  if (state.plan !== "business") {
    main.innerHTML = `
      <div class="page active">
        <div class="page-header">
          <h2>Merchant Tools</h2>
          <p>Collect payments and pay employees</p>
        </div>
        <div class="card">
          <div class="empty-state">
            <div class="icon">◇</div>
            <p>Merchant tools — collections, disbursements, and employee payouts — are available on the Business plan.</p>
            <p style="margin-top:8px;font-size:12.5px;color:var(--muted)">You'll also get your own 5-digit merchant code — like an Airtel Money agent code — so any PocketVault user can pay you directly, no phone number needed.</p>
            <button class="btn btn-primary btn-sm" data-nav="premium">Upgrade to Business</button>
          </div>
        </div>
      </div>
    `;
    return bindNavLinks(main, navigate);
  }

  const txRes = await api.transactions("?limit=200");
  const txs = txRes.transactions || [];

  const tabsHTML = `
    <div class="merchant-tabs" style="display:flex;gap:6px;margin-bottom:16px;border-bottom:1px solid var(--border)">
      ${[["overview", "Overview"], ["transactions", "Transactions"], ["account", "Account"]].map(([id, label]) => `
        <button class="merchant-tab-btn ${tab === id ? "active" : ""}" data-merchant-tab="${id}"
          style="background:none;border:none;padding:10px 4px;font-size:13.5px;font-weight:600;cursor:pointer;color:${tab === id ? "var(--green)" : "var(--muted)"};border-bottom:2px solid ${tab === id ? "var(--green)" : "transparent"};margin-right:16px">
          ${label}
        </button>
      `).join("")}
    </div>
  `;

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Merchant Dashboard</h2>
        <p>${state.user.businessName || "Your business"} on PocketVault</p>
      </div>
      ${tabsHTML}
      <div id="merchant-tab-content"></div>
    </div>
  `;

  main.querySelectorAll("[data-merchant-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.currentPage = "merchant";
      renderMerchantPage(main, navigate, btn.dataset.merchantTab);
    });
  });

  const content = document.getElementById("merchant-tab-content");
  if (tab === "transactions") renderMerchantTransactionsTab(content, txs, navigate);
  else if (tab === "account") renderMerchantAccountTab(content, navigate);
  else renderMerchantOverviewTab(content, txs, navigate);

  bindNavLinks(main, navigate);
}

// ----------------------------
// OVERVIEW TAB
// Balance as hero, three real stats, a real 7-day revenue chart
// bucketed from transaction history client-side (no backend change
// needed — the data was already there), and recent activity.
// ----------------------------
function renderMerchantOverviewTab(content, txs, navigate) {
  const revenueTypes = ["collection", "merchant_payment_received"];
  const revenueTxs = txs.filter(t => revenueTypes.includes(t.type) && t.status !== "failed");

  const now = Date.now();
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const monthRevenue = revenueTxs.filter(t => toMillis(t.timestamp) > monthAgo).reduce((s, t) => s + (t.amount || 0), 0);
  const totalFees = txs.filter(t => t.status !== "failed").reduce((s, t) => s + (t.fee || 0), 0);
  const txCount = txs.filter(t => t.status !== "failed").length;

  // Last 7 days, bucketed by calendar day, oldest first — same
  // bucketing approach as the user's own Analytics page, reused here
  // rather than inventing a second convention.
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    d.setHours(0, 0, 0, 0);
    days.push(d);
  }
  const dayTotals = days.map(d => {
    const nextDay = d.getTime() + 24 * 60 * 60 * 1000;
    return revenueTxs
      .filter(t => { const ts = toMillis(t.timestamp); return ts >= d.getTime() && ts < nextDay; })
      .reduce((s, t) => s + (t.amount || 0), 0);
  });
  const maxDay = Math.max(1, ...dayTotals);

  const recent = [...txs].sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp)).slice(0, 5);

  content.innerHTML = `
    <div class="balance-hero">
      <div class="balance-label">Available Balance</div>
      <div class="balance-amount">MWK <span>${fmt(state.user?.accountBalance || 0)}</span></div>
      <div class="balance-meta">Spendable now — collections, code payments, and balance payments received</div>
      <div class="balance-icon-actions">
        <button class="bal-icon-btn primary" id="m-receive-btn">
          <span class="bal-icon-btn-icon">📥</span>
          <span class="bal-icon-btn-label">Receive</span>
        </button>
        <button class="bal-icon-btn" id="m-overview-transfer-btn">
          <span class="bal-icon-btn-icon">↔️</span>
          <span class="bal-icon-btn-label">Transfer</span>
        </button>
        <button class="bal-icon-btn" id="m-overview-withdraw-btn">
          <span class="bal-icon-btn-icon">↑</span>
          <span class="bal-icon-btn-label">Withdraw</span>
        </button>
      </div>
    </div>

    <div class="grid-3">
      <div class="merchant-stat">
        <div class="val" style="color:var(--green)">${fmt(monthRevenue)}</div>
        <div class="lbl">This Month (MWK)</div>
      </div>
      <div class="merchant-stat">
        <div class="val">${fmt(totalFees)}</div>
        <div class="lbl">Fees Paid (MWK)</div>
      </div>
      <div class="merchant-stat">
        <div class="val">${txCount}</div>
        <div class="lbl">Transactions</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Revenue — Last 7 Days</div></div>
      <div class="chart-bar-wrap">
        ${dayTotals.map(v => `<div class="chart-bar savings" style="height:${Math.max(6, Math.round((v / maxDay) * 100))}%"></div>`).join("")}
      </div>
      <div class="chart-labels">${days.map(d => `<span>${d.toLocaleDateString(undefined, { weekday: "short" })}</span>`).join("")}</div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Recent Transactions</div>
      </div>
      ${recent.length === 0
        ? `<div class="empty-state"><div class="icon">◇</div><p>No transactions yet</p></div>`
        : recent.map(txRowHTML).join("")}
      ${recent.length > 0 ? `<div class="section-row-action" id="m-see-all-tx" style="text-align:right;margin-top:8px;cursor:pointer">See all →</div>` : ""}
    </div>
  `;

  document.getElementById("m-receive-btn").onclick = () => openReceiveModal(navigate);
  document.getElementById("m-overview-transfer-btn").onclick = () => openTransferModal(navigate);
  document.getElementById("m-overview-withdraw-btn").onclick = () => openWithdrawModal(undefined, navigate);
  document.getElementById("m-see-all-tx")?.addEventListener("click", () => {
    renderMerchantPage(document.getElementById("main-content"), navigate, "transactions");
  });
}

// ----------------------------
// TRANSACTIONS TAB
// A real table — id, counterparty, amount, fee, net, status, date —
// with status filtering and search, replacing the old "Recent
// Merchant Activity" list that only showed 10 items with no way to
// see more or search.
// ----------------------------
function renderMerchantTransactionsTab(content, txs, navigate) {
  const merchantTypes = ["collection", "disbursement", "merchant_payment_received"];
  const merchantTxs = [...txs.filter(t => merchantTypes.includes(t.type))]
    .sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));

  function counterparty(t) {
    if (t.type === "collection") return t.customerPhone || "Customer";
    if (t.type === "disbursement") return t.phone || "Recipient";
    return "Code payment";
  }

  function renderRows(list) {
    if (list.length === 0) return `<div class="empty-state"><div class="icon">◇</div><p>No matching transactions</p></div>`;
    return `<div class="table-wrap"><table>
      <thead><tr><th>Reference</th><th>Counterparty</th><th>Amount</th><th>Fee</th><th>Net</th><th>Status</th><th>Date</th></tr></thead>
      <tbody>${list.map(t => {
        const net = (t.amount || 0) - (t.fee || 0);
        return `<tr>
          <td class="mono truncate" style="max-width:120px">${escapeHTML(t.reference || t.id || "—")}</td>
          <td>${escapeHTML(counterparty(t))}</td>
          <td>MWK ${fmt(t.amount)}</td>
          <td>MWK ${fmt(t.fee || 0)}</td>
          <td>MWK ${fmt(net)}</td>
          <td><span class="tx-status ${escapeHTML(t.status || "")}">${escapeHTML(t.status || "—")}</span></td>
          <td class="mono">${formatDate(t.timestamp)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>`;
  }

  content.innerHTML = `
    <div class="card">
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <input class="input" id="m-tx-search" placeholder="Search by reference or phone…" style="flex:1;min-width:180px">
        <select class="input" id="m-tx-status-filter" style="max-width:160px">
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
          <option value="mock">Mock</option>
        </select>
      </div>
      <div id="m-tx-table">${renderRows(merchantTxs)}</div>
    </div>
  `;

  function applyFilters() {
    const q = document.getElementById("m-tx-search").value.trim().toLowerCase();
    const status = document.getElementById("m-tx-status-filter").value;
    let filtered = merchantTxs;
    if (status) filtered = filtered.filter(t => t.status === status);
    if (q) filtered = filtered.filter(t =>
      (t.reference || "").toLowerCase().includes(q) ||
      (counterparty(t) || "").toLowerCase().includes(q)
    );
    document.getElementById("m-tx-table").innerHTML = renderRows(filtered);
  }
  document.getElementById("m-tx-search").addEventListener("input", applyFilters);
  document.getElementById("m-tx-status-filter").addEventListener("change", applyFilters);
}

// ----------------------------
// ACCOUNT TAB
// Merchant identity + code + plan info, folded together — this is
// the "where is my money and how do I move it" answer the original
// bug report was about, plus the account-level details a merchant
// needs to see (code, fee rate, plan) without a separate Settings
// page for information that's genuinely this compact.
// ----------------------------
function renderMerchantAccountTab(content, navigate) {
  content.innerHTML = `
    <div class="card" style="background:linear-gradient(135deg, rgba(0,229,160,0.08), rgba(0,229,160,0.02));border-color:rgba(0,229,160,0.25)">
      <div class="card-header"><div class="card-title">🏪 Your Merchant Code</div></div>
      <div style="text-align:center;padding:8px 0 16px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Any PocketVault user can pay you with this code</div>
        <div style="font-size:42px;font-weight:800;letter-spacing:8px;color:var(--green);font-family:monospace;margin-bottom:16px">
          ${state.user.merchantCode ? state.user.merchantCode.split("").join(" ") : "-----"}
        </div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" id="m-copy-code">📋 Copy Code</button>
          <button class="btn btn-primary btn-sm" id="m-share-code">📤 Share Code</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Business Details</div></div>
      <div class="input-group">
        <label class="input-label">Business name</label>
        <input class="input" id="m-business-name" value="${escapeHTML(state.user.businessName || "")}" placeholder="e.g. Chikondi's Shop">
      </div>
      <div id="m-business-error" class="auth-error" style="display:none"></div>
      <button class="btn btn-primary btn-sm" id="m-save-business">Save</button>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Plan & Fees</div></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--muted);font-size:13px">Current plan</span>
        <span style="font-weight:600;text-transform:capitalize">${state.plan}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--muted);font-size:13px">Transaction fee</span>
        <span style="font-weight:600">${state.planConfig?.transactionFeePercent ?? 2}%</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:8px 0">
        <span style="color:var(--muted);font-size:13px">Balance payment fee</span>
        <span style="font-weight:600">Lower rate — no Airtel cost</span>
      </div>
      <button class="btn btn-outline btn-sm" style="width:100%;margin-top:12px" data-nav="premium">Manage Plan →</button>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Collect or Pay Manually</div></div>
      <p style="font-size:12px;color:var(--muted);margin-bottom:12px">For one-off requests by phone number, instead of your merchant code.</p>
      <div class="input-group">
        <label class="input-label">Customer phone number</label>
        <input class="input" id="m-collect-phone" type="tel" placeholder="e.g. 0991234567">
      </div>
      <div class="input-group">
        <label class="input-label">Amount (MWK)</label>
        <input class="input" id="m-collect-amount" type="number" placeholder="e.g. 5000">
      </div>
      <div id="m-collect-error" class="auth-error" style="display:none"></div>
      <button class="btn btn-outline" id="m-collect-btn" style="width:100%;margin-bottom:16px">Request Payment</button>

      <div class="input-group">
        <label class="input-label">Recipient phone number</label>
        <input class="input" id="m-disburse-phone" type="tel" placeholder="e.g. 0991234567">
      </div>
      <div class="input-group">
        <label class="input-label">Amount (MWK)</label>
        <input class="input" id="m-disburse-amount" type="number" placeholder="e.g. 25000">
      </div>
      <div id="m-disburse-error" class="auth-error" style="display:none"></div>
      <button class="btn btn-outline" id="m-disburse-btn" style="width:100%">Send Payment</button>
    </div>
  `;

  document.getElementById("m-copy-code")?.addEventListener("click", () => {
    if (!state.user.merchantCode) return;
    navigator.clipboard.writeText(state.user.merchantCode).then(() => toast("Code copied!"));
  });

  document.getElementById("m-share-code")?.addEventListener("click", () => {
    if (!state.user.merchantCode) return;
    const text = `Pay me on PocketVault! My merchant code is ${state.user.merchantCode}. Open the PocketVault app, go to "Pay a Merchant", and enter this code.`;
    if (navigator.share) {
      navigator.share({ title: "My PocketVault Merchant Code", text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => toast("Share message copied!"));
    }
  });

  document.getElementById("m-save-business").onclick = async () => {
    const name = document.getElementById("m-business-name").value.trim();
    const errBox = document.getElementById("m-business-error");
    const btn = document.getElementById("m-save-business");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.post("/api/profile", { uid: state.user.uid, businessName: name });
      state.user.businessName = name;
      toast("Business name saved");
    } catch (e) {
      errBox.style.display = "block"; errBox.textContent = e.data?.error || e.message;
    } finally {
      btn.disabled = false; btn.textContent = "Save";
    }
  };

  document.getElementById("m-collect-btn").onclick = async () => {
    const phone = document.getElementById("m-collect-phone").value.trim();
    const amount = document.getElementById("m-collect-amount").value;
    const errBox = document.getElementById("m-collect-error");
    const btn = document.getElementById("m-collect-btn");
    if (!/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) return showModalError(errBox, "Enter a valid phone number");
    if (!amount || amount < 1) return showModalError(errBox, "Enter a valid amount");
    errBox.style.display = "none";
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.merchantCollect(state.user.uid, { customerPhone: phone, amount });
      toast(res.mock ? "Payment request queued (mock mode)" : "Payment request sent");
      renderMerchantPage(document.getElementById("main-content"), navigate, "account");
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Request Payment";
    }
  };

  document.getElementById("m-disburse-btn").onclick = async () => {
    const phone = document.getElementById("m-disburse-phone").value.trim();
    const amount = document.getElementById("m-disburse-amount").value;
    const errBox = document.getElementById("m-disburse-error");
    const btn = document.getElementById("m-disburse-btn");
    if (!/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) return showModalError(errBox, "Enter a valid phone number");
    if (!amount || amount < 1) return showModalError(errBox, "Enter a valid amount");
    errBox.style.display = "none";
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.merchantDisburse(state.user.uid, { phone, amount });
      toast(res.mock ? "Payment queued (mock mode)" : "Payment sent");
      renderMerchantPage(document.getElementById("main-content"), navigate, "account");
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Send Payment";
    }
  };
}

// ----------------------------
// RECEIVE MODAL
// The "Receive" quick action on Overview — just surfaces the
// merchant code prominently for a customer standing in front of the
// merchant right now, without navigating away to the Account tab.
// ----------------------------
function openReceiveModal(navigate) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>📥 Receive a Payment</h3>
      <p class="modal-sub">Show this code to your customer, or have them enter it in "Pay a Merchant"</p>
      <div style="text-align:center;padding:16px 0">
        <div style="font-size:48px;font-weight:800;letter-spacing:10px;color:var(--green);font-family:monospace">
          ${state.user.merchantCode ? state.user.merchantCode.split("").join(" ") : "-----"}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="rcv-close">Close</button>
        <button class="btn btn-primary" id="rcv-share">📤 Share Code</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#rcv-close").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });
  root.querySelector("#rcv-share").onclick = () => {
    const text = `Pay me on PocketVault! My merchant code is ${state.user.merchantCode}. Open the PocketVault app, go to "Pay a Merchant", and enter this code.`;
    if (navigator.share) {
      navigator.share({ title: "My PocketVault Merchant Code", text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => toast("Share message copied!"));
    }
  };
}
