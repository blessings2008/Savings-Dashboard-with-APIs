/* PocketVault Admin — Referral System */
const ReferralAdmin = (() => {
  const esc = (v='') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const mwk = n => `MWK ${Number(n || 0).toLocaleString('en-MW')}`;

  async function load() {
    const root = document.getElementById('referrals-page');
    if (!root) return;
    root.innerHTML = '<div class="ref-loading">Loading referral system…</div>';
    try {
      const secret = sessionStorage.getItem('pv_admin_secret') || '';
      const r = await fetch('/api/admin/referrals/overview', { headers: { 'x-admin-secret': secret } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      render(root, data);
    } catch (e) {
      root.innerHTML = `<div class="ref-error"><strong>Referral system unavailable</strong><p>${esc(e.message)}</p><button class="btn" onclick="ReferralAdmin.load()">Retry</button></div>`;
    }
  }

  function render(root, d={}) {
    const p = d.pool || {};
    const s = d.stats || {};
    const rows = Array.isArray(d.referrals) ? d.referrals : [];
    root.innerHTML = `
      <div class="ref-header"><div><h1>Referral system</h1><p>Referral funding, rewards and participant tracking.</p></div><div class="ref-status ${d.enabled === false ? 'paused' : ''}">${d.enabled === false ? 'Paused' : 'Active'}</div></div>
      <section class="ref-kpis">
        <div class="ref-kpi"><span>Referral pool</span><strong>${mwk(p.availableBalance)}</strong></div>
        <div class="ref-kpi"><span>Total funded</span><strong>${mwk(p.totalFunded)}</strong></div>
        <div class="ref-kpi"><span>Rewards paid</span><strong>${mwk(p.totalPaid)}</strong></div>
        <div class="ref-kpi"><span>Pending rewards</span><strong>${mwk(p.pendingRewards)}</strong></div>
      </section>
      <section class="ref-panel"><div class="ref-panel-head"><div><h2>Fund referral pool</h2><p>Move approved funds into the dedicated referral balance.</p></div></div>
        <div class="ref-transfer-grid">
          <form onsubmit="return ReferralAdmin.transfer(event,'main_pool')"><label>From Main Pool</label><div class="ref-inline"><input class="input" name="amount" type="number" min="1" step="1" placeholder="Amount in MWK" required><button class="btn btn-primary">Transfer</button></div></form>
          <form onsubmit="return ReferralAdmin.transfer(event,'airtel')"><label>From Airtel account</label><div class="ref-inline"><input class="input" name="amount" type="number" min="1" step="1" placeholder="Amount in MWK" required><input class="input" name="reference" placeholder="Airtel transaction reference" required><button class="btn btn-primary">Record funding</button></div></form>
        </div>
      </section>
      <section class="ref-panel"><div class="ref-panel-head"><div><h2>Referral participants</h2><p>${Number(s.totalParticipants || rows.length).toLocaleString()} tracked participants and relationships.</p></div><input class="input ref-search" placeholder="Search referrals" oninput="ReferralAdmin.filter(this.value)"></div>
        <div class="ref-table-wrap"><table class="ref-table"><thead><tr><th>Referrer</th><th>Referred user</th><th>KYC</th><th>First save</th><th>Eligibility</th><th>Reward</th><th>Status</th><th>Review</th></tr></thead><tbody id="referral-rows">${rows.map(row).map(renderRow).join('') || '<tr><td colspan="8" class="ref-empty">No referral records yet.</td></tr>'}</tbody></table></div>
      </section>
      <section class="ref-panel"><div class="ref-panel-head"><div><h2>Pool ledger</h2><p>Funding and reward movements are recorded separately from customer savings.</p></div></div>
        <div class="ref-ledger"><div><span>Pool status</span><strong>${esc(p.status || 'active')}</strong></div><div><span>Reward per qualified referral</span><strong>${mwk(d.settings?.rewardAmount || 500)}</strong></div><div><span>Program participants</span><strong>${Number(s.totalParticipants || 0).toLocaleString()}</strong></div></div>
      </section>`;
  }

  function renderRow(r) {
    return `<tr data-search="${esc([r.referrerName,r.referredName,r.referrerEmail,r.referredEmail].join(' ').toLowerCase())}"><td>${esc(r.referrerName || r.referrerEmail || '—')}</td><td>${esc(r.referredName || r.referredEmail || '—')}</td><td>${esc(r.kycStatus || 'pending')}</td><td>${r.firstSave ? 'Confirmed' : 'Pending'}</td><td>${r.eligible ? 'Eligible' : 'Not eligible'}</td><td>${mwk(r.rewardAmount)}</td><td>${esc(r.rewardStatus || 'pending')}</td><td>${r.flagged ? '<span class="ref-flag">Review</span>' : '—'}</td></tr>`;
  }

  function filter(q) {
    const needle = String(q || '').toLowerCase().trim();
    document.querySelectorAll('#referral-rows tr').forEach(row => { row.hidden = needle && !(row.dataset.search || '').includes(needle); });
  }

  async function transfer(e, source) {
    e.preventDefault();
    const form = e.currentTarget;
    const amount = Number(form.amount.value);
    const reference = form.reference?.value?.trim() || '';
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (source === 'airtel' && !reference) return false;
    try {
      const secret = sessionStorage.getItem('pv_admin_secret') || '';
      const r = await fetch('/api/admin/referrals/pool/fund', { method:'POST', headers:{'Content-Type':'application/json','x-admin-secret':secret,'Idempotency-Key':`ref-${source}-${reference || Date.now()}`}, body:JSON.stringify({source,amount,reference}) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      alert('Referral pool funding recorded.');
      form.reset();
      load();
    } catch (err) { alert(err.message); }
    return false;
  }
  return { load, filter, transfer };
})();
