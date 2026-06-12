import { auth } from "./firebase.js";
import { renderLogin, watchAuth, logOut } from "./auth.js";
import { api } from "./api.js";

// ----------------------------
// GLOBAL STATE
// ----------------------------
const state = {
  user: null,
  plan: "free",
  planConfig: null,
  goals: {},
  notifications: [],
};

// ----------------------------
// TOAST
// ----------------------------
function toast(message, type = "success") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast ${type} show`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 3500);
}

// ----------------------------
// HELPERS
// ----------------------------
function fmt(n) {
  return Math.round(n || 0).toLocaleString();
}

function initials(user) {
  const name = user.displayName || user.email || "U";
  return name.trim().charAt(0).toUpperCase();
}

const ICONS = {
  savings: "💙", roundup: "🔄", subscription: "✨",
  withdrawal: "💸", collection: "💚", disbursement: "👤",
  income: "💚", expense: "❤️"
};

const NAV = [
  { id: "dashboard", icon: "⬡", label: "Dashboard", section: "main" },
  { id: "goals", icon: "◎", label: "Goals", section: "main" },
  { id: "autosave", icon: "↻", label: "Auto-Save", section: "main" },
  { id: "transactions", icon: "≡", label: "Transactions", section: "main" },
  { id: "analytics", icon: "◈", label: "Analytics", section: "insights" },
  { id: "notifications", icon: "◉", label: "Alerts", section: "insights" },
  { id: "merchant", icon: "◇", label: "Merchant", section: "business" },
  { id: "premium", icon: "✦", label: "Plans", section: "business" },
];

// ----------------------------
// SHELL
// ----------------------------
function renderShell(user) {
  const sectionsOrder = ["main", "insights", "business"];
  const sectionLabels = { main: "Main", insights: "Insights", business: "Business" };

  let sidebarHTML = `<div class="logo">Saver<span>Pro</span></div>`;
  for (const sec of sectionsOrder) {
    sidebarHTML += `<div class="nav-section">${sectionLabels[sec]}</div>`;
    for (const item of NAV.filter(n => n.section === sec)) {
      sidebarHTML += `
        <div class="nav-item" data-page="${item.id}">
          <span class="nav-icon">${item.icon}</span> ${item.label}
        </div>`;
    }
  }

  document.getElementById("app").innerHTML = `
    <div class="shell">
      <div class="sidebar">
        ${sidebarHTML}
        <div class="sidebar-bottom">
          <div class="user-pill" id="user-pill">
            <div class="avatar">${initials(user)}</div>
            <div class="user-info">
              <div class="user-name">${user.displayName || user.email}</div>
              <div class="user-plan" id="sidebar-plan">free plan</div>
            </div>
          </div>
        </div>
      </div>

      <div class="main" id="main-content">
        <div class="loading-row"><span class="spinner"></span> Loading...</div>
      </div>
    </div>

    <div class="bottom-nav">
      ${NAV.slice(0, 5).map(item => `
        <div class="nav-item" data-page="${item.id}">
          <span class="nav-icon">${item.icon}</span>${item.label}
        </div>
      `).join("")}
    </div>

    <!-- MODALS -->
    <div class="modal-overlay" id="modal-root"></div>
  `;

  // Nav click handlers
  document.querySelectorAll("[data-page]").forEach(el => {
    el.addEventListener("click", () => navigate(el.dataset.page));
  });

  // User pill -> sign out confirm
  document.getElementById("user-pill").addEventListener("click", async () => {
    if (confirm("Sign out of SaverPro?")) await logOut();
  });
}

let currentPage = "dashboard";

function setActiveNav(page) {
  document.querySelectorAll("[data-page]").forEach(el => {
    el.classList.toggle("active", el.dataset.page === page);
  });
}

async function navigate(page) {
  currentPage = page;
  setActiveNav(page);
  const main = document.getElementById("main-content");
  main.innerHTML = `<div class="loading-row"><span class="spinner"></span> Loading...</div>`;

  try {
    switch (page) {
      case "dashboard": await renderDashboardPage(main); break;
      case "goals": await renderGoalsPage(main); break;
      case "autosave": await renderAutosavePage(main); break;
      case "transactions": await renderTransactionsPage(main); break;
      case "analytics": await renderAnalyticsPage(main); break;
      case "notifications": await renderNotificationsPage(main); break;
      case "merchant": await renderMerchantPage(main); break;
      case "premium": await renderPremiumPage(main); break;
      default: main.innerHTML = `<div class="empty-state"><p>Page not found</p></div>`;
    }
  } catch (err) {
    console.error(err);
    main.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${err.message || "Something went wrong"}</p>
      <button class="btn btn-outline" onclick="location.reload()">Reload</button></div>`;
  }
}

// ----------------------------
// LOAD PLAN INFO (used across pages)
// ----------------------------
async function loadPlan() {
  try {
    const res = await api.subscriptionStatus();
    state.plan = res.plan;
    state.planConfig = res.config;
    state.subscription = res;
    const sidebarPlan = document.getElementById("sidebar-plan");
    if (sidebarPlan) sidebarPlan.textContent = `${res.config.name} plan`;
    if (res.expired) toast(res.message, "error");
  } catch (e) {
    console.error("Failed to load plan", e);
  }
}

// ----------------------------
// DASHBOARD PAGE
// ----------------------------
async function renderDashboardPage(main) {
  await loadPlan();

  const [balanceRes, goalsRes, txRes] = await Promise.all([
    api.balance().catch(() => ({ balance: 0, mock: true })),
    api.goals(),
    api.transactions("?limit=5"),
  ]);

  state.goals = goalsRes.goals || {};
  const goalsArr = Object.values(state.goals);
  const activeGoals = goalsArr.filter(g => !g.completed);
  const transactions = txRes.transactions || [];

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Hi, ${(auth.currentUser.displayName || auth.currentUser.email || "there").split("@")[0]} 👋</h2>
        <p>Here's your savings overview</p>
      </div>

      <div class="balance-hero">
        <div class="balance-label">Airtel Wallet Balance</div>
        <div class="balance-amount">MWK <span>${fmt(balanceRes.balance)}</span></div>
        <div class="balance-meta">${balanceRes.mock ? "Mock mode — Airtel pending approval" : "Synced from Airtel Money"}</div>
        <div class="balance-actions">
          <button class="btn btn-primary" id="btn-save-quick">+ Save Money</button>
          <button class="btn btn-outline" id="btn-withdraw-quick">↑ Withdraw</button>
        </div>
      </div>

      <div class="grid-4">
        <div class="stat highlight">
          <div class="stat-label">Total Saved</div>
          <div class="stat-value">${fmt(activeGoals.reduce((s, g) => s + (g.saved || 0), 0))}</div>
          <div class="stat-sub">across ${activeGoals.length} goal${activeGoals.length !== 1 ? "s" : ""}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Active Goals</div>
          <div class="stat-value">${activeGoals.length}</div>
          <div class="stat-sub">${state.planConfig ? `max ${state.planConfig.maxGoals}` : ""}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Plan</div>
          <div class="stat-value" style="text-transform:capitalize">${state.plan}</div>
          <div class="stat-sub ${state.plan !== 'free' ? 'up' : ''}">${state.plan === "free" ? "Upgrade for more" : "Active"}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Fee Rate</div>
          <div class="stat-value">${state.planConfig?.transactionFeePercent ?? 1}%</div>
          <div class="stat-sub">per transaction</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-header">
            <div class="card-title">Active Goals</div>
            <div class="card-action" data-nav="goals">View all →</div>
          </div>
          ${activeGoals.length === 0 ? `
            <div class="empty-state">
              <div class="icon">🎯</div>
              <p>No goals yet. Create one to start saving.</p>
              <button class="btn btn-primary btn-sm" data-nav="goals">Create Goal</button>
            </div>
          ` : activeGoals.slice(0, 3).map(g => goalCardHTML(g, true)).join("")}
        </div>

        <div class="card">
          <div class="card-header">
            <div class="card-title">Recent Activity</div>
            <div class="card-action" data-nav="transactions">All →</div>
          </div>
          ${transactions.length === 0 ? `
            <div class="empty-state">
              <div class="icon">📋</div>
              <p>No transactions yet</p>
            </div>
          ` : transactions.map(txRowHTML).join("")}
        </div>
      </div>
    </div>
  `;

  bindNavLinks(main);

  document.getElementById("btn-save-quick").onclick = () => openSaveModal();
  document.getElementById("btn-withdraw-quick").onclick = () => openWithdrawModal();
}

function bindNavLinks(scope) {
  scope.querySelectorAll("[data-nav]").forEach(el => {
    el.addEventListener("click", () => navigate(el.dataset.nav));
  });
}

function goalCardHTML(g, compact = false) {
  const pct = g.target > 0 ? Math.min(100, Math.round((g.saved / g.target) * 100)) : 0;
  const badge = g.completed
    ? `<span class="goal-badge badge-completed">✅ Done</span>`
    : g.lockType === "hard"
    ? `<span class="goal-badge badge-locked">🔒 Locked</span>`
    : `<span class="goal-badge badge-flex">Flexible</span>`;

  return `
    <div class="goal-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:${compact ? '10px' : '14px'}">
        <div>
          <div class="goal-emoji">${g.emoji || "🎯"}</div>
          <div class="goal-name">${escapeHTML(g.name)}</div>
          <div class="goal-target">Target: MWK ${fmt(g.target)}${g.deadline ? ` · ${g.deadline}` : ""}</div>
        </div>
        ${badge}
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="goal-stats"><span>MWK ${fmt(g.saved)} saved</span><strong>${pct}%</strong></div>
      ${!compact ? `
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" data-action="save" data-goal="${g.id}">Add Savings</button>
          ${!g.locked ? `<button class="btn btn-outline btn-sm" data-action="withdraw" data-goal="${g.id}">Withdraw</button>` : ""}
        </div>
      ` : ""}
    </div>
  `;
}

function txRowHTML(tx) {
  const isOut = ["savings", "roundup", "subscription", "withdrawal", "collection", "disbursement"].includes(tx.type)
    && ["savings", "roundup", "subscription"].includes(tx.type) === false;
  const sign = ["savings", "roundup", "subscription"].includes(tx.type) ? "neg" : tx.type === "withdrawal" ? "pos" : "sav";
  const icon = ICONS[tx.type] || "•";
  const date = formatDate(tx.timestamp);
  const label = tx.type === "savings" ? `Save → ${tx.goalName || "Goal"}`
    : tx.type === "withdrawal" ? `Withdraw → ${tx.goalName || "Goal"}`
    : tx.type === "roundup" ? `Round-up → ${tx.goalName || "Goal"}`
    : tx.type === "subscription" ? `${tx.plan ? tx.plan.charAt(0).toUpperCase() + tx.plan.slice(1) : ""} subscription`
    : tx.type === "collection" ? `Payment from ${tx.customerPhone || "customer"}`
    : tx.type === "disbursement" ? `Paid ${tx.phone || "employee"}`
    : tx.type;

  return `
    <div class="tx-row">
      <div class="tx-left">
        <div class="tx-icon ${tx.type}">${icon}</div>
        <div style="min-width:0">
          <div class="tx-name">${escapeHTML(label)}</div>
          <div class="tx-date">${date}</div>
        </div>
      </div>
      <div style="text-align:right">
        <div class="tx-amount ${sign}">${sign === "neg" ? "−" : "+"}MWK ${fmt(tx.amount)}</div>
        <div class="tx-status ${tx.status}">${statusLabel(tx.status)}</div>
      </div>
    </div>
  `;
}

function statusLabel(status) {
  const map = { completed: "✓ Confirmed", mock: "Mock", pending: "Pending", failed: "Failed" };
  return map[status] || status;
}

function formatDate(ts) {
  if (!ts) return "";
  const ms = ts._seconds ? ts._seconds * 1000 : (typeof ts === "number" ? ts : Date.parse(ts));
  const d = new Date(ms);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today, ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

function escapeHTML(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ----------------------------
// GOALS PAGE
// ----------------------------
async function renderGoalsPage(main) {
  await loadPlan();
  const goalsRes = await api.goals();
  state.goals = goalsRes.goals || {};
  const goalsArr = Object.values(state.goals).sort((a, b) => (a.completed ? 1 : 0) - (b.completed ? 1 : 0));

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

  document.getElementById("btn-new-goal").onclick = () => openCreateGoalModal();
  document.getElementById("btn-new-goal-empty")?.addEventListener("click", () => openCreateGoalModal());

  main.querySelectorAll('[data-action="save"]').forEach(btn => {
    btn.addEventListener("click", () => openSaveModal(btn.dataset.goal));
  });
  main.querySelectorAll('[data-action="withdraw"]').forEach(btn => {
    btn.addEventListener("click", () => openWithdrawModal(btn.dataset.goal));
  });
}

const GOAL_EMOJIS = ["🎯", "💻", "📱", "🎓", "🏠", "🚗", "✈️", "💍", "🏥", "👶", "🛒", "🎉"];

function openCreateGoalModal() {
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

  root.querySelector("#goal-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelector("#goal-submit").onclick = async () => {
    const name = document.getElementById("goal-name").value.trim();
    const target = document.getElementById("goal-target").value;
    const deadline = document.getElementById("goal-deadline").value;
    const lockType = document.getElementById("goal-lock").value;
    const errBox = document.getElementById("goal-error");
    const btn = root.querySelector("#goal-submit");

    if (!name) return showModalError(errBox, "Please enter a goal name");
    if (!target || parseFloat(target) < 500) return showModalError(errBox, "Minimum target is MWK 500");

    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.createGoal(state.user.uid, { name, target, deadline: deadline || null, emoji: selectedEmoji, lockType });
      closeModal();
      toast("Goal created!");
      navigate("goals");
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Create Goal";
    }
  };
}

function showModalError(box, msg) {
  box.style.display = "block";
  box.textContent = msg;
}

function closeModal() {
  const root = document.getElementById("modal-root");
  root.classList.remove("open");
  root.innerHTML = "";
}

// ----------------------------
// SAVE / WITHDRAW MODALS
// ----------------------------
function openSaveModal(preselectGoalId) {
  const goalsArr = Object.values(state.goals).filter(g => !g.completed);
  if (goalsArr.length === 0) {
    toast("Create a goal first", "error");
    return navigate("goals");
  }

  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>Save Money</h3>
      <p class="modal-sub">Move money from your Airtel wallet into a goal</p>

      <div class="input-group">
        <label class="input-label">Goal</label>
        <select class="input" id="save-goal">
          ${goalsArr.map(g => `<option value="${g.id}" ${g.id === preselectGoalId ? "selected" : ""}>${g.emoji} ${escapeHTML(g.name)}</option>`).join("")}
        </select>
      </div>

      <div class="input-group">
        <label class="input-label">Amount (MWK)</label>
        <input class="input" id="save-amount" type="number" placeholder="e.g. 5000" min="100">
      </div>

      <div class="input-group">
        <label class="input-label">Airtel Money number</label>
        <input class="input" id="save-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.profilePhone || ""}">
      </div>

      <div id="save-error" class="auth-error" style="display:none"></div>

      <div class="modal-info">
        A USSD prompt will appear on this number to confirm. Fee: ${state.planConfig?.transactionFeePercent ?? 1}% deducted from your wallet.
      </div>

      <div class="modal-actions">
        <button class="btn btn-outline" id="save-cancel">Cancel</button>
        <button class="btn btn-primary" id="save-submit">Save Money</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#save-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelector("#save-submit").onclick = async () => {
    const goalId = document.getElementById("save-goal").value;
    const amount = document.getElementById("save-amount").value;
    const phone = document.getElementById("save-phone").value.trim();
    const errBox = document.getElementById("save-error");
    const btn = root.querySelector("#save-submit");

    if (!amount || parseFloat(amount) < 100) return showModalError(errBox, "Minimum save is MWK 100");
    if (!/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) return showModalError(errBox, "Enter a valid Malawi Airtel number");

    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.save(state.user.uid, { goalId, amount, phone });
      closeModal();
      toast(res.message || "Saved!");
      navigate(currentPage);
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Save Money";
    }
  };
}

function openWithdrawModal(preselectGoalId) {
  const goalsArr = Object.values(state.goals).filter(g => (g.saved || 0) > 0 && !g.locked);
  if (goalsArr.length === 0) {
    toast("No withdrawable savings available", "error");
    return;
  }

  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>Withdraw</h3>
      <p class="modal-sub">Send savings back to your Airtel wallet</p>

      <div class="input-group">
        <label class="input-label">Goal</label>
        <select class="input" id="wd-goal">
          ${goalsArr.map(g => `<option value="${g.id}" data-saved="${g.saved}" ${g.id === preselectGoalId ? "selected" : ""}>${g.emoji} ${escapeHTML(g.name)} (MWK ${fmt(g.saved)} available)</option>`).join("")}
        </select>
      </div>

      <div class="input-group">
        <label class="input-label">Amount (MWK)</label>
        <input class="input" id="wd-amount" type="number" placeholder="e.g. 5000" min="100">
      </div>

      <div class="input-group">
        <label class="input-label">Airtel Money number</label>
        <input class="input" id="wd-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.profilePhone || ""}">
      </div>

      <div id="wd-error" class="auth-error" style="display:none"></div>

      <div class="modal-info">
        Fee: ${state.planConfig?.withdrawalFeePercent ?? 1}% deducted from withdrawal amount.
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

  root.querySelector("#wd-submit").onclick = async () => {
    const goalSelect = document.getElementById("wd-goal");
    const goalId = goalSelect.value;
    const maxAvail = parseFloat(goalSelect.selectedOptions[0].dataset.saved);
    const amount = document.getElementById("wd-amount").value;
    const phone = document.getElementById("wd-phone").value.trim();
    const errBox = document.getElementById("wd-error");
    const btn = root.querySelector("#wd-submit");

    if (!amount || parseFloat(amount) < 100) return showModalError(errBox, "Minimum withdrawal is MWK 100");
    if (parseFloat(amount) > maxAvail) return showModalError(errBox, `Only MWK ${fmt(maxAvail)} available`);
    if (!/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) return showModalError(errBox, "Enter a valid Malawi Airtel number");

    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.withdraw(state.user.uid, { goalId, amount, phone });
      closeModal();
      toast(res.message || "Withdrawal sent!");
      navigate(currentPage);
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Withdraw";
    }
  };
}

// ----------------------------
// AUTO-SAVE PAGE
// ----------------------------
async function renderAutosavePage(main) {
  await loadPlan();
  const config = state.planConfig;

  if (!config?.maxAutoRules) {
    main.innerHTML = `
      <div class="page active">
        <div class="page-header">
          <h2>Auto-Save Rules</h2>
          <p>Automate your savings</p>
        </div>
        <div class="card">
          <div class="empty-state">
            <div class="icon">✨</div>
            <p>Auto-save rules, round-ups, and savings locks are available on Pro and Business plans.</p>
            <button class="btn btn-primary btn-sm" data-nav="premium">View Plans</button>
          </div>
        </div>
      </div>
    `;
    return bindNavLinks(main);
  }

  const [rulesRes, goalsRes] = await Promise.all([api.autosaveRules(), api.goals()]);
  state.goals = goalsRes.goals || {};
  const rules = Object.entries(rulesRes.rules || {}).map(([id, r]) => ({ id, ...r }));
  const goalsArr = Object.values(state.goals).filter(g => !g.completed);

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Auto-Save Rules</h2>
        <p>${rules.filter(r => r.enabled).length} active · max ${config.maxAutoRules} on ${state.plan} plan</p>
      </div>
      <div style="margin-bottom:20px">
        <button class="btn btn-primary" id="btn-new-rule" ${goalsArr.length === 0 ? "disabled" : ""}>+ Add Rule</button>
        ${goalsArr.length === 0 ? `<p style="margin-top:8px;font-size:12px;color:var(--muted)">Create a goal first to add rules</p>` : ""}
      </div>
      <div class="card">
        ${rules.length === 0 ? `
          <div class="empty-state">
            <div class="icon">↻</div>
            <p>No auto-save rules yet</p>
          </div>
        ` : rules.map(ruleHTML).join("")}
      </div>
    </div>
  `;

  document.getElementById("btn-new-rule").onclick = () => openCreateRuleModal(goalsArr);

  main.querySelectorAll(".toggle").forEach(t => {
    t.addEventListener("click", async () => {
      const ruleId = t.dataset.rule;
      const newEnabled = t.classList.contains("off");
      t.classList.toggle("off");
      try {
        await api.toggleAutosaveRule(ruleId, newEnabled);
        toast(newEnabled ? "Rule enabled" : "Rule disabled");
      } catch (e) {
        t.classList.toggle("off"); // revert
        toast(e.message, "error");
      }
    });
  });
}

function ruleHTML(r) {
  const icons = { weekly: "📅", monthly: "📆", income_percent: "📊", roundup: "🔄" };
  const goal = state.goals[r.goalId];
  let desc = "";
  if (r.type === "weekly") desc = `Weekly · MWK ${fmt(r.amount)} → ${goal?.name || "goal"}`;
  else if (r.type === "monthly") desc = `Monthly · MWK ${fmt(r.amount)} → ${goal?.name || "goal"}`;
  else if (r.type === "income_percent") desc = `${r.percent}% of income → ${goal?.name || "goal"}`;
  else if (r.type === "roundup") desc = `Round-up spends → ${goal?.name || "goal"}`;

  return `
    <div class="rule-card">
      <div class="rule-icon">${icons[r.type] || "↻"}</div>
      <div>
        <div class="rule-text">${desc}</div>
      </div>
      <div class="toggle ${r.enabled ? "" : "off"}" data-rule="${r.id}"></div>
    </div>
  `;
}

function openCreateRuleModal(goalsArr) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>New Auto-Save Rule</h3>
      <p class="modal-sub">Choose how you want to save automatically</p>

      <div class="input-group">
        <label class="input-label">Rule type</label>
        <select class="input" id="rule-type">
          <option value="weekly">Weekly — fixed amount</option>
          <option value="monthly">Monthly — fixed amount</option>
          <option value="income_percent">Percentage of income</option>
          <option value="roundup">Round-up spending</option>
        </select>
      </div>

      <div class="input-group" id="rule-amount-group">
        <label class="input-label">Amount (MWK)</label>
        <input class="input" id="rule-amount" type="number" placeholder="e.g. 2000">
      </div>

      <div class="input-group" id="rule-percent-group" style="display:none">
        <label class="input-label">Percentage (%)</label>
        <input class="input" id="rule-percent" type="number" placeholder="e.g. 25" min="1" max="100">
      </div>

      <div class="input-group">
        <label class="input-label">Goal</label>
        <select class="input" id="rule-goal">
          ${goalsArr.map(g => `<option value="${g.id}">${g.emoji} ${escapeHTML(g.name)}</option>`).join("")}
        </select>
      </div>

      <div id="rule-error" class="auth-error" style="display:none"></div>

      <div class="modal-actions">
        <button class="btn btn-outline" id="rule-cancel">Cancel</button>
        <button class="btn btn-primary" id="rule-submit">Create Rule</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#rule-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  const typeSelect = root.querySelector("#rule-type");
  typeSelect.addEventListener("change", () => {
    const isPercent = typeSelect.value === "income_percent";
    const isRoundup = typeSelect.value === "roundup";
    root.querySelector("#rule-amount-group").style.display = (isPercent || isRoundup) ? "none" : "block";
    root.querySelector("#rule-percent-group").style.display = isPercent ? "block" : "none";
  });

  root.querySelector("#rule-submit").onclick = async () => {
    const type = typeSelect.value;
    const amount = document.getElementById("rule-amount").value;
    const percent = document.getElementById("rule-percent").value;
    const goalId = document.getElementById("rule-goal").value;
    const errBox = document.getElementById("rule-error");
    const btn = root.querySelector("#rule-submit");

    if (type === "income_percent" && (!percent || percent < 1)) return showModalError(errBox, "Enter a valid percentage");
    if (["weekly", "monthly"].includes(type) && (!amount || amount < 100)) return showModalError(errBox, "Minimum amount is MWK 100");

    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.createAutosaveRule(state.user.uid, { type, amount, percent, goalId, schedule: type, enabled: true });
      closeModal();
      toast("Auto-save rule created!");
      navigate("autosave");
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Create Rule";
    }
  };
}

// ----------------------------
// TRANSACTIONS PAGE
// ----------------------------
async function renderTransactionsPage(main) {
  const filters = [
    { key: "", label: "All" },
    { key: "savings", label: "Savings" },
    { key: "withdrawal", label: "Withdrawals" },
    { key: "roundup", label: "Round-ups" },
    { key: "subscription", label: "Subscriptions" },
  ];

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Transaction History</h2>
        <p>All your SaverPro activity</p>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap" id="tx-filters">
        ${filters.map((f, i) => `<button class="btn ${i === 0 ? 'btn-primary' : 'btn-outline'} btn-sm" data-filter="${f.key}">${f.label}</button>`).join("")}
      </div>
      <div class="card" id="tx-list">
        <div class="loading-row"><span class="spinner"></span> Loading...</div>
      </div>
    </div>
  `;

  async function loadTx(type) {
    const list = document.getElementById("tx-list");
    list.innerHTML = `<div class="loading-row"><span class="spinner"></span> Loading...</div>`;
    const res = await api.transactions(`?limit=50${type ? `&type=${type}` : ""}`);
    const txs = res.transactions || [];
    list.innerHTML = txs.length === 0
      ? `<div class="empty-state"><div class="icon">📋</div><p>No transactions found</p></div>`
      : txs.map(txRowHTML).join("");
  }

  main.querySelectorAll("[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      main.querySelectorAll("[data-filter]").forEach(b => b.className = "btn btn-outline btn-sm");
      btn.className = "btn btn-primary btn-sm";
      loadTx(btn.dataset.filter);
    });
  });

  await loadTx("");
}

// ----------------------------
// ANALYTICS PAGE
// ----------------------------
async function renderAnalyticsPage(main) {
  await loadPlan();
  const res = await api.analytics();
  const a = res.analytics;

  if (!res.fullAnalyticsAvailable) {
    main.innerHTML = `
      <div class="page active">
        <div class="page-header">
          <h2>Analytics</h2>
          <p>Your savings at a glance</p>
        </div>
        <div class="grid-2">
          <div class="stat highlight">
            <div class="stat-label">Total Saved</div>
            <div class="stat-value">${fmt(a.totalSaved)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Savings Rate</div>
            <div class="stat-value">${a.savingsRate}%</div>
          </div>
        </div>
        <div class="card">
          <div class="empty-state">
            <div class="icon">📊</div>
            <p>Full analytics, spending breakdown and AI insights are available on Pro and Business plans.</p>
            <button class="btn btn-primary btn-sm" data-nav="premium">Upgrade to Pro</button>
          </div>
        </div>
      </div>
    `;
    bindNavLinks(main);
    return;
  }

  const months = Object.keys(a.monthlyTrend || {}).sort().slice(-6);
  const maxVal = Math.max(1, ...months.flatMap(m => [a.monthlyTrend[m].saved, a.monthlyTrend[m].spent]));

  const categories = Object.entries(a.categoryBreakdown || {}).sort((x, y) => y[1] - x[1]);
  const totalCat = categories.reduce((s, [, v]) => s + v, 0) || 1;
  const catColors = ["var(--amber)", "var(--blue)", "var(--red)", "var(--purple)", "var(--green)"];

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Analytics</h2>
        <p>Understand your money patterns</p>
      </div>

      <div class="grid-3">
        <div class="stat highlight">
          <div class="stat-label">Savings Rate</div>
          <div class="stat-value">${a.savingsRate}%</div>
        </div>
        <div class="stat">
          <div class="stat-label">Total Saved</div>
          <div class="stat-value">${fmt(a.totalSaved)}</div>
          <div class="stat-sub">MWK lifetime</div>
        </div>
        <div class="stat">
          <div class="stat-label">This Month</div>
          <div class="stat-value">${fmt(a.monthSaved)}</div>
          <div class="stat-sub">MWK saved</div>
        </div>
      </div>

      ${months.length > 0 ? `
        <div class="card">
          <div class="card-header"><div class="card-title">Monthly Trend</div></div>
          <div class="chart-bar-wrap">
            ${months.map(m => `<div class="chart-bar savings" style="height:${Math.max(8, (a.monthlyTrend[m].saved / maxVal) * 100)}%"></div>`).join("")}
          </div>
          <div class="chart-labels">${months.map(m => `<span>${m.split("-")[1]}/${m.split("-")[0].slice(2)}</span>`).join("")}</div>
          <div style="display:flex;gap:16px;margin-top:12px;font-size:12px">
            <span style="color:var(--blue)">● Saved</span>
          </div>
        </div>
      ` : ""}

      ${a.aiInsight?.length ? `
        <div class="card">
          <div class="card-header"><div class="card-title">AI Insights</div></div>
          ${a.aiInsight.map(i => `<div class="insight-box">${i}</div>`).join("")}
        </div>
      ` : ""}

      ${categories.length > 0 ? `
        <div class="card">
          <div class="card-header"><div class="card-title">Spending Breakdown</div></div>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${categories.map(([cat, val], i) => `
              <div>
                <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
                  <span style="text-transform:capitalize">${cat}</span>
                  <span style="color:var(--muted)">MWK ${fmt(val)} · ${Math.round((val / totalCat) * 100)}%</span>
                </div>
                <div class="progress-bar"><div class="progress-fill" style="width:${Math.round((val/totalCat)*100)}%;background:${catColors[i % catColors.length]}"></div></div>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

// ----------------------------
// NOTIFICATIONS PAGE
// ----------------------------
async function renderNotificationsPage(main) {
  const res = await api.notifications();
  const notifs = res.notifications || [];

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Notifications</h2>
        <p>Your savings activity feed</p>
      </div>
      ${notifs.length === 0 ? `
        <div class="empty-state"><div class="icon">🔔</div><p>No notifications yet</p></div>
      ` : notifs.map(notifHTML).join("")}
    </div>
  `;

  main.querySelectorAll("[data-notif]").forEach(el => {
    el.addEventListener("click", async () => {
      if (el.classList.contains("unread")) {
        el.classList.remove("unread");
        try { await api.markNotificationRead(el.dataset.notif); } catch {}
      }
    });
  });
}

const NOTIF_ICONS = {
  savings_success: "💰", withdrawal_success: "💸", goal_complete: "🎉",
  subscription_success: "✨", subscription_expired: "⏰",
  transaction_failed: "⚠️", savings_reconciled: "✅", roundup_success: "🔄"
};

function notifHTML(n) {
  const cls = n.type === "transaction_failed" ? "warn" : n.type?.includes("subscription") ? "info" : "";
  return `
    <div class="notif ${cls} ${n.read ? "" : "unread"}" data-notif="${n.id}">
      <div class="notif-icon">${NOTIF_ICONS[n.type] || "🔔"}</div>
      <div>
        <div class="notif-text">${escapeHTML(n.message)}</div>
        <div class="notif-time">${formatDate(n.timestamp)}</div>
      </div>
    </div>
  `;
}

// ----------------------------
// MERCHANT PAGE
// ----------------------------
async function renderMerchantPage(main) {
  await loadPlan();

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
            <button class="btn btn-primary btn-sm" data-nav="premium">Upgrade to Business</button>
          </div>
        </div>
      </div>
    `;
    return bindNavLinks(main);
  }

  const txRes = await api.transactions("?limit=50");
  const txs = txRes.transactions || [];
  const collections = txs.filter(t => t.type === "collection");
  const disbursements = txs.filter(t => t.type === "disbursement");
  const revenue = collections.filter(t => t.status !== "failed").reduce((s, t) => s + (t.amount || 0), 0);

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Merchant Dashboard</h2>
        <p>Collect payments and pay people via Airtel Money</p>
      </div>

      <div class="grid-3">
        <div class="merchant-stat">
          <div class="val" style="color:var(--green)">${fmt(revenue)}</div>
          <div class="lbl">Revenue (MWK)</div>
        </div>
        <div class="merchant-stat">
          <div class="val">${collections.length}</div>
          <div class="lbl">Collections</div>
        </div>
        <div class="merchant-stat">
          <div class="val">${disbursements.length}</div>
          <div class="lbl">Payouts</div>
        </div>
      </div>

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

// ----------------------------
// PREMIUM / PLANS PAGE
// ----------------------------
async function renderPremiumPage(main) {
  await loadPlan();
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
    btn.addEventListener("click", () => openSubscribeModal(btn.dataset.plan, plans[btn.dataset.plan]));
  });
}

function openSubscribeModal(planKey, plan) {
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
        <input class="input" id="sub-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.profilePhone || ""}">
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

// ----------------------------
// ENTRY POINT
// ----------------------------
watchAuth(
  async (user) => {
    state.user = user;
    renderShell(user);
    await navigate("dashboard");
  },
  () => {
    state.user = null;
    renderLogin();
  }
);
