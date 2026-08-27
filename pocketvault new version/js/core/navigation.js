// PocketVault navigation definitions and shared navigation helpers.
export const NAV = [
  { id: "dashboard", icon: "⬡", label: "Dashboard", section: "main" },
  { id: "goals", icon: "◎", label: "Goals", section: "main" },
  { id: "autosave", icon: "↻", label: "Auto-Save", section: "main" },
  { id: "transactions", icon: "≡", label: "Transactions", section: "main" },
  { id: "analytics", icon: "◈", label: "Analytics", section: "insights" },
  { id: "notifications", icon: "◉", label: "Notifications", section: "insights" },
  { id: "merchant", icon: "◇", label: "Merchant", section: "business" },
  { id: "premium", icon: "✦", label: "Plans", section: "business" },
  { id: "help", icon: "❔", label: "Help", section: "insights" },
];

export const sectionsOrder = ["main", "insights", "business"];
export const sectionLabels = {
  main: "Main",
  insights: "Insights",
  business: "Business",
};

export function setActiveNav(page, root = document) {
  root.querySelectorAll("[data-page]").forEach(el => {
    el.classList.toggle("active", el.dataset.page === page);
  });
}

export function bindNavigation(navigate, root = document) {
  root.querySelectorAll("[data-page]").forEach(el => {
    el.addEventListener("click", () => navigate(el.dataset.page));
  });
}
