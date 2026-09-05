// PocketVault app shell — sidebar, bottom nav, and the unread
// notification badge that polls in the background once the shell
// is up. Kept separate from app.js so the entry point only wires
// things together rather than rendering markup itself.
import { api } from "../api.js";
import { NAV, sectionsOrder, sectionLabels } from "./core/navigation.js";
import { initials } from "./core/utils.js";

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
    // Background badge update; do not interrupt the app when it fails.
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

  const moreItems = NAV.map(item => `
    <button class="mobile-more-item" type="button" data-more-page="${item.id}">
      <span class="mobile-more-icon">${item.icon}</span>
      <span class="mobile-more-label">${item.label}</span>
      <span class="mobile-more-arrow">›</span>
    </button>
  `).join("");

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
      <div class="nav-item" data-page="dashboard"><span class="nav-icon">⬡</span><span>Home</span></div>
      <div class="nav-item" data-page="goals"><span class="nav-icon">◎</span><span>Goals</span></div>
      <div class="nav-item" data-page="transactions"><span class="nav-icon">≡</span><span>Activity</span></div>
      <div class="nav-item" data-page="notifications"><span class="nav-icon notif-nav-icon">◉</span><span>Alerts</span></div>
      <div class="nav-item mobile-more-trigger" id="mobile-more-trigger" role="button" tabindex="0" aria-label="More PocketVault features" aria-expanded="false">
        <span class="nav-icon">•••</span><span>More</span>
      </div>
    </div>

    <div class="mobile-more-overlay" id="mobile-more-overlay" aria-hidden="true">
      <div class="mobile-more-backdrop" id="mobile-more-backdrop"></div>
      <section class="mobile-more-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-more-title">
        <div class="mobile-more-handle"></div>
        <div class="mobile-more-header">
          <div>
            <h2 id="mobile-more-title">PocketVault</h2>
            <p>Everything in one place</p>
          </div>
          <button class="mobile-more-close" id="mobile-more-close" type="button" aria-label="Close menu">×</button>
        </div>
        <div class="mobile-more-list">${moreItems}
          <button class="mobile-more-item" type="button" data-more-page="account">
            <span class="mobile-more-icon">${initials(user)}</span>
            <span class="mobile-more-label">Account & Settings</span>
            <span class="mobile-more-arrow">›</span>
          </button>
        </div>
      </section>
    </div>

    <!-- MODALS -->
    <div class="modal-overlay" id="modal-root"></div>
  `;

  const closeMore = () => {
    const overlay = document.getElementById("mobile-more-overlay");
    const trigger = document.getElementById("mobile-more-trigger");
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    trigger?.setAttribute("aria-expanded", "false");
  };

  const openMore = () => {
    const overlay = document.getElementById("mobile-more-overlay");
    const trigger = document.getElementById("mobile-more-trigger");
    if (!overlay) return;
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    trigger?.setAttribute("aria-expanded", "true");
  };

  document.querySelectorAll("[data-page]").forEach(el => {
    el.addEventListener("click", () => { closeMore(); navigate(el.dataset.page); });
  });

  document.querySelectorAll("[data-more-page]").forEach(el => {
    el.addEventListener("click", () => { closeMore(); navigate(el.dataset.morePage); });
  });

  document.getElementById("user-pill").addEventListener("click", () => navigate("account"));
  document.getElementById("mobile-more-trigger")?.addEventListener("click", openMore);
  document.getElementById("mobile-more-trigger")?.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMore(); }
  });
  document.getElementById("mobile-more-close")?.addEventListener("click", closeMore);
  document.getElementById("mobile-more-backdrop")?.addEventListener("click", closeMore);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMore(); }, { once: true });

  fetchUnreadCount();
  setInterval(fetchUnreadCount, 30000);
}
