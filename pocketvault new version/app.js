// PocketVault app entry point.
import { renderLogin, watchAuth } from "./auth.js";
import { api } from "./api.js";
import { state } from "./js/core/state.js";

// Page modules are loaded on demand. This keeps one broken/unsupported page
// from preventing the entire user app from booting.
const PAGE_LOADERS = {
  dashboard: () => import("./js/pages/dashboard.js"),
  goals: () => import("./js/pages/goals.js"),
  autosave: () => import("./js/pages/autosave.js"),
  transactions: () => import("./js/pages/transactions.js"),
  analytics: () => import("./js/pages/analytics.js"),
  ai: () => import("./js/pages/ai.js"),
  notifications: () => import("./js/pages/notifications.js"),
  merchant: () => import("./js/pages/merchant.js"),
  premium: () => import("./js/pages/premium.js"),
  help: () => import("./js/pages/help.js"),
  account: () => import("./js/pages/account.js")
};

function setActiveNav(page) { document.querySelectorAll("[data-page]").forEach(el => el.classList.toggle("active", el.dataset.page === page)); }

async function navigate(page) {
  // Help owns its polling lifecycle. Stop it only when leaving Help.
  if (page !== "help" && state.currentPage === "help") {
    try {
      const helpModule = await import("./js/pages/help.js");
      helpModule.stopHelpPolling();
    } catch (error) {
      console.warn("Could not stop Help polling:", error);
    }
  }
  state.currentPage = page; setActiveNav(page);
  const main = document.getElementById("main-content");
  main.innerHTML = `<div class="page-skeleton"><div class="skel-stat-grid"><div class="skel skel-stat-box"></div><div class="skel skel-stat-box"></div><div class="skel skel-stat-box"></div><div class="skel skel-stat-box"></div></div><div class="skel skel-list-item"></div><div class="skel skel-list-item"></div></div>`;
  try {
    const loader = PAGE_LOADERS[page];
    if (!loader) {
      main.innerHTML = `<div class="empty-state"><p>Page not found</p></div>`;
      return;
    }
    const module = await loader();
    const renderNames = { dashboard: "renderDashboardPage", goals: "renderGoalsPage", autosave: "renderAutosavePage", transactions: "renderTransactionsPage", analytics: "renderAnalyticsPage", ai: "renderAIPage", notifications: "renderNotificationsPage", merchant: "renderMerchantPage", premium: "renderPremiumPage", help: "renderHelpPage", account: "renderAccountPage" };
    const render = module[renderNames[page]];
    if (typeof render !== "function") {
      throw new Error(`The ${page} page could not be loaded.`);
    }
    await render(main, navigate);
  } catch (err) {
    console.error(err);
    main.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${err.message || "Something went wrong"}</p><button class="btn btn-outline" onclick="location.reload()">Reload</button></div>`;
  }
}

async function enterVerifiedSession(user) {
  state.user = user;
  const [{ renderShell }, { getDeviceFingerprint }] = await Promise.all([
    import("./js/shell.js"),
    import("./js/core/fingerprint.js")
  ]);
  renderShell(user, navigate);
  api.post("/api/profile", { uid: user.uid, deviceFingerprint: getDeviceFingerprint() }).catch(() => {});
  navigate("dashboard");
}

// Render the sign-in UI immediately. Do not leave the boot skeleton waiting
// for Firebase/network state.
renderLogin();

watchAuth(async user => {
  try {
    if (!user.emailVerified) {
      const { renderEmailOtp } = await import("./js/core/email-otp.js");
      renderEmailOtp(user, enterVerifiedSession);
      return;
    }
    await enterVerifiedSession(user);
  } catch (error) {
    console.error("Session startup failed:", error);
    renderLogin();
  }
}, () => {
  state.user = null;
  renderLogin();
});
