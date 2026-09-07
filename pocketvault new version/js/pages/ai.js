import { api } from "../../api.js";
import { state } from "../core/state.js";

function escapeHTML(value = "") {
  return String(value).replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}

function renderMessage(role, text) {
  const user = role === "user";
  return `<div class="ai-message ${user ? "ai-message-user" : "ai-message-assistant"} ${user ? "" : "ai-message-ai"}">
    <div class="ai-message-meta">
      ${user ? "You" : '<span class="ai-mini-avatar" aria-hidden="true">✦</span> PocketVault AI'}
    </div>
    <div class="ai-message-body">${escapeHTML(text).replace(/\n/g, "<br>")}</div>
  </div>`;
}

function renderInsight(item) {
  const severity = ["positive", "warning", "info"].includes(item?.severity) ? item.severity : "info";
  const icon = severity === "positive" ? "↗" : severity === "warning" ? "!" : "✦";
  return `<article class="ai-insight ai-insight-${severity}">
    <div class="ai-insight-icon" aria-hidden="true">${icon}</div>
    <div><div class="ai-insight-title">${escapeHTML(item?.title || "PocketVault insight")}</div><div class="ai-insight-text">${escapeHTML(item?.text || "")}</div></div>
  </article>`;
}

export async function renderAIPage(main, navigate) {
  let status;
  let insightData;
  try {
    [status, insightData] = await Promise.all([api.aiStatus(), api.aiInsights()]);
  } catch (err) {
    try { status = await api.aiStatus(); } catch (e) { status = { error: e.message }; }
    insightData = { insights: [] };
  }

  const limit = Number(status?.dailyMessageLimit ?? 5);
  const used = Number(status?.used ?? 0);
  const remaining = Math.max(0, Number(status?.remaining ?? limit - used));
  const plan = String(status?.plan || state.plan || "free").toLowerCase();
  const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const configured = status?.configured !== false;
  const insights = Array.isArray(insightData?.insights) ? insightData.insights : [];
  const firstName = state.user?.displayName ? state.user.displayName.split(" ")[0] : "";

  main.innerHTML = `<section class="ai-page">
    <header class="ai-header">
      <div class="ai-branding">
        <div class="ai-orb" aria-hidden="true"><span>✦</span></div>
        <div class="ai-title-wrap">
          <div class="ai-brand-row"><span class="eyebrow">POCKETVAULT AI</span><span class="ai-status"><i></i> ${configured ? "Online" : "Offline"}</span></div>
          <h1>Your money, understood.</h1>
          <p>Your personal financial assistant for understanding savings, spending, goals, and recent activity — without moving your money.</p>
        </div>
      </div>
      <div class="ai-usage-card">
        <div class="ai-usage-heading"><span>AI usage</span><strong>${escapeHTML(plan)} plan</strong></div>
        <div class="ai-usage-number"><b>${remaining}</b><span>questions left today</span></div>
        <div class="ai-progress" role="progressbar" aria-label="AI questions used today" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${used}"><span style="width:${percent}%"></span></div>
        <small>${used} of ${limit} used today</small>
      </div>
    </header>

    <div class="ai-layout">
      <div class="ai-chat-card">
        <div class="ai-chat-header">
          <div class="ai-assistant-identity"><div class="ai-avatar" aria-hidden="true">✦</div><div><strong>PocketVault AI</strong><span>Personal financial assistant · Read-only</span></div></div>
          <span class="ai-live-badge"><i></i> Ready</span>
        </div>
        <div class="ai-chat" id="ai-chat">
          ${renderMessage("assistant", `Hi${firstName ? ` ${firstName}` : ""}. I’m ready to help you make sense of your PocketVault activity. Ask me anything about your savings, spending, goals, or transactions.`)}
        </div>
        <div class="ai-prompt-heading"><span>Try asking</span><small>Quick insights from your data</small></div>
        <div class="ai-prompts" id="ai-prompts">
          <button type="button" data-prompt="How am I doing with my savings?"><span>◎</span><b>How am I doing?</b><small>Review savings progress</small></button>
          <button type="button" data-prompt="What did I spend recently?"><span>◈</span><b>Review my spending</b><small>Find recent patterns</small></button>
          <button type="button" data-prompt="How much can I save?"><span>↗</span><b>How much can I save?</b><small>Explore your pace</small></button>
          <button type="button" data-prompt="Analyze my savings progress."><span>✦</span><b>Analyze my progress</b><small>Get a bigger picture</small></button>
        </div>
        <form class="ai-composer" id="ai-form">
          <div class="ai-input-wrap"><span class="ai-input-icon" aria-hidden="true">✦</span><input id="ai-input" maxlength="1000" autocomplete="off" aria-label="Ask PocketVault AI" placeholder="Ask about your money..."/><span class="ai-char-count" id="ai-char-count">0/1000</span></div>
          <button class="btn btn-primary ai-send" type="submit" aria-label="Send question"><span>Ask AI</span><b>↗</b></button>
        </form>
        <div class="ai-disclaimer"><span aria-hidden="true">⌁</span> AI explains your PocketVault data; it does not move, withdraw, or spend your money.</div>
      </div>

      <aside class="ai-side-card">
        <div class="ai-side-heading"><div><span class="eyebrow">PERSONALIZED</span><h3>Today’s insights</h3></div><span class="ai-insight-count">${insights.length}</span></div>
        <div class="ai-insights" id="ai-insights">${insights.length ? insights.map(renderInsight).join("") : '<div class="ai-empty-insight"><span>✦</span><b>No new insight yet</b><small>Keep using PocketVault and I’ll look for useful patterns.</small></div>'}</div>
        <div class="ai-help-heading"><span>CAPABILITIES</span><h3>What I can help with</h3></div>
        <div class="ai-help-grid">
          <div class="ai-help-item"><span>◎</span><div><b>Saving</b><small>Progress and saving habits</small></div></div>
          <div class="ai-help-item"><span>◈</span><div><b>Spending</b><small>Patterns and recent activity</small></div></div>
          <div class="ai-help-item"><span>◇</span><div><b>Goals</b><small>Progress and attention areas</small></div></div>
          <div class="ai-help-item"><span>≡</span><div><b>Transactions</b><small>Plain-language explanations</small></div></div>
        </div>
        <div class="ai-readonly-note"><b><span>✓</span> Your money stays yours</b><span>AI is read-only and cannot transfer, withdraw, or spend funds.</span></div>
        ${!configured ? '<div class="ai-config-note">AI service is not configured yet. Chat will become available once a provider is configured.</div>' : ''}
      </aside>
    </div>
  </section>`;

  const chat = document.getElementById("ai-chat");
  const input = document.getElementById("ai-input");
  const form = document.getElementById("ai-form");
  const prompts = document.getElementById("ai-prompts");
  const charCount = document.getElementById("ai-char-count");
  const sendButton = form.querySelector(".ai-send");
  let busy = false;

  input.addEventListener("input", () => { charCount.textContent = `${input.value.length}/1000`; });

  async function ask(message) {
    const clean = String(message || "").trim();
    if (!clean || busy) return;
    busy = true;
    input.value = "";
    charCount.textContent = "0/1000";
    sendButton.disabled = true;
    prompts.querySelectorAll("button").forEach(button => { button.disabled = true; });
    chat.insertAdjacentHTML("beforeend", renderMessage("user", clean));
    const loading = document.createElement("div");
    loading.className = "ai-message ai-message-assistant ai-message-ai";
    loading.innerHTML = '<div class="ai-message-meta"><span class="ai-mini-avatar" aria-hidden="true">✦</span> PocketVault AI</div><div class="ai-message-body ai-thinking"><span>Thinking</span><i></i><i></i><i></i></div>';
    chat.appendChild(loading);
    chat.scrollTop = chat.scrollHeight;
    try {
      const result = await api.aiChat(clean);
      loading.outerHTML = renderMessage("assistant", result.answer || "I couldn't produce an answer right now.");
      const usage = result.usage;
      if (usage) {
        const usageStrong = document.querySelector(".ai-usage-number b");
        const usageSmall = document.querySelector(".ai-usage-card small");
        const progress = document.querySelector(".ai-progress span");
        const bar = document.querySelector(".ai-progress");
        if (usageStrong) usageStrong.textContent = usage.remaining;
        if (usageSmall) usageSmall.textContent = `${usage.used} of ${usage.limit} used today`;
        if (progress) progress.style.width = `${usage.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0}%`;
        if (bar) bar.parentElement?.setAttribute("aria-valuenow", String(usage.used));
      }
    } catch (err) {
      loading.outerHTML = renderMessage("assistant", err?.status === 429 ? (err.data?.error || "You've reached today's AI limit. You can continue tomorrow or upgrade your plan for a higher limit.") : err?.status === 403 ? "AI isn't available for this account yet. Check your plan or account access." : (err.message || "I couldn't reach PocketVault AI. Please try again."));
    } finally {
      busy = false;
      sendButton.disabled = false;
      prompts.querySelectorAll("button").forEach(button => { button.disabled = false; });
      input.focus();
      chat.scrollTop = chat.scrollHeight;
    }
  }

  form.addEventListener("submit", e => { e.preventDefault(); ask(input.value); });
  prompts.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => ask(button.dataset.prompt)));
}
