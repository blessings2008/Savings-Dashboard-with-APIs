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
  { id: "home", icon: "⊞", label: "Home", section: "main" },
  { id: "dashboard", icon: "⬡", label: "PocketVault", section: "main" },
  { id: "goals", icon: "◎", label: "Goals", section: "main" },
  { id: "autosave", icon: "↻", label: "Auto-Save", section: "main" },
  { id: "transactions", icon: "≡", label: "Transactions", section: "main" },
  { id: "analytics", icon: "◈", label: "Analytics", section: "insights" },
  { id: "notifications", icon: "◉", label: "Notifications", section: "insights" },
  { id: "merchant", icon: "◇", label: "Merchant", section: "business" },
  { id: "premium", icon: "✦", label: "Plans", section: "business" },
  { id: "budget", icon: "📊", label: "Budget", section: "apps" },
  { id: "fees", icon: "🎓", label: "School Fees", section: "apps" },
  { id: "loans", icon: "🤝", label: "Loans", section: "apps" },
  { id: "split", icon: "🧾", label: "Bill Split", section: "apps" },
  { id: "pos", icon: "🏪", label: "POS", section: "apps" },
];

// ----------------------------
// SHELL
// ----------------------------
function renderShell(user) {
  const sectionsOrder = ["main", "insights", "business", "apps"];
  const sectionLabels = { main: "Main", insights: "Insights", business: "Business", apps: "Mini Apps" };

  let sidebarHTML = `<div class="logo"><img src="icon-192.png" class="logo-img" alt="PocketVault"> Pocket<span>Vault</span></div>`;
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
      <div class="nav-item" data-page="home"><span class="nav-icon">⊞</span>Apps</div>
      <div class="nav-item" data-page="dashboard"><span class="nav-icon">⬡</span>Vault</div>
      <div class="nav-item" data-page="budget"><span class="nav-icon">📊</span>Budget</div>
      <div class="nav-item" data-page="notifications"><span class="nav-icon notif-nav-icon">◉</span>Alerts</div>
      <div class="nav-item" data-page="account"><span class="nav-icon">${initials(user)}</span>Account</div>
    </div>

    <!-- MODALS -->
    <div class="modal-overlay" id="modal-root"></div>
  `;

  // Nav click handlers
  document.querySelectorAll("[data-page]").forEach(el => {
    el.addEventListener("click", () => navigate(el.dataset.page));
  });

  // User pill -> account page
  document.getElementById("user-pill").addEventListener("click", () => navigate("account"));

  // Start polling unread notification count
  fetchUnreadCount();
  setInterval(fetchUnreadCount, 30000);
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
      case "home": await renderHomePage(main); break;
      case "merchant": await renderMerchantPage(main); break;
      case "premium": await renderPremiumPage(main); break;
      case "account": await renderAccountPage(main); break;
      case "budget": await renderBudgetPage(main); break;
      case "fees": await renderFeesPage(main); break;
      case "loans": await renderLoansPage(main); break;
      case "split": await renderSplitPage(main); break;
      case "pos": await renderPOSPage(main); break;
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

      ${state.user?.kycStatus !== "verified" && state.user?.kycStatus !== "mock_verified" ? `
        <div class="kyc-banner" id="kyc-banner-btn">
          <span style="font-size:20px">⚠️</span>
          <div>
            <strong>Phone not verified</strong> — Verify your Airtel number to start saving and withdrawing.
            <span style="margin-left:6px;text-decoration:underline">Verify now →</span>
          </div>
        </div>
      ` : ""}

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

  document.getElementById("kyc-banner-btn")?.addEventListener("click", () => navigate("account"));
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

  const decisionBanner = (!compact && g.deadlineDecisionPending && !g.completed) ? `
    <div class="deadline-decision-banner">
      <div style="font-weight:700;margin-bottom:4px">⏰ Deadline passed at ${pct}% saved</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">Choose what to do with this goal</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" data-decision="unlock" data-goal="${g.id}">🔓 Unlock Now</button>
        <button class="btn btn-outline btn-sm" data-decision="extend" data-goal="${g.id}">📅 Extend Deadline</button>
      </div>
    </div>
  ` : (!compact && g.deadlinePassed && g.deadlineBehavior === "stay_locked" && !g.completed) ? `
    <div class="deadline-decision-banner muted">
      <div style="font-size:12.5px">📌 Deadline passed at ${pct}% — stays locked until target is reached, as you chose.</div>
    </div>
  ` : "";

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
      ${decisionBanner}
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
  main.querySelectorAll('[data-decision="unlock"]').forEach(btn => {
    btn.addEventListener("click", () => handleDeadlineDecision(btn.dataset.goal, "unlock"));
  });
  main.querySelectorAll('[data-decision="extend"]').forEach(btn => {
    btn.addEventListener("click", () => openExtendDeadlineModal(btn.dataset.goal));
  });
}

async function handleDeadlineDecision(goalId, action, newDeadline) {
  try {
    await api.patch(`/api/goals/${goalId}/deadline-decision`, { action, newDeadline });
    toast(action === "unlock" ? "Goal unlocked!" : "Deadline extended!");
    navigate("goals");
  } catch (e) {
    toast(e.data?.error || e.message, "error");
  }
}

function openExtendDeadlineModal(goalId) {
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
  // KYC gate
  const kyc = state.user?.kycStatus;
  if (kyc !== "verified" && kyc !== "mock_verified") {
    toast("Verify your phone number first to save money", "error");
    return navigate("account");
  }
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
        <input class="input" id="save-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.phone || state.user.profilePhone || ""}" ${state.user.phone ? "readonly" : ""}>
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
  // KYC gate
  const kyc = state.user?.kycStatus;
  if (kyc !== "verified" && kyc !== "mock_verified") {
    toast("Verify your phone number first to withdraw", "error");
    return navigate("account");
  }
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
        <input class="input" id="wd-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.phone || state.user.profilePhone || ""}" ${state.user.phone ? "readonly" : ""}>
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
        <p>All your PocketVault activity</p>
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
  // Mark all read and clear badge
  try {
    await api.post("/api/notifications/read-all", {});
    updateNotifBadge(0);
  } catch {}
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
  const isAdmin = n.type === "admin_message";
  const cls = n.type === "transaction_failed" ? "warn" : n.type?.includes("subscription") ? "info" : isAdmin ? "admin" : "";
  const senderIcon = isAdmin ? "🛡️" : "";
  const senderName = isAdmin ? '<span class="notif-sender">PocketVault Admin</span>' : "";
  const topic = n.topic ? `<span class="notif-topic">${escapeHTML(n.topic)}</span>` : "";
  return `
    <div class="notif ${cls} ${n.read ? "read" : "unread"}" data-notif="${n.id}">
      <div class="notif-icon">${senderIcon || NOTIF_ICONS[n.type] || "🔔"}</div>
      <div style="flex:1;min-width:0">
        ${senderName}
        ${topic}
        <div class="notif-text">${escapeHTML(n.message)}</div>
        <div class="notif-time">${formatDate(n.timestamp)}${n.read ? "" : ' <span class="notif-dot"></span>'}</div>
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

// ----------------------------
// ACCOUNT PAGE
// ----------------------------
async function renderAccountPage(main) {
  await loadPlan();

  const user = state.user;
  const sub = state.subscription || {};

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Account</h2>
        <p>Manage your profile and security</p>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Profile</div></div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
          <div class="avatar" style="width:48px;height:48px;font-size:18px">${initials(user)}</div>
          <div>
            <div style="font-weight:700;font-size:15px">${escapeHTML(user.displayName || "PocketVault User")}</div>
            <div style="font-size:12.5px;color:var(--muted)">${escapeHTML(user.email || "")}</div>
          </div>
        </div>

        <div class="input-group">
          <label class="input-label">Display name</label>
          <input class="input" id="acc-name" placeholder="Your name" value="${escapeHTML(user.displayName || "")}">
        </div>

        <div class="input-group">
          <label class="input-label">Airtel Money number</label>
          <input class="input" id="acc-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.phone || state.user.profilePhone || ""}" ${state.user.phone ? "readonly" : ""}>
        </div>

        <div id="acc-error" class="auth-error" style="display:none"></div>
        <div id="acc-success" class="insight-box" style="display:none"></div>

        <button class="btn btn-primary" id="acc-save" style="width:100%">Save Changes</button>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Phone Verification (KYC)</div></div>
        <p style="font-size:13px;color:var(--muted);margin-bottom:14px">
          ${state.user.kycStatus === "verified" || state.user.kycStatus === "mock_verified"
            ? `✅ Verified${state.user.kycName ? ` as ${escapeHTML(state.user.kycName)}` : ""}`
            : "Verify your Airtel number to enable savings, withdrawals and subscriptions."}
        </p>
        ${state.user.kycStatus === "verified" || state.user.kycStatus === "mock_verified" ? "" : `
          <button class="btn btn-outline" id="acc-kyc" style="width:100%">Verify Phone Number</button>
        `}
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Plan</div></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <div style="font-weight:700;text-transform:capitalize">${state.plan} plan</div>
            <div style="font-size:12px;color:var(--muted)">
              ${sub.daysRemaining ? `Renews in ${sub.daysRemaining} day${sub.daysRemaining !== 1 ? "s" : ""}` : "No active subscription"}
            </div>
          </div>
          <button class="btn btn-outline btn-sm" data-nav="premium">Manage</button>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Session</div></div>
        <button class="btn btn-danger" id="acc-signout" style="width:100%">Sign Out</button>
      </div>
    </div>
  `;

  bindNavLinks(main);

  document.getElementById("acc-save").onclick = async () => {
    const name = document.getElementById("acc-name").value.trim();
    const phone = document.getElementById("acc-phone").value.trim();
    const errBox = document.getElementById("acc-error");
    const okBox = document.getElementById("acc-success");
    errBox.style.display = "none";
    okBox.style.display = "none";

    if (phone && !/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) {
      errBox.style.display = "block";
      errBox.textContent = "Enter a valid Malawi Airtel number";
      return;
    }

    const btn = document.getElementById("acc-save");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.profile(state.user.uid, { name, phone });
      state.user.profilePhone = phone;
      okBox.style.display = "block";
      okBox.textContent = "Profile updated.";
      toast("Profile saved");
    } catch (e) {
      errBox.style.display = "block";
      errBox.textContent = e.data?.error || e.message;
    } finally {
      btn.disabled = false; btn.textContent = "Save Changes";
    }
  };

  document.getElementById("acc-kyc")?.addEventListener("click", () => {
    const phone = document.getElementById("acc-phone").value.trim();
    if (!/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) {
      const errBox = document.getElementById("acc-error");
      errBox.style.display = "block";
      errBox.textContent = "Enter your Airtel number above first, then verify.";
      return;
    }
    openKYCModal(phone);
  });

  document.getElementById("acc-signout").onclick = async () => {
    if (confirm("Sign out of PocketVault?")) await logOut();
  };
}

function openKYCModal(phone) {
  const root = document.getElementById("modal-root");

  // STEP 1: Send OTP
  function showStep1() {
    root.innerHTML = `
      <div class="modal">
        <h3>🔐 Verify Phone Number</h3>
        <p class="modal-sub">We'll send a 6-digit code to confirm <strong>${escapeHTML(phone)}</strong> is yours.</p>
        <div class="modal-info" style="margin-bottom:16px">
          This number will be used for all your transactions — it cannot be changed once verified.
        </div>
        <div id="kyc-error" class="auth-error" style="display:none"></div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="kyc-cancel">Cancel</button>
          <button class="btn btn-primary" id="kyc-send-otp">Send Code</button>
        </div>
      </div>
    `;
    root.classList.add("open");
    root.querySelector("#kyc-cancel").onclick = closeModal;
    root.addEventListener("click", e => { if (e.target === root) closeModal(); });

    root.querySelector("#kyc-send-otp").onclick = async () => {
      const errBox = document.getElementById("kyc-error");
      const btn = root.querySelector("#kyc-send-otp");
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Sending...`;
      try {
        const res = await api.post("/api/kyc/send-otp", { uid: state.user.uid, phone });
        toast(res.mock ? "Code sent — check your Notifications 🔔" : res.message);
        showStep2();
      } catch (e) {
        showModalError(errBox, e.data?.error || e.message);
        btn.disabled = false; btn.textContent = "Send Code";
      }
    };
  }

  // STEP 2: Enter OTP
  function showStep2() {
    root.innerHTML = `
      <div class="modal">
        <h3>🔐 Enter Verification Code</h3>
        <p class="modal-sub">Check your <strong>Notifications</strong> (bell icon) for the 6-digit code sent to ${escapeHTML(phone)}.</p>
        <div class="input-group">
          <label class="input-label">6-Digit Code</label>
          <input class="input" id="kyc-otp" type="number" inputmode="numeric" maxlength="6" placeholder="123456"
            style="font-size:22px;letter-spacing:6px;text-align:center">
        </div>
        <div id="kyc-error2" class="auth-error" style="display:none"></div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="kyc-resend">Resend Code</button>
          <button class="btn btn-primary" id="kyc-verify">Verify</button>
        </div>
        <p style="font-size:11.5px;color:var(--muted);margin-top:10px;text-align:center">Code expires in 10 minutes</p>
      </div>
    `;

    // Focus the OTP input automatically
    setTimeout(() => document.getElementById("kyc-otp")?.focus(), 100);

    root.querySelector("#kyc-resend").onclick = () => showStep1();
    root.querySelector("#kyc-verify").onclick = async () => {
      const otp = document.getElementById("kyc-otp").value.trim();
      const errBox = document.getElementById("kyc-error2");
      const btn = root.querySelector("#kyc-verify");
      if (!otp || otp.length !== 6) return showModalError(errBox, "Enter the 6-digit code");

      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Verifying...`;
      try {
        const res = await api.post("/api/kyc/verify-otp", { uid: state.user.uid, phone, otp });
        if (res.success) {
          state.user.kycStatus = "verified";
          state.user.kycName = res.name;
          state.user.phone = phone;
          state.user.profilePhone = phone;
          closeModal();
          toast(res.message || "✅ Phone verified!");
          fetchUnreadCount(); // Refresh badge — KYC success notification was sent
          navigate("account");
        } else {
          showModalError(errBox, res.message || "Verification failed");
          btn.disabled = false; btn.textContent = "Verify";
        }
      } catch (e) {
        showModalError(errBox, e.data?.error || e.message);
        btn.disabled = false; btn.textContent = "Verify";
      }
    };

    // Allow pressing Enter to submit
    root.querySelector("#kyc-otp").addEventListener("keydown", e => {
      if (e.key === "Enter") root.querySelector("#kyc-verify").click();
    });
  }

  showStep1();
}


watchAuth(
  async (user) => {
    state.user = user;
    // Render shell immediately — don't wait for profile load
    renderShell(user);
    // Load profile in background (KYC status, phone)
    loadUserProfile().then(() => {
      // If already on dashboard, refresh to show KYC banner if needed
      if (currentPage === "dashboard") navigate("dashboard");
    });
    navigate("dashboard");
  },
  () => {
    state.user = null;
    renderLogin();
  }
);

// ============================================================
// HOME SCREEN — App Launcher
// ============================================================
async function renderHomePage(main) {
  await loadPlan();
  let summary = {};
  try {
    const res = await api.get("/api/apps/summary");
    summary = res.summary || {};
  } catch {}

  const APPS = [
    {
      id: "dashboard", icon: "💰", name: "PocketVault",
      desc: "Savings goals & Airtel Money",
      color: "#00e5a0",
      stat: `${summary.savings?.activeGoals || 0} active goals`,
    },
    {
      id: "budget", icon: "📊", name: "Budget Tracker",
      desc: "Track spending by category",
      color: "#0ea5e9",
      stat: `MWK ${fmt(summary.budget?.monthlySpend || 0)} spent this month`,
    },
    {
      id: "fees", icon: "🎓", name: "School Fees",
      desc: "Plan & save for term fees",
      color: "#a855f7",
      stat: `${summary.fees?.pendingPlans || 0} pending plan${summary.fees?.pendingPlans !== 1 ? "s" : ""}`,
    },
    {
      id: "loans", icon: "🤝", name: "Loan Tracker",
      desc: "Track money lent & borrowed",
      color: "#f59e0b",
      stat: `${summary.loans?.activeLoans || 0} active loan${summary.loans?.activeLoans !== 1 ? "s" : ""}`,
    },
    {
      id: "split", icon: "🧾", name: "Bill Splitter",
      desc: "Split bills among friends",
      color: "#f43f5e",
      stat: `${summary.split?.openGroups || 0} open group${summary.split?.openGroups !== 1 ? "s" : ""}`,
    },
    {
      id: "pos", icon: "🏪", name: "Merchant POS",
      desc: "Point-of-sale for your business",
      color: "#00e5a0",
      stat: `MWK ${fmt(summary.pos?.monthRevenue || 0)} this month`,
    },
  ];

  const user = auth.currentUser;
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  })();

  main.innerHTML = `
    <div class="page active">
      <div class="home-header">
        <div>
          <div class="home-greeting">${greeting},</div>
          <div class="home-name">${escapeHTML((user?.displayName || user?.email || "there").split("@")[0])} 👋</div>
        </div>
        <img src="icon-192.png" style="width:44px;height:44px;border-radius:12px;opacity:0.9" alt="">
      </div>

      <div class="apps-grid">
        ${APPS.map(app => `
          <div class="app-card" data-nav="${app.id}" style="--app-color:${app.color}">
            <div class="app-card-icon">${app.icon}</div>
            <div class="app-card-name">${app.name}</div>
            <div class="app-card-desc">${app.desc}</div>
            <div class="app-card-stat">${app.stat}</div>
          </div>
        `).join("")}
      </div>

      <!-- Quick stats row -->
      <div class="card" style="margin-top:8px">
        <div class="card-header"><div class="card-title">Quick Stats</div></div>
        <div style="display:flex;gap:10px;padding:16px;flex-wrap:wrap">
          <div style="flex:1;min-width:120px;text-align:center">
            <div style="font-size:20px;font-weight:800;font-family:Syne,sans-serif;color:var(--green)">${fmt(summary.savings?.activeGoals || 0)}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:3px">Active Goals</div>
          </div>
          <div style="flex:1;min-width:120px;text-align:center">
            <div style="font-size:20px;font-weight:800;font-family:Syne,sans-serif;color:var(--amber)">${summary.loans?.activeLoans || 0}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:3px">Open Loans</div>
          </div>
          <div style="flex:1;min-width:120px;text-align:center">
            <div style="font-size:20px;font-weight:800;font-family:Syne,sans-serif;color:var(--blue)">MWK ${fmt(summary.budget?.monthlySpend || 0)}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:3px">Spent This Month</div>
          </div>
          <div style="flex:1;min-width:120px;text-align:center">
            <div style="font-size:20px;font-weight:800;font-family:Syne,sans-serif;color:var(--purple)">${summary.fees?.pendingPlans || 0}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:3px">Fees Due</div>
          </div>
        </div>
      </div>
    </div>
  `;

  bindNavLinks(main);
  main.querySelectorAll("[data-nav]").forEach(el => {
    el.addEventListener("click", () => navigate(el.dataset.nav));
  });
}

// ============================================================
// BUDGET TRACKER
// ============================================================
async function renderBudgetPage(main) {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const monthLabel = now.toLocaleDateString([], { month: "long", year: "numeric" });

  const [catsRes, expRes] = await Promise.all([
    api.get("/api/budget/categories"),
    api.get(`/api/budget/expenses?month=${thisMonth}`)
  ]);
  const cats = catsRes.categories || [];
  const expenses = expRes.expenses || [];

  // Build spend per category this month
  const spendByCat = {};
  expenses.forEach(e => { spendByCat[e.categoryId] = (spendByCat[e.categoryId] || 0) + e.amount; });
  const totalSpend = expenses.reduce((s, e) => s + e.amount, 0);
  const totalBudget = cats.reduce((s, c) => s + (c.monthlyLimit || 0), 0);

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>📊 Budget Tracker</h2>
        <p>${monthLabel} · MWK ${fmt(totalSpend)} of MWK ${fmt(totalBudget)} budgeted</p>
      </div>

      <div class="grid-2">
        <div class="stat highlight">
          <div class="stat-label">Total Spent</div>
          <div class="stat-value">MWK ${fmt(totalSpend)}</div>
          <div class="stat-sub ${totalSpend > totalBudget ? "down" : "up"}">${totalBudget > 0 ? Math.round((totalSpend/totalBudget)*100) : 0}% of budget</div>
        </div>
        <div class="stat">
          <div class="stat-label">Remaining</div>
          <div class="stat-value">MWK ${fmt(Math.max(0, totalBudget - totalSpend))}</div>
          <div class="stat-sub">${cats.length} categories</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Categories</div>
          <span class="card-action" id="btn-add-cat">+ Add</span>
        </div>
        ${cats.length === 0 ? `
          <div class="empty-state"><div class="icon">📊</div><p>Add a category to start tracking</p>
          <button class="btn btn-primary btn-sm" id="btn-add-cat-empty">Add Category</button></div>
        ` : cats.map(cat => {
          const spent = spendByCat[cat.id] || 0;
          const pct = cat.monthlyLimit > 0 ? Math.min(100, Math.round((spent/cat.monthlyLimit)*100)) : 0;
          const over = spent > cat.monthlyLimit;
          return `
            <div style="padding:12px 0;border-bottom:1px solid var(--border)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="font-size:20px">${cat.emoji}</span>
                  <div>
                    <div style="font-weight:600;font-size:14px">${escapeHTML(cat.name)}</div>
                    <div style="font-size:11px;color:var(--muted)">Limit: MWK ${fmt(cat.monthlyLimit)}/month</div>
                  </div>
                </div>
                <div style="text-align:right">
                  <div style="font-weight:700;color:${over?"var(--red)":"var(--text)"};font-size:14px">MWK ${fmt(spent)}</div>
                  <div style="font-size:11px;color:${over?"var(--red)":"var(--muted)"}">${over?"OVER":""+pct+"%"}</div>
                </div>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width:${pct}%;background:${over?"var(--red)":cat.color||"var(--green)"}"></div>
              </div>
            </div>`;
        }).join("")}
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Add Expense</div>
        </div>
        ${cats.length === 0 ? `<div class="empty-state"><p>Add a category first</p></div>` : `
          <div style="display:flex;flex-direction:column;gap:10px;padding:0 0 4px">
            <select class="input" id="exp-cat">
              <option value="">Select category</option>
              ${cats.map(c => `<option value="${c.id}">${c.emoji} ${escapeHTML(c.name)}</option>`).join("")}
            </select>
            <div style="display:flex;gap:8px">
              <input class="input" id="exp-amount" type="number" placeholder="Amount (MWK)" style="flex:1">
              <input class="input" id="exp-note" type="text" placeholder="Note (optional)" style="flex:2">
            </div>
            <button class="btn btn-primary" id="btn-add-expense">Add Expense</button>
          </div>`}
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Recent Expenses</div></div>
        ${expenses.length === 0 ? `<div class="empty-state"><div class="icon">💸</div><p>No expenses this month</p></div>`
        : expenses.slice(0, 20).map(e => `
          <div class="tx-row">
            <div class="tx-left">
              <div class="tx-icon expense">${e.categoryEmoji || "💸"}</div>
              <div>
                <div class="tx-name">${escapeHTML(e.categoryName)}${e.note ? ` — ${escapeHTML(e.note)}` : ""}</div>
                <div class="tx-date">${e.date}</div>
              </div>
            </div>
            <div style="text-align:right">
              <div class="tx-amount neg">−MWK ${fmt(e.amount)}</div>
              <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;background:transparent;color:var(--muted);border:none;cursor:pointer" data-del-exp="${e.id}">✕</button>
            </div>
          </div>`).join("")}
      </div>
    </div>
  `;

  document.getElementById("btn-add-cat")?.addEventListener("click", () => openAddCategoryModal());
  document.getElementById("btn-add-cat-empty")?.addEventListener("click", () => openAddCategoryModal());

  document.getElementById("btn-add-expense")?.addEventListener("click", async () => {
    const catId = document.getElementById("exp-cat").value;
    const amount = document.getElementById("exp-amount").value;
    const note = document.getElementById("exp-note").value;
    if (!catId || !amount) return toast("Select a category and enter an amount", "error");
    const btn = document.getElementById("btn-add-expense");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.post("/api/budget/expenses", { uid: state.user.uid, categoryId: catId, amount, note });
      toast("Expense added");
      navigate("budget");
    } catch (e) { toast(e.data?.error || e.message, "error"); btn.disabled = false; btn.textContent = "Add Expense"; }
  });

  main.querySelectorAll("[data-del-exp]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this expense?")) return;
      await api.delete(`/api/budget/expenses/${btn.dataset.delExp}`).catch(() => {});
      toast("Deleted"); navigate("budget");
    });
  });
}

function openAddCategoryModal() {
  const root = document.getElementById("modal-root");
  const EMOJIS = ["🍔","🚗","💊","📚","🏠","👗","💡","📱","✈️","🎬","🏋️","💰"];
  let selectedEmoji = EMOJIS[0];
  const COLORS = ["#00e5a0","#0ea5e9","#f59e0b","#f43f5e","#a855f7","#06b6d4"];
  let selectedColor = COLORS[0];

  root.innerHTML = `
    <div class="modal">
      <h3>New Category</h3>
      <p class="modal-sub">Set a monthly budget limit for this category</p>
      <div class="input-group">
        <label class="input-label">Icon</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${EMOJIS.map((e,i)=>`<button type="button" class="btn btn-outline btn-sm emoji-btn" data-emoji="${e}" style="font-size:18px;padding:8px;${i===0?"border-color:var(--green)":""}">${e}</button>`).join("")}
        </div>
      </div>
      <div class="input-group">
        <label class="input-label">Name</label>
        <input class="input" id="cat-name" placeholder="e.g. Food & Drinks">
      </div>
      <div class="input-group">
        <label class="input-label">Monthly Limit (MWK)</label>
        <input class="input" id="cat-limit" type="number" placeholder="e.g. 50000">
      </div>
      <div class="input-group">
        <label class="input-label">Color</label>
        <div style="display:flex;gap:8px">
          ${COLORS.map((c,i)=>`<div class="color-swatch ${i===0?"selected":""}" data-color="${c}" style="width:26px;height:26px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${i===0?"white":"transparent"}"></div>`).join("")}
        </div>
      </div>
      <div id="cat-error" class="auth-error" style="display:none"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="cat-cancel">Cancel</button>
        <button class="btn btn-primary" id="cat-save">Add Category</button>
      </div>
    </div>`;
  root.classList.add("open");
  root.querySelector("#cat-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelectorAll(".emoji-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      root.querySelectorAll(".emoji-btn").forEach(b => b.style.borderColor = "var(--border)");
      btn.style.borderColor = "var(--green)"; selectedEmoji = btn.dataset.emoji;
    });
  });
  root.querySelectorAll(".color-swatch").forEach(sw => {
    sw.addEventListener("click", () => {
      root.querySelectorAll(".color-swatch").forEach(s => s.style.borderColor = "transparent");
      sw.style.borderColor = "white"; selectedColor = sw.dataset.color;
    });
  });

  root.querySelector("#cat-save").onclick = async () => {
    const name = document.getElementById("cat-name").value.trim();
    const limit = document.getElementById("cat-limit").value;
    const errBox = document.getElementById("cat-error");
    const btn = root.querySelector("#cat-save");
    if (!name) return showModalError(errBox, "Enter a category name");
    if (!limit || parseFloat(limit) < 1) return showModalError(errBox, "Enter a valid monthly limit");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.post("/api/budget/categories", { uid: state.user.uid, name, emoji: selectedEmoji, monthlyLimit: limit, color: selectedColor });
      closeModal(); toast("Category added!"); navigate("budget");
    } catch (e) { showModalError(errBox, e.data?.error || e.message); btn.disabled = false; btn.textContent = "Add Category"; }
  };
}

// ============================================================
// SCHOOL FEES PLANNER
// ============================================================
async function renderFeesPage(main) {
  const res = await api.get("/api/fees/plans");
  const plans = res.plans || [];
  const active = plans.filter(p => !p.paid);
  const completed = plans.filter(p => p.paid);
  const totalNeeded = active.reduce((s, p) => s + p.termAmount, 0);
  const totalSaved = active.reduce((s, p) => s + (p.saved || 0), 0);

  main.innerHTML = `
    <div class="page active">
      <div class="page-header"><h2>🎓 School Fees Planner</h2><p>Save for each child's term fees</p></div>

      <div class="grid-2">
        <div class="stat highlight">
          <div class="stat-label">Total Needed</div>
          <div class="stat-value">MWK ${fmt(totalNeeded)}</div>
          <div class="stat-sub">${active.length} pending plan${active.length!==1?"s":""}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Total Saved</div>
          <div class="stat-value">MWK ${fmt(totalSaved)}</div>
          <div class="stat-sub">${totalNeeded > 0 ? Math.round((totalSaved/totalNeeded)*100) : 0}% ready</div>
        </div>
      </div>

      <div style="margin-bottom:16px">
        <button class="btn btn-primary" id="btn-add-fees">+ Add Plan</button>
      </div>

      ${active.length === 0 && completed.length === 0 ? `
        <div class="card"><div class="empty-state"><div class="icon">🎓</div>
          <p>No fees plans yet. Add one to start saving.</p>
          <button class="btn btn-primary btn-sm" id="btn-add-fees-empty">Add Plan</button>
        </div></div>
      ` : ""}

      ${active.map(p => {
        const pct = p.termAmount > 0 ? Math.min(100, Math.round(((p.saved||0)/p.termAmount)*100)) : 0;
        const daysLeft = p.dueDate ? Math.ceil((new Date(p.dueDate)-new Date())/(1000*60*60*24)) : null;
        return `
          <div class="goal-card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
              <div>
                <div style="font-size:28px;margin-bottom:4px">${p.emoji}</div>
                <div class="goal-name">${escapeHTML(p.childName)}</div>
                <div class="goal-target">${escapeHTML(p.school||"")} · ${escapeHTML(p.term)}</div>
              </div>
              <div style="text-align:right">
                ${daysLeft !== null ? `<span class="goal-badge ${daysLeft < 14 ? "badge-active" : "badge-flex"}">${daysLeft < 0 ? "OVERDUE" : `${daysLeft}d left`}</span>` : ""}
                <div style="font-size:11px;color:var(--muted);margin-top:4px">Due: ${p.dueDate||"—"}</div>
              </div>
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            <div class="goal-stats"><span>MWK ${fmt(p.saved||0)} saved</span><strong>${pct}%</strong></div>
            <div style="margin-top:10px;font-size:13px;color:var(--muted)">Target: MWK ${fmt(p.termAmount)}</div>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn btn-primary btn-sm" data-save-fees="${p.id}" data-name="${escapeHTML(p.childName)}">+ Add Savings</button>
              <button class="btn btn-outline btn-sm" data-del-fees="${p.id}">Delete</button>
            </div>
          </div>`;
      }).join("")}

      ${completed.length > 0 ? `
        <div class="card" style="margin-top:8px">
          <div class="card-header"><div class="card-title">✅ Completed Plans</div></div>
          ${completed.map(p => `
            <div class="tx-row">
              <div class="tx-left"><div class="tx-icon savings">${p.emoji}</div>
                <div><div class="tx-name">${escapeHTML(p.childName)} — ${escapeHTML(p.term)}</div>
                <div class="tx-date">MWK ${fmt(p.termAmount)} · ${p.dueDate||""}</div></div>
              </div>
              <span class="goal-badge badge-completed">✅ Done</span>
            </div>`).join("")}
        </div>` : ""}
    </div>
  `;

  document.getElementById("btn-add-fees")?.addEventListener("click", () => openAddFeesPlanModal());
  document.getElementById("btn-add-fees-empty")?.addEventListener("click", () => openAddFeesPlanModal());

  main.querySelectorAll("[data-save-fees]").forEach(btn => {
    btn.addEventListener("click", () => openFeesSaveModal(btn.dataset.saveFees, btn.dataset.name));
  });
  main.querySelectorAll("[data-del-fees]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this fees plan?")) return;
      await api.delete(`/api/fees/plans/${btn.dataset.delFees}`).catch(() => {});
      toast("Deleted"); navigate("fees");
    });
  });
}

function openAddFeesPlanModal() {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>New School Fees Plan</h3>
      <p class="modal-sub">Track savings for a child's term fees</p>
      <div class="input-group"><label class="input-label">Child's Name</label>
        <input class="input" id="fees-child" placeholder="e.g. Chisomo"></div>
      <div class="input-group"><label class="input-label">School</label>
        <input class="input" id="fees-school" placeholder="e.g. Kamuzu Academy"></div>
      <div class="input-group"><label class="input-label">Term</label>
        <select class="input" id="fees-term">
          <option>Term 1</option><option>Term 2</option><option>Term 3</option>
        </select></div>
      <div class="input-group"><label class="input-label">Term Fees Amount (MWK)</label>
        <input class="input" id="fees-amount" type="number" placeholder="e.g. 150000"></div>
      <div class="input-group"><label class="input-label">Due Date</label>
        <input class="input" id="fees-due" type="date"></div>
      <div id="fees-error" class="auth-error" style="display:none"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="fees-cancel">Cancel</button>
        <button class="btn btn-primary" id="fees-save">Add Plan</button>
      </div>
    </div>`;
  root.classList.add("open");
  root.querySelector("#fees-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });
  root.querySelector("#fees-save").onclick = async () => {
    const childName = document.getElementById("fees-child").value.trim();
    const school = document.getElementById("fees-school").value.trim();
    const term = document.getElementById("fees-term").value;
    const termAmount = document.getElementById("fees-amount").value;
    const dueDate = document.getElementById("fees-due").value;
    const errBox = document.getElementById("fees-error");
    const btn = root.querySelector("#fees-save");
    if (!childName || !termAmount || !dueDate) return showModalError(errBox, "Fill all required fields");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.post("/api/fees/plans", { uid: state.user.uid, childName, school, term, termAmount, dueDate, emoji: "🎓" });
      closeModal(); toast("Plan added!"); navigate("fees");
    } catch (e) { showModalError(errBox, e.data?.error || e.message); btn.disabled = false; btn.textContent = "Add Plan"; }
  };
}

function openFeesSaveModal(planId, childName) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>Add Savings</h3>
      <p class="modal-sub">Add savings toward <strong>${escapeHTML(childName)}</strong>'s fees</p>
      <div class="input-group"><label class="input-label">Amount (MWK)</label>
        <input class="input" id="fees-save-amount" type="number" placeholder="e.g. 20000"></div>
      <div id="fees-save-error" class="auth-error" style="display:none"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="fsa-cancel">Cancel</button>
        <button class="btn btn-primary" id="fsa-save">Save</button>
      </div>
    </div>`;
  root.classList.add("open");
  root.querySelector("#fsa-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });
  root.querySelector("#fsa-save").onclick = async () => {
    const amount = document.getElementById("fees-save-amount").value;
    const errBox = document.getElementById("fees-save-error");
    const btn = root.querySelector("#fsa-save");
    if (!amount || parseFloat(amount) < 1) return showModalError(errBox, "Enter a valid amount");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.post(`/api/fees/plans/${planId}/save`, { amount });
      closeModal(); toast("Savings added!"); navigate("fees");
    } catch (e) { showModalError(errBox, e.data?.error || e.message); btn.disabled = false; btn.textContent = "Save"; }
  };
}

// ============================================================
// LOAN TRACKER
// ============================================================
async function renderLoansPage(main) {
  const res = await api.get("/api/loans");
  const loans = res.loans || [];
  const lent = loans.filter(l => l.type === "lent");
  const borrowed = loans.filter(l => l.type === "borrowed");
  const totalLent = lent.reduce((s, l) => s + (l.remaining||0), 0);
  const totalBorrowed = borrowed.reduce((s, l) => s + (l.remaining||0), 0);

  main.innerHTML = `
    <div class="page active">
      <div class="page-header"><h2>🤝 Loan Tracker</h2><p>Track money you've lent and borrowed</p></div>

      <div class="grid-2">
        <div class="stat" style="border-color:rgba(0,229,160,0.2)">
          <div class="stat-label">💚 People Owe You</div>
          <div class="stat-value" style="color:var(--green)">MWK ${fmt(totalLent)}</div>
          <div class="stat-sub">${lent.length} loan${lent.length!==1?"s":""}</div>
        </div>
        <div class="stat" style="border-color:rgba(244,63,94,0.2)">
          <div class="stat-label">❤️ You Owe</div>
          <div class="stat-value" style="color:var(--red)">MWK ${fmt(totalBorrowed)}</div>
          <div class="stat-sub">${borrowed.length} loan${borrowed.length!==1?"s":""}</div>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button class="btn btn-primary" id="btn-lent">+ I Lent Money</button>
        <button class="btn btn-outline" id="btn-borrowed">+ I Borrowed</button>
      </div>

      ${loans.length === 0 ? `<div class="card"><div class="empty-state"><div class="icon">🤝</div>
        <p>No loans tracked yet</p></div></div>` : ""}

      ${lent.length > 0 ? `
        <div class="card">
          <div class="card-header"><div class="card-title">💚 Money I Lent</div></div>
          ${lent.map(l => loanCard(l)).join("")}
        </div>` : ""}

      ${borrowed.length > 0 ? `
        <div class="card">
          <div class="card-header"><div class="card-title">❤️ Money I Owe</div></div>
          ${borrowed.map(l => loanCard(l)).join("")}
        </div>` : ""}
    </div>
  `;

  document.getElementById("btn-lent").onclick = () => openAddLoanModal("lent");
  document.getElementById("btn-borrowed").onclick = () => openAddLoanModal("borrowed");
  main.querySelectorAll("[data-repay]").forEach(btn => {
    btn.addEventListener("click", () => openRepayModal(btn.dataset.repay, btn.dataset.name, btn.dataset.remaining));
  });
  main.querySelectorAll("[data-del-loan]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this loan record?")) return;
      await api.delete(`/api/loans/${btn.dataset.delLoan}`).catch(() => {});
      toast("Deleted"); navigate("loans");
    });
  });
}

function loanCard(l) {
  const pct = l.amount > 0 ? Math.round(((l.amount - l.remaining) / l.amount) * 100) : 0;
  const isOverdue = l.dueDate && new Date(l.dueDate) < new Date() && !l.settled;
  return `
    <div style="padding:14px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <div style="font-weight:700;font-size:14px">${escapeHTML(l.personName)}</div>
          <div style="font-size:12px;color:var(--muted)">${l.personPhone || ""} ${l.note ? "· " + escapeHTML(l.note) : ""}</div>
          ${l.dueDate ? `<div style="font-size:11px;color:${isOverdue?"var(--red)":"var(--muted)"}">${isOverdue?"⚠ OVERDUE":"Due"}: ${l.dueDate}</div>` : ""}
        </div>
        <div style="text-align:right">
          <div style="font-weight:700;font-size:15px">MWK ${fmt(l.remaining)}</div>
          <div style="font-size:11px;color:var(--muted)">of MWK ${fmt(l.amount)}</div>
        </div>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        ${!l.settled ? `<button class="btn btn-primary btn-sm" data-repay="${l.id}" data-name="${escapeHTML(l.personName)}" data-remaining="${l.remaining}">Record Payment</button>` : `<span class="goal-badge badge-completed">✅ Settled</span>`}
        <button class="btn btn-outline btn-sm" data-del-loan="${l.id}">Delete</button>
      </div>
    </div>`;
}

function openAddLoanModal(type) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>${type === "lent" ? "💚 I Lent Money" : "❤️ I Borrowed Money"}</h3>
      <p class="modal-sub">${type === "lent" ? "Record money you gave to someone" : "Record money you received from someone"}</p>
      <div class="input-group"><label class="input-label">${type === "lent" ? "Borrower" : "Lender"} Name</label>
        <input class="input" id="loan-person" placeholder="Person's name"></div>
      <div class="input-group"><label class="input-label">Phone (optional)</label>
        <input class="input" id="loan-phone" type="tel" placeholder="0991234567"></div>
      <div class="input-group"><label class="input-label">Amount (MWK)</label>
        <input class="input" id="loan-amount" type="number" placeholder="e.g. 10000"></div>
      <div class="input-group"><label class="input-label">Note (optional)</label>
        <input class="input" id="loan-note" placeholder="e.g. For groceries"></div>
      <div class="input-group"><label class="input-label">Due Date (optional)</label>
        <input class="input" id="loan-due" type="date"></div>
      <div id="loan-error" class="auth-error" style="display:none"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="loan-cancel">Cancel</button>
        <button class="btn btn-primary" id="loan-save">${type === "lent" ? "Record Loan" : "Record Debt"}</button>
      </div>
    </div>`;
  root.classList.add("open");
  root.querySelector("#loan-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });
  root.querySelector("#loan-save").onclick = async () => {
    const personName = document.getElementById("loan-person").value.trim();
    const personPhone = document.getElementById("loan-phone").value.trim();
    const amount = document.getElementById("loan-amount").value;
    const note = document.getElementById("loan-note").value.trim();
    const dueDate = document.getElementById("loan-due").value;
    const errBox = document.getElementById("loan-error");
    const btn = root.querySelector("#loan-save");
    if (!personName || !amount) return showModalError(errBox, "Name and amount required");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.post("/api/loans", { uid: state.user.uid, type, personName, personPhone, amount, note, dueDate: dueDate || null });
      closeModal(); toast("Loan recorded!"); navigate("loans");
    } catch (e) { showModalError(errBox, e.data?.error || e.message); btn.disabled = false; btn.textContent = type === "lent" ? "Record Loan" : "Record Debt"; }
  };
}

function openRepayModal(loanId, name, remaining) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>Record Payment</h3>
      <p class="modal-sub">Payment from/to <strong>${escapeHTML(name)}</strong> · MWK ${fmt(remaining)} remaining</p>
      <div class="input-group"><label class="input-label">Amount Paid (MWK)</label>
        <input class="input" id="repay-amount" type="number" placeholder="Amount" max="${remaining}" value="${remaining}"></div>
      <div id="repay-error" class="auth-error" style="display:none"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="repay-cancel">Cancel</button>
        <button class="btn btn-primary" id="repay-save">Record</button>
      </div>
    </div>`;
  root.classList.add("open");
  root.querySelector("#repay-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });
  root.querySelector("#repay-save").onclick = async () => {
    const amount = document.getElementById("repay-amount").value;
    const errBox = document.getElementById("repay-error");
    const btn = root.querySelector("#repay-save");
    if (!amount || parseFloat(amount) <= 0) return showModalError(errBox, "Enter a valid amount");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.post(`/api/loans/${loanId}/repay`, { amount });
      closeModal(); toast(res.settled ? "✅ Loan fully settled!" : "Payment recorded"); navigate("loans");
    } catch (e) { showModalError(errBox, e.data?.error || e.message); btn.disabled = false; btn.textContent = "Record"; }
  };
}

// ============================================================
// BILL SPLITTER
// ============================================================
async function renderSplitPage(main) {
  const res = await api.get("/api/split/groups");
  const groups = res.groups || [];
  const open = groups.filter(g => !g.settled);
  const done = groups.filter(g => g.settled);

  main.innerHTML = `
    <div class="page active">
      <div class="page-header"><h2>🧾 Bill Splitter</h2><p>Split bills equally among friends & family</p></div>

      <div style="margin-bottom:16px">
        <button class="btn btn-primary" id="btn-new-split">+ Split a Bill</button>
      </div>

      ${groups.length === 0 ? `<div class="card"><div class="empty-state"><div class="icon">🧾</div>
        <p>No split bills yet. Start one!</p>
        <button class="btn btn-primary btn-sm" id="btn-new-split-empty">Split a Bill</button>
      </div></div>` : ""}

      ${open.map(g => splitCard(g)).join("")}

      ${done.length > 0 ? `
        <div class="card">
          <div class="card-header"><div class="card-title">✅ Settled Bills</div></div>
          ${done.map(g => `
            <div class="tx-row">
              <div class="tx-left"><div class="tx-icon savings">${g.emoji}</div>
                <div><div class="tx-name">${escapeHTML(g.name)}</div>
                <div class="tx-date">MWK ${fmt(g.perPerson)}/person · ${g.participants?.length} people</div></div>
              </div>
              <span class="goal-badge badge-completed">✅ Done</span>
            </div>`).join("")}
        </div>` : ""}
    </div>
  `;

  document.getElementById("btn-new-split")?.addEventListener("click", () => openNewSplitModal());
  document.getElementById("btn-new-split-empty")?.addEventListener("click", () => openNewSplitModal());
  main.querySelectorAll("[data-mark-paid]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await api.post(`/api/split/groups/${btn.dataset.groupId}/mark-paid`, { participantIndex: parseInt(btn.dataset.idx) });
      toast("Marked as paid"); navigate("split");
    });
  });
  main.querySelectorAll("[data-request-pay]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
      try {
        const res = await api.post(`/api/split/groups/${btn.dataset.groupId}/request-payment`, { participantIndex: parseInt(btn.dataset.idx) });
        toast(res.message || "Request sent");
      } catch (e) { toast(e.data?.error || e.message, "error"); }
      btn.disabled = false; btn.textContent = "Request";
    });
  });
  main.querySelectorAll("[data-del-split]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this split?")) return;
      await api.delete(`/api/split/groups/${btn.dataset.delSplit}`).catch(() => {});
      toast("Deleted"); navigate("split");
    });
  });
}

function splitCard(g) {
  const paidCount = g.participants?.filter(p => p.paid).length || 0;
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${g.emoji} ${escapeHTML(g.name)}</div>
          <div style="font-size:12px;color:var(--muted)">MWK ${fmt(g.totalAmount)} total · MWK ${fmt(g.perPerson)}/person · ${paidCount}/${g.participants?.length} paid</div>
        </div>
        <button class="btn btn-outline btn-sm" data-del-split="${g.id}">Delete</button>
      </div>
      <div style="padding:4px 0">
        ${(g.participants || []).map((p, i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:10px">
              <div class="avatar" style="width:28px;height:28px;font-size:11px">${p.name[0]?.toUpperCase()}</div>
              <div>
                <div style="font-size:13px;font-weight:600">${escapeHTML(p.name)}</div>
                ${p.phone ? `<div style="font-size:11px;color:var(--muted)">${escapeHTML(p.phone)}</div>` : ""}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              ${p.paid ? `<span class="goal-badge badge-completed">✅ Paid</span>` : `
                ${p.phone ? `<button class="btn btn-outline btn-sm" data-request-pay data-group-id="${g.id}" data-idx="${i}">Request</button>` : ""}
                <button class="btn btn-primary btn-sm" data-mark-paid data-group-id="${g.id}" data-idx="${i}">Mark Paid</button>
              `}
            </div>
          </div>`).join("")}
      </div>
    </div>`;
}

function openNewSplitModal() {
  const root = document.getElementById("modal-root");
  let participants = [{ name: "", phone: "" }];

  function renderParticipants() {
    const container = document.getElementById("participants-list");
    if (!container) return;
    container.innerHTML = participants.map((p, i) => `
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input class="input" placeholder="Name" value="${escapeHTML(p.name)}" data-p-name="${i}" style="flex:2">
        <input class="input" placeholder="Phone (opt)" value="${escapeHTML(p.phone)}" data-p-phone="${i}" type="tel" style="flex:2">
        ${i > 0 ? `<button type="button" class="btn btn-outline btn-sm" data-remove-p="${i}" style="flex:0 0 auto">✕</button>` : ""}
      </div>`).join("");

    container.querySelectorAll("[data-p-name]").forEach(inp => {
      inp.oninput = e => participants[parseInt(inp.dataset.pName)].name = e.target.value;
    });
    container.querySelectorAll("[data-p-phone]").forEach(inp => {
      inp.oninput = e => participants[parseInt(inp.dataset.pPhone)].phone = e.target.value;
    });
    container.querySelectorAll("[data-remove-p]").forEach(btn => {
      btn.onclick = () => { participants.splice(parseInt(btn.dataset.removeP), 1); renderParticipants(); };
    });
  }

  root.innerHTML = `
    <div class="modal">
      <h3>🧾 Split a Bill</h3>
      <p class="modal-sub">Split equally among everyone listed</p>
      <div class="input-group"><label class="input-label">Bill name</label>
        <input class="input" id="split-name" placeholder="e.g. Restaurant dinner"></div>
      <div class="input-group"><label class="input-label">Total amount (MWK)</label>
        <input class="input" id="split-total" type="number" placeholder="e.g. 45000"></div>
      <div class="input-group">
        <label class="input-label">Participants</label>
        <div id="participants-list"></div>
        <button type="button" class="btn btn-outline btn-sm" id="add-participant" style="margin-top:4px">+ Add Person</button>
      </div>
      <div id="split-preview" style="font-size:13px;color:var(--green);margin-bottom:12px"></div>
      <div id="split-error" class="auth-error" style="display:none"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="split-cancel">Cancel</button>
        <button class="btn btn-primary" id="split-save">Create Split</button>
      </div>
    </div>`;
  root.classList.add("open");
  renderParticipants();

  root.querySelector("#split-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelector("#add-participant").onclick = () => {
    participants.push({ name: "", phone: "" }); renderParticipants();
  };

  root.querySelector("#split-total").addEventListener("input", e => {
    const total = parseFloat(e.target.value) || 0;
    const per = participants.length > 0 ? Math.ceil(total / participants.length) : 0;
    const preview = document.getElementById("split-preview");
    if (per > 0) preview.textContent = `MWK ${fmt(per)} per person`;
  });

  root.querySelector("#split-save").onclick = async () => {
    const name = document.getElementById("split-name").value.trim();
    const totalAmount = document.getElementById("split-total").value;
    const errBox = document.getElementById("split-error");
    const btn = root.querySelector("#split-save");
    const validParts = participants.filter(p => p.name.trim());
    if (!name || !totalAmount) return showModalError(errBox, "Bill name and amount required");
    if (validParts.length < 2) return showModalError(errBox, "Add at least 2 participants");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.post("/api/split/groups", { uid: state.user.uid, name, emoji: "🧾", totalAmount, participants: validParts });
      closeModal(); toast("Bill split created!"); navigate("split");
    } catch (e) { showModalError(errBox, e.data?.error || e.message); btn.disabled = false; btn.textContent = "Create Split"; }
  };
}

// ============================================================
// MERCHANT POS
// ============================================================
async function renderPOSPage(main) {
  const [productsRes, salesRes] = await Promise.all([
    api.get("/api/pos/products"),
    api.get("/api/pos/sales?limit=10")
  ]);
  const products = productsRes.products || [];
  const sales = salesRes.sales || [];
  const monthRevenue = salesRes.totalRevenue || 0;

  // Cart state
  if (!window._posCart) window._posCart = [];
  const cart = window._posCart;
  const cartTotal = cart.reduce((s, i) => s + i.unitPrice * i.qty, 0);

  main.innerHTML = `
    <div class="page active">
      <div class="page-header"><h2>🏪 Point of Sale</h2><p>Accept payments from customers via Airtel Money or cash</p></div>

      <div class="grid-4">
        <div class="stat highlight"><div class="stat-label">Month Revenue</div><div class="stat-value">MWK ${fmt(monthRevenue)}</div></div>
        <div class="stat"><div class="stat-label">Total Sales</div><div class="stat-value">${sales.length}</div></div>
        <div class="stat"><div class="stat-label">Products</div><div class="stat-value">${products.length}</div></div>
        <div class="stat"><div class="stat-label">Cart</div><div class="stat-value">${cart.length} items</div></div>
      </div>

      <div class="grid-2">
        <!-- PRODUCTS GRID -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">Products</div>
            <span class="card-action" id="btn-add-product">+ Add</span>
          </div>
          ${products.length === 0 ? `
            <div class="empty-state"><div class="icon">📦</div><p>Add products to start selling</p>
            <button class="btn btn-primary btn-sm" id="btn-add-product-empty">Add Product</button></div>
          ` : `
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:4px 0">
              ${products.map(p => `
                <div class="product-tile" data-product="${JSON.stringify({id:p.id,name:p.name,emoji:p.emoji,price:p.price}).replace(/"/g,"&quot;")}">
                  <div class="product-emoji">${p.emoji}</div>
                  <div class="product-name">${escapeHTML(p.name)}</div>
                  <div class="product-price">MWK ${fmt(p.price)}</div>
                  ${p.stock !== null ? `<div class="product-stock">${p.stock} left</div>` : ""}
                </div>`).join("")}
            </div>`}
        </div>

        <!-- CART -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">🛒 Cart</div>
            ${cart.length > 0 ? `<span class="card-action" id="btn-clear-cart">Clear</span>` : ""}
          </div>
          ${cart.length === 0 ? `
            <div class="empty-state"><div class="icon">🛒</div><p>Tap products to add them</p></div>
          ` : `
            <div style="padding:4px 0">
              ${cart.map((item, i) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
                  <div>
                    <div style="font-size:14px;font-weight:600">${item.emoji} ${escapeHTML(item.name)}</div>
                    <div style="font-size:12px;color:var(--muted)">MWK ${fmt(item.unitPrice)} × ${item.qty}</div>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px">
                    <div style="font-weight:700">MWK ${fmt(item.unitPrice * item.qty)}</div>
                    <button class="btn btn-outline btn-sm" data-cart-remove="${i}">✕</button>
                  </div>
                </div>`).join("")}
              <div style="padding:12px 0;border-top:1px solid var(--border);font-family:Syne,sans-serif;font-size:18px;font-weight:800;display:flex;justify-content:space-between">
                <span>Total</span><span style="color:var(--green)">MWK ${fmt(cartTotal)}</span>
              </div>
            </div>
            <div class="input-group" style="margin-top:4px">
              <label class="input-label">Customer phone (for Airtel payment)</label>
              <input class="input" id="pos-phone" type="tel" placeholder="0991234567 (optional for cash)">
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-outline" id="btn-cash-sale" style="flex:1">💵 Cash</button>
              <button class="btn btn-primary" id="btn-airtel-sale" style="flex:2">📱 Airtel Money</button>
            </div>
          `}
        </div>
      </div>

      <!-- RECENT SALES -->
      <div class="card">
        <div class="card-header"><div class="card-title">Recent Sales</div></div>
        ${sales.length === 0 ? `<div class="empty-state"><p>No sales yet</p></div>` :
          sales.map(s => `
            <div class="tx-row">
              <div class="tx-left">
                <div class="tx-icon savings">🧾</div>
                <div>
                  <div class="tx-name">${s.items?.map(i => `${i.productName||""} ×${i.qty}`).join(", ") || "Sale"}</div>
                  <div class="tx-date">${formatDate(s.createdAt)} · ${s.paymentMethod}</div>
                </div>
              </div>
              <div style="text-align:right">
                <div class="tx-amount pos">MWK ${fmt(s.total)}</div>
                <div class="tx-status ${s.status}">${statusLabel(s.status)}</div>
              </div>
            </div>`).join("")}
      </div>
    </div>
  `;

  document.getElementById("btn-add-product")?.addEventListener("click", () => openAddProductModal());
  document.getElementById("btn-add-product-empty")?.addEventListener("click", () => openAddProductModal());
  document.getElementById("btn-clear-cart")?.addEventListener("click", () => { window._posCart = []; navigate("pos"); });

  // Add to cart
  main.querySelectorAll(".product-tile").forEach(tile => {
    tile.addEventListener("click", () => {
      const p = JSON.parse(tile.dataset.product.replace(/&quot;/g, '"'));
      const existing = window._posCart.find(i => i.id === p.id);
      if (existing) existing.qty++;
      else window._posCart.push({ id: p.id, name: p.name, emoji: p.emoji, unitPrice: p.price, qty: 1 });
      navigate("pos");
    });
  });

  // Remove from cart
  main.querySelectorAll("[data-cart-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      window._posCart.splice(parseInt(btn.dataset.cartRemove), 1);
      navigate("pos");
    });
  });

  async function processSale(paymentMethod) {
    const cart = window._posCart;
    if (!cart.length) return toast("Add products first", "error");
    const phone = document.getElementById("pos-phone")?.value?.trim();
    if (paymentMethod === "airtel" && !phone) return toast("Enter customer phone for Airtel payment", "error");

    const btn = document.getElementById(paymentMethod === "cash" ? "btn-cash-sale" : "btn-airtel-sale");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.post("/api/pos/sales", {
        uid: state.user.uid,
        items: cart.map(i => ({ productId: i.id, productName: i.name, qty: i.qty, unitPrice: i.unitPrice })),
        customerPhone: phone || null, paymentMethod,
        total: cart.reduce((s, i) => s + i.unitPrice * i.qty, 0)
      });
      window._posCart = [];
      toast(res.status === "completed" || res.status === "mock" ? `✅ Sale of MWK ${fmt(res.total)} recorded!` : "Sale queued — awaiting Airtel confirmation");
      navigate("pos");
    } catch (e) {
      toast(e.data?.error || e.message, "error");
      btn.disabled = false; btn.textContent = paymentMethod === "cash" ? "💵 Cash" : "📱 Airtel Money";
    }
  }

  document.getElementById("btn-cash-sale")?.addEventListener("click", () => processSale("cash"));
  document.getElementById("btn-airtel-sale")?.addEventListener("click", () => processSale("airtel"));
}

function openAddProductModal() {
  const root = document.getElementById("modal-root");
  const EMOJIS = ["📦","🍔","🥤","👗","💊","📱","🛠️","🎮","🍞","🧴","🎁","🖨️"];
  let selectedEmoji = EMOJIS[0];
  root.innerHTML = `
    <div class="modal">
      <h3>Add Product</h3>
      <p class="modal-sub">Add to your POS product catalog</p>
      <div class="input-group"><label class="input-label">Icon</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${EMOJIS.map((e,i)=>`<button type="button" class="btn btn-outline btn-sm emoji-btn" data-emoji="${e}" style="font-size:18px;padding:8px;${i===0?"border-color:var(--green)":""}">${e}</button>`).join("")}
        </div>
      </div>
      <div class="input-group"><label class="input-label">Product Name</label>
        <input class="input" id="prod-name" placeholder="e.g. Coca Cola 500ml"></div>
      <div class="input-group"><label class="input-label">Price (MWK)</label>
        <input class="input" id="prod-price" type="number" placeholder="e.g. 500"></div>
      <div class="input-group"><label class="input-label">Category</label>
        <input class="input" id="prod-cat" placeholder="e.g. Drinks"></div>
      <div class="input-group"><label class="input-label">Stock (leave blank for unlimited)</label>
        <input class="input" id="prod-stock" type="number" placeholder="e.g. 50"></div>
      <div id="prod-error" class="auth-error" style="display:none"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="prod-cancel">Cancel</button>
        <button class="btn btn-primary" id="prod-save">Add Product</button>
      </div>
    </div>`;
  root.classList.add("open");
  root.querySelector("#prod-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });
  root.querySelectorAll(".emoji-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      root.querySelectorAll(".emoji-btn").forEach(b => b.style.borderColor = "var(--border)");
      btn.style.borderColor = "var(--green)"; selectedEmoji = btn.dataset.emoji;
    });
  });
  root.querySelector("#prod-save").onclick = async () => {
    const name = document.getElementById("prod-name").value.trim();
    const price = document.getElementById("prod-price").value;
    const category = document.getElementById("prod-cat").value.trim();
    const stock = document.getElementById("prod-stock").value;
    const errBox = document.getElementById("prod-error");
    const btn = root.querySelector("#prod-save");
    if (!name || !price) return showModalError(errBox, "Name and price required");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.post("/api/pos/products", {
        uid: state.user.uid, name, price, emoji: selectedEmoji,
        category: category || "General", stock: stock ? parseInt(stock) : null
      });
      closeModal(); toast("Product added!"); navigate("pos");
    } catch (e) { showModalError(errBox, e.data?.error || e.message); btn.disabled = false; btn.textContent = "Add Product"; }
  };
}
