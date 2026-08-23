// PocketVault transaction history page.
import { api } from "../../api.js";
import { txRowHTML } from "../core/render-helpers.js";

export async function renderTransactionsPage(main) {
  const filters = [
    { key: "", label: "All" },
    { key: "savings", label: "Savings" },
    { key: "withdrawal", label: "Withdrawals" },
    { key: "roundup", label: "Round-ups" },
    { key: "subscription", label: "Subscriptions" },
  ];

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Transaction History</h2>
        <p>All your PocketVault activity</p>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap" id="tx-filters">
        ${filters.map((f, i) => `<button class="btn ${i === 0 ? 'btn-primary' : 'btn-outline'} btn-sm" data-filter="${f.key}">${f.label}</button>`).join("")}
      </div>
      <div class="card" id="tx-list">
        <div class="loading-row"><span class="spinner"></span> Loading...</div>
      </div>
    </div>
  `;

  async function loadTx(type) {
    const list = document.getElementById("tx-list");
    list.innerHTML = `<div class="loading-row"><span class="spinner"></span> Loading...</div>`;
    const res = await api.transactions(`?limit=50${type ? `&type=${type}` : ""}`);
    const txs = res.transactions || [];
    list.innerHTML = txs.length === 0
      ? `<div class="empty-state"><div class="icon">📋</div><p>No transactions found</p></div>`
      : txs.map(txRowHTML).join("");
  }

  main.querySelectorAll("[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      main.querySelectorAll("[data-filter]").forEach(b => b.className = "btn btn-outline btn-sm");
      btn.className = "btn btn-primary btn-sm";
      loadTx(btn.dataset.filter);
    });
  });

  await loadTx("");
}
