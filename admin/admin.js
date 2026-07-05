// ============================================================
// PocketVault Admin Panel v2
// Layout inspired by modern fintech admin dashboards.
// PocketVault green/dark theme maintained throughout.
// ============================================================

const SESSION_KEY = "pv_admin_secret";
let currentPage = "overview";
let currentUserUid = null;

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
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

// ----------------------------
// HELPERS
// ----------------------------
const fmt = n => Math.round(n || 0).toLocaleString();
const fmtMWK = n => `MWK ${fmt(n)}`;
function escapeHTML(s) {
  if (typeof s !== "string") return s || "—";
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function toMs(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (ts._seconds) return ts._seconds * 1000;
  return new Date(ts).getTime() || 0;
}
function timeAgo(ts) {
  const ms = toMs(ts); if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return new Date(ms).toLocaleDateString([], {day:"numeric",month:"short",year:"numeric"});
}
function formatDate(ts) {
  const ms = toMs(ts); if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString([], {day:"numeric",month:"short"}) + " " +
    d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
}
function planBadge(plan) {
  return `<span class="badge badge-${plan||"free"}">${plan||"free"}</span>`;
}
function statusBadge(status) {
  const map = {completed:"ok",verified:"verified",mock:"warn",pending:"warn",failed:"danger",resolved:"ok",unverified:"unverified"};
  return `<span class="badge badge-${map[status]||"warn"}">${status||"—"}</span>`;
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function toast(msg, type = "success") {
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.className = `toast ${type} show`;
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 3200);
}

function closeModal() {
  const r = document.getElementById("modal-root");
  if (r) { r.classList.remove("open"); r.innerHTML = ""; }
}

// ----------------------------
// SVG CHART HELPERS
// ----------------------------
function lineChart(data, {width=600,height=120,color="#00e5a0",fillColor="rgba(0,229,160,0.08)"}={}) {
  if (!data.length) return `<svg viewBox="0 0 ${width} ${height}"><text x="50%" y="50%" fill="#555" text-anchor="middle" font-size="12">No data</text></svg>`;
  const max = Math.max(...data) || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length-1)) * width;
    const y = height - (v / max) * (height - 10) - 5;
    return `${x},${y}`;
  });
  const path = "M" + pts.join(" L");
  const fill = "M0," + height + " L" + pts.join(" L") + ` L${width},${height} Z`;
  return `<svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="none">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${fill}" fill="url(#lg)"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${pts.map((p, i) => i === data.length-1 ? `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="4" fill="${color}"/>` : "").join("")}
  </svg>`;
}

function donutChart(segments, total, centerVal, centerLabel) {
  // segments = [{value, color, label}]
  const r = 54, cx = 70, cy = 70, circ = 2 * Math.PI * r;
  let offset = 0;
  const paths = segments.map(s => {
    const pct = s.value / (total || 1);
    const dash = pct * circ;
    const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="12"
      stroke-dasharray="${dash} ${circ - dash}" stroke-dashoffset="${-offset}" stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})" opacity="0.9"/>`;
    offset += dash;
    return el;
  });
  return `
    <svg viewBox="0 0 140 140" width="140" height="140">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="12"/>
      ${paths.join("")}
      <text x="${cx}" y="${cy-6}" text-anchor="middle" fill="#f0f4f8" font-size="17" font-weight="800" font-family="Syne,sans-serif">${centerVal}</text>
      <text x="${cx}" y="${cy+12}" text-anchor="middle" fill="rgba(240,244,248,0.45)" font-size="9" font-family="DM Sans,sans-serif">${centerLabel}</text>
    </svg>`;
}

function barChart(labels, values, color="#00e5a0") {
  const max = Math.max(...values, 1);
  const w = 320, h = 80, barW = Math.floor((w - (values.length*4)) / values.length);
  const bars = values.map((v, i) => {
    const bh = Math.max(4, (v/max) * h);
    const x = i * (barW + 4);
    const y = h - bh;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="4" fill="${color}" opacity="${0.5 + 0.5*(v/max)}"/>
      <text x="${x+barW/2}" y="${h+14}" text-anchor="middle" fill="rgba(240,244,248,0.45)" font-size="9" font-family="DM Sans,sans-serif">${labels[i]||""}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${h+18}" class="chart-svg">
    ${bars.join("")}
  </svg>`;
}

// ----------------------------
// LOGIN
// ----------------------------
function renderLogin() {
  document.getElementById("app").innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-logo-row">
          <img src="/icon-192.png" class="auth-logo-icon" alt="PocketVault">
          <div>
            <div class="auth-logo-text">Pocket<span>Vault</span></div>
            <div style="font-size:10px;color:var(--red);font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Admin Panel</div>
          </div>
        </div>
        <p class="auth-sub">Founder access only — enter your admin secret to continue.</p>
        <div id="auth-error" class="auth-error" style="display:none"></div>
        <div class="input-group">
          <label class="input-label">Admin Password</label>
          <input class="input" id="admin-secret" type="password" placeholder="Enter admin secret" autocomplete="off">
        </div>
        <button class="btn btn-primary btn-block" id="login-btn">Sign In</button>
      </div>
    </div>`;

  const input = document.getElementById("admin-secret");
  const errBox = document.getElementById("auth-error");
  const btn = document.getElementById("login-btn");

  async function doLogin() {
    const secret = input.value.trim(); if (!secret) return;
    errBox.style.display = "none"; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await fetch("/api/admin/login", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({secret}) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Login failed");
      sessionStorage.setItem(SESSION_KEY, secret);
      renderShell(); navigate("overview");
    } catch (e) {
      errBox.style.display = "block"; errBox.textContent = e.message;
      btn.disabled = false; btn.textContent = "Sign In";
    }
  }
  btn.onclick = doLogin;
  input.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  input.focus();
}

// ----------------------------
// SHELL
// ----------------------------
const NAV = [
  { section: "Main", items: [
    { id:"overview", icon:"⬡", label:"Overview" },
    { id:"users", icon:"◎", label:"Users" },
    { id:"transactions", icon:"≡", label:"Transactions" },
  ]},
  { section: "AI", items: [
    { id:"ai_assistant", icon:"✦", label:"AI Assistant" },
    { id:"ai_anomalies", icon:"⚠", label:"Anomaly Detection" },
  ]},
  { section: "Comms", items: [
    { id:"messages", icon:"✉", label:"Messages" },
    { id:"notifications_admin", icon:"◉", label:"Notifications" },
  ]},
  { section: "System", items: [
    { id:"operations", icon:"◈", label:"Operations" },
    { id:"errors", icon:"⚠", label:"Errors" },
  ]},
];

function renderShell() {
  const navHTML = NAV.map(sec => `
    <div class="nav-section-label">${sec.section}</div>
    ${sec.items.map(item => `
      <div class="nav-item" data-page="${item.id}">
        <span class="nav-icon">${item.icon}</span>
        <span>${item.label}</span>
      </div>
    `).join("")}
  `).join("");

  document.getElementById("app").innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="sidebar-header">
          <img src="/icon-192.png" class="sidebar-logo-icon" alt="">
          <div>
            <div class="sidebar-logo-text">Pocket<span>Vault</span></div>
            <div class="sidebar-logo-sub">Admin</div>
          </div>
        </div>
        <nav class="sidebar-nav">${navHTML}</nav>
        <div class="sidebar-bottom">
          <div class="admin-pill">
            <div class="admin-avatar">A</div>
            <div>
              <div class="admin-name">Founder</div>
              <div class="admin-role">Administrator</div>
            </div>
          </div>
          <button class="btn btn-ghost btn-block btn-sm" id="logout-btn" style="justify-content:flex-start">⎋ Sign Out</button>
        </div>
      </aside>
      <div class="main">
        <div id="main-content" class="page-content">
          <div class="loading-row"><span class="spinner"></span> Loading...</div>
        </div>
      </div>
    </div>
    <div class="modal-overlay" id="modal-root"></div>
  `;

  document.querySelectorAll("[data-page]").forEach(el => el.addEventListener("click", () => navigate(el.dataset.page)));
  document.getElementById("logout-btn").onclick = () => { sessionStorage.removeItem(SESSION_KEY); renderLogin(); };
}

function setActiveNav(page) {
  document.querySelectorAll("[data-page]").forEach(el => el.classList.toggle("active", el.dataset.page === page));
}

async function navigate(page, param) {
  currentPage = page;
  setActiveNav(page === "userDetail" ? "users" : page);
  const main = document.getElementById("main-content");
  main.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
  try {
    switch (page) {
      case "overview": await renderOverview(main); break;
      case "users": await renderUsers(main); break;
      case "userDetail": await renderUserDetail(main, param); break;
      case "transactions": await renderTransactions(main); break;
      case "messages": await renderMessages(main); break;
      case "notifications_admin": await renderNotificationsAdmin(main); break;
      case "operations": await renderOperations(main); break;
      case "errors": await renderErrors(main); break;
      case "ai_assistant": await renderAIAssistant(main); break;
      case "ai_anomalies": await renderAIAnomalies(main); break;
      default: main.innerHTML = `<div class="empty-state"><p>Page not found</p></div>`;
    }
  } catch (err) {
    if (err.status === 401) { sessionStorage.removeItem(SESSION_KEY); return renderLogin(); }
    console.error(err);
    main.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${escapeHTML(err.message)}</p><button class="btn btn-outline" onclick="navigate('${page}')">Retry</button></div>`;
  }
}

// ----------------------------
// OVERVIEW
// ----------------------------
async function renderOverview(main) {
  const data = await apiCall("/api/admin/overview");
  const { revenue, users, float, alerts, airtelConfigured } = data;

  const totalUsers = users.total || 0;
  const proUsers = users.byPlan.pro || 0;
  const bizUsers = users.byPlan.business || 0;
  const paidPct = totalUsers ? Math.round(((proUsers + bizUsers) / totalUsers) * 100) : 0;
  const floatOk = float.status === "ok";

  // Build monthly revenue bars from byType
  const revenueTypes = Object.entries(revenue.byType || {});
  const revenueMax = Math.max(...revenueTypes.map(e => e[1]), 1);

  main.innerHTML = `
    <div class="page-hdr">
      <div class="page-hdr-left">
        <h2>Overview</h2>
        <p>Business health at a glance · Airtel: ${airtelConfigured ? '<span class="text-green">✅ Live</span>' : '<span class="text-amber">⏳ Mock mode</span>'}</p>
      </div>
      <div class="page-hdr-right">
        <span class="topbar-badge">${new Date().toLocaleDateString([], {weekday:"short",day:"numeric",month:"short"})}</span>
        <button class="btn btn-outline btn-sm" onclick="navigate('overview')">↻ Refresh</button>
      </div>
    </div>

    <!-- STAT CARDS -->
    <div class="stat-grid">
      <div class="stat-card highlight">
        <div class="stat-icon">💰</div>
        <div class="stat-label">Total Revenue</div>
        <div class="stat-value">MWK ${fmt(revenue.total)}</div>
        <div class="stat-footer">
          <span class="stat-delta up">↑ MWK ${fmt(revenue.month)}</span> this month
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">👥</div>
        <div class="stat-label">Total Users</div>
        <div class="stat-value">${fmt(totalUsers)}</div>
        <div class="stat-footer">
          <span class="stat-delta up">${paidPct}%</span> on paid plans
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">✦</div>
        <div class="stat-label">Pro / Business</div>
        <div class="stat-value">${fmt(proUsers + bizUsers)}</div>
        <div class="stat-footer">
          Pro: ${proUsers} &nbsp;·&nbsp; Business: ${bizUsers}
        </div>
      </div>
      <div class="stat-card ${floatOk ? "" : "danger"}">
        <div class="stat-icon">🏦</div>
        <div class="stat-label">Corporate Float</div>
        <div class="stat-value">${float.balance !== null ? fmtMWK(float.balance) : "—"}</div>
        <div class="stat-footer">
          ${float.status === "low" ? `<span class="stat-delta down">⚠ LOW</span> threshold ${fmtMWK(float.threshold)}` : float.status === "ok" ? `<span class="stat-delta up">✓ Healthy</span>` : "Not yet measured"}
        </div>
      </div>
    </div>

    <!-- CHARTS ROW -->
    <div class="grid-7-3" style="margin-bottom:16px">
      <div class="card">
        <div class="card-hdr">
          <div><div class="card-title">Revenue by Source</div><div class="card-sub">All-time breakdown</div></div>
        </div>
        <div class="card-body">
          ${revenueTypes.length === 0 ? `<div class="empty-state"><p>No revenue yet</p></div>` : `
            <div style="display:flex;flex-direction:column;gap:10px">
              ${revenueTypes.sort((a,b)=>b[1]-a[1]).map(([type, val]) => `
                <div>
                  <div class="flex-between" style="margin-bottom:5px">
                    <span style="font-size:13px;text-transform:capitalize">${type}</span>
                    <span style="font-size:13px;font-weight:600">${fmtMWK(val)}</span>
                  </div>
                  <div class="prog-bar"><div class="prog-fill" style="width:${Math.round((val/revenueMax)*100)}%"></div></div>
                </div>
              `).join("")}
            </div>
          `}
        </div>
      </div>

      <div class="card">
        <div class="card-hdr"><div class="card-title">Users by Plan</div></div>
        <div class="card-body" style="display:flex;flex-direction:column;align-items:center">
          ${donutChart([
            {value: users.byPlan.free || 0, color: "rgba(255,255,255,0.15)", label:"Free"},
            {value: proUsers, color: "#00e5a0", label:"Pro"},
            {value: bizUsers, color: "#a855f7", label:"Business"},
          ], totalUsers, totalUsers, "Users")}
          <div class="chart-legend" style="justify-content:center">
            <div class="legend-item"><div class="legend-dot" style="background:rgba(255,255,255,0.3)"></div>Free (${users.byPlan.free||0})</div>
            <div class="legend-item"><div class="legend-dot" style="background:var(--green)"></div>Pro (${proUsers})</div>
            <div class="legend-item"><div class="legend-dot" style="background:var(--purple)"></div>Biz (${bizUsers})</div>
          </div>
        </div>
      </div>
    </div>

    <!-- RECENT USERS + ALERTS -->
    <div class="grid-2">
      <div class="card">
        <div class="card-hdr">
          <div class="card-title">Open Alerts</div>
          <span class="badge ${alerts.length > 0 ? 'badge-danger' : 'badge-ok'}">${alerts.length}</span>
        </div>
        ${alerts.length === 0
          ? `<div class="card-body"><div class="empty-state"><div class="empty-icon">✅</div><p>No open alerts</p></div></div>`
          : `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Message</th><th>Time</th><th></th></tr></thead><tbody>
            ${alerts.slice(0,6).map(a => `
              <tr>
                <td>${statusBadge("warn")}</td>
                <td style="max-width:200px" class="truncate">${escapeHTML(a.message)}</td>
                <td class="mono">${timeAgo(a.timestamp)}</td>
                <td><button class="btn btn-ghost btn-sm btn-icon" data-resolve="${a.id}">✓</button></td>
              </tr>`).join("")}
          </tbody></table></div>`}
      </div>

      <div class="card">
        <div class="card-hdr">
          <div class="card-title">Revenue by Plan</div>
        </div>
        <div class="card-body">
          ${Object.entries(revenue.byPlan || {}).length === 0
            ? `<div class="empty-state"><p>No revenue data yet</p></div>`
            : Object.entries(revenue.byPlan).map(([plan, val]) => `
              <div class="flex-between" style="padding:10px 0;border-bottom:1px solid var(--border)">
                <div class="flex-gap">${planBadge(plan)}</div>
                <div style="font-weight:700">${fmtMWK(val)}</div>
              </div>`).join("")}
        </div>
      </div>
    </div>
  `;

  main.querySelectorAll("[data-resolve]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await apiCall(`/api/admin/alerts/${btn.dataset.resolve}`, "PATCH").catch(() => {});
      toast("Alert resolved"); navigate("overview");
    });
  });
}

// ----------------------------
// USERS
// ----------------------------
async function renderUsers(main) {
  main.innerHTML = `
    <div class="page-hdr">
      <div class="page-hdr-left"><h2>Users</h2><p>All registered PocketVault users</p></div>
    </div>
    <div class="form-row">
      <div class="search-bar" style="flex:1">
        <span class="search-icon">🔍</span>
        <input id="user-search" placeholder="Search email, name, phone or UID...">
      </div>
      <div class="input-group" style="width:150px;margin-bottom:0">
        <select class="input" id="plan-filter">
          <option value="">All Plans</option>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="business">Business</option>
        </select>
      </div>
    </div>

    <!-- Recent 3 as cards (like Image 3) -->
    <div id="user-card-row" class="user-card-grid" style="margin-bottom:16px"></div>

    <!-- Full table -->
    <div class="card" id="users-table">
      <div class="loading-row"><span class="spinner"></span></div>
    </div>
  `;

  async function load() {
    const q = document.getElementById("user-search")?.value?.trim() || "";
    const plan = document.getElementById("plan-filter")?.value || "";
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (plan) params.set("plan", plan);
    const container = document.getElementById("users-table");
    container.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    const res = await apiCall(`/api/admin/users?${params}`);
    const users = res.users || [];

    // Top 3 as user cards
    const cardRow = document.getElementById("user-card-row");
    if (cardRow && !q && !plan) {
      cardRow.innerHTML = users.slice(0,3).map(u => `
        <div class="user-card" data-uid="${u.uid}">
          <div class="user-card-top">
            <div class="user-avatar-lg">${(u.displayName||u.email||"?")[0].toUpperCase()}</div>
            ${planBadge(u.plan)}
          </div>
          <div class="user-card-name">${escapeHTML(u.displayName || u.email)}</div>
          <div class="user-card-email">${escapeHTML(u.email || u.uid)}</div>
          <div class="user-card-meta">
            <div class="user-card-meta-item">
              <div class="user-card-meta-label">KYC</div>
              ${u.kycStatus === "verified" || u.kycStatus === "mock_verified" ? '<span class="text-green">✓ Verified</span>' : '<span class="text-amber">Pending</span>'}
            </div>
            <div class="user-card-meta-item">
              <div class="user-card-meta-label">Joined</div>
              ${u.createdAt ? new Date(u.createdAt).toLocaleDateString([],{day:"numeric",month:"short"}) : "—"}
            </div>
          </div>
        </div>
      `).join("");
      cardRow.querySelectorAll("[data-uid]").forEach(el => el.addEventListener("click", () => navigate("userDetail", el.dataset.uid)));
    } else if (cardRow) {
      cardRow.innerHTML = "";
    }

    if (!users.length) { container.innerHTML = `<div class="card-body"><div class="empty-state"><div class="empty-icon">👥</div><p>No users found</p></div></div>`; return; }

    container.innerHTML = `
      <div class="card-hdr">
        <div><div class="card-title">All Users</div><div class="card-sub">${users.length} result${users.length!==1?"s":""}</div></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>User</th><th>Plan</th><th>KYC</th><th>Phone</th><th>Last Sign In</th><th>Action</th></tr></thead>
          <tbody>
            ${users.map(u => `
              <tr class="clickable" data-uid="${u.uid}">
                <td>
                  <div class="flex-gap">
                    <div class="user-avatar-lg" style="width:30px;height:30px;font-size:12px">${(u.displayName||u.email||"?")[0].toUpperCase()}</div>
                    <div>
                      <div style="font-weight:600;font-size:13px">${escapeHTML(u.displayName||u.email||u.uid)}</div>
                      <div class="mono">${escapeHTML(u.email||"")}</div>
                    </div>
                  </div>
                </td>
                <td>${planBadge(u.plan)}</td>
                <td>${u.kycStatus==="verified"||u.kycStatus==="mock_verified" ? '<span class="badge badge-ok">✓</span>' : `<span class="badge badge-warn">${u.kycStatus||"unverified"}</span>`}</td>
                <td class="mono">${escapeHTML(u.phone||"—")}</td>
                <td class="mono">${timeAgo(u.lastSignIn)}</td>
                <td><button class="btn btn-outline btn-sm">View →</button></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;

    container.querySelectorAll("[data-uid]").forEach(el => el.addEventListener("click", () => navigate("userDetail", el.dataset.uid)));
  }

  document.getElementById("user-search").addEventListener("input", debounce(load, 350));
  document.getElementById("plan-filter").addEventListener("change", load);
  await load();
}

// ----------------------------
// USER DETAIL
// ----------------------------
async function renderUserDetail(main, uid) {
  currentUserUid = uid;
  const res = await apiCall(`/api/admin/users/${uid}`);
  const { user, goals, transactions, notifications, stats } = res;
  const isVerified = user.kycStatus === "verified" || user.kycStatus === "mock_verified";
  const goalsSaved = goals.reduce((s, g) => s + (g.saved||0), 0);
  const goalsPct = goals.length ? Math.round((goals.filter(g=>g.completed).length / goals.length) * 100) : 0;

  main.innerHTML = `
    <div class="page-hdr">
      <div class="page-hdr-left">
        <div class="flex-gap" style="cursor:pointer" id="back-btn">
          <span style="color:var(--muted)">← Users</span>
        </div>
        <h2 style="margin-top:6px">${escapeHTML(user.displayName||user.email||uid)}</h2>
        <p class="mono">${escapeHTML(user.email||"")} · ${uid.slice(0,16)}...</p>
      </div>
      <div class="page-hdr-right">
        <button class="btn btn-outline btn-sm" id="send-msg-btn">💬 Message</button>
        <button class="btn ${user.disabled ? "btn-primary" : "btn-danger"} btn-sm" id="suspend-btn">
          ${user.disabled ? "✅ Restore" : "🚫 Suspend"}
        </button>
      </div>
    </div>

    <!-- STAT CARDS -->
    <div class="stat-grid">
      <div class="stat-card highlight">
        <div class="stat-icon">💰</div>
        <div class="stat-label">Total Saved</div>
        <div class="stat-value">${fmtMWK(stats.totalSaved)}</div>
        <div class="stat-footer">${stats.goalCount} goal${stats.goalCount!==1?"s":""}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">💸</div>
        <div class="stat-label">Fees Generated</div>
        <div class="stat-value">${fmtMWK(stats.totalFees)}</div>
        <div class="stat-footer">${stats.transactionCount} transactions</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">✦</div>
        <div class="stat-label">Plan</div>
        <div class="stat-value" style="font-size:16px;margin-top:4px">${planBadge(user.plan)}</div>
        <div class="stat-footer">${user.subscriptionExpiry ? `Exp: ${new Date(user.subscriptionExpiry).toLocaleDateString()}` : "No subscription"}</div>
      </div>
      <div class="stat-card ${isVerified?"":"warn"}">
        <div class="stat-icon">🔐</div>
        <div class="stat-label">KYC</div>
        <div class="stat-value" style="font-size:16px;margin-top:4px">${statusBadge(isVerified?"verified":"unverified")}</div>
        <div class="stat-footer">${escapeHTML(user.kycName||user.phone||"No phone")}</div>
      </div>
    </div>

    <!-- ADMIN ACTIONS CARD -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-hdr"><div class="card-title">Admin Controls</div></div>
      <div class="card-body">
        <div class="form-row">
          <div class="input-group">
            <label class="input-label">Change Plan</label>
            <select class="input" id="plan-select">
              <option value="free" ${user.plan==="free"?"selected":""}>Free</option>
              <option value="pro" ${user.plan==="pro"?"selected":""}>Pro</option>
              <option value="business" ${user.plan==="business"?"selected":""}>Business</option>
            </select>
          </div>
          <button class="btn btn-primary" id="apply-plan">Apply Plan</button>
          <button class="btn btn-outline" id="toggle-kyc">
            ${isVerified ? "Revoke KYC" : "Mark Verified"}
          </button>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <!-- GOALS -->
      <div class="card">
        <div class="card-hdr">
          <div><div class="card-title">Savings Goals</div><div class="card-sub">${goals.length} total · ${goalsPct}% completed</div></div>
        </div>
        ${goals.length === 0 ? `<div class="card-body"><div class="empty-state"><p>No goals yet</p></div></div>` : `
          <div class="table-wrap"><table>
            <thead><tr><th>Goal</th><th>Saved</th><th>Progress</th><th>Status</th></tr></thead>
            <tbody>
              ${goals.slice(0,8).map(g => {
                const pct = g.target > 0 ? Math.min(100, Math.round((g.saved/g.target)*100)) : 0;
                return `<tr>
                  <td>${g.emoji||"🎯"} ${escapeHTML(g.name)}</td>
                  <td>${fmtMWK(g.saved)}</td>
                  <td style="width:80px"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div></td>
                  <td>${g.completed?'<span class="badge badge-ok">Done</span>':g.locked?'<span class="badge badge-info">Locked</span>':'<span class="badge badge-warn">Active</span>'}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table></div>`}
      </div>

      <!-- RECENT TRANSACTIONS -->
      <div class="card">
        <div class="card-hdr">
          <div><div class="card-title">Recent Transactions</div><div class="card-sub">Last ${Math.min(transactions.length,10)}</div></div>
        </div>
        ${transactions.length === 0 ? `<div class="card-body"><div class="empty-state"><p>No transactions</p></div></div>` : `
          <div class="table-wrap"><table>
            <thead><tr><th>Type</th><th>Amount</th><th>Fee</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              ${transactions.slice(0,10).map(t => `<tr>
                <td style="text-transform:capitalize">${t.type}</td>
                <td>${fmtMWK(t.amount)}</td>
                <td class="mono">${t.fee?fmtMWK(t.fee):"—"}</td>
                <td>${statusBadge(t.status)}</td>
                <td class="mono">${timeAgo(t.timestamp)}</td>
              </tr>`).join("")}
            </tbody>
          </table></div>`}
      </div>
    </div>

    <!-- NOTIFICATIONS -->
    <div class="card">
      <div class="card-hdr"><div class="card-title">Notification History</div></div>
      ${notifications.length === 0 ? `<div class="card-body"><div class="empty-state"><p>No notifications</p></div></div>` : `
        <div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>Message</th><th>Read</th><th>Time</th></tr></thead>
          <tbody>
            ${notifications.slice(0,10).map(n => `<tr class="${n.read?"":"unread-row"}">
              <td>${statusBadge(n.type==="admin_message"?"info":n.type?.includes("success")?"ok":"warn")}</td>
              <td>${escapeHTML(n.topic ? `[${n.topic}] ` : "")}${escapeHTML(n.message)}</td>
              <td>${n.read?'<span class="text-muted">Read</span>':'<span class="text-green">Unread</span>'}</td>
              <td class="mono">${timeAgo(n.timestamp)}</td>
            </tr>`).join("")}
          </tbody>
        </table></div>`}
    </div>
  `;

  document.getElementById("back-btn").onclick = () => navigate("users");

  document.getElementById("apply-plan").onclick = async () => {
    const plan = document.getElementById("plan-select").value;
    const btn = document.getElementById("apply-plan");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await apiCall(`/api/admin/users/${uid}`, "PATCH", { plan });
      toast(`Plan updated to ${plan}`); navigate("userDetail", uid);
    } catch (e) { toast(e.message, "error"); btn.disabled = false; btn.textContent = "Apply Plan"; }
  };

  document.getElementById("toggle-kyc").onclick = async () => {
    const btn = document.getElementById("toggle-kyc"); btn.disabled = true;
    try {
      await apiCall(`/api/admin/users/${uid}`, "PATCH", { kycStatus: isVerified?"unverified":"verified", phoneVerified:!isVerified });
      toast("KYC updated"); navigate("userDetail", uid);
    } catch (e) { toast(e.message, "error"); btn.disabled = false; }
  };

  document.getElementById("send-msg-btn").onclick = () => openSendMessageModal(uid, user.email);
  document.getElementById("suspend-btn").onclick = async () => {
    if (!confirm(`${user.disabled?"Restore":"Suspend"} this account?`)) return;
    const btn = document.getElementById("suspend-btn"); btn.disabled = true;
    try {
      await apiCall(`/api/admin/users/${uid}/suspend`, "PATCH", { suspended: !user.disabled });
      toast(`Account ${user.disabled?"restored":"suspended"}`); navigate("userDetail", uid);
    } catch (e) { toast(e.message, "error"); btn.disabled = false; }
  };
}

// ----------------------------
// TRANSACTIONS
// ----------------------------
async function renderTransactions(main) {
  main.innerHTML = `
    <div class="page-hdr">
      <div class="page-hdr-left"><h2>Transactions</h2><p>Search and manage all transactions across all users</p></div>
    </div>
    <div class="form-row">
      <div class="search-bar" style="flex:2">
        <span class="search-icon">🔍</span>
        <input id="tx-q" placeholder="Reference, phone or Airtel ID...">
      </div>
      <div class="input-group" style="width:140px;margin-bottom:0">
        <select class="input" id="tx-status">
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="mock">Mock</option>
        </select>
      </div>
      <div class="input-group" style="width:140px;margin-bottom:0">
        <select class="input" id="tx-type">
          <option value="">All Types</option>
          <option value="savings">Savings</option>
          <option value="withdrawal">Withdrawal</option>
          <option value="subscription">Subscription</option>
          <option value="collection">Collection</option>
          <option value="disbursement">Disbursement</option>
          <option value="roundup">Round-up</option>
        </select>
      </div>
    </div>
    <div class="card" id="tx-list"><div class="loading-row"><span class="spinner"></span></div></div>
  `;

  async function loadTx() {
    const q = document.getElementById("tx-q").value.trim();
    const status = document.getElementById("tx-status").value;
    const type = document.getElementById("tx-type").value;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    if (type) params.set("type", type);
    const el = document.getElementById("tx-list");
    el.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    const res = await apiCall(`/api/admin/transactions?${params}`);
    const txs = res.transactions || [];
    if (!txs.length) { el.innerHTML = `<div class="card-body"><div class="empty-state"><p>No transactions found</p></div></div>`; return; }
    el.innerHTML = `
      <div class="card-hdr"><div class="card-title">${txs.length} result${txs.length!==1?"s":""}</div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Type</th><th>Amount</th><th>Fee</th><th>Status</th><th>Reference</th><th>User</th><th>Date</th><th>Override</th></tr></thead>
        <tbody>
          ${txs.map(t => `<tr>
            <td style="text-transform:capitalize">${t.type||"—"}</td>
            <td>${fmtMWK(t.amount)}</td>
            <td class="mono">${t.fee?fmtMWK(t.fee):"—"}</td>
            <td>${statusBadge(t.status)}</td>
            <td class="mono" style="max-width:120px" title="${t.reference||""}">${(t.reference||"—").slice(0,14)}…</td>
            <td class="mono">${(t.uid||"").slice(0,10)}</td>
            <td class="mono">${timeAgo(t.timestamp)}</td>
            <td>${t.status==="pending"?`
              <select class="input btn-sm" style="padding:4px 8px;font-size:11px" data-tx="${t.id}">
                <option value="">Change...</option>
                <option value="completed">completed</option>
                <option value="failed">failed</option>
              </select>`:""}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;

    el.querySelectorAll("[data-tx]").forEach(sel => {
      sel.addEventListener("change", async () => {
        const status = sel.value; if (!status) return;
        if (!confirm(`Override to "${status}"?`)) { sel.value = ""; return; }
        try { await apiCall(`/api/admin/transactions/${sel.dataset.tx}`, "PATCH", { status }); toast("Updated"); loadTx(); }
        catch (e) { toast(e.message, "error"); sel.value = ""; }
      });
    });
  }

  ["tx-q","tx-status","tx-type"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.addEventListener("input", debounce(loadTx, 350)); el.addEventListener("change", loadTx); }
  });
  await loadTx();
}

// ----------------------------
// MESSAGES
// ----------------------------
async function renderMessages(main) {
  const history = await apiCall("/api/admin/messages");
  const msgs = history.messages || [];
  let usersCache = [];
  try { const r = await apiCall("/api/admin/users?limit=200"); usersCache = r.users || []; } catch {}

  main.innerHTML = `
    <div class="page-hdr">
      <div class="page-hdr-left"><h2>Messages</h2><p>Send notifications directly to users from PocketVault Admin</p></div>
    </div>

    <div class="grid-6-4">
      <div class="card">
        <div class="card-hdr"><div class="card-title">📨 Send Message</div></div>
        <div class="card-body">
          <div class="input-group">
            <label class="input-label">Recipient</label>
            <select class="input" id="msg-target">
              <option value="">📢 Broadcast to ALL users</option>
              ${usersCache.map(u => `<option value="${u.uid}">${escapeHTML(u.displayName||u.email||u.uid)}</option>`).join("")}
            </select>
          </div>
          <div class="input-group">
            <label class="input-label">Subject / Topic</label>
            <input class="input" id="msg-topic" placeholder="e.g. System Update, Account Notice">
          </div>
          <div class="input-group">
            <label class="input-label">✦ Draft with AI (optional)</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="ai-draft-intent" placeholder="e.g. remind users to verify their KYC" style="flex:1">
              <button class="btn btn-outline btn-sm" id="ai-draft-btn" style="white-space:nowrap">✦ Draft</button>
            </div>
          </div>
          <div class="input-group">
            <label class="input-label">Message</label>
            <textarea class="input" id="msg-text" rows="4" placeholder="Write your message..." style="resize:vertical"></textarea>
          </div>
          <div id="msg-error" class="auth-error" style="display:none"></div>
          <button class="btn btn-primary btn-block" id="msg-send">🛡️ Send as PocketVault Admin</button>
        </div>
      </div>

      <div class="card">
        <div class="card-hdr"><div class="card-title">Message History</div></div>
        ${msgs.length === 0
          ? `<div class="card-body"><div class="empty-state"><div class="empty-icon">✉️</div><p>No messages sent yet</p></div></div>`
          : `<div class="table-wrap"><table>
              <thead><tr><th>To</th><th>Subject</th><th>Sent</th></tr></thead>
              <tbody>
                ${msgs.map(m => `<tr>
                  <td>${m.broadcast ? '<span class="badge badge-warn">Broadcast</span>' : `<span class="mono">${escapeHTML((m.uid||"").slice(0,12))}</span>`}</td>
                  <td class="truncate" style="max-width:140px">${escapeHTML(m.topic||m.message||"—")}</td>
                  <td class="mono">${timeAgo(m.timestamp)}</td>
                </tr>`).join("")}
              </tbody>
            </table></div>`}
      </div>
    </div>
  `;

  document.getElementById("ai-draft-btn").onclick = async () => {
    const intent = document.getElementById("ai-draft-intent").value.trim();
    if (!intent) { toast("Describe what the message should say first", "error"); return; }
    const btn = document.getElementById("ai-draft-btn");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await apiCall("/api/admin/ai/draft-message", "POST", { intent });
      document.getElementById("msg-text").value = res.message || "";
      if (res.topic) document.getElementById("msg-topic").value = res.topic;
      toast("✦ Draft ready — review before sending");
    } catch (e) {
      toast(e.message, "error");
    }
    btn.disabled = false; btn.innerHTML = "✦ Draft";
  };

  document.getElementById("msg-send").onclick = async () => {
    const uid = document.getElementById("msg-target").value || null;
    const topic = document.getElementById("msg-topic").value.trim();
    const message = document.getElementById("msg-text").value.trim();
    const errBox = document.getElementById("msg-error");
    const btn = document.getElementById("msg-send");
    if (!message) { errBox.style.display = "block"; errBox.textContent = "Message is required"; return; }
    errBox.style.display = "none"; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Sending...`;
    try {
      const res = await apiCall("/api/admin/messages", "POST", { uid, message, topic });
      toast(`✅ Sent to ${res.sent} user${res.sent!==1?"s":""}`);
      navigate("messages");
    } catch (e) {
      errBox.style.display = "block"; errBox.textContent = e.message;
      btn.disabled = false; btn.textContent = "🛡️ Send as PocketVault Admin";
    }
  };
}

// ----------------------------
// NOTIFICATIONS (admin view of all)
// ----------------------------
async function renderNotificationsAdmin(main) {
  main.innerHTML = `<div class="page-hdr"><div class="page-hdr-left"><h2>Notifications Feed</h2><p>All user notifications across PocketVault</p></div></div>
    <div class="card"><div class="loading-row"><span class="spinner"></span></div></div>`;
  // Just link to transactions for now and show a summary from overview
  navigate("overview");
}

// ----------------------------
// OPERATIONS
// ----------------------------
async function renderOperations(main) {
  const res = await apiCall("/api/admin/operations");
  const { floatHistory, pendingTransactions, inbox, alerts, queueLength } = res;
  const latest = floatHistory[0];
  const maxFloat = Math.max(1, ...floatHistory.map(f => f.balance||0));
  const floatData = floatHistory.slice(0,20).reverse().map(f => f.balance||0);
  const floatLabels = floatHistory.slice(0,20).reverse().map(f => timeAgo(f.timestamp).replace(" ago",""));

  main.innerHTML = `
    <div class="page-hdr">
      <div class="page-hdr-left"><h2>Operations</h2><p>System health, float, and pipeline status</p></div>
      <div class="page-hdr-right">
        <span class="topbar-badge ${queueLength>0?"amber":""}">Queue: ${queueLength}</span>
        <button class="btn btn-outline btn-sm" onclick="navigate('operations')">↻ Refresh</button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card ${latest?.status==="low"?"danger":""}">
        <div class="stat-icon">🏦</div>
        <div class="stat-label">Current Float</div>
        <div class="stat-value">${latest ? fmtMWK(latest.balance) : "—"}</div>
        <div class="stat-footer">${latest ? timeAgo(latest.timestamp) : "Not measured"}</div>
      </div>
      <div class="stat-card ${pendingTransactions.length>0?"warn":""}">
        <div class="stat-icon">⏳</div>
        <div class="stat-label">Pending Transactions</div>
        <div class="stat-value">${pendingTransactions.length}</div>
        <div class="stat-footer">awaiting reconciliation</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📲</div>
        <div class="stat-label">Webhook Inbox</div>
        <div class="stat-value">${inbox.length}</div>
        <div class="stat-footer">recent events</div>
      </div>
      <div class="stat-card ${alerts.filter(a=>!a.resolved).length>0?"warn":""}">
        <div class="stat-icon">🔔</div>
        <div class="stat-label">Open Alerts</div>
        <div class="stat-value">${alerts.filter(a=>!a.resolved).length}</div>
        <div class="stat-footer">of ${alerts.length} total</div>
      </div>
    </div>

    <div class="grid-7-3">
      <div class="card">
        <div class="card-hdr"><div><div class="card-title">Float History</div><div class="card-sub">Corporate wallet balance over time</div></div></div>
        <div class="card-body">
          ${floatData.length === 0
            ? `<div class="empty-state"><p>No float data yet — appears once Airtel is configured</p></div>`
            : lineChart(floatData, {color:"#00e5a0"})}
          ${floatData.length > 0 ? `<div class="chart-legend">
            <div class="legend-item"><div class="legend-dot" style="background:var(--green)"></div>Wallet Balance</div>
            <div class="legend-item" style="color:var(--muted)">Threshold: ${fmtMWK(res.floatHistory[0]?.threshold||50000)}</div>
          </div>` : ""}
        </div>
      </div>

      <div class="card">
        <div class="card-hdr"><div class="card-title">Airtel Queue</div></div>
        <div class="card-body">
          <div class="donut-wrap">
            ${donutChart(
              [{value: Math.max(queueLength, 0.01), color: queueLength>0?"#f59e0b":"#00e5a0", label:""}],
              Math.max(queueLength, 1), queueLength, "in queue"
            )}
          </div>
          <p style="text-align:center;font-size:12px;color:var(--muted);margin-top:8px">
            ${queueLength === 0 ? "✅ No pending API calls" : `${queueLength} call${queueLength!==1?"s":""} queued`}
          </p>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-hdr">
          <div><div class="card-title">Pending Transactions</div><div class="card-sub">${pendingTransactions.length} awaiting reconciliation</div></div>
        </div>
        ${pendingTransactions.length === 0
          ? `<div class="card-body"><div class="empty-state"><div class="empty-icon">✅</div><p>All clear</p></div></div>`
          : `<div class="table-wrap"><table>
              <thead><tr><th>Type</th><th>Amount</th><th>User</th><th>Age</th></tr></thead>
              <tbody>${pendingTransactions.slice(0,10).map(t=>`<tr>
                <td style="text-transform:capitalize">${t.type}</td>
                <td>${fmtMWK(t.amount)}</td>
                <td class="mono">${(t.uid||"").slice(0,10)}</td>
                <td class="mono">${timeAgo(t.timestamp)}</td>
              </tr>`).join("")}</tbody>
            </table></div>`}
      </div>

      <div class="card">
        <div class="card-hdr"><div class="card-title">Alerts</div></div>
        ${alerts.length === 0
          ? `<div class="card-body"><div class="empty-state"><div class="empty-icon">✅</div><p>No alerts</p></div></div>`
          : `<div class="table-wrap"><table>
              <thead><tr><th>Message</th><th>Status</th><th>Time</th><th></th></tr></thead>
              <tbody>${alerts.slice(0,8).map(a=>`<tr>
                <td style="max-width:160px" class="truncate">${escapeHTML(a.message)}</td>
                <td>${a.resolved?'<span class="badge badge-ok">Resolved</span>':'<span class="badge badge-warn">Open</span>'}</td>
                <td class="mono">${timeAgo(a.timestamp)}</td>
                <td>${!a.resolved?`<button class="btn btn-ghost btn-sm btn-icon" data-resolve="${a.id}">✓</button>`:""}</td>
              </tr>`).join("")}</tbody>
            </table></div>`}
      </div>
    </div>

    <!-- INBOX -->
    <div class="card">
      <div class="card-hdr"><div class="card-title">Webhook Inbox</div><div class="card-sub">Recent Airtel notifications</div></div>
      ${inbox.length === 0
        ? `<div class="card-body"><div class="empty-state"><p>No webhook activity yet</p></div></div>`
        : `<div class="table-wrap"><table>
            <thead><tr><th>Message</th><th>Amount</th><th>TID</th><th>Source</th><th>Time</th></tr></thead>
            <tbody>${inbox.map(i=>`<tr>
              <td>${escapeHTML(i.message||"—")}</td>
              <td>${i.amount?fmtMWK(i.amount):"—"}</td>
              <td class="mono">${escapeHTML(i.tid||"—")}</td>
              <td class="mono">${escapeHTML(i.source||"—")}</td>
              <td class="mono">${timeAgo(i.timestamp)}</td>
            </tr>`).join("")}</tbody>
          </table></div>`}
    </div>
  `;

  main.querySelectorAll("[data-resolve]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await apiCall(`/api/admin/alerts/${btn.dataset.resolve}`, "PATCH").catch(()=>{});
      toast("Alert resolved"); navigate("operations");
    });
  });
}

// ----------------------------
// ERRORS
// ----------------------------
async function renderErrors(main) {
  const res = await apiCall("/api/admin/errors");
  const errors = res.errors || [];
  const unread = res.unread || 0;

  main.innerHTML = `
    <div class="page-hdr">
      <div class="page-hdr-left"><h2>System Errors</h2><p>${unread} unread · ${errors.length} total</p></div>
      <div class="page-hdr-right">
        ${unread > 0 ? `<button class="btn btn-primary btn-sm" id="ai-analyze-errors">✦ Analyze with AI</button>` : ""}
        ${unread > 0 ? `<button class="btn btn-outline btn-sm" id="mark-all-read">Mark All Read</button>` : ""}
        <button class="btn btn-outline btn-sm" onclick="navigate('errors')">↻ Refresh</button>
      </div>
    </div>
    <div id="ai-error-analysis"></div>
    <div class="card">
      ${errors.length === 0
        ? `<div class="card-body"><div class="empty-state"><div class="empty-icon">✅</div><p>No errors logged</p></div></div>`
        : `<div class="table-wrap"><table>
            <thead><tr><th>Source</th><th>Message</th><th>Stack</th><th>Time</th><th></th></tr></thead>
            <tbody>
              ${errors.map(e => `<tr style="${!e.read?"background:rgba(244,63,94,0.04)":""}">
                <td><span class="badge badge-warn">${escapeHTML(e.source||"—")}</span></td>
                <td style="max-width:200px">
                  <div style="font-weight:${e.read?400:600};font-size:13px" class="truncate">${escapeHTML(e.message||"—")}</div>
                </td>
                <td style="max-width:200px">
                  <div class="mono" style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;opacity:0.5">
                    ${escapeHTML((e.stack||"").split("\\n").slice(0,1).join(""))}
                  </div>
                </td>
                <td class="mono">${timeAgo(e.timestamp)}</td>
                <td>${!e.read?`<button class="btn btn-ghost btn-sm btn-icon" data-err="${e.id}">✓</button>`:""}</td>
              </tr>`).join("")}
            </tbody>
          </table></div>`}
    </div>
  `;

  document.getElementById("mark-all-read")?.addEventListener("click", async () => {
    await apiCall("/api/admin/errors/read-all", "POST");
    toast("All cleared"); navigate("errors");
  });

  document.getElementById("ai-analyze-errors")?.addEventListener("click", async () => {
    const btn = document.getElementById("ai-analyze-errors");
    const panel = document.getElementById("ai-error-analysis");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Analyzing...`;
    panel.innerHTML = `<div class="card"><div class="card-body"><div class="loading-row"><span class="spinner"></span> AI is reviewing your errors...</div></div></div>`;
    try {
      const res = await apiCall("/api/admin/ai/analyze-errors", "POST", {});
      const cachedBadge = res.cached ? `<span class="badge" style="background:rgba(14,165,233,0.12);color:var(--blue);margin-left:6px;font-size:9px">CACHED</span>` : "";
      panel.innerHTML = `
        <div class="card" style="border-color:rgba(0,229,160,0.25)">
          <div class="card-hdr"><div class="card-title">✦ AI Error Analysis ${cachedBadge}</div></div>
          <div class="card-body">
            <div style="white-space:pre-wrap;font-size:13px;line-height:1.7;color:var(--text)">${escapeHTML(res.analysis)}</div>
          </div>
        </div>`;
    } catch (e) {
      const icon = e.status === 429 ? "⏳" : "⚠️";
      panel.innerHTML = `<div class="card"><div class="card-body"><div class="empty-state"><div class="empty-icon">${icon}</div><p>${escapeHTML(e.message)}</p></div></div></div>`;
    }
    btn.disabled = false; btn.innerHTML = "✦ Analyze with AI";
  });

  main.querySelectorAll("[data-err]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await apiCall(`/api/admin/errors/${btn.dataset.err}`, "PATCH");
      btn.closest("tr").style.background = "";
      btn.remove();
    });
  });
}

// ----------------------------
// AI ASSISTANT — CHAT
// ----------------------------
let aiChatHistory = [];

async function renderAIAssistant(main) {
  let insightData = null;
  let statusData = null;
  try { statusData = await apiCall("/api/admin/ai/status"); } catch { statusData = { configured: false }; }
  try { insightData = await apiCall("/api/admin/ai/insights"); } catch (e) { insightData = { error: e.message }; }

  main.innerHTML = `
    <div class="page-hdr">
      <div class="page-hdr-left"><h2>✦ AI Assistant</h2><p>Ask questions about your platform in plain English</p></div>
      <div class="page-hdr-right">
        ${statusData.configured
          ? `<span class="badge" style="background:rgba(0,229,160,0.12);color:var(--green)">● ${escapeHTML(statusData.providerLabel)}</span>`
          : `<span class="badge" style="background:rgba(244,63,94,0.12);color:var(--red)">● Not configured</span>`}
      </div>
    </div>

    ${!statusData.configured ? `
      <div class="card" style="margin-bottom:16px;border-color:rgba(245,158,11,0.3)">
        <div class="card-body">
          <p style="font-size:13px;color:var(--amber)">⚠ No AI provider is configured. Set <span class="mono">ANTHROPIC_API_KEY</span> or <span class="mono">GEMINI_API_KEY</span> in Render environment variables to enable this page.</p>
        </div>
      </div>
    ` : ""}

    <div class="card" style="margin-bottom:16px">
      <div class="card-hdr">
        <div class="card-title">📊 This Week's Insights ${insightData?.cached ? `<span class="badge" style="background:rgba(14,165,233,0.12);color:var(--blue);margin-left:6px;font-size:9px">CACHED</span>` : ""}</div>
        <button class="btn btn-outline btn-sm" id="refresh-insights">↻ Refresh</button>
      </div>
      <div class="card-body" id="insights-body">
        ${insightData?.isRateLimit
          ? `<div class="empty-state"><div class="empty-icon">⏳</div><p>${escapeHTML(insightData.error)}</p></div>`
          : insightData?.error
          ? `<div class="empty-state"><p>${escapeHTML(insightData.error)}</p></div>`
          : `<div style="white-space:pre-wrap;font-size:13.5px;line-height:1.7;color:var(--text)">${escapeHTML(insightData.insight)}</div>`}
      </div>
    </div>

    <div class="card">
      <div class="card-hdr"><div class="card-title">💬 Ask the Assistant</div></div>
      <div class="card-body">
        <div id="chat-log" style="max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:12px;margin-bottom:14px">
          ${aiChatHistory.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">✦</div>
              <p>Ask things like "which users are close to reaching a goal?" or "summarize revenue this month"</p>
            </div>
          ` : aiChatHistory.map(m => chatBubble(m)).join("")}
        </div>
        <div style="display:flex;gap:8px">
          <input class="input" id="chat-input" placeholder="Ask a question about your platform..." style="flex:1">
          <button class="btn btn-primary" id="chat-send">Ask</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("refresh-insights").onclick = async () => {
    const body = document.getElementById("insights-body");
    const cardTitle = document.querySelector(".card-title");
    body.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const res = await apiCall("/api/admin/ai/insights");
      const cachedBadge = res.cached ? `<span class="badge" style="background:rgba(14,165,233,0.12);color:var(--blue);margin-left:6px;font-size:9px">CACHED</span>` : "";
      body.innerHTML = `<div style="white-space:pre-wrap;font-size:13.5px;line-height:1.7;color:var(--text)">${escapeHTML(res.insight)}</div>`;
      if (cardTitle) cardTitle.innerHTML = `📊 This Week's Insights ${cachedBadge}`;
    } catch (e) {
      if (e.status === 429) {
        body.innerHTML = `<div class="empty-state"><div class="empty-icon">⏳</div><p>${escapeHTML(e.message)}</p></div>`;
      } else {
        body.innerHTML = `<div class="empty-state"><p>${escapeHTML(e.message)}</p></div>`;
      }
    }
  };

  function chatBubble(m) {
    const isUser = m.role === "user";
    return `
      <div style="display:flex;${isUser ? "justify-content:flex-end" : "justify-content:flex-start"}">
        <div style="max-width:80%;padding:10px 14px;border-radius:14px;font-size:13px;line-height:1.6;
          background:${isUser ? "var(--green-dim)" : "var(--surface2)"};
          color:${isUser ? "var(--green)" : "var(--text)"};
          border:1px solid ${isUser ? "rgba(0,229,160,0.2)" : "var(--border)"}">
          ${!isUser ? '<div style="font-size:10px;font-weight:800;color:var(--purple);margin-bottom:4px">✦ AI Assistant</div>' : ""}
          <div style="white-space:pre-wrap">${escapeHTML(m.content)}</div>
        </div>
      </div>`;
  }

  async function sendChat() {
    const input = document.getElementById("chat-input");
    const question = input.value.trim();
    if (!question) return;
    const log = document.getElementById("chat-log");
    const btn = document.getElementById("chat-send");

    aiChatHistory.push({ role: "user", content: question });
    log.innerHTML = aiChatHistory.map(m => chatBubble(m)).join("") +
      `<div style="display:flex;justify-content:flex-start"><div style="padding:10px 14px;border-radius:14px;background:var(--surface2);border:1px solid var(--border)"><span class="spinner"></span></div></div>`;
    log.scrollTop = log.scrollHeight;
    input.value = "";
    btn.disabled = true;

    try {
      const res = await apiCall("/api/admin/ai/chat", "POST", {
        question,
        history: aiChatHistory.slice(-6, -1)
      });
      aiChatHistory.push({ role: "assistant", content: res.answer });
    } catch (e) {
      const msg = e.status === 429 ? `⏳ ${e.message}` : `⚠️ ${e.message}`;
      aiChatHistory.push({ role: "assistant", content: msg });
    }
    log.innerHTML = aiChatHistory.map(m => chatBubble(m)).join("");
    log.scrollTop = log.scrollHeight;
    btn.disabled = false;
  }

  document.getElementById("chat-send").onclick = sendChat;
  document.getElementById("chat-input").addEventListener("keydown", e => {
    if (e.key === "Enter") sendChat();
  });
}

// ----------------------------
// AI ANOMALY DETECTION
// ----------------------------
async function renderAIAnomalies(main) {
  main.innerHTML = `
    <div class="page-hdr">
      <div class="page-hdr-left"><h2>⚠ Anomaly Detection</h2><p>AI-reviewed unusual transaction patterns</p></div>
      <div class="page-hdr-right">
        <button class="btn btn-primary btn-sm" id="scan-btn">✦ Scan Now</button>
      </div>
    </div>
    <div id="anomaly-results">
      <div class="card"><div class="card-body"><div class="empty-state">
        <div class="empty-icon">⚠</div>
        <p>Click "Scan Now" to analyze recent transactions for unusual patterns</p>
      </div></div></div>
    </div>
  `;

  document.getElementById("scan-btn").onclick = async () => {
    const btn = document.getElementById("scan-btn");
    const results = document.getElementById("anomaly-results");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Scanning...`;
    results.innerHTML = `<div class="card"><div class="card-body"><div class="loading-row"><span class="spinner"></span> AI is reviewing transaction patterns...</div></div></div>`;

    try {
      const res = await apiCall("/api/admin/ai/anomalies");
      const anomalies = res.anomalies || [];
      const cachedBadge = res.cached ? `<span class="badge" style="background:rgba(14,165,233,0.12);color:var(--blue);margin-left:6px;font-size:9px">CACHED</span>` : "";
      const rateLimitBanner = res.isRateLimit
        ? `<div class="card" style="margin-bottom:14px;border-color:rgba(245,158,11,0.3)"><div class="card-body"><p style="font-size:13px;color:var(--amber)">⏳ ${escapeHTML(res.summary)}</p></div></div>`
        : "";

      if (anomalies.length === 0) {
        results.innerHTML = `${rateLimitBanner}<div class="card"><div class="card-body"><div class="empty-state">
          <div class="empty-icon">✅</div><p>${escapeHTML(res.summary || "No unusual patterns detected")}</p>
        </div></div></div>`;
      } else {
        const riskColor = { high: "var(--red)", medium: "var(--amber)", low: "var(--muted)", unknown: "var(--muted)" };
        results.innerHTML = `
          ${rateLimitBanner}
          <div class="card" style="margin-bottom:14px">
            <div class="card-hdr"><div class="card-title">Summary ${cachedBadge}</div></div>
            <div class="card-body"><p style="font-size:13.5px;color:var(--text);line-height:1.6">${escapeHTML(res.summary)}</p></div>
          </div>
          ${anomalies.map(a => `
            <div class="card">
              <div class="card-body">
                <div class="flex-between" style="margin-bottom:8px">
                  <div class="flex-gap">
                    <span class="badge" style="background:${riskColor[a.risk]}22;color:${riskColor[a.risk]}">${(a.risk||"unknown").toUpperCase()} RISK</span>
                    <span class="mono">${escapeHTML(a.email || a.uid)}</span>
                  </div>
                  <button class="btn btn-outline btn-sm" data-view-user="${a.uid}">View User →</button>
                </div>
                <p style="font-size:13px;color:var(--text);margin-bottom:6px">${escapeHTML(a.reason || "")}</p>
                <p style="font-size:12px;color:var(--green)"><strong>Suggested:</strong> ${escapeHTML(a.suggestedAction || "Review manually")}</p>
                <div style="display:flex;gap:14px;margin-top:8px;font-size:11px;color:var(--muted)">
                  ${a.largeTransactions ? `<span>${a.largeTransactions} large tx</span>` : ""}
                  ${a.rapidTransactions ? `<span>${a.rapidTransactions} rapid tx</span>` : ""}
                  ${a.failedTransactions ? `<span>${a.failedTransactions} failed tx</span>` : ""}
                </div>
              </div>
            </div>
          `).join("")}
        `;
        results.querySelectorAll("[data-view-user]").forEach(b => {
          b.addEventListener("click", () => navigate("userDetail", b.dataset.viewUser));
        });
      }
    } catch (e) {
      results.innerHTML = `<div class="card"><div class="card-body"><div class="empty-state"><p>${escapeHTML(e.message)}</p></div></div></div>`;
    }
    btn.disabled = false; btn.innerHTML = "✦ Scan Now";
  };
}

// ----------------------------
// SEND MESSAGE MODAL (from user detail)
// ----------------------------
function openSendMessageModal(uid, email) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <div class="modal-hdr">
        <h3>💬 Message User</h3>
        <button class="modal-close" id="m-close">✕</button>
      </div>
      <p class="modal-sub">Sending to: <strong>${escapeHTML(email||uid)}</strong></p>
      <div class="input-group">
        <label class="input-label">Subject</label>
        <input class="input" id="dm-topic" placeholder="e.g. Account Notice">
      </div>
      <div class="input-group">
        <label class="input-label">Message</label>
        <textarea class="input" id="dm-text" rows="4" style="resize:vertical"></textarea>
      </div>
      <div id="dm-error" class="auth-error" style="display:none"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="dm-cancel">Cancel</button>
        <button class="btn btn-primary" id="dm-send">🛡️ Send</button>
      </div>
    </div>`;
  root.classList.add("open");
  root.querySelector("#m-close").onclick = root.querySelector("#dm-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });
  root.querySelector("#dm-send").onclick = async () => {
    const message = document.getElementById("dm-text").value.trim();
    const topic = document.getElementById("dm-topic").value.trim();
    const errBox = document.getElementById("dm-error");
    const btn = root.querySelector("#dm-send");
    if (!message) { errBox.style.display = "block"; errBox.textContent = "Enter a message"; return; }
    errBox.style.display = "none"; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await apiCall("/api/admin/messages", "POST", { uid, message, topic });
      closeModal(); toast("Message sent ✅");
    } catch (e) {
      errBox.style.display = "block"; errBox.textContent = e.message;
      btn.disabled = false; btn.textContent = "🛡️ Send";
    }
  };
}

// ----------------------------
// BADGE POLLING
// ----------------------------
async function pollBadges() {
  try {
    const res = await apiCall("/api/admin/errors");
    const unread = res.unread || 0;
    document.querySelectorAll("[data-page='errors']").forEach(el => {
      el.querySelectorAll(".nav-badge-count").forEach(b => b.remove());
      if (unread > 0) {
        const b = document.createElement("span");
        b.className = "nav-badge-count";
        b.textContent = unread > 99 ? "99+" : unread;
        el.appendChild(b);
      }
    });
  } catch {}
}

// ----------------------------
// ENTRY POINT
// ----------------------------
(function init() {
  const secret = sessionStorage.getItem(SESSION_KEY);
  if (secret) {
    renderShell(); navigate("overview");
    setInterval(pollBadges, 60000);
    setTimeout(pollBadges, 3000);
  } else {
    renderLogin();
  }
})();
