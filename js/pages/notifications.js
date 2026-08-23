// PocketVault notifications page.
import { api } from "../../api.js";
import { notifHTML } from "../core/render-helpers.js";
import { fetchUnreadCount } from "../shell.js";

export async function renderNotificationsPage(main) {
  // Mark all read and clear badge.
  //
  // PRODUCTION FIX: this previously called updateNotifBadge(0), a
  // function that was never defined anywhere in the codebase — a
  // silent dead reference (the call isn't awaited, so it threw in
  // the console without visibly breaking the page). The actual
  // function that updates the badge is fetchUnreadCount() in
  // shell.js; calling it here re-polls the real unread count
  // (which is now 0 after read-all) instead of pretending to zero
  // it out locally.
  try {
    await api.post("/api/notifications/read-all", {});
    fetchUnreadCount();
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
