import {
  auth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  googleProvider,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  sendPasswordResetEmail
} from "./firebase.js";

const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 48 48">
  <path fill="#FFC107" d="M43.6 20.5h-1.9V20.4H24v7.2h11.3c-1.6 4.6-6 7.9-11.3 7.9-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.1-5.1C33.6 5.5 29 3.6 24 3.6 12.9 3.6 4 12.5 4 23.6S12.9 43.6 24 43.6c10.5 0 19.5-7.6 19.5-19.6 0-1.2-.1-2.3-.3-3.5z"/>
  <path fill="#FF3D00" d="M6.3 14.7l5.9 4.3C13.7 15.7 18.5 12 24 12c3 0 5.8 1.1 7.9 3l5.1-5.1C33.6 6.5 29 4.6 24 4.6 16 4.6 9 9.1 6.3 14.7z"/>
  <path fill="#4CAF50" d="M24 43.6c5 0 9.6-1.9 13-5l-6-4.9c-1.9 1.4-4.3 2.2-7 2.2-5.3 0-9.7-3.3-11.3-7.9l-6 4.6C9.1 39.1 16 43.6 24 43.6z"/>
  <path fill="#1976D2" d="M43.6 20.5h-1.9V20.4H24v7.2h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6 4.9c-.4.4 6.4-4.7 6.4-14.6 0-1.2-.1-2.3-.3-3.5z"/>
</svg>`;

export function renderLogin() {
  document.getElementById("app").innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">

        <!-- Logo -->
        <div style="text-align:center;margin-bottom:20px">
          <img src="icon-192.png" class="auth-logo-img" alt="PocketVault" style="display:block;margin:0 auto 10px">
          <div class="auth-logo">Pocket<span class="green">Vault</span></div>
          <p class="auth-sub">Save smarter with Airtel Money 🇲🇼</p>
        </div>

        <!-- Tabs -->
        <div class="auth-tabs">
          <button class="auth-tab active" id="tab-signin">Sign In</button>
          <button class="auth-tab" id="tab-signup">Sign Up</button>
        </div>

        <!-- Error box -->
        <div id="auth-error" class="auth-error" style="display:none"></div>
        <div id="auth-success" class="auth-success" style="display:none"></div>

        <!-- SIGN IN FORM -->
        <div id="form-signin">
          <div class="input-group">
            <label class="input-label">Email address</label>
            <input id="signin-email" class="input" type="email" placeholder="you@example.com" autocomplete="email">
          </div>
          <div class="input-group">
            <label class="input-label">Password</label>
            <div class="input-password-wrap">
              <input id="signin-password" class="input" type="password" placeholder="••••••••" autocomplete="current-password">
              <button class="input-eye" id="toggle-signin-pw" type="button" tabindex="-1">👁</button>
            </div>
          </div>
          <div style="text-align:right;margin:-8px 0 14px">
            <span class="auth-link" id="btn-forgot">Forgot password?</span>
          </div>
          <button id="btn-signin" class="btn btn-primary btn-block">Sign In</button>
        </div>

        <!-- SIGN UP FORM -->
        <div id="form-signup" style="display:none">
          <div class="input-group">
            <label class="input-label">Full name</label>
            <input id="signup-name" class="input" type="text" placeholder="Your name" autocomplete="name">
          </div>
          <div class="input-group">
            <label class="input-label">Email address</label>
            <input id="signup-email" class="input" type="email" placeholder="you@example.com" autocomplete="email">
          </div>
          <div class="input-group">
            <label class="input-label">Password</label>
            <div class="input-password-wrap">
              <input id="signup-password" class="input" type="password" placeholder="Min. 6 characters" autocomplete="new-password">
              <button class="input-eye" id="toggle-signup-pw" type="button" tabindex="-1">👁</button>
            </div>
          </div>
          <div class="input-group">
            <label class="input-label">Confirm password</label>
            <div class="input-password-wrap">
              <input id="signup-confirm" class="input" type="password" placeholder="Repeat password" autocomplete="new-password">
              <button class="input-eye" id="toggle-signup-confirm" type="button" tabindex="-1">👁</button>
            </div>
          </div>

          <!-- Password strength -->
          <div id="pw-strength-bar" style="display:none;margin-bottom:12px">
            <div style="height:4px;background:var(--surface2);border-radius:99px;overflow:hidden;margin-bottom:4px">
              <div id="pw-strength-fill" style="height:100%;border-radius:99px;transition:width 0.3s,background 0.3s;width:0%"></div>
            </div>
            <div id="pw-strength-label" style="font-size:11px;color:var(--muted)"></div>
          </div>

          <!-- T&C checkbox -->
          <label class="auth-checkbox-label">
            <input type="checkbox" id="terms-check" class="auth-checkbox">
            <span>I agree to PocketVault's
              <span class="auth-link" id="btn-terms">Terms & Conditions</span>
              and
              <span class="auth-link" id="btn-privacy">Privacy Policy</span>
            </span>
          </label>

          <button id="btn-register" class="btn btn-primary btn-block" style="margin-top:14px">Create Account</button>
        </div>

        <!-- Divider -->
        <div class="auth-divider"><span>or</span></div>

        <!-- Google -->
        <button id="btn-google" class="btn btn-google btn-block">
          ${GOOGLE_SVG} Continue with Google
        </button>

        <!-- Bottom switch -->
        <p class="auth-switch" id="auth-switch-text">
          Don't have an account? <span class="auth-link" id="switch-to-signup">Sign up free →</span>
        </p>

      </div>
    </div>

    <!-- Terms Modal -->
    <div class="modal-overlay" id="terms-modal">
      <div class="modal" style="max-height:80vh;overflow-y:auto">
        <h3 style="color:var(--green);margin-bottom:12px">Terms & Conditions</h3>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:10px">
          <strong style="color:var(--text)">1. Service</strong><br>
          PocketVault is a savings management platform that facilitates money transfers via Airtel Money in Malawi. By using PocketVault you agree to these terms.
        </p>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:10px">
          <strong style="color:var(--text)">2. Eligibility</strong><br>
          You must be at least 18 years old and hold a valid Airtel Money account to use savings and withdrawal features.
        </p>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:10px">
          <strong style="color:var(--text)">3. Fees</strong><br>
          PocketVault charges a transaction fee on savings and withdrawals (1% Free plan, 0.75% Pro, 0.5% Business). Monthly subscription fees apply for Pro and Business plans.
        </p>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:10px">
          <strong style="color:var(--text)">4. KYC Verification</strong><br>
          You must verify your Airtel Money phone number via OTP before conducting any financial transactions. Your verified number is used exclusively for your account.
        </p>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:10px">
          <strong style="color:var(--text)">5. Security</strong><br>
          You are responsible for keeping your account credentials secure. PocketVault will never ask for your Airtel Money PIN. Report suspicious activity immediately.
        </p>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:10px">
          <strong style="color:var(--text)">6. Savings Lock</strong><br>
          Goals set to "Locked" mode cannot be withdrawn until the target is reached. This is a voluntary commitment feature.
        </p>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:20px">
          <strong style="color:var(--text)">7. Limitation of Liability</strong><br>
          PocketVault is not liable for delays caused by Airtel Money's network, USSD timeouts, or third-party service interruptions. All transactions are subject to Airtel Money's terms.
        </p>
        <button class="btn btn-primary btn-block" id="close-terms">I Understand</button>
      </div>
    </div>

    <!-- Privacy Modal -->
    <div class="modal-overlay" id="privacy-modal">
      <div class="modal" style="max-height:80vh;overflow-y:auto">
        <h3 style="color:var(--green);margin-bottom:12px">Privacy Policy</h3>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:10px">
          <strong style="color:var(--text)">Data We Collect</strong><br>
          Email address, display name, Airtel Money phone number, transaction history, savings goals, and device/session information.
        </p>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:10px">
          <strong style="color:var(--text)">How We Use It</strong><br>
          To provide savings and payment services, verify your identity (KYC), send transaction notifications, and improve the platform.
        </p>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:10px">
          <strong style="color:var(--text)">Data Sharing</strong><br>
          Your phone number and transaction amounts are shared with Airtel Africa solely to process payments. We never sell your data to advertisers.
        </p>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:10px">
          <strong style="color:var(--text)">Security</strong><br>
          All data is encrypted in transit (HTTPS) and at rest (Firebase/Google Cloud). OTP codes are stored as one-way SHA-256 hashes and never in plaintext.
        </p>
        <p style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:20px">
          <strong style="color:var(--text)">Your Rights</strong><br>
          You may request deletion of your account and associated data by contacting support. Goal and transaction history will be retained for 7 years for financial compliance purposes.
        </p>
        <button class="btn btn-primary btn-block" id="close-privacy">Close</button>
      </div>
    </div>

    <!-- Forgot Password Modal -->
    <div class="modal-overlay" id="forgot-modal">
      <div class="modal">
        <h3 style="margin-bottom:6px">Reset Password</h3>
        <p style="font-size:13px;color:var(--muted);margin-bottom:18px">
          Enter your email and we'll send a password reset link.
        </p>
        <div class="input-group">
          <label class="input-label">Email address</label>
          <input id="forgot-email" class="input" type="email" placeholder="you@example.com">
        </div>
        <div id="forgot-error" class="auth-error" style="display:none"></div>
        <div id="forgot-success" class="auth-success" style="display:none"></div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn btn-outline" id="close-forgot" style="flex:1">Cancel</button>
          <button class="btn btn-primary" id="send-reset" style="flex:1">Send Link</button>
        </div>
      </div>
    </div>
  `;

  // ---- HELPERS ----
  const showError = (msg) => {
    const b = document.getElementById("auth-error");
    b.style.display = "block"; b.textContent = msg;
    document.getElementById("auth-success").style.display = "none";
  };
  const showSuccess = (msg) => {
    const b = document.getElementById("auth-success");
    b.style.display = "block"; b.textContent = msg;
    document.getElementById("auth-error").style.display = "none";
  };
  const hideMessages = () => {
    document.getElementById("auth-error").style.display = "none";
    document.getElementById("auth-success").style.display = "none";
  };

  // ---- TABS ----
  const tabSignIn = document.getElementById("tab-signin");
  const tabSignUp = document.getElementById("tab-signup");
  const formSignIn = document.getElementById("form-signin");
  const formSignUp = document.getElementById("form-signup");
  const switchText = document.getElementById("auth-switch-text");

  function showSignIn() {
    tabSignIn.classList.add("active");
    tabSignUp.classList.remove("active");
    formSignIn.style.display = "block";
    formSignUp.style.display = "none";
    switchText.innerHTML = `Don't have an account? <span class="auth-link" id="switch-to-signup">Sign up free →</span>`;
    document.getElementById("switch-to-signup").onclick = showSignUp;
    hideMessages();
  }

  function showSignUp() {
    tabSignUp.classList.add("active");
    tabSignIn.classList.remove("active");
    formSignUp.style.display = "block";
    formSignIn.style.display = "none";
    switchText.innerHTML = `Already have an account? <span class="auth-link" id="switch-to-signin">Sign in →</span>`;
    document.getElementById("switch-to-signin").onclick = showSignIn;
    hideMessages();
  }

  tabSignIn.onclick = showSignIn;
  tabSignUp.onclick = showSignUp;
  document.getElementById("switch-to-signup").onclick = showSignUp;

  // ---- PASSWORD TOGGLES ----
  function togglePw(inputId, btnId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    btn.addEventListener("click", () => {
      const isText = input.type === "text";
      input.type = isText ? "password" : "text";
      btn.textContent = isText ? "👁" : "🙈";
    });
  }
  togglePw("signin-password", "toggle-signin-pw");
  togglePw("signup-password", "toggle-signup-pw");
  togglePw("signup-confirm", "toggle-signup-confirm");

  // ---- PASSWORD STRENGTH ----
  document.getElementById("signup-password").addEventListener("input", (e) => {
    const pw = e.target.value;
    const bar = document.getElementById("pw-strength-bar");
    const fill = document.getElementById("pw-strength-fill");
    const label = document.getElementById("pw-strength-label");

    if (!pw) { bar.style.display = "none"; return; }
    bar.style.display = "block";

    let score = 0;
    if (pw.length >= 6) score++;
    if (pw.length >= 10) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;

    const levels = [
      { label: "Too short", color: "#f43f5e", w: "20%" },
      { label: "Weak", color: "#f43f5e", w: "30%" },
      { label: "Fair", color: "#f59e0b", w: "55%" },
      { label: "Good", color: "#0ea5e9", w: "75%" },
      { label: "Strong", color: "#00e5a0", w: "100%" },
    ];
    const lvl = levels[Math.min(score, 4)];
    fill.style.width = lvl.w;
    fill.style.background = lvl.color;
    label.textContent = lvl.label;
    label.style.color = lvl.color;
  });

  // ---- SIGN IN ----
  document.getElementById("btn-signin").onclick = async () => {
    hideMessages();
    const email = document.getElementById("signin-email").value.trim();
    const password = document.getElementById("signin-password").value;
    if (!email || !password) return showError("Please enter your email and password.");
    const btn = document.getElementById("btn-signin");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Signing in...`;
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
      const map = {
        "auth/invalid-credential": "Incorrect email or password.",
        "auth/user-not-found": "No account found with this email.",
        "auth/wrong-password": "Incorrect password.",
        "auth/too-many-requests": "Too many failed attempts. Try again later.",
        "auth/user-disabled": "This account has been suspended.",
      };
      showError(map[e.code] || "Sign in failed. Please try again.");
      btn.disabled = false; btn.textContent = "Sign In";
    }
  };

  // Enter key on sign in form
  ["signin-email", "signin-password"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", e => {
      if (e.key === "Enter") document.getElementById("btn-signin").click();
    });
  });

  // ---- SIGN UP ----
  document.getElementById("btn-register").onclick = async () => {
    hideMessages();
    const name = document.getElementById("signup-name").value.trim();
    const email = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;
    const confirm = document.getElementById("signup-confirm").value;
    const agreed = document.getElementById("terms-check").checked;

    if (!name) return showError("Please enter your full name.");
    if (!email) return showError("Please enter your email address.");
    if (!password) return showError("Please enter a password.");
    if (password.length < 6) return showError("Password must be at least 6 characters.");
    if (password !== confirm) return showError("Passwords do not match.");
    if (!agreed) return showError("Please read and accept the Terms & Conditions to continue.");

    const btn = document.getElementById("btn-register");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Creating account...`;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      // Save display name
      try {
        await fetch("/api/profile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + await cred.user.getIdToken()
          },
          body: JSON.stringify({ uid: cred.user.uid, name })
        });
      } catch {}
    } catch (e) {
      const map = {
        "auth/email-already-in-use": "An account with this email already exists. Sign in instead.",
        "auth/invalid-email": "Please enter a valid email address.",
        "auth/weak-password": "Password is too weak. Use at least 6 characters.",
      };
      showError(map[e.code] || e.message.replace("Firebase: ", "").replace(/\(auth\/.*\)/, "").trim());
      btn.disabled = false; btn.textContent = "Create Account";
    }
  };

  // ---- GOOGLE ----
  document.getElementById("btn-google").onclick = async () => {
    hideMessages();
    // If on signup tab, check T&C
    if (formSignUp.style.display !== "none") {
      if (!document.getElementById("terms-check").checked) {
        return showError("Please accept the Terms & Conditions before signing up with Google.");
      }
    }
    try {
      await setPersistence(auth, browserLocalPersistence);
    } catch {}
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      const code = e.code || "";
      if (["auth/popup-blocked","auth/popup-closed-by-user",
           "auth/operation-not-supported-in-this-environment",
           "auth/disallowed-useragent"].includes(code)) {
        try { await signInWithRedirect(auth, googleProvider); } catch {
          showError("Google sign-in isn't supported in this browser. Try Chrome or Safari.");
        }
      } else if (code !== "auth/cancelled-popup-request") {
        showError("Google sign-in failed. Please try again.");
      }
    }
  };

  // ---- FORGOT PASSWORD ----
  document.getElementById("btn-forgot").onclick = () => {
    // Pre-fill email if typed
    const email = document.getElementById("signin-email").value.trim();
    if (email) document.getElementById("forgot-email").value = email;
    document.getElementById("forgot-modal").classList.add("open");
  };

  document.getElementById("close-forgot").onclick = () => {
    document.getElementById("forgot-modal").classList.remove("open");
    document.getElementById("forgot-error").style.display = "none";
    document.getElementById("forgot-success").style.display = "none";
  };

  document.getElementById("forgot-email").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("send-reset").click();
  });

  document.getElementById("send-reset").onclick = async () => {
    const email = document.getElementById("forgot-email").value.trim();
    const errBox = document.getElementById("forgot-error");
    const okBox = document.getElementById("forgot-success");
    const btn = document.getElementById("send-reset");

    errBox.style.display = "none"; okBox.style.display = "none";
    if (!email) { errBox.style.display = "block"; errBox.textContent = "Enter your email address."; return; }

    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await sendPasswordResetEmail(auth, email);
      okBox.style.display = "block";
      okBox.textContent = `✅ Reset link sent to ${email}. Check your inbox (and spam folder).`;
      btn.disabled = false; btn.textContent = "Send Link";
    } catch (e) {
      const map = {
        "auth/user-not-found": "No account found with this email.",
        "auth/invalid-email": "Enter a valid email address.",
        "auth/too-many-requests": "Too many requests. Try again later.",
      };
      errBox.style.display = "block";
      errBox.textContent = map[e.code] || "Failed to send reset email. Try again.";
      btn.disabled = false; btn.textContent = "Send Link";
    }
  };

  // ---- TERMS & PRIVACY MODALS ----
  document.getElementById("btn-terms").onclick = () => {
    document.getElementById("terms-modal").classList.add("open");
  };
  document.getElementById("btn-privacy").onclick = () => {
    document.getElementById("privacy-modal").classList.add("open");
  };
  document.getElementById("close-terms").onclick = () => {
    document.getElementById("terms-modal").classList.remove("open");
    // Auto-tick the checkbox after reading
    document.getElementById("terms-check").checked = true;
  };
  document.getElementById("close-privacy").onclick = () => {
    document.getElementById("privacy-modal").classList.remove("open");
  };

  // Close modals on overlay click
  ["terms-modal","privacy-modal","forgot-modal"].forEach(id => {
    document.getElementById(id).addEventListener("click", e => {
      if (e.target.id === id) document.getElementById(id).classList.remove("open");
    });
  });
}

export function watchAuth(onSignedIn, onSignedOut) {
  getRedirectResult(auth).catch((e) => {
    console.error("Redirect sign-in error:", e.message);
  });
  onAuthStateChanged(auth, (user) => {
    if (user) onSignedIn(user);
    else onSignedOut();
  });
}

export async function logOut() {
  await signOut(auth);
}
