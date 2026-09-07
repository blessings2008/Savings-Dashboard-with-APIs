import { auth } from '../../firebase.js';
import { api } from '../../api.js';

const style = `
<style>
.pv-otp-shell{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top,#eefbf5 0,#f6f8f7 42%,#eef2f1 100%)}
.pv-otp-card{width:min(440px,100%);background:var(--surface,#fff);border:1px solid rgba(15,23,42,.08);border-radius:24px;padding:30px;box-shadow:0 24px 70px rgba(15,23,42,.10);text-align:center}
.pv-otp-icon{width:64px;height:64px;margin:0 auto 18px;border-radius:20px;display:grid;place-items:center;background:#ecfdf5;font-size:30px}
.pv-otp-card h1{margin:0 0 8px;font-size:26px}.pv-otp-muted{color:var(--muted,#64748b);font-size:14px;line-height:1.6;margin:0 0 22px}.pv-otp-email{font-weight:700;color:var(--text,#111827)}
.pv-otp-input{width:100%;box-sizing:border-box;text-align:center;letter-spacing:12px;font-size:28px;font-weight:800;padding:16px 10px;border:1px solid #d8e0dc;border-radius:14px;background:var(--surface2,#f8faf9);outline:none}.pv-otp-input:focus{border-color:#00a86b;box-shadow:0 0 0 4px rgba(0,168,107,.10)}
.pv-otp-msg{min-height:20px;margin:12px 0;font-size:13px}.pv-otp-error{color:#dc2626}.pv-otp-ok{color:#15803d}.pv-otp-actions{display:flex;gap:10px;margin-top:16px}.pv-otp-actions button{flex:1}.pv-otp-note{font-size:11px;color:#94a3b8;margin-top:18px;line-height:1.5}.pv-otp-back{margin-top:14px;background:none;border:0;color:#64748b;cursor:pointer;font-weight:600}
@media(max-width:480px){.pv-otp-card{padding:24px;border-radius:20px}.pv-otp-input{letter-spacing:8px}}
</style>`;

export function renderEmailOtp(user, onVerified) {
  const app = document.getElementById('app');
  const masked = user.email ? user.email.replace(/^(.{2}).*(@.*)$/, '$1••••$2') : 'your email address';
  app.innerHTML = `${style}<div class="pv-otp-shell"><section class="pv-otp-card" aria-labelledby="otp-title"><div class="pv-otp-icon">✉️</div><h1 id="otp-title">Verify your email</h1><p class="pv-otp-muted">We sent a 6-digit one-time password to <span class="pv-otp-email">${masked}</span>. Enter it below to finish signing in.</p><input id="pv-otp-code" class="pv-otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="6-digit verification code"><div id="pv-otp-msg" class="pv-otp-msg"></div><button id="pv-otp-verify" class="btn btn-primary btn-block">Verify & Continue</button><div class="pv-otp-actions"><button id="pv-otp-resend" class="btn btn-outline">Resend code</button><button id="pv-otp-logout" class="btn btn-outline">Use another account</button></div><div class="pv-otp-note">Your code expires in 10 minutes. PocketVault will never ask for your password or Airtel Money PIN by email.</div></section></div>`;

  const code = document.getElementById('pv-otp-code');
  const verify = document.getElementById('pv-otp-verify');
  const resend = document.getElementById('pv-otp-resend');
  const msg = document.getElementById('pv-otp-msg');

  const show = (text, ok = false) => { msg.textContent = text; msg.className = `pv-otp-msg ${ok ? 'pv-otp-ok' : 'pv-otp-error'}`; };
  const setBusy = (busy, label) => { verify.disabled = busy; verify.innerHTML = busy ? `<span class="spinner"></span> ${label}` : 'Verify & Continue'; };

  const send = async () => {
    resend.disabled = true;
    try {
      const result = await api.post('/api/auth/email-otp/send', {});
      if (result.verified) return onVerified(auth.currentUser);
      show('A new verification code has been sent.', true);
      let seconds = 60; resend.textContent = `Resend in ${seconds}s`;
      const timer = setInterval(() => { seconds -= 1; if (seconds <= 0) { clearInterval(timer); resend.disabled = false; resend.textContent = 'Resend code'; } else resend.textContent = `Resend in ${seconds}s`; }, 1000);
    } catch (e) { show(e.message || 'Could not send the code. Try again.'); resend.disabled = false; resend.textContent = 'Resend code'; }
  };

  verify.onclick = async () => {
    const value = code.value.replace(/\D/g, '');
    if (value.length !== 6) return show('Enter the 6-digit code from your email.');
    setBusy(true, 'Checking...');
    try {
      await api.post('/api/auth/email-otp/verify', { code: value });
      await auth.currentUser.reload();
      show('Email verified. Opening PocketVault…', true);
      setTimeout(() => onVerified(auth.currentUser), 350);
    } catch (e) { show(e.message || 'That code could not be verified.'); setBusy(false); }
  };
  code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); if (code.value.length === 6) verify.click(); });
  code.addEventListener('keydown', e => { if (e.key === 'Enter') verify.click(); });
  resend.onclick = send;
  document.getElementById('pv-otp-logout').onclick = async () => { await auth.signOut(); };

  send();
}
