// PocketVault shared utility functions.
export function fmt(n) {
  return Math.round(n || 0).toLocaleString();
}

export function initials(user) {
  const name = user.displayName || user.email || "U";
  return name.trim().charAt(0).toUpperCase();
}

export function daysUntil(timestampMs) {
  const diff = timestampMs - Date.now();
  if (diff <= 0) return "less than a day";
  const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
  return `${days} day${days !== 1 ? "s" : ""}`;
}

export function statusLabel(status) {
  const map = { completed: "✓ Confirmed", mock: "Mock", pending: "Pending", failed: "Failed" };
  return map[status] || status;
}

export function formatDate(ts) {
  if (!ts) return "";
  const ms = ts._seconds ? ts._seconds * 1000 : (typeof ts === "number" ? ts : Date.parse(ts));
  const d = new Date(ms);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today, ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

// Normalizes a Firestore timestamp (raw {_seconds}, a plain number,
// or an ISO string) into plain epoch milliseconds — the same
// normalization formatDate() already does internally for display,
// exposed here as a raw number for sorting/bucketing (e.g. the
// merchant revenue chart's day-by-day grouping).
export function toMillis(ts) {
  if (!ts) return 0;
  if (ts._seconds) return ts._seconds * 1000;
  if (typeof ts === "number") return ts;
  return Date.parse(ts) || 0;
}

export function escapeHTML(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const ICONS = {
  savings: "💙", roundup: "🔄", subscription: "✨",
  withdrawal: "💸", collection: "💚", disbursement: "👤",
  income: "💚", expense: "❤️"
};
