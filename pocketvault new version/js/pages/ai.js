import { api } from "../../api.js";
import { state } from "../core/state.js";

function escapeHTML(value = "") {
  return String(value).replace(/[&<>'"]/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[ch]));
}

function renderMessage(role, text) {
  const label = role === "user" ? "You" : "PocketVault AI";
  return `<div class="ai-message ${role === "user" ? "ai-message-user" : "ai-message-assistant"}">
    <div class="ai-message-label">${label}</div>
    <div class="ai-message-body">${escapeHTML(text).replace(/\n/g, "<br>")}</div>
  </div>`;
}

export async function renderAIPage(main, navigate) {
  let status = null;
  try { status = await api.aiStatus(); } catch (err) { status = { error: err.message }; }

  const limit = Number(status?.limit ?? 10);
  const used = Number(status?.used ?? 0);
  const remaining = Math.max(0, Number(status?.remaining ?? limit - used));
  const plan = String(status?.plan || state.plan || "free").toLowerCase();
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  main.innerHTML = `
    <section class="ai-page">
      <div class="ai-header">
        <div>
          <div class="eyebrow">POCKETVAULT AI</div>
          <h1>Your money, understood.</h1>
          <p>Ask about your savings, spending, goals, or recent activity. AI can explain your PocketVault data without moving your money.</p>
        </div>
        <div class="ai-usage-card">
          <div class="ai-usage-top"><span>${escapeHTML(plan)} plan</span><strong>${remaining} left</strong></div>
          <div class="ai-progress"><span style="width:${percent}%"></span></div>
          <small>${used} of ${limit} questions used today</small>
        </div>
      </div>

      <div class="ai-layout">
        <div class="ai-chat-card">
          <div class="ai-chat" id="ai-chat">
            ${renderMessage("assistant", "Hi${state.user?.displayName ? ` ${state.user.displayName.split(" ")[0]}` : ""}. I can help you understand your PocketVault activity. Try one of the questions below.")}
          </div>
          <div class="ai-prompts" id="ai-prompts">
            <button type="button" data-prompt="How am I doing with my savings?"><span>◎</span> How am I doing?</button>
            <button type="button" data-prompt="What did I spend recently?"><span>◈</span> Review my spending</button>
            <button type="button" data-prompt="How much can I save?"><span>↗</span> How much can I save?</button>
            <button type="button" data-prompt="Analyze my savings progress."><span>✦</span> Analyze my progress</button>
          </div>
          <form class="ai-composer" id="ai-form">
            <input id="ai-input" maxlength="1000" autocomplete="off" placeholder="Ask PocketVault AI anything about your money..." />
            <button class="btn btn-primary" type="submit">Ask</button>
          </form>
          <div class="ai-disclaimer">AI provides guidance and explanations, not guaranteed financial advice. Verify important decisions in PocketVault.</div>
        </div>

        <aside class="ai-side-card">
          <h3>What I can help with</h3>
          <div class="ai-help-item"><b>Saving</b><span>Understand progress and realistic saving habits.</span></div>
          <div class="ai-help-item"><b>Spending</b><span>Spot patterns and explain recent activity.</span></div>
          <div class="ai-help-item"><b>Goals</b><span>See which goals need attention.</span></div>
          <div class="ai-help-item"><b>Transactions</b><span>Get plain-language explanations of activity.</span></div>
          <div class="ai-readonly-note">For now, AI is read-only. It cannot transfer, withdraw, or spend money.</div>
        </aside>
      </div>
    </section>`;

  const chat = document.getElementById("ai-chat");
  const input = document.getElementById("ai-input");
  const form = document.getElementById("ai-form");
  const prompts = document.getElementById("ai-prompts");
  let busy = false;

  async function ask(message) {
    const clean = String(message || "").trim();
    if (!clean || busy) return;
    busy = true;
    input.value = "";
    chat.insertAdjacentHTML("beforeend", renderMessage("user", clean));
    const loading = document.createElement("div");
    loading.className = "ai-message ai-message-assistant";
    loading.innerHTML = '<div class="ai-message-label">PocketVault AI</div><div class="ai-message-body ai-thinking">Thinking…</div>';
    chat.appendChild(loading);
    chat.scrollTop = chat.scrollHeight;
    try {
      const result = await api.aiChat(clean);
      loading.outerHTML = renderMessage("assistant", result.reply || result.message || "I couldn't produce an answer right now.");
    } catch (err) {
      const message = err?.status === 429
        ? "You've reached today's AI limit. You can continue tomorrow or upgrade your plan for a higher limit."
        : err?.status === 403
          ? "AI isn't available for this account yet. Check your plan or account access."
          : (err.message || "I couldn't reach PocketVault AI. Please try again.");
      loading.outerHTML = renderMessage("assistant", message);
    } finally {
      busy = false;
      chat.scrollTop = chat.scrollHeight;
    }
  }

  form.addEventListener("submit", event => { event.preventDefault(); ask(input.value); });
  prompts.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => ask(button.dataset.prompt)));
}
