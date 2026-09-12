(function () {
  'use strict';
  const API = (path, method = 'GET', body) => {
    const secret = sessionStorage.getItem('pv_admin_secret');
    return fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-admin-secret': secret } : {}) }, body: body ? JSON.stringify(body) : undefined })
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; });
  };
  const money = n => `MWK ${Math.round(Number(n) || 0).toLocaleString()}`;
  const esc = s => String(s ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

  async function load() {
    const root = document.getElementById('referrals-page');
    if (!root) return;
    root.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading referrals...</div>';
    try {
      const [overview, ledger] = await Promise.all([API('/api/admin/referrals/overview'), API('/api/admin/referrals/pool/ledger?limit=100')]);
      const rows = overview.referrals || [];
      root.innerHTML = `
        <div class="page-header"><div><div class="eyebrow">Growth & rewards</div><h1>Referrals</h1><p>Manage the referral programme, funding pool and reward history.</p></div></div>
        <div class="stats-grid referral-stats">
          <div class="stat-card"><div class="stat-label">Referral pool</div><div class="stat-value">${money(overview.pool?.availableBalance)}</div><div class="stat-meta">Available to pay rewards</div></div>
          <div class="stat-card"><div class="stat-label">Total funded</div><div class="stat-value">${money(overview.pool?.totalFunded)}</div><div class="stat-meta">Money moved into pool</div></div>
          <div class="stat-card"><div class="stat-label">Rewards paid</div><div class="stat-value">${money(overview.pool?.totalPaid)}</div><div class="stat-meta">Paid to participants</div></div>
          <div class="stat-card"><div class="stat-label">Participants</div><div class="stat-value">${overview.totalReferrals || 0}</div><div class="stat-meta">Tracked referrals</div></div>
        </div>
        <div class="referral-grid">
          <section class="panel"><div class="panel-head"><div><h2>Fund referral pool</h2><p>Transfer funds into the dedicated referral balance.</p></div></div>
            <form id="referral-fund-form" class="form-grid">
              <label>Source<select name="source" class="input"><option value="main_pool">Main Pool</option><option value="airtel">Airtel account</option></select></label>
              <label>Amount (MWK)<input name="amount" class="input" type="number" min="1" step="1" required></label>
              <label>Reference<input name="reference" class="input" maxlength="120" placeholder="Required for Airtel funding"></label>
              <div><button class="btn btn-primary" type="submit">Transfer to Referral Pool</button></div>
            </form>
            <div class="referral-note">Airtel funding records a confirmed external transaction reference; PocketVault does not pretend to debit a personal wallet automatically.</div>
          </section>
          <section class="panel"><div class="panel-head"><div><h2>Programme status</h2><p>Current referral controls.</p></div></div>
            <div class="setting-row"><span>Status</span><strong>${esc(overview.pool?.status || 'active')}</strong></div>
            <div class="setting-row"><span>Reward per person</span><strong>${money(overview.rewardAmount || 500)}</strong></div>
            <div class="setting-row"><span>Maximum lifetime referrals</span><strong>${overview.lifetimeCap || 10}</strong></div>
            <div class="setting-row"><span>Pending rewards</span><strong>${overview.pendingRewards || 0}</strong></div>
          </section>
        </div>
        <section class="panel"><div class="panel-head"><div><h2>Referral participants</h2><p>Every referral relationship and its reward state.</p></div><input id="referral-search" class="input search-input" placeholder="Search user or referral ID"></div>
          <div class="table-wrap"><table><thead><tr><th>Referrer</th><th>Referred user</th><th>KYC</th><th>First save</th><th>Status</th><th>Reward</th><th>Action</th></tr></thead><tbody id="referral-rows">${renderRows(rows)}</tbody></table></div>
        </section>
        <section class="panel"><div class="panel-head"><div><h2>Referral ledger</h2><p>Funding and reward movements.</p></div></div>
          <div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Reference</th></tr></thead><tbody>${(ledger.ledger || []).map(x => `<tr><td>${esc(x.createdAt || x.timestamp || '—')}</td><td>${esc(x.type || '—')}</td><td>${money(x.amount)}</td><td>${esc(x.reference || x.id)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No ledger entries yet.</td></tr>'}</tbody></table></div>
        </section>`;
      wire(root, rows);
    } catch (e) { root.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p><button class="btn btn-outline" id="referral-retry">Retry</button></div>`; root.querySelector('#referral-retry').onclick = load; }
  }

  function renderRows(rows) {
    if (!rows.length) return '<tr><td colspan="7" class="muted">No referral participants found.</td></tr>';
    return rows.map(r => `<tr data-search="${esc(`${r.referralId} ${r.referrerEmail} ${r.referredEmail}`.toLowerCase())}"><td>${esc(r.referrerEmail || r.referrerUid)}</td><td>${esc(r.referredEmail || r.referredUid)}</td><td>${esc(r.kycStatus || 'unverified')}</td><td>${r.firstSave ? 'Yes' : 'No'}</td><td>${esc(r.rewardStatus || r.status || 'pending')}</td><td>${money(r.rewardTotal ?? 1000)}</td><td>${r.rewardStatus === 'paid' ? '<span class="muted">Paid</span>' : `<button class="btn btn-primary btn-sm" data-pay="${esc(r.referralId)}">Pay reward</button>`}</td></tr>`).join('');
  }

  function wire(root, rows) {
    root.querySelector('#referral-fund-form')?.addEventListener('submit', async e => {
      e.preventDefault(); const form = e.currentTarget; const fd = new FormData(form); const btn = form.querySelector('button'); btn.disabled = true;
      try { await API('/api/admin/referrals/pool/fund', 'POST', { source: fd.get('source'), amount: Number(fd.get('amount')), reference: fd.get('reference') || null }); form.reset(); await load(); }
      catch (err) { alert(err.message); btn.disabled = false; }
    });
    root.querySelector('#referral-search')?.addEventListener('input', e => { const q = e.target.value.toLowerCase(); root.querySelectorAll('#referral-rows tr').forEach(row => { row.hidden = q && !(row.dataset.search || '').includes(q); }); });
    root.querySelectorAll('[data-pay]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Pay the eligible referral reward from the referral pool?')) return;
      btn.disabled = true;
      try { await API(`/api/admin/referrals/${encodeURIComponent(btn.dataset.pay)}/reward`, 'POST', {}); await load(); }
      catch (err) { alert(err.message); btn.disabled = false; }
    }));
  }

  function install() {
    if (!document.body) return;
    if (!document.getElementById('referral-nav')) {
      const nav = document.querySelector('.sidebar-nav');
      if (nav) {
        const item = document.createElement('div'); item.id = 'referral-nav'; item.className = 'nav-item'; item.dataset.page = 'referrals';
        item.innerHTML = '<span class="nav-icon">R</span><span>Referrals</span>';
        item.onclick = () => window.navigate && window.navigate('referrals'); nav.appendChild(item);
      }
    }
    if (!window.__pvReferralNavigateWrapped && typeof window.navigate === 'function') {
      const original = window.navigate;
      window.navigate = async function(page, param) {
        if (page === 'referrals') {
          document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === 'referrals'));
          const main = document.getElementById('main-content'); if (main) { main.innerHTML = '<div id="referrals-page"></div>'; await load(); }
          return;
        }
        return original(page, param);
      };
      window.__pvReferralNavigateWrapped = true;
    }
  }
  window.ReferralAdmin = { load };
  install();
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
})();
