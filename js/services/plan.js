// PocketVault subscription/plan service extracted from app.js.
export async function loadPlan({ api, state, toast, documentRef = document }) {
  try {
    const res = await api.subscriptionStatus();
    state.plan = res.plan;
    state.planConfig = res.config;
    state.subscription = res;
    const sidebarPlan = documentRef.getElementById("sidebar-plan");
    if (sidebarPlan) sidebarPlan.textContent = `${res.config.name} plan`;
    if (res.expired) toast(res.message, "error");
    return res;
  } catch (e) {
    console.error("Failed to load plan", e);
    return null;
  }
}
