// PocketVault analytics page.
import { api } from "../../api.js";
import { state } from "../core/state.js";
import { fmt } from "../core/utils.js";
import { bindNavLinks } from "../core/render-helpers.js";
import { loadPlan } from "../services/plan.js";
import { toast } from "../components/toast.js";

const money = value => `MWK ${fmt(Math.max(0, Number(value) || 0))}`;
const pct = value => `${Number(value || 0).toFixed(Number(value || 0) % 1 ? 1 : 0)}%`;
const monthLabel = key => {
  const [year, month] = String(key).split("-");
  if (!year || !month) return key;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString(undefined, { month: "short" });
};

export async function renderAnalyticsPage(main, navigate) {
  try {
    await loadPlan({ api, state, toast });
    const res = await api.analytics();
    const a = res.analytics || {};

    if (!res.fullAnalyticsAvailable) {
      main.innerHTML = `
        <div class="page active analytics-page">
          <div class="page-header analytics-header">
            <div>
              <span class="eyebrow">Financial overview</span>
              <h2>Analytics</h2>
              <p>Your savings at a glance</p>
            </div>
          </div>
          <div class="analytics-upgrade">
            <div class="analytics-upgrade-icon">◈</div>
            <div>
              <span class="eyebrow">Unlock deeper insights</span>
              <h3>See where your money is going</h3>
              <p>Pro and Business plans unlock spending trends, category breakdowns and richer financial insights.</p>
              <button class="btn btn-primary btn-sm" data-nav="premium">Upgrade to Pro</button>
            </div>
          </div>
          <div class="analytics-kpi-grid analytics-kpi-grid--basic">
            <div class="analytics-kpi analytics-kpi--accent">
              <span class="analytics-kpi-label">Total Saved</span>
              <strong>${money(a.totalSaved)}</strong>
              <small>Lifetime savings</small>
            </div>
            <div class="analytics-kpi">
              <span class="analytics-kpi-label">Savings Rate</span>
              <strong>${pct(a.savingsRate)}</strong>
              <small>Overall rate</small>
            </div>
          </div>
        </div>
      `;
      bindNavLinks(main, navigate);
      return;
    }

    const months = Object.keys(a.monthlyTrend || {}).sort().slice(-6);
    const monthValues = months.map(m => ({
      key: m,
      saved: Number(a.monthlyTrend[m]?.saved || 0),
      spent: Number(a.monthlyTrend[m]?.spent || 0)
    }));
    const maxVal = Math.max(1, ...monthValues.flatMap(m => [m.saved, m.spent]));
    const categories = Object.entries(a.categoryBreakdown || {})
      .map(([name, value]) => [name, Number(value) || 0])
      .sort((x, y) => y[1] - x[1]);
    const totalCat = categories.reduce((sum, [, value]) => sum + value, 0) || 1;
    const topCategory = categories[0];
    const avgSaved = monthValues.length ? monthValues.reduce((s, m) => s + m.saved, 0) / monthValues.length : 0;
    const avgSpent = monthValues.length ? monthValues.reduce((s, m) => s + m.spent, 0) / monthValues.length : 0;
    const netMonth = (Number(a.monthSaved) || 0) - (Number(a.monthSpent) || 0);

    main.innerHTML = `
      <div class="page active analytics-page">
        <div class="page-header analytics-header">
          <div>
            <span class="eyebrow">Financial intelligence</span>
            <h2>Analytics</h2>
            <p>Understand your money patterns and make better decisions.</p>
          </div>
          <div class="analytics-period"><span class="analytics-live-dot"></span>Live from your activity</div>
        </div>

        <div class="analytics-kpi-grid">
          <div class="analytics-kpi analytics-kpi--accent">
            <div class="analytics-kpi-top"><span class="analytics-kpi-label">Savings Rate</span><span class="analytics-kpi-icon">↗</span></div>
            <strong>${pct(a.savingsRate)}</strong>
            <small>Overall savings performance</small>
          </div>
          <div class="analytics-kpi">
            <div class="analytics-kpi-top"><span class="analytics-kpi-label">Total Saved</span><span class="analytics-kpi-icon">◆</span></div>
            <strong>${money(a.totalSaved)}</strong>
            <small>Lifetime savings</small>
          </div>
          <div class="analytics-kpi">
            <div class="analytics-kpi-top"><span class="analytics-kpi-label">This Month</span><span class="analytics-kpi-icon">●</span></div>
            <strong>${money(a.monthSaved)}</strong>
            <small>Saved this month</small>
          </div>
          <div class="analytics-kpi analytics-kpi--danger">
            <div class="analytics-kpi-top"><span class="analytics-kpi-label">Total Spent</span><span class="analytics-kpi-icon">↘</span></div>
            <strong>${money(a.totalSpent)}</strong>
            <small>Tracked outflows</small>
          </div>
        </div>

        <div class="analytics-main-grid">
          <section class="card analytics-card analytics-trend-card">
            <div class="analytics-card-head">
              <div><span class="eyebrow">Last 6 months</span><h3>Money Trend</h3></div>
              <div class="analytics-legend"><span><i class="legend-dot saved"></i>Saved</span><span><i class="legend-dot spent"></i>Spent</span></div>
            </div>
            ${monthValues.length ? `
              <div class="trend-chart" role="img" aria-label="Monthly saved and spent trend">
                <div class="trend-grid"><span></span><span></span><span></span><span></span></div>
                <div class="trend-bars">
                  ${monthValues.map(m => `
                    <div class="trend-month">
                      <div class="trend-columns">
                        <div class="trend-bar saved" style="height:${Math.max(5, (m.saved / maxVal) * 100)}%" title="Saved ${money(m.saved)}"><span>${m.saved ? money(m.saved) : ""}</span></div>
                        <div class="trend-bar spent" style="height:${Math.max(5, (m.spent / maxVal) * 100)}%" title="Spent ${money(m.spent)}"><span>${m.spent ? money(m.spent) : ""}</span></div>
                      </div>
                      <small>${monthLabel(m.key)}</small>
                    </div>
                  `).join("")}
                </div>
              </div>
              <div class="trend-summary">
                <div><span>Avg. saved / month</span><strong>${money(avgSaved)}</strong></div>
                <div><span>Avg. spent / month</span><strong>${money(avgSpent)}</strong></div>
                <div><span>Current month net</span><strong class="${netMonth >= 0 ? "positive" : "negative"}">${netMonth >= 0 ? "+" : "-"}${money(Math.abs(netMonth))}</strong></div>
              </div>
            ` : `<div class="analytics-empty"><span>◈</span><p>Not enough activity yet to show a monthly trend.</p></div>`}
          </section>

          <section class="card analytics-card category-card">
            <div class="analytics-card-head"><div><span class="eyebrow">Where it goes</span><h3>Spending Breakdown</h3></div></div>
            ${categories.length ? `
              <div class="category-total"><strong>${money(a.totalSpent)}</strong><span>total tracked spending</span></div>
              <div class="category-list">
                ${categories.slice(0, 6).map(([cat, val], i) => {
                  const share = Math.round((val / totalCat) * 100);
                  return `<div class="category-row">
                    <div class="category-meta"><span><i class="category-dot category-dot-${i % 6}"></i>${cat}</span><b>${share}%</b></div>
                    <div class="category-track"><div style="width:${share}%"></div></div>
                    <small>${money(val)}</small>
                  </div>`;
                }).join("")}
              </div>
              ${categories.length > 6 ? `<div class="category-more">+ ${categories.length - 6} more categories</div>` : ""}
            ` : `<div class="analytics-empty"><span>◎</span><p>No spending categories to display yet.</p></div>`}
          </section>
        </div>

        <div class="analytics-secondary-grid">
          <section class="card analytics-card month-card">
            <div class="analytics-card-head"><div><span class="eyebrow">This month</span><h3>Cash Flow Snapshot</h3></div></div>
            <div class="cashflow-list">
              <div><span>Saved</span><strong class="positive">${money(a.monthSaved)}</strong></div>
              <div><span>Spent</span><strong class="negative">${money(a.monthSpent)}</strong></div>
              <div class="cashflow-net"><span>Net</span><strong class="${netMonth >= 0 ? "positive" : "negative"}">${netMonth >= 0 ? "+" : "-"}${money(Math.abs(netMonth))}</strong></div>
            </div>
          </section>
          <section class="card analytics-card insight-card">
            <div class="analytics-card-head"><div><span class="eyebrow">PocketVault intelligence</span><h3>Insights</h3></div><span class="insight-spark">✦</span></div>
            ${a.aiInsight?.length ? `<div class="insight-list">${a.aiInsight.map((insight, i) => `<div class="analytics-insight"><span>${i + 1}</span><p>${insight}</p></div>`).join("")}</div>` : `<div class="analytics-empty compact"><span>✦</span><p>Keep using PocketVault and your insights will appear here.</p></div>`}
          </section>
        </div>

        ${topCategory ? `<div class="analytics-callout"><div class="callout-icon">◈</div><div><span class="eyebrow">Your biggest spending category</span><strong>${topCategory[0]}</strong><p>${money(topCategory[1])} of tracked spending · ${Math.round((topCategory[1] / totalCat) * 100)}% of the breakdown.</p></div></div>` : ""}
      </div>
    `;
  } catch (err) {
    console.error("Analytics render failed", err);
    main.innerHTML = `
      <div class="page active analytics-page">
        <div class="analytics-error card"><span>!</span><h3>Analytics couldn't load</h3><p>We couldn't retrieve your latest financial data. Please try again.</p><button class="btn btn-primary btn-sm" data-nav="analytics">Try again</button></div>
      </div>
    `;
    bindNavLinks(main, navigate);
    toast?.("Unable to load analytics", "error");
  }
}
