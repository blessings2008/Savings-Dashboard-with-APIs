// PocketVault Help / Customer Care page.
// Two modes, same underlying thread shape (see routes/user.js's
// support_threads endpoints):
//   'chat'   — user expects an admin to be actively present right
//              now and able to act on their account (e.g. an
//              emergency unlock). Polled faster.
//   'ticket' — async, no urgency signal, worked when an admin gets
//              to it. Polled slower.
import { api } from "../../api.js";
import { state } from "../core/state.js";
import { escapeHTML } from "../core/utils.js";
import { toast } from "../components/toast.js";

const CHAT_POLL_MS = 5000;
const TICKET_POLL_MS = 20000;
let pollTimer = null;

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
export { stopPolling as stopHelpPolling };

export async function renderHelpPage(main, navigate) {
  stopPolling();
  const res = await api.mySupportThreads();
  const threads = res.threads || [];

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Help & Support</h2>
        <p>Need something changed on your account, or ran into a problem? Start here.</p>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:20px">
        <button class="btn btn-primary" id="help-new-chat">💬 Start a Chat</button>
        <button class="btn btn-outline" id="help-new-ticket">🎫 Submit a Ticket</button>
      </div>

      <div class="card" style="margin-bottom:12px">
        <p style="font-size:12.5px;color:var(--muted)">
          <strong>Chat</strong> — for when you need help right now (e.g. a locked goal in an
          emergency). An admin can act on your account live while you talk.<br>
          <strong>Ticket</strong> — for anything that isn't urgent. An admin will review and reply
          when they can, usually not instantly.
        </p>
      </div>

      <div id="help-thread-list">
        ${threads.length === 0 ? `
          <div class="empty-state"><div class="icon">💬</div><p>No conversations yet</p></div>
        ` : threads.map(threadListItemHTML).join("")}
      </div>
    </div>
  `;

  document.getElementById("help-new-chat").onclick = () => openNewThreadModal("chat", navigate);
  document.getElementById("help-new-ticket").onclick = () => openNewThreadModal("ticket", navigate);

  main.querySelectorAll("[data-thread]").forEach(el => {
    el.addEventListener("click", () => renderThreadView(main, el.dataset.thread, navigate));
  });
}

function threadListItemHTML(t) {
  const lastMsg = t.messages?.[t.messages.length - 1];
  const statusLabel = t.status === "resolved" ? "Resolved" : t.status === "in_progress" ? "In progress" : "Open";
  const statusColor = t.status === "resolved" ? "var(--muted)" : t.status === "in_progress" ? "var(--blue)" : "var(--amber)";
  return `
    <div class="card" data-thread="${t.id}" style="cursor:pointer;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:700;font-size:13.5px">${t.mode === "chat" ? "💬 Chat" : "🎫 Ticket"}</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${escapeHTML(lastMsg?.text || "")}
          </div>
        </div>
        <span style="font-size:11px;color:${statusColor};white-space:nowrap">${statusLabel}</span>
      </div>
    </div>
  `;
}

function openNewThreadModal(mode, navigate) {
  const root = document.getElementById("modal-root");
  const goalsArr = Object.values(state.goals || {});
  root.innerHTML = `
    <div class="modal">
      <h3>${mode === "chat" ? "💬 Start a Chat" : "🎫 Submit a Ticket"}</h3>
      <p class="modal-sub">${mode === "chat"
        ? "An admin will see this is a live chat and can act on your account while you talk."
        : "Describe what's going on — an admin will review and reply."}</p>

      ${goalsArr.length > 0 ? `
        <div class="input-group">
          <label class="input-label">Is this about a specific goal? (optional)</label>
          <select class="input" id="help-goal">
            <option value="">Not goal-specific</option>
            ${goalsArr.map(g => `<option value="${g.id}">${g.emoji || "🎯"} ${escapeHTML(g.name)}</option>`).join("")}
          </select>
        </div>
      ` : ""}

      <div class="input-group">
        <label class="input-label">What's going on?</label>
        <textarea class="input" id="help-message" rows="4" style="resize:vertical" placeholder="${mode === "chat" ? "e.g. I have a family emergency and need my locked goal unlocked" : "e.g. My referral bonus never showed up"}"></textarea>
      </div>

      <div id="help-error" class="auth-error" style="display:none"></div>

      <div class="modal-actions">
        <button class="btn btn-outline" id="help-cancel">Cancel</button>
        <button class="btn btn-primary" id="help-submit">${mode === "chat" ? "Start Chat" : "Submit Ticket"}</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#help-cancel").onclick = () => root.classList.remove("open");
  root.addEventListener("click", e => { if (e.target === root) root.classList.remove("open"); });

  root.querySelector("#help-submit").onclick = async () => {
    const message = document.getElementById("help-message").value.trim();
    const relatedGoalId = document.getElementById("help-goal")?.value || undefined;
    const errBox = document.getElementById("help-error");
    const btn = root.querySelector("#help-submit");
    if (!message) {
      errBox.style.display = "block"; errBox.textContent = "Enter a message";
      return;
    }
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const res = await api.startSupportThread({ mode, message, relatedGoalId });
      root.classList.remove("open");
      toast(mode === "chat" ? "Chat started" : "Ticket submitted");
      renderThreadView(document.getElementById("main-content"), res.threadId, navigate);
    } catch (e) {
      errBox.style.display = "block"; errBox.textContent = e.data?.error || e.message;
      btn.disabled = false; btn.textContent = mode === "chat" ? "Start Chat" : "Submit Ticket";
    }
  };
}

async function renderThreadView(main, threadId, navigate) {
  stopPolling();
  const res = await api.getSupportThread(threadId);
  const thread = res.thread;
  if (!thread) return;

  renderThreadHTML(main, thread, navigate);

  // Poll for new messages — faster for chat (the whole premise is
  // an admin may reply within moments), slower for tickets, where
  // there's no expectation of an immediate response.
  const interval = thread.mode === "chat" ? CHAT_POLL_MS : TICKET_POLL_MS;
  pollTimer = setInterval(async () => {
    try {
      const fresh = await api.getSupportThread(threadId);
      if (fresh.thread && document.getElementById("help-thread-view")) {
        renderThreadHTML(main, fresh.thread, navigate, true);
      }
    } catch {
      stopPolling();
    }
  }, interval);
}

function renderThreadHTML(main, thread, navigate, isPoll = false) {
  const statusLabel = thread.status === "resolved" ? "Resolved" : thread.status === "in_progress" ? "In progress" : "Open";

  main.innerHTML = `
    <div class="page active" id="help-thread-view">
      <div class="page-header">
        <button class="btn btn-outline btn-sm" id="help-back" style="margin-bottom:12px">← Back</button>
        <h2>${thread.mode === "chat" ? "💬 Chat" : "🎫 Ticket"} — ${statusLabel}</h2>
        ${thread.mode === "chat" ? `<p>An admin can act on your account live in this conversation</p>` : `<p>An admin will reply when they review this</p>`}
      </div>

      <div class="card" style="display:flex;flex-direction:column;gap:10px;max-height:50vh;overflow-y:auto" id="help-messages">
        ${(thread.messages || []).map(m => `
          <div style="align-self:${m.from === "user" ? "flex-end" : "flex-start"};max-width:80%">
            <div style="font-size:10.5px;color:var(--muted);margin-bottom:2px;text-align:${m.from === "user" ? "right" : "left"}">
              ${m.from === "user" ? "You" : "Support"}
            </div>
            <div style="background:${m.from === "user" ? "var(--green)" : "var(--surface2)"};color:${m.from === "user" ? "#04120c" : "var(--text)"};padding:8px 12px;border-radius:12px;font-size:13.5px">
              ${escapeHTML(m.text)}
            </div>
          </div>
        `).join("")}
      </div>

      ${thread.status !== "resolved" ? `
        <div style="display:flex;gap:8px;margin-top:14px">
          <input class="input" id="help-reply-input" placeholder="Type a message…" style="flex:1">
          <button class="btn btn-primary" id="help-reply-send">Send</button>
        </div>
      ` : `
        <div class="modal-info" style="margin-top:14px">This conversation is resolved. Start a new one if you need further help.</div>
      `}
    </div>
  `;

  document.getElementById("help-back").onclick = () => { stopPolling(); navigate("help"); };

  // Auto-scroll to the latest message, but only on a fresh render or
  // when the poll actually brought new messages — not on every poll
  // tick if nothing changed, to avoid yanking the scroll position
  // while someone's reading older messages.
  const msgBox = document.getElementById("help-messages");
  if (msgBox) msgBox.scrollTop = msgBox.scrollHeight;

  const sendBtn = document.getElementById("help-reply-send");
  if (sendBtn) {
    sendBtn.onclick = async () => {
      const input = document.getElementById("help-reply-input");
      const text = input.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      try {
        await api.replySupportThread(thread.id, text);
        input.value = "";
        const fresh = await api.getSupportThread(thread.id);
        renderThreadHTML(main, fresh.thread, navigate);
      } catch (e) {
        toast(e.data?.error || e.message, "error");
      } finally {
        sendBtn.disabled = false;
      }
    };
    document.getElementById("help-reply-input")?.addEventListener("keydown", e => {
      if (e.key === "Enter") sendBtn.click();
    });
  }
}
