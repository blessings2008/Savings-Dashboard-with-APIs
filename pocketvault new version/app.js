// PocketVault app entry point.
import { renderLogin, watchAuth } from "./auth.js";
import { api } from "./api.js";
import { getDeviceFingerprint } from "./js/core/fingerprint.js";
import { renderEmailOtp } from "./js/core/email-otp.js";
import { state } from "./js/core/state.js";
import { renderShell } from "./js/shell.js";

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
  if (page !== "help") stopHelpPolling();
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
    const renderNames = { dashboard: "renderDashboardPage", goals: "renderGoalsPage", autosave: "renderAutosavePage", transactions: "renderTransactionsPage", analytics: "renderAnalyticsPage", ai: "renderAIPage", notifications: "renderNotificationsPage", merchant: "renderMerchantPage", premium: "renderPremiumPage", help: "renderHelpPage", account: "renderAccountPage" };\n    const render = module[renderNames[page]];
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
  renderShell(user, navigate);
  // Dashboard loads the profile together with its other data. Do not fetch it
  // a second time here; the duplicate request made sign-in noticeably slower.
  api.post("/api/profile", { uid: user.uid, deviceFingerprint: getDeviceFingerprint() }).catch(() => {});
  navigate("dashboard");
}

watchAuth(async user => {
  try {
    const status = await api.get("/api/auth/email-otp/status");
    if (!status.verified) {
      renderEmailOtp(user, enterVerifiedSession);
      return;
    }
    await enterVerifiedSession(user);
  } catch (error) {
    console.error("Email verification check failed:", error);
    renderEmailOtp(user, enterVerifiedSession);
  }
}, () => { state.user = null; renderLogin(); });
