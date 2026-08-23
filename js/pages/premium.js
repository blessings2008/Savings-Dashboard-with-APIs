// PocketVault plans/subscription page.
import { api } from "../../api.js";
import { state } from "../core/state.js";
import { fmt } from "../core/utils.js";
import { loadPlan } from "../services/plan.js";
import { toast } from "../components/toast.js";
import { closeModal, showModalError } from "../components/modal.js";

export async function renderPremiumPage(main, navigate) {
  await loadPlan({ api, state, toast });
  const plansRes = await api.plans();
  const plans = plansRes.plans;
  const sub = state.subscription;

  const planOrder = ["free", "pro", "business"];
  const planFeatures = {
    free: ["2 active goals", "Manual saves", "Basic transaction history", "Standard fee (1%)"],
    pro: ["20 active goals", "Auto-save rules", "Round-up savings", "Full analytics + AI insights", "Savings lock", "Reduced fee (0.75%)"],
    business: ["100 active goals", "Everything in Pro", "Merchant collections", "Pay employees / disbursements", "Lowest fee (0.5%)"]
  };

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Plans & Subscription</h2>
        <p>Pick the plan that fits how you save</p>
      </div>

      ${sub?.subscriptionExpiry ? `
        <div class="insight-box" style="margin-bottom:20px">
          ${sub.daysRemaining > 0
            ? `Your <strong style="color:var(--text)">${plans[state.plan].name}</strong> plan renews in ${sub.daysRemaining} day${sub.daysRemaining !== 1 ? "s" : ""}.`
            : `Your subscription has expired.`}
        </div>
      ` : ""}

      <div class="grid-3" id="plans-grid">
        ${planOrder.map(key => {
          const p = plans[key];
          const isCurrent = state.plan === key;
          return `
            <div class="plan-card ${key === "pro" ? "featured" : ""}">
              <div class="plan-name ${key === "pro" ? "green" : ""}">${p.name}${key === "pro" ? " ✦" : ""}</div>
              <div class="plan-price">MWK ${fmt(p.price)}<span>/month</span></div>
              <div class="plan-features">${planFeatures[key].map(f => `✓ ${f}`).join("<br>")}</div>
              ${isCurrent
                ? `<div class="plan-current">Current Plan</div>`
                : `<button class="btn ${key === "pro" ? "btn-primary" : "btn-outline"}" data-plan="${key}" style="width:100%">${key === "free" ? "Downgrade" : "Upgrade"}</button>`
              }
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;

  main.querySelectorAll("[data-plan]").forEach(btn => {
    btn.addEventListener("click", () => openSubscribeModal(btn.dataset.plan, plans[btn.dataset.plan], navigate));
  });
}

function openSubscribeModal(planKey, plan, navigate) {
  const root = document.getElementById("modal-root");

  if (planKey === "free") {
    root.innerHTML = `
      <div class="modal">
        <h3>Downgrade to Free</h3>
        <p class="modal-sub">You'll lose access to Pro/Business features at the end of your billing period.</p>
        <div class="modal-actions">
          <button class="btn btn-outline" id="dg-cancel">Cancel</button>
          <button class="btn btn-danger" id="dg-confirm">Downgrade</button>
        </div>
      </div>
    `;
    root.classList.add("open");
    root.querySelector("#dg-cancel").onclick = closeModal;
    root.addEventListener("click", e => { if (e.target === root) closeModal(); });
    root.querySelector("#dg-confirm").onclick = async () => {
      try {
        await api.subscribe(state.user.uid, "free");
        closeModal();
        toast("Moved to free plan");
        navigate("premium");
      } catch (e) {
        toast(e.message, "error");
      }
    };
    return;
  }

  root.innerHTML = `
    <div class="modal">
      <h3>Upgrade to ${plan.name}</h3>
      <p class="modal-sub">MWK ${fmt(plan.price)}/month, billed via Airtel Money</p>

      <div class="input-group">
        <label class="input-label">Airtel Money number</label>
        <input class="input" id="sub-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.phone || state.user.profilePhone || ""}" ${state.user.phone ? "readonly" : ""}>
      </div>

      <div id="sub-error" class="auth-error" style="display:none"></div>

      <div class="modal-info">
        A USSD prompt will appear on this number to confirm payment of MWK ${fmt(plan.price)}.
      </div>

      <div class="modal-actions">
        <button class="btn btn-outline" id="sub-cancel">Cancel</button>
        <button class="btn btn-primary" id="sub-confirm">Pay & Upgrade</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#sub-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelector("#sub-confirm").onclick = async () => {
    const phone = document.getElementById("sub-phone").value.trim();
    const errBox = document.getElementById("sub-error");
    const btn = root.querySelector("#sub-confirm");
    if (!/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) return showModalError(errBox, "Enter a valid Malawi Airtel number");

    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.subscribe(state.user.uid, planKey, phone);
      closeModal();
      toast(res.message || "Upgraded!");
      navigate("premium");
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Pay & Upgrade";
    }
  };
}
