// PocketVault app shell — sidebar, bottom nav, and the unread
// notification badge that polls in the background once the shell
// is up. Kept separate from app.js so the entry point only wires
// things together rather than rendering markup itself.
import { api } from "../api.js";
import { NAV, sectionsOrder, sectionLabels } from "./core/navigation.js";
import { initials } from "./core/utils.js";

// ----------------------------
// UNREAD NOTIFICATION BADGE
// Was previously called from renderShell() and the KYC success flow
// but never actually defined — a silent dead reference that threw
// in the console on every page load without visibly breaking
// anything (both call sites don't await it). Fixed here properly:
// updates the small badge dot on the Alerts nav item.
// ----------------------------
export async function fetchUnreadCount() {
  try {
    const res = await api.unreadCount();
    const count = res.count || 0;
    document.querySelectorAll(".notif-nav-icon").forEach(icon => {
      const navItem = icon.closest(".nav-item");
      if (!navItem) return;
      let badge = navItem.querySelector(".notif-badge-dot");
      if (count > 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "notif-badge-dot";
          navItem.appendChild(badge);
        }
        badge.textContent = count > 9 ? "9+" : count;
      } else if (badge) {
        badge.remove();
      }
    });
  } catch {
    // Silent — this is a background badge update, not worth
    // surfacing an error for a failed poll
  }
}

export function renderShell(user, navigate) {
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
        <div class="page-skeleton">
          <div class="skel-stat-grid">
            <div class="skel skel-stat-box"></div>
            <div class="skel skel-stat-box"></div>
            <div class="skel skel-stat-box"></div>
            <div class="skel skel-stat-box"></div>
          </div>
          <div class="skel skel-list-item"></div>
          <div class="skel skel-list-item"></div>
        </div>
      </div>
    </div>

    <div class="bottom-nav">
      <div class="nav-item" data-page="dashboard"><span class="nav-icon">⬡</span>Home</div>
      <div class="nav-item" data-page="goals"><span class="nav-icon">◎</span>Goals</div>
      <div class="nav-item" data-page="transactions"><span class="nav-icon">≡</span>Activity</div>
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
