// PocketVault analytics page.
import { api } from "../../api.js";
import { state } from "../core/state.js";
import { fmt } from "../core/utils.js";
import { bindNavLinks } from "../core/render-helpers.js";
import { loadPlan } from "../services/plan.js";
import { toast } from "../components/toast.js";

export async function renderAnalyticsPage(main, navigate) {
  await loadPlan({ api, state, toast });
  const res = await api.analytics();
  const a = res.analytics;

  if (!res.fullAnalyticsAvailable) {
    main.innerHTML = `
      <div class="page active">
        <div class="page-header">
          <h2>Analytics</h2>
          <p>Your savings at a glance</p>
        </div>
        <div class="grid-2">
          <div class="stat highlight">
            <div class="stat-label">Total Saved</div>
            <div class="stat-value">${fmt(a.totalSaved)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Savings Rate</div>
            <div class="stat-value">${a.savingsRate}%</div>
          </div>
        </div>
        <div class="card">
          <div class="empty-state">
            <div class="icon">📊</div>
            <p>Full analytics, spending breakdown and AI insights are available on Pro and Business plans.</p>
            <button class="btn btn-primary btn-sm" data-nav="premium">Upgrade to Pro</button>
          </div>
        </div>
      </div>
    `;
    bindNavLinks(main, navigate);
    return;
  }

  const months = Object.keys(a.monthlyTrend || {}).sort().slice(-6);
  const maxVal = Math.max(1, ...months.flatMap(m => [a.monthlyTrend[m].saved, a.monthlyTrend[m].spent]));

  const categories = Object.entries(a.categoryBreakdown || {}).sort((x, y) => y[1] - x[1]);
  const totalCat = categories.reduce((s, [, v]) => s + v, 0) || 1;
  const catColors = ["var(--amber)", "var(--blue)", "var(--red)", "var(--purple)", "var(--green)"];

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Analytics</h2>
        <p>Understand your money patterns</p>
      </div>

      <div class="grid-3">
        <div class="stat highlight">
          <div class="stat-label">Savings Rate</div>
          <div class="stat-value">${a.savingsRate}%</div>
        </div>
        <div class="stat">
          <div class="stat-label">Total Saved</div>
          <div class="stat-value">${fmt(a.totalSaved)}</div>
          <div class="stat-sub">MWK lifetime</div>
        </div>
        <div class="stat">
          <div class="stat-label">This Month</div>
          <div class="stat-value">${fmt(a.monthSaved)}</div>
          <div class="stat-sub">MWK saved</div>
        </div>
      </div>

      ${months.length > 0 ? `
        <div class="card">
          <div class="card-header"><div class="card-title">Monthly Trend</div></div>
          <div class="chart-bar-wrap">
            ${months.map(m => `<div class="chart-bar savings" style="height:${Math.max(8, (a.monthlyTrend[m].saved / maxVal) * 100)}%"></div>`).join("")}
          </div>
          <div class="chart-labels">${months.map(m => `<span>${m.split("-")[1]}/${m.split("-")[0].slice(2)}</span>`).join("")}</div>
          <div style="display:flex;gap:16px;margin-top:12px;font-size:12px">
            <span style="color:var(--blue)">● Saved</span>
          </div>
        </div>
      ` : ""}

      ${a.aiInsight?.length ? `
        <div class="card">
          <div class="card-header"><div class="card-title">AI Insights</div></div>
          ${a.aiInsight.map(i => `<div class="insight-box">${i}</div>`).join("")}
        </div>
      ` : ""}

      ${categories.length > 0 ? `
        <div class="card">
          <div class="card-header"><div class="card-title">Spending Breakdown</div></div>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${categories.map(([cat, val], i) => `
              <div>
                <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
                  <span style="text-transform:capitalize">${cat}</span>
                  <span style="color:var(--muted)">MWK ${fmt(val)} · ${Math.round((val / totalCat) * 100)}%</span>
                </div>
                <div class="progress-bar"><div class="progress-fill" style="width:${Math.round((val/totalCat)*100)}%;background:${catColors[i % catColors.length]}"></div></div>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
    </div>
  `;
}
