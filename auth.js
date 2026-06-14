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
  browserLocalPersistence
} from "./firebase.js";

export function renderLogin() {
  document.getElementById("app").innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <img src="icon-192.png" class="auth-logo-img" alt="PocketVault"><div class="auth-logo">Pocket<span class="green">Vault</span></div>
        <p class="auth-sub">Save smarter with Airtel Money 🇲🇼</p>

        <div id="auth-error" class="auth-error" style="display:none"></div>

        <div class="input-group">
          <label class="input-label">Email address</label>
          <input id="auth-email" class="input" type="email" placeholder="you@example.com" autocomplete="email">
        </div>

        <div class="input-group">
          <label class="input-label">Password</label>
          <input id="auth-password" class="input" type="password" placeholder="••••••••" autocomplete="current-password">
        </div>

        <button id="btn-signin" class="btn btn-primary btn-block">Sign In</button>
        <button id="btn-register" class="btn btn-outline btn-block">Create Account</button>

        <div class="auth-divider"><span>or</span></div>

        <button id="btn-google" class="btn btn-google btn-block">
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5h-1.9V20.4H24v7.2h11.3c-1.6 4.6-6 7.9-11.3 7.9-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.1-5.1C33.6 5.5 29 3.6 24 3.6 12.9 3.6 4 12.5 4 23.6S12.9 43.6 24 43.6c10.5 0 19.5-7.6 19.5-19.6 0-1.2-.1-2.3-.3-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l5.9 4.3C13.7 15.7 18.5 12 24 12c3 0 5.8 1.1 7.9 3l5.1-5.1C33.6 6.5 29 4.6 24 4.6 16 4.6 9 9.1 6.3 14.7z"/><path fill="#4CAF50" d="M24 43.6c5 0 9.6-1.9 13-5l-6-4.9c-1.9 1.4-4.3 2.2-7 2.2-5.3 0-9.7-3.3-11.3-7.9l-6 4.6C9.1 39.1 16 43.6 24 43.6z"/><path fill="#1976D2" d="M43.6 20.5h-1.9V20.4H24v7.2h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6 4.9c-.4.4 6.4-4.7 6.4-14.6 0-1.2-.1-2.3-.3-3.5z"/></svg>
          Continue with Google
        </button>
      </div>
    </div>
  `;

  const emailInput = document.getElementById("auth-email");
  const passwordInput = document.getElementById("auth-password");
  const errorBox = document.getElementById("auth-error");

  const showError = (msg) => { errorBox.style.display = "block"; errorBox.textContent = msg; };
  const hideError = () => { errorBox.style.display = "none"; };

  document.getElementById("btn-signin").onclick = async () => {
    hideError();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) return showError("Enter your email and password.");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
      showError("Invalid email or password.");
    }
  };

  document.getElementById("btn-register").onclick = async () => {
    hideError();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) return showError("Enter your email and password.");
    if (password.length < 6) return showError("Password must be at least 6 characters.");
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (e) {
      showError(e.message.replace("Firebase: ", "").replace(/\(auth\/.*\)/, "").trim());
    }
  };

  document.getElementById("btn-google").onclick = async () => {
    hideError();
    try {
      await setPersistence(auth, browserLocalPersistence);
    } catch (e) {
      // Some browsers (private mode, partitioned storage) reject this — continue anyway
      console.warn("setPersistence failed:", e.message);
    }
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      const code = e.code || "";
      if (
        code === "auth/popup-blocked" ||
        code === "auth/popup-closed-by-user" ||
        code === "auth/operation-not-supported-in-this-environment" ||
        code === "auth/disallowed-useragent"
      ) {
        try {
          await signInWithRedirect(auth, googleProvider);
        } catch (e2) {
          showError("Google sign-in isn't supported in this browser. Please open this page in Chrome or Safari.");
        }
      } else {
        showError("Google sign-in failed. Try again.");
      }
    }
  };
}

export function watchAuth(onSignedIn, onSignedOut) {
  // Complete any pending redirect-based sign-in (e.g. Google)
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
