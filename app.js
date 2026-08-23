// PocketVault app entry point.
//
// This file used to contain every page, modal, and helper in one
// ~2,300-line module. It's now split across js/core, js/components,
// js/services, js/pages, and js/shell.js — this file's only job is
// to wire navigation and boot the app once the user's auth state is
// known. See each imported module for the logic that used to live
// here inline.
import { auth } from "./firebase.js";
import { renderLogin, watchAuth, logOut } from "./auth.js";
import { api } from "./api.js";

import { state } from "./js/core/state.js";
import { renderShell } from "./js/shell.js";

import { renderDashboardPage } from "./js/pages/dashboard.js";
import { renderGoalsPage } from "./js/pages/goals.js";
import { renderAutosavePage } from "./js/pages/autosave.js";
import { renderTransactionsPage } from "./js/pages/transactions.js";
import { renderAnalyticsPage } from "./js/pages/analytics.js";
import { renderNotificationsPage } from "./js/pages/notifications.js";
import { renderMerchantPage } from "./js/pages/merchant.js";
import { renderPremiumPage } from "./js/pages/premium.js";
import { renderAccountPage } from "./js/pages/account.js";

import { loadUserProfile } from "./js/services/profile.js";

function setActiveNav(page) {
  document.querySelectorAll("[data-page]").forEach(el => {
    el.classList.toggle("active", el.dataset.page === page);
  });
}

async function navigate(page) {
  state.currentPage = page;
  setActiveNav(page);
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="page-skeleton">
      <div class="skel-stat-grid">
        <div class="skel skel-stat-box"></div>
        <div class="skel skel-stat-box"></div>
        <div class="skel skel-stat-box"></div>
        <div class="skel skel-stat-box"></div>
      </div>
      <div class="skel skel-list-item"></div>
      <div class="skel skel-list-item"></div>
      <div class="skel skel-list-item"></div>
    </div>`;

  try {
    switch (page) {
      case "dashboard": await renderDashboardPage(main, navigate); break;
      case "goals": await renderGoalsPage(main, navigate); break;
      case "autosave": await renderAutosavePage(main, navigate); break;
      case "transactions": await renderTransactionsPage(main, navigate); break;
      case "analytics": await renderAnalyticsPage(main, navigate); break;
      case "notifications": await renderNotificationsPage(main, navigate); break;
      case "merchant": await renderMerchantPage(main, navigate); break;
      case "premium": await renderPremiumPage(main, navigate); break;
      case "account": await renderAccountPage(main, navigate); break;
      default: main.innerHTML = `<div class="empty-state"><p>Page not found</p></div>`;
    }
  } catch (err) {
    console.error(err);
    main.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${err.message || "Something went wrong"}</p>
      <button class="btn btn-outline" onclick="location.reload()">Reload</button></div>`;
  }
}

watchAuth(
  async (user) => {
    state.user = user;
    // Render shell immediately — don't wait for profile load
    renderShell(user, navigate);
    // Load profile in background (KYC status, phone)
    loadUserProfile({ api, state }).then(() => {
      // If already on dashboard, refresh to show KYC banner if needed
      if (state.currentPage === "dashboard") navigate("dashboard");
    });
    navigate("dashboard");
  },
  () => {
    state.user = null;
    renderLogin();
  }
);
