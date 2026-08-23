// PocketVault account page — profile, KYC, plan summary, referrals, sign-out.
import { api } from "../../api.js";
import { logOut } from "../../auth.js";
import { state } from "../core/state.js";
import { fmt, initials, escapeHTML } from "../core/utils.js";
import { bindNavLinks } from "../core/render-helpers.js";
import { loadPlan } from "../services/plan.js";
import { loadUserProfile } from "../services/profile.js";
import { toast } from "../components/toast.js";
import { closeModal, showModalError } from "../components/modal.js";
import { fetchUnreadCount } from "../shell.js";

export async function renderAccountPage(main, navigate) {
  await loadPlan({ api, state, toast });
  await loadUserProfile({ api, state });

  const user = state.user;
  const sub = state.subscription || {};

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Account</h2>
        <p>Manage your profile and security</p>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Profile</div></div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
          <div class="avatar" style="width:48px;height:48px;font-size:18px">${initials(user)}</div>
          <div>
            <div style="font-weight:700;font-size:15px">${escapeHTML(user.displayName || "PocketVault User")}</div>
            <div style="font-size:12.5px;color:var(--muted)">${escapeHTML(user.email || "")}</div>
          </div>
        </div>

        <div class="input-group">
          <label class="input-label">Display name</label>
          <input class="input" id="acc-name" placeholder="Your name" value="${escapeHTML(user.displayName || "")}">
        </div>

        <div class="input-group">
          <label class="input-label">Airtel Money number</label>
          <input class="input" id="acc-phone" type="tel" placeholder="e.g. 0991234567" value="${state.user.phone || state.user.profilePhone || ""}" ${state.user.phone ? "readonly" : ""}>
        </div>

        <div id="acc-error" class="auth-error" style="display:none"></div>
        <div id="acc-success" class="insight-box" style="display:none"></div>

        <button class="btn btn-primary" id="acc-save" style="width:100%">Save Changes</button>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Phone Verification (KYC)</div></div>
        <p style="font-size:13px;color:var(--muted);margin-bottom:14px">
          ${state.user.kycStatus === "verified" || state.user.kycStatus === "mock_verified"
            ? `✅ Verified${state.user.kycName ? ` as ${escapeHTML(state.user.kycName)}` : ""}`
            : "Verify your Airtel number to enable savings, withdrawals and subscriptions."}
        </p>
        ${state.user.kycStatus === "verified" || state.user.kycStatus === "mock_verified" ? "" : `
          <button class="btn btn-outline" id="acc-kyc" style="width:100%">Verify Phone Number</button>
        `}
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Plan</div></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <div style="font-weight:700;text-transform:capitalize">${state.plan} plan</div>
            <div style="font-size:12px;color:var(--muted)">
              ${sub.daysRemaining ? `Renews in ${sub.daysRemaining} day${sub.daysRemaining !== 1 ? "s" : ""}` : "No active subscription"}
            </div>
          </div>
          <button class="btn btn-outline btn-sm" data-nav="premium">Manage</button>
        </div>
      </div>

      <div class="card" id="referral-card">
        <div class="card-header"><div class="card-title">🎁 Refer & Earn</div></div>
        <div id="referral-body">
          <div class="loading-row"><span class="spinner"></span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Session</div></div>
        <button class="btn btn-danger" id="acc-signout" style="width:100%">Sign Out</button>
      </div>
    </div>
  `;

  bindNavLinks(main, navigate);
  loadReferralCard(navigate);

  document.getElementById("acc-save").onclick = async () => {
    const name = document.getElementById("acc-name").value.trim();
    const phone = document.getElementById("acc-phone").value.trim();
    const errBox = document.getElementById("acc-error");
    const okBox = document.getElementById("acc-success");
    errBox.style.display = "none";
    okBox.style.display = "none";

    if (phone && !/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) {
      errBox.style.display = "block";
      errBox.textContent = "Enter a valid Malawi Airtel number";
      return;
    }

    const btn = document.getElementById("acc-save");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.profile(state.user.uid, { name, phone });
      state.user.profilePhone = phone;
      okBox.style.display = "block";
      okBox.textContent = "Profile updated.";
      toast("Profile saved");
    } catch (e) {
      errBox.style.display = "block";
      errBox.textContent = e.data?.error || e.message;
    } finally {
      btn.disabled = false; btn.textContent = "Save Changes";
    }
  };

  document.getElementById("acc-kyc")?.addEventListener("click", () => {
    const phone = document.getElementById("acc-phone").value.trim();
    if (!/^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phone)) {
      const errBox = document.getElementById("acc-error");
      errBox.style.display = "block";
      errBox.textContent = "Enter your Airtel number above first, then verify.";
      return;
    }
    openKYCModal(phone, navigate);
  });

  document.getElementById("acc-signout").onclick = async () => {
    if (confirm("Sign out of PocketVault?")) await logOut();
  };
}

// ----------------------------
// REFERRAL CARD (loaded async on Account page)
// Shows the user's own referral code, share button, and progress
// (pending vs completed referrals, total earned). Deliberately its
// own function rather than inline in renderAccountPage so it can
// load independently without blocking the rest of the page.
// ----------------------------
async function loadReferralCard(navigate) {
  const body = document.getElementById("referral-body");
  if (!body) return;
  try {
    const res = await api.myReferralCode();
    const shareText = `Save smarter with PocketVault! Use my code ${res.code} when you sign up and we both get MWK ${fmt(res.bonusAmount)} 🎁`;
    const shareUrl = `${window.location.origin}?ref=${res.code}`;

    body.innerHTML = `
      <p style="font-size:13px;color:var(--muted);margin-bottom:14px">
        Share your code. When a friend verifies their phone and makes their first save, you both get
        <strong style="color:var(--green)">MWK ${fmt(res.bonusAmount)}</strong> added to a goal automatically.
      </p>

      <div class="referral-code-box">
        <span class="referral-code-text">${escapeHTML(res.code)}</span>
        <button class="btn btn-outline btn-sm" id="ref-copy-code">Copy Code</button>
      </div>

      <button class="btn btn-primary" id="ref-share-btn" style="width:100%;margin-top:10px">📤 Share with Friends</button>

      <div class="referral-stats-row">
        <div class="referral-stat">
          <div class="referral-stat-value">${res.pendingReferrals}</div>
          <div class="referral-stat-label">Pending</div>
        </div>
        <div class="referral-stat">
          <div class="referral-stat-value" style="color:var(--green)">${res.completedReferrals}</div>
          <div class="referral-stat-label">Completed</div>
        </div>
        <div class="referral-stat">
          <div class="referral-stat-value" style="color:var(--green)">MWK ${fmt(res.totalEarned)}</div>
          <div class="referral-stat-label">Earned</div>
        </div>
      </div>

      ${!state.user?.referredBy ? `
        <div class="referral-apply-row">
          <input class="input" id="ref-apply-code" placeholder="Have a code? Enter it here" style="flex:1">
          <button class="btn btn-outline btn-sm" id="ref-apply-btn">Apply</button>
        </div>
      ` : ""}
    `;

    document.getElementById("ref-copy-code").onclick = () => {
      navigator.clipboard.writeText(res.code);
      toast("Code copied!");
    };

    document.getElementById("ref-share-btn").onclick = async () => {
      if (navigator.share) {
        try { await navigator.share({ title: "PocketVault", text: shareText, url: shareUrl }); }
        catch {} // user cancelled share sheet — not an error
      } else {
        navigator.clipboard.writeText(`${shareText} ${shareUrl}`);
        toast("Share message copied to clipboard!");
      }
    };

    document.getElementById("ref-apply-btn")?.addEventListener("click", async () => {
      const code = document.getElementById("ref-apply-code").value.trim();
      if (!code) return toast("Enter a code first", "error");
      const btn = document.getElementById("ref-apply-btn");
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
      try {
        const applyRes = await api.applyReferralCode(state.user.uid, code);
        toast(applyRes.message || "Referral code applied!");
        navigate("account");
      } catch (e) {
        toast(e.data?.error || e.message, "error");
        btn.disabled = false; btn.textContent = "Apply";
      }
    });
  } catch (e) {
    body.innerHTML = `<p style="font-size:13px;color:var(--muted)">Couldn't load referral info right now.</p>`;
  }
}

function openKYCModal(phone, navigate) {
  const root = document.getElementById("modal-root");

  // STEP 1: Send OTP
  function showStep1() {
    root.innerHTML = `
      <div class="modal">
        <h3>🔐 Verify Phone Number</h3>
        <p class="modal-sub">We'll send a 6-digit code to confirm <strong>${escapeHTML(phone)}</strong> is yours.</p>
        <div class="modal-info" style="margin-bottom:16px">
          This number will be used for all your transactions — it cannot be changed once verified.
        </div>
        <div id="kyc-error" class="auth-error" style="display:none"></div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="kyc-cancel">Cancel</button>
          <button class="btn btn-primary" id="kyc-send-otp">Send Code</button>
        </div>
      </div>
    `;
    root.classList.add("open");
    root.querySelector("#kyc-cancel").onclick = closeModal;
    root.addEventListener("click", e => { if (e.target === root) closeModal(); });

    root.querySelector("#kyc-send-otp").onclick = async () => {
      const errBox = document.getElementById("kyc-error");
      const btn = root.querySelector("#kyc-send-otp");
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Sending...`;
      try {
        const res = await api.post("/api/kyc/send-otp", { uid: state.user.uid, phone });
        toast(res.mock ? "Code sent — check your Notifications 🔔" : res.message);
        showStep2();
      } catch (e) {
        showModalError(errBox, e.data?.error || e.message);
        btn.disabled = false; btn.textContent = "Send Code";
      }
    };
  }

  // STEP 2: Enter OTP
  function showStep2() {
    root.innerHTML = `
      <div class="modal">
        <h3>🔐 Enter Verification Code</h3>
        <p class="modal-sub">Check your <strong>Notifications</strong> (bell icon) for the 6-digit code sent to ${escapeHTML(phone)}.</p>
        <div class="input-group">
          <label class="input-label">6-Digit Code</label>
          <input class="input" id="kyc-otp" type="number" inputmode="numeric" maxlength="6" placeholder="123456"
            style="font-size:22px;letter-spacing:6px;text-align:center">
        </div>
        <div id="kyc-error2" class="auth-error" style="display:none"></div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="kyc-resend">Resend Code</button>
          <button class="btn btn-primary" id="kyc-verify">Verify</button>
        </div>
        <p style="font-size:11.5px;color:var(--muted);margin-top:10px;text-align:center">Code expires in 10 minutes</p>
      </div>
    `;

    // Focus the OTP input automatically
    setTimeout(() => document.getElementById("kyc-otp")?.focus(), 100);

    root.querySelector("#kyc-resend").onclick = () => showStep1();
    root.querySelector("#kyc-verify").onclick = async () => {
      const otp = document.getElementById("kyc-otp").value.trim();
      const errBox = document.getElementById("kyc-error2");
      const btn = root.querySelector("#kyc-verify");
      if (!otp || otp.length !== 6) return showModalError(errBox, "Enter the 6-digit code");

      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Verifying...`;
      try {
        const res = await api.post("/api/kyc/verify-otp", { uid: state.user.uid, phone, otp });
        if (res.success) {
          state.user.kycStatus = "verified";
          state.user.kycName = res.name;
          state.user.phone = phone;
          state.user.profilePhone = phone;
          closeModal();
          toast(res.message || "✅ Phone verified!");
          fetchUnreadCount(); // Refresh badge — KYC success notification was sent
          navigate("account");
        } else {
          showModalError(errBox, res.message || "Verification failed");
          btn.disabled = false; btn.textContent = "Verify";
        }
      } catch (e) {
        showModalError(errBox, e.data?.error || e.message);
        btn.disabled = false; btn.textContent = "Verify";
      }
    };

    // Allow pressing Enter to submit
    root.querySelector("#kyc-otp").addEventListener("keydown", e => {
      if (e.key === "Enter") root.querySelector("#kyc-verify").click();
    });
  }

  showStep1();
}
