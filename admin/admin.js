// ============================================================
// PocketVault Admin Panel
// Plain JS, no build step. Auth via shared secret (ADMIN_SECRET).
// ============================================================

const SESSION_KEY = "pv_admin_secret";

// ----------------------------
// API HELPER
// ----------------------------
async function apiCall(path, method = "GET", body) {
  const secret = sessionStorage.getItem(SESSION_KEY);
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "x-admin-secret": secret } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ----------------------------
// HELPERS
// ----------------------------
function fmt(n) {
  return Math.round(n || 0).toLocaleString();
}

function escapeHTML(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (ts._seconds) return ts._seconds * 1000;
  return new Date(ts).getTime() || 0;
}

function formatDate(ts) {
  if (!ts) return "—";
  const ms = toMillis(ts);
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) +
    " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function planBadge(plan) {
  return `<span class="badge badge-${plan || "free"}">${plan || "free"}</span>`;
}

function statusBadge(status) {
  const map = { completed: "completed", mock: "pending", pending: "pending", failed: "failed", resolved: "resolved" };
  return `<span class="badge badge-${map[status] || "pending"}">${status || "—"}</span>`;
}

function toast(message, type = "success") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast ${type} show`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 3500);
}

function closeModal() {
  const root = document.getElementById("modal-root");
  if (root) { root.classList.remove("open"); root.innerHTML = ""; }
}

// ----------------------------
// LOGIN PAGE
// ----------------------------
function renderLogin() {
  document.getElementById("app").innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-logo">Pocket<span class="red">Vault</span> Admin</div>
        <p class="auth-sub">Founder access only</p>
        <div id="auth-error" class="auth-error" style="display:none"></div>
        <div class="input-group">
          <label class="input-label">Admin Password</label>
          <input class="input" id="admin-secret" type="password" placeholder="Enter admin secret" autocomplete="off">
        </div>
        <button class="btn btn-primary btn-block" id="login-btn">Sign In</button>
      </div>
    </div>
  `;

  const input = document.getElementById("admin-secret");
  const errBox = document.getElementById("auth-error");
  const btn = document.getElementById("login-btn");

  async function doLogin() {
    const secret = input.value.trim();
    if (!secret) return;
    errBox.style.display = "none";
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Login failed");
      sessionStorage.setItem(SESSION_KEY, secret);
      renderShell();
      navigate("overview");
    } catch (e) {
      errBox.style.display = "block";
      errBox.textContent = e.message;
      btn.disabled = false; btn.textContent = "Sign In";
    }
  }

  btn.onclick = doLogin;
  input.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  input.focus();
}

// ----------------------------
// SHELL / NAV
// ----------------------------
const NAV = [
  { id: "overview", icon: "⬡", label: "Overview" },
  { id: "users", icon: "◎", label: "Users" },
  { id: "operations", icon: "◈", label: "Operations" },
];

let currentPage = "overview";
let currentUserUid = null;

function renderShell() {
  document.getElementById("app").innerHTML = `
    <div class="shell">
      <div class="sidebar">
        <div class="logo">Pocket<span>Vault</span> Admin</div>
        ${NAV.map(item => `
          <div class="nav-item" data-page="${item.id}">
            <span class="nav-icon">${item.icon}</span> ${item.label}
          </div>
        `).join("")}
        <div class="sidebar-bottom">
          <button class="btn btn-outline btn-block btn-sm" id="logout-btn">Sign Out</button>
        </div>
      </div>
      <div class="main" id="main-content">
        <div class="loading-row"><span class="spinner"></span> Loading...</div>
      </div>
    </div>
    <div class="modal-overlay" id="modal-root"></div>
  `;

  document.querySelectorAll("[data-page]").forEach(el => {
    el.addEventListener("click", () => navigate(el.dataset.page));
  });

  document.getElementById("logout-btn").onclick = () => {
    sessionStorage.removeItem(SESSION_KEY);
    renderLogin();
  };
}

function setActiveNav(page) {
  document.querySelectorAll("[data-page]").forEach(el => {
    el.classList.toggle("active", el.dataset.page === page);
  });
}

async function navigate(page, param) {
  currentPage = page;
  setActiveNav(page === "userDetail" ? "users" : page);
  const main = document.getElementById("main-content");
  main.innerHTML = `<div class="loading-row"><span class="spinner"></span> Loading...</div>`;

  try {
    switch (page) {
      case "overview": await renderOverviewPage(main); break;
      case "users": await renderUsersPage(main); break;
      case "userDetail": await renderUserDetailPage(main, param); break;
      case "operations": await renderOperationsPage(main); break;
      default: main.innerHTML = `<div class="empty-state">Page not found</div>`;
    }
  } catch (err) {
    console.error(err);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      return renderLogin();
    }
    main.innerHTML = `<div class="empty-state">⚠️ ${escapeHTML(err.message || "Something went wrong")}</div>`;
  }
}

// ----------------------------
// OVERVIEW PAGE
// ----------------------------
async function renderOverviewPage(main) {
  const data = await apiCall("/api/admin/overview");
  const { revenue, users, float, alerts, airtelConfigured } = data;

  const planRows = [
    { key: "free", label: "Free" },
    { key: "pro", label: "Pro" },
    { key: "business", label: "Business" },
  ];

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Overview</h2>
        <p>Revenue, users, and system health · Airtel: ${airtelConfigured ? "✅ Live" : "⏳ Mock mode"}</p>
      </div>

      <div class="grid-4">
        <div class="stat highlight">
          <div class="stat-label">Total Revenue</div>
          <div class="stat-value">MWK ${fmt(revenue.total)}</div>
          <div class="stat-sub">all-time</div>
        </div>
        <div class="stat">
          <div class="stat-label">Revenue This Month</div>
          <div class="stat-value">MWK ${fmt(revenue.month)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Total Users</div>
          <div class="stat-value">${fmt(users.total)}</div>
          <div class="stat-sub">Pro: ${users.byPlan.pro || 0} · Business: ${users.byPlan.business || 0}</div>
        </div>
        <div class="stat ${float.status === 'low' ? 'danger' : float.status === 'ok' ? '' : ''}">
          <div class="stat-label">Corporate Float</div>
          <div class="stat-value">${float.balance !== null ? `MWK ${fmt(float.balance)}` : "—"}</div>
          <div class="stat-sub">${float.status === "low" ? `<span class="badge badge-low">LOW</span> threshold MWK ${fmt(float.threshold)}` : float.status === "ok" ? `<span class="badge badge-ok">OK</span>` : "Not yet measured"}</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-header"><div class="card-title">Revenue by Type</div></div>
          ${revenueTable(revenue.byType)}
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">Revenue by Plan</div></div>
          ${revenueTable(revenue.byPlan)}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Users by Plan</div></div>
        <div class="grid-3" style="margin-bottom:0">
          ${planRows.map(p => `
            <div class="stat">
              <div class="stat-label">${p.label}</div>
              <div class="stat-value">${users.byPlan[p.key] || 0}</div>
            </div>
          `).join("")}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Open Alerts</div>
          <div class="badge ${alerts.length ? 'badge-low' : 'badge-ok'}">${alerts.length}</div>
        </div>
        ${alerts.length === 0
          ? `<div class="empty-state">No open alerts ✅</div>`
          : alerts.map(a => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
              <div>
                <div style="font-size:13px">${escapeHTML(a.message)}</div>
                <div class="mono">${formatDate(a.timestamp)}</div>
              </div>
              <button class="btn btn-outline btn-sm" data-resolve="${a.id}">Resolve</button>
            </div>
          `).join("")}
      </div>
    </div>
  `;

  main.querySelectorAll("[data-resolve]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await apiCall(`/api/admin/alerts/${btn.dataset.resolve}`, "PATCH");
        toast("Alert resolved");
        navigate("overview");
      } catch (e) {
        toast(e.message, "error");
        btn.disabled = false;
      }
    });
  });
}

function revenueTable(obj) {
  const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return `<div class="empty-state">No revenue yet</div>`;
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  return `
    <table>
      ${entries.map(([key, val]) => `
        <tr>
          <td style="text-transform:capitalize">${escapeHTML(key)}</td>
          <td class="text-right">MWK ${fmt(val)}</td>
          <td class="text-right mono">${Math.round((val / total) * 100)}%</td>
        </tr>
      `).join("")}
    </table>
  `;
}

// ----------------------------
// USERS PAGE
// ----------------------------
async function renderUsersPage(main) {
  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Users</h2>
        <p>All registered PocketVault users</p>
      </div>
      <div class="form-row">
        <div class="input-group">
          <label class="input-label">Search</label>
          <input class="input" id="user-search" placeholder="Email, name, phone or UID">
        </div>
        <div class="input-group" style="flex:0 0 160px">
          <label class="input-label">Plan</label>
          <select class="input" id="plan-filter">
            <option value="">All plans</option>
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="business">Business</option>
          </select>
        </div>
      </div>
      <div class="card" id="users-table">
        <div class="loading-row"><span class="spinner"></span> Loading...</div>
      </div>
    </div>
  `;

  async function load() {
    const q = document.getElementById("user-search").value.trim();
    const plan = document.getElementById("plan-filter").value;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (plan) params.set("plan", plan);

    const container = document.getElementById("users-table");
    container.innerHTML = `<div class="loading-row"><span class="spinner"></span> Loading...</div>`;

    const res = await apiCall(`/api/admin/users?${params.toString()}`);
    const users = res.users || [];

    if (users.length === 0) {
      container.innerHTML = `<div class="empty-state">No users found</div>`;
      return;
    }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Plan</th>
            <th>KYC</th>
            <th>Balance</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(u => `
            <tr class="clickable" data-uid="${u.uid}">
              <td>
                <div style="font-weight:600">${escapeHTML(u.displayName || u.email || u.uid.slice(0, 10))}</div>
                <div class="mono">${escapeHTML(u.email || u.uid)}</div>
              </td>
              <td>${planBadge(u.plan)}</td>
              <td>${u.kycStatus === "verified" || u.kycStatus === "mock_verified" ? `<span class="badge badge-ok">verified</span>` : `<span class="badge badge-warn">${u.kycStatus}</span>`}</td>
              <td>${u.airtelBalance !== null ? `MWK ${fmt(u.airtelBalance)}` : "—"}</td>
              <td class="mono">${formatDate(u.createdAt)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;

    container.querySelectorAll("[data-uid]").forEach(row => {
      row.addEventListener("click", () => navigate("userDetail", row.dataset.uid));
    });
  }

  document.getElementById("user-search").addEventListener("input", debounce(load, 350));
  document.getElementById("plan-filter").addEventListener("change", load);

  await load();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ----------------------------
// USER DETAIL PAGE
// ----------------------------
async function renderUserDetailPage(main, uid) {
  currentUserUid = uid;
  const res = await apiCall(`/api/admin/users/${uid}`);
  const { user, goals, transactions, notifications, stats } = res;

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer" id="back-btn">
          <span>←</span><span style="color:var(--muted);font-size:13px">Back to Users</span>
        </div>
        <h2 style="margin-top:8px">${escapeHTML(user.displayName || user.email || uid)}</h2>
        <p class="mono">${escapeHTML(user.email || "")} · ${uid}</p>
      </div>

      <div class="grid-4">
        <div class="stat highlight">
          <div class="stat-label">Total Saved</div>
          <div class="stat-value">MWK ${fmt(stats.totalSaved)}</div>
          <div class="stat-sub">${stats.goalCount} goal${stats.goalCount !== 1 ? "s" : ""}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Fees Generated</div>
          <div class="stat-value">MWK ${fmt(stats.totalFees)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Plan</div>
          <div class="stat-value">${planBadge(user.plan)}</div>
          <div class="stat-sub">${user.subscriptionExpiry ? `Renews ${formatDate(user.subscriptionExpiry)}` : "No active subscription"}</div>
        </div>
        <div class="stat">
          <div class="stat-label">KYC Status</div>
          <div class="stat-value" style="font-size:14px">${user.kycStatus === "verified" || user.kycStatus === "mock_verified" ? `<span class="badge badge-ok">Verified</span>` : `<span class="badge badge-warn">${user.kycStatus || "unverified"}</span>`}</div>
          <div class="stat-sub">${escapeHTML(user.kycName || user.phone || "No phone on file")}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Admin Actions</div>
        </div>
        <div class="form-row">
          <div class="input-group">
            <label class="input-label">Change Plan</label>
            <select class="input" id="plan-select">
              <option value="free" ${user.plan === "free" ? "selected" : ""}>Free</option>
              <option value="pro" ${user.plan === "pro" ? "selected" : ""}>Pro</option>
              <option value="business" ${user.plan === "business" ? "selected" : ""}>Business</option>
            </select>
          </div>
          <button class="btn btn-primary" id="apply-plan">Apply</button>
        </div>
        <div class="form-row" style="margin-bottom:0">
          <button class="btn btn-outline btn-sm" id="toggle-kyc">
            ${user.kycStatus === "verified" || user.kycStatus === "mock_verified" ? "Mark KYC Unverified" : "Mark KYC Verified"}
          </button>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-header"><div class="card-title">Goals (${goals.length})</div></div>
          ${goals.length === 0 ? `<div class="empty-state">No goals</div>` : `
            <table>
              <thead><tr><th>Goal</th><th>Saved</th><th>Target</th><th>Status</th></tr></thead>
              <tbody>
                ${goals.map(g => `
                  <tr>
                    <td>${g.emoji || "🎯"} ${escapeHTML(g.name)}</td>
                    <td>MWK ${fmt(g.saved)}</td>
                    <td>MWK ${fmt(g.target)}</td>
                    <td>${g.completed ? `<span class="badge badge-completed">Done</span>` : g.locked ? `<span class="badge badge-business">Locked</span>` : `<span class="badge badge-pro">Active</span>`}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          `}
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">Notifications (${notifications.length})</div></div>
          ${notifications.length === 0 ? `<div class="empty-state">No notifications</div>` : notifications.slice(0, 8).map(n => `
            <div style="padding:8px 0;border-bottom:1px solid var(--border)">
              <div style="font-size:12.5px">${escapeHTML(n.message)}</div>
              <div class="mono">${formatDate(n.timestamp)}</div>
            </div>
          `).join("")}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Recent Transactions (${transactions.length})</div></div>
        ${transactions.length === 0 ? `<div class="empty-state">No transactions</div>` : `
          <table>
            <thead><tr><th>Type</th><th>Amount</th><th>Fee</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              ${transactions.slice(0, 20).map(t => `
                <tr>
                  <td style="text-transform:capitalize">${escapeHTML(t.type)}</td>
                  <td>MWK ${fmt(t.amount)}</td>
                  <td class="mono">${t.fee ? `MWK ${fmt(t.fee)}` : "—"}</td>
                  <td>${statusBadge(t.status)}</td>
                  <td class="mono">${formatDate(t.timestamp)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>
    </div>
  `;

  document.getElementById("back-btn").onclick = () => navigate("users");

  document.getElementById("apply-plan").onclick = async () => {
    const plan = document.getElementById("plan-select").value;
    const btn = document.getElementById("apply-plan");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await apiCall(`/api/admin/users/${uid}`, "PATCH", { plan });
      toast(`Plan updated to ${plan}`);
      navigate("userDetail", uid);
    } catch (e) {
      toast(e.message, "error");
      btn.disabled = false; btn.textContent = "Apply";
    }
  };

  document.getElementById("toggle-kyc").onclick = async () => {
    const isVerified = user.kycStatus === "verified" || user.kycStatus === "mock_verified";
    const btn = document.getElementById("toggle-kyc");
    btn.disabled = true;
    try {
      await apiCall(`/api/admin/users/${uid}`, "PATCH", {
        kycStatus: isVerified ? "unverified" : "verified",
        phoneVerified: !isVerified
      });
      toast("KYC status updated");
      navigate("userDetail", uid);
    } catch (e) {
      toast(e.message, "error");
      btn.disabled = false;
    }
  };
}

// ----------------------------
// OPERATIONS PAGE
// ----------------------------
async function renderOperationsPage(main) {
  const res = await apiCall("/api/admin/operations");
  const { floatHistory, pendingTransactions, inbox, alerts, queueLength } = res;

  const latestFloat = floatHistory[0];
  const maxFloat = Math.max(1, ...floatHistory.map(f => f.balance || 0));

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Operations</h2>
        <p>System health, float monitoring, and pending transactions</p>
      </div>

      <div class="grid-3">
        <div class="stat ${latestFloat?.status === 'low' ? 'danger' : ''}">
          <div class="stat-label">Current Float</div>
          <div class="stat-value">${latestFloat ? `MWK ${fmt(latestFloat.balance)}` : "—"}</div>
          <div class="stat-sub">${latestFloat ? formatDate(latestFloat.timestamp) : "No data yet"}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Pending Transactions</div>
          <div class="stat-value">${pendingTransactions.length}</div>
          <div class="stat-sub">awaiting reconciliation</div>
        </div>
        <div class="stat">
          <div class="stat-label">Airtel Queue</div>
          <div class="stat-value">${queueLength}</div>
          <div class="stat-sub">requests in flight</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Float History (last ${floatHistory.length})</div></div>
        ${floatHistory.length === 0 ? `<div class="empty-state">No float data yet — appears once Airtel is configured</div>` : `
          <div style="display:flex;align-items:flex-end;gap:3px;height:60px;margin-bottom:10px">
            ${floatHistory.slice(0, 30).reverse().map(f => `
              <div style="flex:1;border-radius:3px 3px 0 0;min-height:4px;height:${Math.max(4, (f.balance / maxFloat) * 100)}%;background:${f.status === 'low' ? 'var(--red)' : 'var(--green)'}" title="MWK ${fmt(f.balance)}"></div>
            `).join("")}
          </div>
          <div class="mono">Showing oldest → newest of last 30 readings</div>
        `}
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Pending Transactions</div></div>
        ${pendingTransactions.length === 0 ? `<div class="empty-state">None pending ✅</div>` : `
          <table>
            <thead><tr><th>Type</th><th>Amount</th><th>Reference</th><th>User</th><th>Created</th></tr></thead>
            <tbody>
              ${pendingTransactions.map(t => `
                <tr>
                  <td style="text-transform:capitalize">${escapeHTML(t.type)}</td>
                  <td>MWK ${fmt(t.amount)}</td>
                  <td class="mono">${escapeHTML(t.reference || "—")}</td>
                  <td class="mono">${escapeHTML((t.uid || "").slice(0, 10))}</td>
                  <td class="mono">${formatDate(t.timestamp)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Recent Webhook Activity (Inbox)</div></div>
        ${inbox.length === 0 ? `<div class="empty-state">No webhook activity yet</div>` : `
          <table>
            <thead><tr><th>Message</th><th>Amount</th><th>Source</th><th>Time</th></tr></thead>
            <tbody>
              ${inbox.map(i => `
                <tr>
                  <td>${escapeHTML(i.message || "—")}</td>
                  <td>MWK ${fmt(i.amount)}</td>
                  <td class="mono">${escapeHTML(i.source || "—")}</td>
                  <td class="mono">${formatDate(i.timestamp)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">All Alerts (${alerts.length})</div></div>
        ${alerts.length === 0 ? `<div class="empty-state">No alerts</div>` : `
          <table>
            <thead><tr><th>Message</th><th>Status</th><th>Time</th><th></th></tr></thead>
            <tbody>
              ${alerts.map(a => `
                <tr>
                  <td>${escapeHTML(a.message)}</td>
                  <td>${a.resolved ? `<span class="badge badge-resolved">Resolved</span>` : `<span class="badge badge-low">Open</span>`}</td>
                  <td class="mono">${formatDate(a.timestamp)}</td>
                  <td>${!a.resolved ? `<button class="btn btn-outline btn-sm" data-resolve="${a.id}">Resolve</button>` : ""}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>
    </div>
  `;

  main.querySelectorAll("[data-resolve]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await apiCall(`/api/admin/alerts/${btn.dataset.resolve}`, "PATCH");
        toast("Alert resolved");
        navigate("operations");
      } catch (e) {
        toast(e.message, "error");
        btn.disabled = false;
      }
    });
  });
}

// ----------------------------
// ENTRY POINT
// ----------------------------
(function init() {
  const secret = sessionStorage.getItem(SESSION_KEY);
  if (secret) {
    renderShell();
    navigate("overview");
  } else {
    renderLogin();
  }
})();
