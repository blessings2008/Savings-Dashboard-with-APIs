// PocketVault goals page — goal list, create/save/withdraw modals,
// deadline decisions, and frozen-goal handling.
//
// openSaveModal, openWithdrawModal are exported because dashboard.js
// also triggers them from its quick-action buttons — these are
// "move money" modals, not purely goals-page UI, but they're kept
// here (rather than a separate modals/ file) since they operate
// entirely on goal data and share validation logic with the rest of
// this module.
import { api } from "../../api.js";
import { state } from "../core/state.js";
import { fmt, escapeHTML, daysUntil } from "../core/utils.js";
import { goalCardHTML } from "../core/render-helpers.js";
import { loadPlan } from "../services/plan.js";
import { toast } from "../components/toast.js";
import { closeModal, showModalError } from "../components/modal.js";

export async function renderGoalsPage(main, navigate) {
  await loadPlan({ api, state, toast });
  const goalsRes = await api.goals();
  state.goals = goalsRes.goals || {};
  const goalsArr = Object.values(state.goals).sort((a, b) => (a.completed ? 1 : 0) - (b.completed ? 1 : 0));

  // One-time frozen-goal prompt: per spec, the modal interrupts the
  // user exactly once per goal (frozenPromptShown gates it) — after
  // that they only see the persistent banner on the goal card, never
  // another popup for the same goal.
  const newlyFrozen = goalsArr.find(g => g.frozen && !g.frozenPromptShown && !g.completed);
  if (newlyFrozen) openFrozenGoalPromptModal(newlyFrozen, navigate);

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Savings Goals</h2>
        <p>${goalsArr.filter(g => !g.completed).length} active · ${state.planConfig ? `max ${state.planConfig.maxGoals}` : ""} on ${state.plan} plan</p>
      </div>
      <div style="margin-bottom:20px">
        <button class="btn btn-primary" id="btn-new-goal">+ New Goal</button>
      </div>
      <div id="goals-list">
        ${goalsArr.length === 0 ? `
          <div class="empty-state">
            <div class="icon">🎯</div>
            <p>You haven't created any savings goals yet.</p>
            <button class="btn btn-primary btn-sm" id="btn-new-goal-empty">Create your first goal</button>
          </div>
        ` : goalsArr.map(g => goalCardHTML(g, false)).join("")}
      </div>
    </div>
  `;

  document.getElementById("btn-new-goal").onclick = () => openCreateGoalModal(navigate);
  document.getElementById("btn-new-goal-empty")?.addEventListener("click", () => openCreateGoalModal(navigate));

  main.querySelectorAll('[data-action="allocate"]').forEach(btn => {
    btn.addEventListener("click", () => openAllocateModal(btn.dataset.goal, navigate));
  });
  main.querySelectorAll('[data-action="deallocate"]').forEach(btn => {
    btn.addEventListener("click", () => openDeallocateModal(btn.dataset.goal, navigate));
  });
  main.querySelectorAll('[data-decision="unlock"]').forEach(btn => {
    btn.addEventListener("click", () => handleDeadlineDecision(btn.dataset.goal, "unlock", undefined, navigate));
  });
  main.querySelectorAll('[data-decision="extend"]').forEach(btn => {
    btn.addEventListener("click", () => openExtendDeadlineModal(btn.dataset.goal, navigate));
  });
  main.querySelectorAll('[data-frozen-decision="unlock"]').forEach(btn => {
    btn.addEventListener("click", () => handleFrozenDecision(btn.dataset.goal, "unlock", navigate));
  });
  main.querySelectorAll('[data-frozen-decision="keep_locked"]').forEach(btn => {
    btn.addEventListener("click", () => handleFrozenDecision(btn.dataset.goal, "keep_locked", navigate));
  });
}

async function handleDeadlineDecision(goalId, action, newDeadline, navigate) {
  try {
    await api.patch(`/api/goals/${goalId}/deadline-decision`, { action, newDeadline });
    toast(action === "unlock" ? "Goal unlocked!" : "Deadline extended!");
    navigate("goals");
  } catch (e) {
    toast(e.data?.error || e.message, "error");
  }
}

// "keep_locked" just records that the one-time prompt was answered
// (frozenPromptShown) so it collapses to the persistent countdown
// banner instead of re-asking — the goal itself stays exactly as
// frozen as it already was. "unlock" is the early-unlock path.
async function handleFrozenDecision(goalId, action, navigate) {
  try {
    await api.patch(`/api/goals/${goalId}/frozen-decision`, { action });
    toast(action === "unlock" ? "Goal unlocked!" : "Got it — goal stays locked until you renew.");
    navigate("goals");
  } catch (e) {
    toast(e.data?.error || e.message, "error");
  }
}

// Kept as a single source of truth so the modal's copy can never
// drift out of sync with the backend's actual grace window — if
// FREEZE_GRACE_DAYS ever changes server-side, update this constant
// to match (there's no live config endpoint for it yet).
const FREEZE_GRACE_DAYS_LABEL = "7 days";

function openFrozenGoalPromptModal(goal, navigate) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>🧊 "${escapeHTML(goal.name)}" is frozen</h3>
      <p class="modal-sub">Your subscription expired while this goal was locked, so no new savings can be added right now. What would you like to do?</p>
      <div id="frozen-prompt-error" class="auth-error" style="display:none"></div>
      <div class="modal-actions" style="flex-direction:column;gap:8px">
        <button class="btn btn-primary" id="frozen-prompt-unlock" style="width:100%">🔓 Unlock Now</button>
        <button class="btn btn-outline" id="frozen-prompt-keep" style="width:100%">Keep Locked — I'll Renew</button>
      </div>
      <p style="font-size:11.5px;color:var(--muted);margin-top:10px;text-align:center">
        No response needed right now — if you don't choose, it unlocks automatically in ${FREEZE_GRACE_DAYS_LABEL}.
      </p>
    </div>
  `;
  root.classList.add("open");
  // Deliberately no click-outside-to-close and no explicit "later"
  // button here beyond the two real choices — closing without an
  // answer is fine (the grace-period job is the real safety net),
  // but we don't want a stray backdrop click to silently record a
  // decision the user didn't make. If they dismiss without picking,
  // frozenPromptShown stays false and the modal reappears next visit
  // until the grace period itself resolves it.

  const errBox = document.getElementById("frozen-prompt-error");
  root.querySelector("#frozen-prompt-unlock").onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.patch(`/api/goals/${goal.id}/frozen-decision`, { action: "unlock" });
      closeModal();
      toast("Goal unlocked!");
      navigate("goals");
    } catch (err) {
      showModalError(errBox, err.data?.error || err.message);
      btn.disabled = false; btn.textContent = "🔓 Unlock Now";
    }
  };
  root.querySelector("#frozen-prompt-keep").onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.patch(`/api/goals/${goal.id}/frozen-decision`, { action: "keep_locked" });
      closeModal();
      toast("Got it — goal stays locked until you renew.");
      navigate("goals");
    } catch (err) {
      showModalError(errBox, err.data?.error || err.message);
      btn.disabled = false; btn.textContent = "Keep Locked — I'll Renew";
    }
  };
}

function openExtendDeadlineModal(goalId, navigate) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>📅 Extend Deadline</h3>
      <p class="modal-sub">Choose a new date to keep working toward this goal</p>
      <div class="input-group">
        <label class="input-label">New deadline</label>
        <input class="input" id="new-deadline" type="date">
      </div>
      <div id="extend-error" class="auth-error" style="display:none"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="extend-cancel">Cancel</button>
        <button class="btn btn-primary" id="extend-confirm">Extend</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#extend-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelector("#extend-confirm").onclick = async () => {
    const newDeadline = document.getElementById("new-deadline").value;
    const errBox = document.getElementById("extend-error");
    const btn = root.querySelector("#extend-confirm");
    if (!newDeadline) return showModalError(errBox, "Pick a new date");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.patch(`/api/goals/${goalId}/deadline-decision`, { action: "extend", newDeadline });
      closeModal();
      toast("Deadline extended!");
      navigate("goals");
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Extend";
    }
  };
}

const GOAL_EMOJIS = ["🎯", "💻", "📱", "🎓", "🏠", "🚗", "✈️", "💍", "🏥", "👶", "🛒", "🎉"];

function openCreateGoalModal(navigate) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>New Savings Goal</h3>
      <p class="modal-sub">Set a target and we'll track your progress</p>

      <div class="input-group">
        <label class="input-label">Goal name</label>
        <input class="input" id="goal-name" placeholder="e.g. New Phone" maxlength="40">
      </div>

      <div class="input-group">
        <label class="input-label">Icon</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${GOAL_EMOJIS.map((e, i) => `
            <button type="button" class="btn btn-outline btn-sm goal-emoji-btn" data-emoji="${e}" style="font-size:18px;padding:8px 12px;${i === 0 ? 'border-color:var(--green)' : ''}">${e}</button>
          `).join("")}
        </div>
      </div>

      <div class="input-group">
        <label class="input-label">Target amount (MWK)</label>
        <input class="input" id="goal-target" type="number" placeholder="e.g. 150000" min="500">
      </div>

      <div class="input-group">
        <label class="input-label">Deadline (optional)</label>
        <input class="input" id="goal-deadline" type="date">
      </div>

      <div class="input-group">
        <label class="input-label">Lock type</label>
        <select class="input" id="goal-lock">
          <option value="flexible">Flexible — withdraw anytime</option>
          <option value="hard" ${!state.planConfig?.savingsLock ? "disabled" : ""}>
            Locked — until target reached ${!state.planConfig?.savingsLock ? "(Pro/Business only)" : ""}
          </option>
        </select>
      </div>

      <div class="input-group" id="deadline-behavior-group" style="display:none">
        <label class="input-label">If the deadline passes before you reach your target...</label>
        <div class="deadline-behavior-options">
          <label class="behavior-option">
            <input type="radio" name="deadline-behavior" value="ask_me" checked>
            <div>
              <strong>Ask me what to do</strong>
              <span>You'll get a notification to choose: unlock now or extend the date</span>
            </div>
          </label>
          <label class="behavior-option">
            <input type="radio" name="deadline-behavior" value="auto_unlock">
            <div>
              <strong>Unlock automatically</strong>
              <span>Withdraw whatever you've saved, no questions asked — good for real due dates like fees</span>
            </div>
          </label>
          <label class="behavior-option">
            <input type="radio" name="deadline-behavior" value="stay_locked">
            <div>
              <strong>Stay locked regardless</strong>
              <span>Keep the commitment strict — good for discipline-style goals</span>
            </div>
          </label>
        </div>
      </div>

      <div id="goal-error" class="auth-error" style="display:none"></div>

      <div class="modal-actions">
        <button class="btn btn-outline" id="goal-cancel">Cancel</button>
        <button class="btn btn-primary" id="goal-submit">Create Goal</button>
      </div>
    </div>
  `;
  root.classList.add("open");

  let selectedEmoji = GOAL_EMOJIS[0];
  root.querySelectorAll(".goal-emoji-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      root.querySelectorAll(".goal-emoji-btn").forEach(b => b.style.borderColor = "var(--border)");
      btn.style.borderColor = "var(--green)";
      selectedEmoji = btn.dataset.emoji;
    });
  });

  // Show/hide the deadline behavior section based on lock type + deadline presence
  const lockSelect = root.querySelector("#goal-lock");
  const deadlineInput = root.querySelector("#goal-deadline");
  const behaviorGroup = root.querySelector("#deadline-behavior-group");
  function updateBehaviorVisibility() {
    const isLocked = lockSelect.value === "hard";
    const hasDeadline = !!deadlineInput.value;
    behaviorGroup.style.display = (isLocked && hasDeadline) ? "block" : "none";
  }
  lockSelect.addEventListener("change", updateBehaviorVisibility);
  deadlineInput.addEventListener("change", updateBehaviorVisibility);

  root.querySelector("#goal-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelector("#goal-submit").onclick = async () => {
    const name = document.getElementById("goal-name").value.trim();
    const target = document.getElementById("goal-target").value;
    const deadline = document.getElementById("goal-deadline").value;
    const lockType = document.getElementById("goal-lock").value;
    const deadlineBehavior = root.querySelector('input[name="deadline-behavior"]:checked')?.value || "ask_me";
    const errBox = document.getElementById("goal-error");
    const btn = root.querySelector("#goal-submit");

    if (!name) return showModalError(errBox, "Please enter a goal name");
    if (!target || parseFloat(target) < 500) return showModalError(errBox, "Minimum target is MWK 500");

    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.createGoal(state.user.uid, { name, target, deadline: deadline || null, emoji: selectedEmoji, lockType, deadlineBehavior });
      closeModal();
      toast("Goal created!");
      navigate("goals");
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Create Goal";
    }
  };
}

// ----------------------------
// SAVE / WITHDRAW MODALS
// Exported: also triggered from dashboard.js's quick-action buttons.
// ----------------------------
export function openSaveModal(preselectGoalId, navigate) {
  // preselectGoalId is accepted but intentionally unused now — save
  // deposits into accountBalance, not a specific goal, so there's
  // nothing to preselect. Kept as a parameter so every existing call
  // site (dashboard's quick-action button, goal card buttons) keeps
  // working without needing to know the signature changed.
  const kyc = state.user?.kycStatus;
  if (kyc !== "verified" && kyc !== "mock_verified") {
    toast("Verify your phone number first to save money", "error");
    return navigate("account");
  }

  // PRODUCTION FIX: generated ONCE when the modal opens, not inside
  // the click handler — this is what makes it actually protect
  // against a double-tap. If it were regenerated per click, two
  // taps would just create two different keys and the backend's
  // idempotency check would never catch the duplicate.
  const idempotencyKey = crypto.randomUUID();

  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>Add to Account Balance</h3>
      <p class="modal-sub">Move money from your Airtel wallet into PocketVault — allocate it to a goal anytime after.</p>

      <div class="input-group">
        <label class="input-label">Amount (MWK)</label>
        <input class="input" id="save-amount" type="number" placeholder="e.g. 5000" min="100">
      </div>

      <div class="input-group">
        <label class="input-label">Airtel Money number</label>
        <input class="input" id="save-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.phone || state.user.profilePhone || ""}" ${state.user.phone ? "readonly" : ""}>
      </div>

      <div id="save-error" class="auth-error" style="display:none"></div>

      <div class="modal-info">
        A USSD prompt will appear on this number to confirm. Fee: ${state.planConfig?.transactionFeePercent ?? 2.5}% deducted from your wallet.
      </div>

      <div class="modal-actions">
        <button class="btn btn-outline" id="save-cancel">Cancel</button>
        <button class="btn btn-primary" id="save-submit">Add to Balance</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#save-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelector("#save-submit").onclick = async () => {
    const amount = document.getElementById("save-amount").value;
    const phone = document.getElementById("save-phone").value.trim();
    const errBox = document.getElementById("save-error");
    const btn = root.querySelector("#save-submit");

    if (!amount || parseFloat(amount) < 100) return showModalError(errBox, "Minimum save is MWK 100");
    if (!/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) return showModalError(errBox, "Enter a valid Malawi Airtel number");

    // Belt-and-braces: disable immediately so even a very fast
    // double-click before the network request starts can't fire
    // twice. The idempotencyKey below is the real backend-enforced
    // protection; this is just good UI practice on top of it.
    if (btn.disabled) return;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.save(state.user.uid, { amount, phone, idempotencyKey });
      closeModal();
      toast(res.message || "Added to your balance!");
      navigate(state.currentPage);
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Add to Balance";
    }
  };
}

export function openWithdrawModal(preselectGoalId, navigate) {
  // preselectGoalId is unused now — same reasoning as openSaveModal
  // above: withdraw pulls from accountBalance, not a specific goal.
  const kyc = state.user?.kycStatus;
  if (kyc !== "verified" && kyc !== "mock_verified") {
    toast("Verify your phone number first to withdraw", "error");
    return navigate("account");
  }
  const available = state.user?.accountBalance || 0;
  if (available <= 0) {
    toast("No account balance available to withdraw", "error");
    return;
  }

  // Generated once when the modal opens — same reasoning as the
  // save modal above. Must not be regenerated per click.
  const idempotencyKey = crypto.randomUUID();

  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>Withdraw</h3>
      <p class="modal-sub">Send from your account balance back to your Airtel wallet</p>

      <div class="modal-info" style="margin-bottom:14px">
        Available: <strong>MWK ${fmt(available)}</strong>
      </div>

      <div class="input-group">
        <label class="input-label">Amount (MWK)</label>
        <input class="input" id="wd-amount" type="number" placeholder="e.g. 5000" min="100">
      </div>

      <div class="input-group">
        <label class="input-label">Airtel Money number</label>
        <input class="input" id="wd-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.phone || state.user.profilePhone || ""}" ${state.user.phone ? "readonly" : ""}>
      </div>

      <div id="wd-error" class="auth-error" style="display:none"></div>

      <div class="modal-info" id="wd-fee-preview">
        Fee: ${state.planConfig?.withdrawalFeePercent ?? 2.5}% deducted from withdrawal amount. Enter an amount to see exactly what you'll receive.
      </div>

      <div class="modal-actions">
        <button class="btn btn-outline" id="wd-cancel">Cancel</button>
        <button class="btn btn-primary" id="wd-submit">Withdraw</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#wd-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  // Live fee preview — recalculates as the user types, so the fee is
  // visible BEFORE confirming, not just mentioned in a toast after
  // the money has already moved. This is the actual fix for
  // "withdrew everything with no fee" — the fee was always applied
  // server-side, but the only place it was ever surfaced was a
  // post-hoc toast whose wording made the net amount read like the
  // full amount, easy to misread as "no fee was taken."
  const feePercent = state.planConfig?.withdrawalFeePercent ?? 2.5;
  document.getElementById("wd-amount").addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const preview = document.getElementById("wd-fee-preview");
    if (!val || val <= 0) {
      preview.textContent = `Fee: ${feePercent}% deducted from withdrawal amount. Enter an amount to see exactly what you'll receive.`;
      return;
    }
    const fee = Math.ceil(val * (feePercent / 100));
    const net = val - fee;
    preview.innerHTML = `You'll receive <strong>MWK ${fmt(net)}</strong> — MWK ${fmt(val)} withdrawn, MWK ${fmt(fee)} fee (${feePercent}%).`;
  });

  root.querySelector("#wd-submit").onclick = async () => {
    const amount = document.getElementById("wd-amount").value;
    const phone = document.getElementById("wd-phone").value.trim();
    const errBox = document.getElementById("wd-error");
    const btn = root.querySelector("#wd-submit");

    if (!amount || parseFloat(amount) < 100) return showModalError(errBox, "Minimum withdrawal is MWK 100");
    if (parseFloat(amount) > available) return showModalError(errBox, `Only MWK ${fmt(available)} available`);
    if (!/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) return showModalError(errBox, "Enter a valid Malawi Airtel number");

    if (btn.disabled) return;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.withdraw(state.user.uid, { amount, phone, idempotencyKey });
      closeModal();
      toast(res.message || "Withdrawal sent!");
      navigate(state.currentPage);
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Withdraw";
    }
  };
}

// ----------------------------
// ALLOCATE: MOVE MONEY FROM ACCOUNT BALANCE INTO A GOAL
// Purely internal — no Airtel, no fee, no phone number needed. This
// is the only way a goal's saved amount increases from a direct user
// action now; save() deposits into accountBalance, and this is the
// separate step that commits some of that balance to a specific
// goal. Blocked (button disabled on the card) if the goal is frozen.
// ----------------------------
function openAllocateModal(goalId, navigate) {
  const goal = state.goals[goalId];
  if (!goal) return;
  const available = state.user?.accountBalance || 0;
  if (available <= 0) {
    toast("Your account balance is empty — add funds first", "error");
    return;
  }

  const idempotencyKey = crypto.randomUUID();

  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>Allocate to "${escapeHTML(goal.name)}"</h3>
      <p class="modal-sub">Move money from your account balance into this goal — no fee, instant.</p>

      <div class="modal-info" style="margin-bottom:14px">
        Available in balance: <strong>MWK ${fmt(available)}</strong>
      </div>

      <div class="input-group">
        <label class="input-label">Amount (MWK)</label>
        <input class="input" id="alloc-amount" type="number" placeholder="e.g. 5000" min="1" max="${available}">
      </div>

      <div id="alloc-error" class="auth-error" style="display:none"></div>

      <div class="modal-actions">
        <button class="btn btn-outline" id="alloc-cancel">Cancel</button>
        <button class="btn btn-primary" id="alloc-submit">Allocate</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#alloc-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelector("#alloc-submit").onclick = async () => {
    const amount = document.getElementById("alloc-amount").value;
    const errBox = document.getElementById("alloc-error");
    const btn = root.querySelector("#alloc-submit");

    if (!amount || parseFloat(amount) <= 0) return showModalError(errBox, "Enter a valid amount");
    if (parseFloat(amount) > available) return showModalError(errBox, `Only MWK ${fmt(available)} available in your balance`);

    if (btn.disabled) return;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.allocate(state.user.uid, goalId, { amount, idempotencyKey });
      closeModal();
      toast(res.message || "Allocated!");
      navigate(state.currentPage);
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Allocate";
    }
  };
}

// ----------------------------
// MOVE TO BALANCE (deallocate)
// The reverse of allocate. Available anytime on a flexible goal;
// only once complete on a locked goal — same enforcement as the
// backend, mirrored here so the button is disabled with an accurate
// reason rather than relying purely on a server-side rejection.
// ----------------------------
function openDeallocateModal(goalId, navigate) {
  const goal = state.goals[goalId];
  if (!goal) return;
  const available = goal.saved || 0;
  if (available <= 0) {
    toast("Nothing saved in this goal yet", "error");
    return;
  }
  if (goal.lockType === "hard" && !goal.completed) {
    toast("This goal is locked until it reaches its target", "error");
    return;
  }

  const idempotencyKey = crypto.randomUUID();

  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>Move from "${escapeHTML(goal.name)}" to Balance</h3>
      <p class="modal-sub">Move money from this goal back to your account balance — no fee, instant.</p>

      <div class="modal-info" style="margin-bottom:14px">
        Saved in this goal: <strong>MWK ${fmt(available)}</strong>
      </div>

      <div class="input-group">
        <label class="input-label">Amount (MWK)</label>
        <input class="input" id="dealloc-amount" type="number" placeholder="e.g. 5000" min="1" max="${available}">
      </div>

      <div id="dealloc-error" class="auth-error" style="display:none"></div>

      <div class="modal-actions">
        <button class="btn btn-outline" id="dealloc-cancel">Cancel</button>
        <button class="btn btn-primary" id="dealloc-submit">Move to Balance</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#dealloc-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelector("#dealloc-submit").onclick = async () => {
    const amount = document.getElementById("dealloc-amount").value;
    const errBox = document.getElementById("dealloc-error");
    const btn = root.querySelector("#dealloc-submit");

    if (!amount || parseFloat(amount) <= 0) return showModalError(errBox, "Enter a valid amount");
    if (parseFloat(amount) > available) return showModalError(errBox, `Only MWK ${fmt(available)} saved in this goal`);

    if (btn.disabled) return;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.deallocate(state.user.uid, goalId, { amount, idempotencyKey });
      closeModal();
      toast(res.message || "Moved to your balance!");
      navigate(state.currentPage);
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Move to Balance";
    }
  };
}
