// PocketVault transaction history page.
import { api, downloadAuthenticatedPdf } from "../../api.js";
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
        <div><h2>Transaction History</h2><p>All your PocketVault activity</p></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" id="tx-pdf-download">↓ PDF</button>
          <button class="btn btn-primary btn-sm" id="tx-pdf-email">✉ Email PDF</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap" id="tx-filters">
        ${filters.map((f, i) => `<button class="btn ${i === 0 ? 'btn-primary' : 'btn-outline'} btn-sm" data-filter="${f.key}">${f.label}</button>`).join("")}
      </div>
      <div class="card" id="tx-list"><div class="loading-row"><span class="spinner"></span> Loading...</div></div>
    </div>
  `;

  async function loadTx(type) {
    const list = document.getElementById("tx-list");
    list.innerHTML = `<div class="loading-row"><span class="spinner"></span> Loading...</div>`;
    const res = await api.transactions(`?limit=50${type ? `&type=${type}` : ""}`);
    const txs = res.transactions || [];
    list.innerHTML = txs.length === 0 ? `<div class="empty-state"><div class="icon">📋</div><p>No transactions found</p></div>` : txs.map(txRowHTML).join("");
  }

  const downloadBtn = document.getElementById("tx-pdf-download");
  const emailBtn = document.getElementById("tx-pdf-email");
  downloadBtn.onclick = async () => {
    downloadBtn.disabled = true; downloadBtn.textContent = "Preparing…";
    try { await downloadAuthenticatedPdf("/api/reports/transactions.pdf", `pocketvault-transaction-history.pdf`); }
    catch (e) { alert(e.message || "Could not create the PDF."); }
    finally { downloadBtn.disabled = false; downloadBtn.textContent = "↓ PDF"; }
  };
  emailBtn.onclick = async () => {
    emailBtn.disabled = true; emailBtn.textContent = "Sending…";
    try { const result = await api.post("/api/reports/transactions/email", {}); emailBtn.textContent = "✓ Sent"; setTimeout(() => { emailBtn.disabled = false; emailBtn.textContent = "✉ Email PDF"; }, 2200); if (!result.success) throw new Error("Could not send the report."); }
    catch (e) { alert(e.message || "Could not email the PDF."); emailBtn.disabled = false; emailBtn.textContent = "✉ Email PDF"; }
  };

  main.querySelectorAll("[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      main.querySelectorAll("[data-filter]").forEach(b => b.className = "btn btn-outline btn-sm");
      btn.className = "btn btn-primary btn-sm";
      loadTx(btn.dataset.filter);
    });
  });

  await loadTx("");
}
