// PocketVault merchant page — Business-plan merchant dashboard, plus
// the "Pay a Merchant" modal available to every user regardless of
// plan (that's the payer's side of the feature, not merchant
// management, but it lives here since it's merchant-code logic).
import { api } from "../../api.js";
import { state } from "../core/state.js";
import { fmt, escapeHTML, formatDate } from "../core/utils.js";
import { bindNavLinks, txRowHTML } from "../core/render-helpers.js";
import { loadPlan } from "../services/plan.js";
import { toast } from "../components/toast.js";
import { closeModal, showModalError } from "../components/modal.js";

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
        <h3>💳 Pay a Merchant</h3>
        <p class="modal-sub">Enter the merchant's 5-digit PocketVault code</p>

        <div class="input-group">
          <label class="input-label">Merchant code</label>
          <input class="input" id="pm-code" type="text" inputmode="numeric" maxlength="5" placeholder="e.g. 84729" style="font-size:24px;letter-spacing:6px;text-align:center;font-family:monospace">
        </div>

        <div id="pm-code-error" class="auth-error" style="display:none"></div>

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
        <h3>💸 Internal Transfer</h3>
        <p class="modal-sub">Send from your account balance to a merchant — no Airtel fee</p>

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
        <h3>💸 Send to ${escapeHTML(merchantName)}</h3>
        <p class="modal-sub">Code ${code} · confirmed merchant · internal transfer</p>

        <div class="modal-info" style="margin-bottom:14px">
          Available in balance: <strong>MWK ${fmt(available)}</strong>
        </div>

        <div class="input-group">
          <label class="input-label">Amount (MWK)</label>
          <input class="input" id="tr-amount" type="number" placeholder="e.g. 5000" min="100" max="${available}">
        </div>

        <div id="tr-amount-error" class="auth-error" style="display:none"></div>

        <div class="modal-info">
          No Airtel fee — this stays entirely inside PocketVault.
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

export async function renderMerchantPage(main, navigate) {
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

  const txRes = await api.transactions("?limit=50");
  const txs = txRes.transactions || [];
  const collections = txs.filter(t => t.type === "collection");
  const disbursements = txs.filter(t => t.type === "disbursement");
  const codePayments = txs.filter(t => t.type === "merchant_payment_received");
  const revenue = collections.filter(t => t.status !== "failed").reduce((s, t) => s + (t.amount || 0), 0)
    + codePayments.filter(t => t.status !== "failed").reduce((s, t) => s + (t.amount || 0), 0);

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Merchant Dashboard</h2>
        <p>Collect payments and pay people via Airtel Money</p>
      </div>

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

      <div class="grid-3">
        <div class="merchant-stat">
          <div class="val" style="color:var(--green)">${fmt(revenue)}</div>
          <div class="lbl">Revenue (MWK)</div>
        </div>
        <div class="merchant-stat">
          <div class="val">${collections.length + codePayments.length}</div>
          <div class="lbl">Collections</div>
        </div>
        <div class="merchant-stat">
          <div class="val">${disbursements.length}</div>
          <div class="lbl">Payouts</div>
        </div>
      </div>

      ${codePayments.length > 0 ? `
        <div class="card">
          <div class="card-header"><div class="card-title">Recent Code Payments</div></div>
          ${codePayments.slice(0, 5).map(t => `
            <div class="tx-row">
              <div class="tx-left">
                <div class="tx-icon savings">💳</div>
                <div>
                  <div class="tx-name">Payment via merchant code</div>
                  <div class="tx-date">${formatDate(t.timestamp)}</div>
                </div>
              </div>
              <div class="tx-amount pos">+MWK ${fmt(t.amount)}</div>
            </div>
          `).join("")}
        </div>
      ` : ""}

      <div class="card">
        <div class="card-header"><div class="card-title">Collect Payment</div></div>
        <div class="input-group">
          <label class="input-label">Customer phone number</label>
          <input class="input" id="m-collect-phone" type="tel" placeholder="e.g. 0991234567">
        </div>
        <div class="input-group">
          <label class="input-label">Amount (MWK)</label>
          <input class="input" id="m-collect-amount" type="number" placeholder="e.g. 5000">
        </div>
        <div id="m-collect-error" class="auth-error" style="display:none"></div>
        <button class="btn btn-primary" id="m-collect-btn" style="width:100%">Request Payment</button>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Pay Someone</div></div>
        <div class="input-group">
          <label class="input-label">Recipient phone number</label>
          <input class="input" id="m-disburse-phone" type="tel" placeholder="e.g. 0991234567">
        </div>
        <div class="input-group">
          <label class="input-label">Amount (MWK)</label>
          <input class="input" id="m-disburse-amount" type="number" placeholder="e.g. 25000">
        </div>
        <div id="m-disburse-error" class="auth-error" style="display:none"></div>
        <button class="btn btn-primary" id="m-disburse-btn" style="width:100%">Send Payment</button>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Recent Merchant Activity</div></div>
        ${[...collections, ...disbursements].length === 0
          ? `<div class="empty-state"><div class="icon">◇</div><p>No merchant transactions yet</p></div>`
          : [...collections, ...disbursements].sort((a,b) => (b.timestamp?._seconds||0)-(a.timestamp?._seconds||0)).slice(0,10).map(txRowHTML).join("")}
      </div>
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
      navigate("merchant");
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
      navigate("merchant");
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Send Payment";
    }
  };
}
