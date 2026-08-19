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

export function escapeHTML(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const ICONS = {
  savings: "💙", roundup: "🔄", subscription: "✨",
  withdrawal: "💸", collection: "💚", disbursement: "👤",
  income: "💚", expense: "❤️"
};

export const NAV = [
  { id: "dashboard", icon: "⬡", label: "Dashboard", section: "main" },
  { id: "goals", icon: "◎", label: "Goals", section: "main" },
  { id: "autosave", icon: "↻", label: "Auto-Save", section: "main" },
  { id: "transactions", icon: "≡", label: "Transactions", section: "main" },
  { id: "analytics", icon: "◈", label: "Analytics", section: "insights" },
  { id: "notifications", icon: "◉", label: "Notifications", section: "insights" },
  { id: "merchant", icon: "◇", label: "Merchant", section: "business" },
  { id: "premium", icon: "✦", label: "Plans", section: "business" },
];
