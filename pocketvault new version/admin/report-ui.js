(() => {
  const SECRET_KEY = 'pv_admin_secret';
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function sendReport(year, month) {
    const secret = sessionStorage.getItem(SECRET_KEY);
    if (!secret) throw new Error('Admin session expired. Sign in again.');
    const res = await fetch('/api/admin/reports/monthly/email', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
      body: JSON.stringify({ year, month })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not send the report.');
    return data;
  }

  function inject() {
    const main = document.getElementById('main-content');
    if (!main || !main.querySelector('.page-hdr') || document.getElementById('monthly-report-card')) return;
    const now = new Date();
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const card = document.createElement('div');
    card.id = 'monthly-report-card';
    card.style.cssText = 'margin:0 0 16px;padding:16px 18px;border:1px solid rgba(0,229,160,.18);border-radius:14px;background:linear-gradient(135deg,rgba(0,229,160,.07),rgba(255,255,255,.02));display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap';
    card.innerHTML = `<div><div style="font-weight:800">Monthly PDF report</div><div style="font-size:12px;color:var(--muted);margin-top:4px">Generate the previous month's platform data and email the PDF to the configured admin address.</div></div><div style="display:flex;align-items:center;gap:8px"><input id="report-month" type="month" value="${previous.getFullYear()}-${String(previous.getMonth()+1).padStart(2,'0')}" class="input" style="width:160px"><button id="send-monthly-report" class="btn btn-primary btn-sm">✉ Send PDF</button></div>`;
    const hdr = main.querySelector('.page-hdr');
    hdr.parentNode.insertBefore(card, hdr.nextSibling);
    const btn = card.querySelector('#send-monthly-report');
    btn.onclick = async () => {
      const value = card.querySelector('#report-month').value;
      if (!value) return;
      const [year, month] = value.split('-').map(Number);
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const result = await sendReport(year, month);
        btn.textContent = '✓ Sent';
        if (typeof window.toast === 'function') window.toast(`Monthly report sent for ${result.month}`);
        else alert(`Monthly report sent for ${result.month}.`);
        setTimeout(() => { btn.disabled = false; btn.textContent = '✉ Send PDF'; }, 2200);
      } catch (error) {
        btn.disabled = false; btn.textContent = '✉ Send PDF';
        alert(error.message || 'Could not send the report.');
      }
    };
  }

  const observer = new MutationObserver(inject);
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(inject, 500);
})();
