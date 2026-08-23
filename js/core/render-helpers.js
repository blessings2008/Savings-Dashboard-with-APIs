// PocketVault shared render helpers.
// These produce markup used from more than one page module, so they
// live here instead of inside any single page file:
//   - goalCardHTML   -> goals.js, and formerly dashboard's own pill
//                       markup is separate (dashboard renders a
//                       compact pill inline, not via this function)
//   - txRowHTML      -> dashboard.js (recent activity) and
//                       transactions.js (full history) and
//                       merchant.js (merchant activity list)
//   - notifHTML      -> notifications.js
//   - bindNavLinks   -> every page with a [data-nav] element
import { fmt, escapeHTML, daysUntil, formatDate, statusLabel, ICONS } from "./utils.js";

export function bindNavLinks(scope, navigate) {
  scope.querySelectorAll("[data-nav]").forEach(el => {
    el.addEventListener("click", () => navigate(el.dataset.nav));
  });
}

export function goalCardHTML(g, compact = false) {
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

  // Frozen banner takes priority over the deadline banner above — a
  // frozen goal (subscription expired while hard-locked) is a more
  // urgent state than a passed deadline. Shows a live countdown to
  // the grace-period auto-unlock so the "keep locked" choice doesn't
  // feel like a black box.
  const frozenBanner = (!compact && g.frozen && !g.completed) ? `
    <div class="frozen-goal-banner">
      <div style="font-weight:700;margin-bottom:4px">🧊 Frozen — subscription expired</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
        No new savings can be added${g.frozenGraceDeadline ? ` · auto-unlocks in ${daysUntil(g.frozenGraceDeadline)}` : ""}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" data-frozen-decision="unlock" data-goal="${g.id}">🔓 Unlock Now</button>
        <button class="btn btn-outline btn-sm" data-frozen-decision="keep_locked" data-goal="${g.id}">Keep Locked — I'll Renew</button>
      </div>
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
      ${frozenBanner}
      ${!g.frozen ? decisionBanner : ""}
      ${!compact ? `
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" data-action="allocate" data-goal="${g.id}" ${g.frozen ? "disabled title=\"Frozen — subscription expired\"" : ""}>Allocate from Balance</button>
        </div>
      ` : ""}
    </div>
  `;
}

export function txRowHTML(tx) {
  const sign = ["savings", "roundup", "subscription", "merchant_payment"].includes(tx.type) ? "neg"
    : ["withdrawal", "merchant_payment_received"].includes(tx.type) ? "pos" : "sav";
  const icon = tx.type === "merchant_payment" ? "💳" : tx.type === "merchant_payment_received" ? "🏪" : (ICONS[tx.type] || "•");
  const date = formatDate(tx.timestamp);
  const label = tx.type === "savings" ? `Save → ${tx.goalName || "Goal"}`
    : tx.type === "withdrawal" ? `Withdraw → ${tx.goalName || "Goal"}`
    : tx.type === "roundup" ? `Round-up → ${tx.goalName || "Goal"}`
    : tx.type === "subscription" ? `${tx.plan ? tx.plan.charAt(0).toUpperCase() + tx.plan.slice(1) : ""} subscription`
    : tx.type === "collection" ? `Payment from ${tx.customerPhone || "customer"}`
    : tx.type === "disbursement" ? `Paid ${tx.phone || "employee"}`
    : tx.type === "merchant_payment" ? `Paid ${tx.merchantName || "merchant"} (code ${tx.merchantCode || ""})`
    : tx.type === "merchant_payment_received" ? `Payment via merchant code`
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

const NOTIF_ICONS = {
  savings_success: "💰", withdrawal_success: "💸", goal_complete: "🎉",
  subscription_success: "✨", subscription_expired: "⏰",
  transaction_failed: "⚠️", savings_reconciled: "✅", roundup_success: "🔄"
};

export function notifHTML(n) {
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
