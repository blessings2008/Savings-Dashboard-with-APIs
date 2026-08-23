// PocketVault dashboard page.
import { auth } from "../../firebase.js";
import { api } from "../../api.js";
import { state } from "../core/state.js";
import { fmt, escapeHTML } from "../core/utils.js";
import { bindNavLinks, txRowHTML } from "../core/render-helpers.js";
import { loadPlan } from "../services/plan.js";
import { loadUserProfile } from "../services/profile.js";
import { toast } from "../components/toast.js";
import { openSaveModal, openWithdrawModal } from "./goals.js";
import { openPayMerchantModal, openTransferModal } from "./merchant.js";

export async function renderDashboardPage(main, navigate) {
  // PRODUCTION FIX: previously only api.balance() was guarded with
  // .catch() — if api.goals() or api.transactions() ever rejected
  // (a transient network blip, a token refresh hiccup right after
  // login), Promise.all() failed as a WHOLE, which should have shown
  // the error screen in navigate()'s try/catch... but combined with
  // fetch() having no timeout (see api.js), a genuine network hang
  // meant this promise never resolved OR rejected — it just sat
  // forever, which is the actual "loads forever" symptom. Every call
  // is now individually guarded so one flaky request degrades
  // gracefully instead of blocking the whole dashboard.
  const [, , balanceRes, goalsRes, txRes] = await Promise.all([
    loadPlan({ api, state, toast }).catch(() => null),
    loadUserProfile({ api, state }).catch(() => null),
    api.balance().catch(() => ({ balance: 0, mock: true })),
    api.goals().catch(() => ({ goals: {} })),
    api.transactions("?limit=5").catch(() => ({ transactions: [] })),
  ]);

  state.goals = goalsRes.goals || {};
  const goalsArr = Object.values(state.goals);
  const activeGoals = goalsArr.filter(g => !g.completed);
  const transactions = txRes.transactions || [];
  const totalSaved = activeGoals.reduce((s, g) => s + (g.saved || 0), 0);

  main.innerHTML = `
    <div class="page active">

      <!-- Greeting -->
      <div class="dash-greeting">
        <div>
          <div class="dash-greeting-sub">Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"},</div>
          <div class="dash-greeting-name">${(auth.currentUser.displayName || auth.currentUser.email || "there").split("@")[0]} 👋</div>
        </div>
        ${state.user?.streakCount > 0 ? `
          <div class="streak-badge" title="${state.user.streakCount} consecutive weeks with a save">
            <span class="streak-fire">🔥</span>
            <span class="streak-count">${state.user.streakCount}</span>
            <span class="streak-label">week${state.user.streakCount !== 1 ? "s" : ""}</span>
          </div>
        ` : ""}
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

      <!-- Balance Hero Card -->
      <div class="balance-hero">
        <div class="balance-label">PocketVault Balance</div>
        <div class="balance-amount">MWK <span>${fmt(state.user?.accountBalance || 0)}</span></div>
        <div class="balance-meta">Airtel wallet: MWK ${fmt(balanceRes.balance)}${balanceRes.mock ? " (mock mode)" : ""}</div>

        <!-- IMPROVEMENT 1: Action buttons embedded in balance card as icon grid -->
        <div class="balance-icon-actions">
          <button class="bal-icon-btn primary" id="btn-save-quick">
            <span class="bal-icon-btn-icon">💰</span>
            <span class="bal-icon-btn-label">Add Funds</span>
          </button>
          <button class="bal-icon-btn" id="btn-withdraw-quick">
            <span class="bal-icon-btn-icon">↑</span>
            <span class="bal-icon-btn-label">Withdraw</span>
          </button>
          <button class="bal-icon-btn muted" data-nav="autosave">
            <span class="bal-icon-btn-icon">↻</span>
            <span class="bal-icon-btn-label">Auto-Save</span>
          </button>
          <button class="bal-icon-btn muted" data-nav="analytics">
            <span class="bal-icon-btn-icon">📊</span>
            <span class="bal-icon-btn-label">Analytics</span>
          </button>
        </div>
      </div>

      <!-- Stats row (kept compact) -->
      <div class="grid-4" style="margin-top:14px">
        <div class="stat highlight">
          <div class="stat-label">Total Saved</div>
          <div class="stat-value">${fmt(totalSaved)}</div>
          <div class="stat-sub">${activeGoals.length} goal${activeGoals.length !== 1 ? "s" : ""}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Plan</div>
          <div class="stat-value" style="text-transform:capitalize">${state.plan}</div>
          <div class="stat-sub ${state.plan !== "free" ? "up" : ""}">${state.plan === "free" ? "Upgrade →" : "Active"}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Fee Rate</div>
          <div class="stat-value">${state.planConfig?.transactionFeePercent ?? 1}%</div>
          <div class="stat-sub">per transaction</div>
        </div>
        <div class="stat">
          <div class="stat-label">Goals Max</div>
          <div class="stat-value">${activeGoals.length}/${state.planConfig?.maxGoals ?? 2}</div>
          <div class="stat-sub">active</div>
        </div>
      </div>

      <!-- IMPROVEMENT 2: Quick-action icon grid -->
      <div class="quick-action-section">
        <div class="quick-action-label">Quick Actions</div>
        <div class="quick-action-grid">
          <div class="quick-action-item hl" data-nav="goals">
            <div class="quick-action-icon">🎯</div>
            <div class="quick-action-text">New Goal</div>
          </div>
          <div class="quick-action-item" data-nav="autosave">
            <div class="quick-action-icon">↻</div>
            <div class="quick-action-text">Auto-Save</div>
          </div>
          <div class="quick-action-item" data-nav="transactions">
            <div class="quick-action-icon">≡</div>
            <div class="quick-action-text">History</div>
          </div>
          <div class="quick-action-item" data-nav="premium">
            <div class="quick-action-icon">✦</div>
            <div class="quick-action-text">Upgrade</div>
          </div>
          <div class="quick-action-item" data-nav="analytics">
            <div class="quick-action-icon">◈</div>
            <div class="quick-action-text">Insights</div>
          </div>
          <div class="quick-action-item" data-nav="merchant">
            <div class="quick-action-icon">◇</div>
            <div class="quick-action-text">Merchant</div>
          </div>
          <div class="quick-action-item" id="qa-pay-merchant">
            <div class="quick-action-icon">💳</div>
            <div class="quick-action-text">Pay Merchant</div>
          </div>
          <div class="quick-action-item" id="qa-transfer">
            <div class="quick-action-icon">💸</div>
            <div class="quick-action-text">Transfer</div>
          </div>
          <div class="quick-action-item" data-nav="notifications">
            <div class="quick-action-icon">◉</div>
            <div class="quick-action-text">Alerts</div>
          </div>
          <div class="quick-action-item" data-nav="account">
            <div class="quick-action-icon">👤</div>
            <div class="quick-action-text">Account</div>
          </div>
        </div>
      </div>

      <!-- IMPROVEMENT 3: Horizontal scrollable goal pills -->
      <div class="section-row">
        <div class="section-row-title">My Goals</div>
        <div class="section-row-action" data-nav="goals">See all →</div>
      </div>
      <div class="goals-pill-scroll">
        ${activeGoals.length === 0 ? `
          <div class="goals-pill-empty">No goals yet — <span data-nav="goals" style="color:var(--green);cursor:pointer">create one</span></div>
        ` : activeGoals.slice(0, 5).map(g => {
          const pct = g.target > 0 ? Math.min(100, Math.round((g.saved / g.target) * 100)) : 0;
          return `
            <div class="goal-pill" data-nav="goals">
              <div class="goal-pill-top">
                <span style="font-size:22px">${g.emoji || "🎯"}</span>
                ${g.locked ? `<span class="goal-pill-badge locked">🔒</span>` : `<span class="goal-pill-badge flex">Flex</span>`}
              </div>
              <div class="goal-pill-name">${escapeHTML(g.name)}</div>
              <div class="goal-pill-saved">MWK ${fmt(g.saved)} saved</div>
              <div class="goal-pill-prog-bg"><div class="goal-pill-prog-fill" style="width:${pct}%"></div></div>
              <div class="goal-pill-pct">${pct}%</div>
            </div>`;
        }).join("")}
        <div class="goal-pill-add" data-nav="goals">
          <div style="font-size:24px;color:var(--green);margin-bottom:6px">+</div>
          <div style="font-size:11px;font-weight:600;color:rgba(0,229,160,0.6)">New Goal</div>
        </div>
      </div>

      <!-- Recent Transactions -->
      <div class="section-row">
        <div class="section-row-title">Recent Activity</div>
        <div class="section-row-action" data-nav="transactions">All →</div>
      </div>
      <div class="card">
        ${transactions.length === 0 ? `
          <div class="empty-state"><div class="icon">📋</div><p>No transactions yet</p></div>
        ` : transactions.map(txRowHTML).join("")}
      </div>

    </div>
  `;

  bindNavLinks(main, navigate);
  document.getElementById("kyc-banner-btn")?.addEventListener("click", () => navigate("account"));
  document.getElementById("btn-save-quick").onclick = () => openSaveModal(undefined, navigate);
  document.getElementById("btn-withdraw-quick").onclick = () => openWithdrawModal(undefined, navigate);
  document.getElementById("qa-pay-merchant")?.addEventListener("click", () => openPayMerchantModal(navigate));
  document.getElementById("qa-transfer")?.addEventListener("click", () => openTransferModal(navigate));
}
