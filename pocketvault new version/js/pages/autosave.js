// PocketVault auto-save rules page.
import { api } from "../../api.js";
import { state } from "../core/state.js";
import { fmt, escapeHTML } from "../core/utils.js";
import { bindNavLinks } from "../core/render-helpers.js";
import { loadPlan } from "../services/plan.js";
import { toast } from "../components/toast.js";
import { closeModal, showModalError } from "../components/modal.js";

export async function renderAutosavePage(main, navigate) {
  await loadPlan({ api, state, toast });
  const config = state.planConfig;

  if (!config?.maxAutoRules) {
    main.innerHTML = `
      <div class="page active">
        <div class="page-header">
          <h2>Auto-Save Rules</h2>
          <p>Automate your savings</p>
        </div>
        <div class="card">
          <div class="empty-state">
            <div class="icon">✨</div>
            <p>Auto-save rules, round-ups, and savings locks are available on Pro and Business plans.</p>
            <button class="btn btn-primary btn-sm" data-nav="premium">View Plans</button>
          </div>
        </div>
      </div>
    `;
    return bindNavLinks(main, navigate);
  }

  const [rulesRes, goalsRes] = await Promise.all([api.autosaveRules(), api.goals()]);
  state.goals = goalsRes.goals || {};
  const rules = Object.entries(rulesRes.rules || {}).map(([id, r]) => ({ id, ...r }));
  const goalsArr = Object.values(state.goals).filter(g => !g.completed);

  main.innerHTML = `
    <div class="page active">
      <div class="page-header">
        <h2>Auto-Save Rules</h2>
        <p>${rules.filter(r => r.enabled).length} active · max ${config.maxAutoRules} on ${state.plan} plan</p>
      </div>
      <div style="margin-bottom:20px">
        <button class="btn btn-primary" id="btn-new-rule" ${goalsArr.length === 0 ? "disabled" : ""}>+ Add Rule</button>
        ${goalsArr.length === 0 ? `<p style="margin-top:8px;font-size:12px;color:var(--muted)">Create a goal first to add rules</p>` : ""}
      </div>
      <div class="card">
        ${rules.length === 0 ? `
          <div class="empty-state">
            <div class="icon">↻</div>
            <p>No auto-save rules yet</p>
          </div>
        ` : rules.map(ruleHTML).join("")}
      </div>
    </div>
  `;

  document.getElementById("btn-new-rule").onclick = () => openCreateRuleModal(goalsArr, navigate);

  main.querySelectorAll(".toggle").forEach(t => {
    t.addEventListener("click", async () => {
      const ruleId = t.dataset.rule;
      const newEnabled = t.classList.contains("off");
      t.classList.toggle("off");
      try {
        await api.toggleAutosaveRule(ruleId, newEnabled);
        toast(newEnabled ? "Rule enabled" : "Rule disabled");
      } catch (e) {
        t.classList.toggle("off"); // revert
        toast(e.message, "error");
      }
    });
  });
}

function ruleHTML(r) {
  const icons = { weekly: "📅", monthly: "📆", income_percent: "📊", roundup: "🔄" };
  const goal = r.goalId ? state.goals[r.goalId] : null;
  const destLabel = goal ? goal.name : "your account balance";
  let desc = "";
  if (r.type === "weekly") desc = `Weekly (${r.schedule || "Mon"}) · MWK ${fmt(r.amount)} → ${destLabel}`;
  else if (r.type === "monthly") desc = `Monthly (day ${r.schedule || "1"}) · MWK ${fmt(r.amount)} → ${destLabel}`;
  else if (r.type === "income_percent") desc = `${r.percent}% of MWK ${fmt(r.declaredIncome)} on day ${r.incomeDay} → ${destLabel}`;
  else if (r.type === "roundup") desc = `Round-up spends → ${destLabel}`;

  return `
    <div class="rule-card">
      <div class="rule-icon">${icons[r.type] || "↻"}</div>
      <div>
        <div class="rule-text">${desc}</div>
      </div>
      <div class="toggle ${r.enabled ? "" : "off"}" data-rule="${r.id}"></div>
    </div>
  `;
}

function openCreateRuleModal(goalsArr, navigate) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal">
      <h3>New Auto-Save Rule</h3>
      <p class="modal-sub">Choose how you want to save automatically</p>

      <div class="input-group">
        <label class="input-label">Rule type</label>
        <select class="input" id="rule-type">
          <option value="weekly">Weekly — fixed amount</option>
          <option value="monthly">Monthly — fixed amount</option>
          <option value="income_percent">Percentage of income</option>
          <option value="roundup">Round-up spending</option>
        </select>
      </div>

      <div class="input-group" id="rule-amount-group">
        <label class="input-label">Amount (MWK)</label>
        <input class="input" id="rule-amount" type="number" placeholder="e.g. 2000">
      </div>

      <div class="input-group" id="rule-percent-group" style="display:none">
        <label class="input-label">Percentage (%)</label>
        <input class="input" id="rule-percent" type="number" placeholder="e.g. 25" min="1" max="100">
      </div>

      <div class="input-group" id="rule-income-group" style="display:none">
        <label class="input-label">Your typical income (MWK)</label>
        <input class="input" id="rule-declared-income" type="number" placeholder="e.g. 150000">
        <p style="font-size:11.5px;color:var(--muted);margin-top:6px">
          We can't yet see your Airtel Money income automatically, so tell us roughly how much
          you're usually paid — we'll save your percentage of this amount on your pay day.
        </p>
      </div>

      <div class="input-group" id="rule-payday-group" style="display:none">
        <label class="input-label">Day of month you get paid</label>
        <input class="input" id="rule-income-day" type="number" placeholder="e.g. 25" min="1" max="31">
      </div>

      <div class="input-group" id="rule-schedule-group">
        <label class="input-label" id="rule-schedule-label">Day of week</label>
        <select class="input" id="rule-schedule">
          <option value="MON">Monday</option>
          <option value="TUE">Tuesday</option>
          <option value="WED">Wednesday</option>
          <option value="THU">Thursday</option>
          <option value="FRI">Friday</option>
          <option value="SAT">Saturday</option>
          <option value="SUN">Sunday</option>
        </select>
      </div>

      <div class="input-group">
        <label class="input-label">Where should this go?</label>
        <div class="deadline-behavior-options">
          <label class="behavior-option">
            <input type="radio" name="rule-destination" value="balance" checked>
            <div>
              <strong>Account balance</strong>
              <span>Lands in your general balance — allocate to a goal anytime after</span>
            </div>
          </label>
          <label class="behavior-option">
            <input type="radio" name="rule-destination" value="goal">
            <div>
              <strong>A specific goal</strong>
              <span>Commits straight into the goal automatically, no manual step</span>
            </div>
          </label>
        </div>
      </div>

      <div class="input-group" id="rule-goal-group" style="display:none">
        <label class="input-label">Goal</label>
        <select class="input" id="rule-goal">
          ${goalsArr.map(g => `<option value="${g.id}">${g.emoji} ${escapeHTML(g.name)}</option>`).join("")}
        </select>
      </div>

      <div id="rule-error" class="auth-error" style="display:none"></div>

      <div class="modal-actions">
        <button class="btn btn-outline" id="rule-cancel">Cancel</button>
        <button class="btn btn-primary" id="rule-submit">Create Rule</button>
      </div>
    </div>
  `;
  root.classList.add("open");
  root.querySelector("#rule-cancel").onclick = closeModal;
  root.addEventListener("click", e => { if (e.target === root) closeModal(); });

  root.querySelectorAll('input[name="rule-destination"]').forEach(radio => {
    radio.addEventListener("change", () => {
      root.querySelector("#rule-goal-group").style.display = radio.value === "goal" && radio.checked ? "block" : "none";
    });
  });

  const typeSelect = root.querySelector("#rule-type");
  const scheduleSelect = root.querySelector("#rule-schedule");
  typeSelect.addEventListener("change", () => {
    const type = typeSelect.value;
    const isPercent = type === "income_percent";
    const isRoundup = type === "roundup";
    const isMonthly = type === "monthly";
    const isWeekly = type === "weekly";

    root.querySelector("#rule-amount-group").style.display = (isPercent || isRoundup) ? "none" : "block";
    root.querySelector("#rule-percent-group").style.display = isPercent ? "block" : "none";
    root.querySelector("#rule-income-group").style.display = isPercent ? "block" : "none";
    root.querySelector("#rule-payday-group").style.display = isPercent ? "block" : "none";
    root.querySelector("#rule-schedule-group").style.display = (isWeekly || isMonthly) ? "block" : "none";

    if (isMonthly) {
      root.querySelector("#rule-schedule-label").textContent = "Day of month";
      scheduleSelect.outerHTML = `<select class="input" id="rule-schedule">
        ${Array.from({length: 28}, (_, i) => `<option value="${i+1}">${i+1}</option>`).join("")}
      </select>`;
    } else if (isWeekly) {
      root.querySelector("#rule-schedule-label").textContent = "Day of week";
    }
  });

  root.querySelector("#rule-submit").onclick = async () => {
    const type = typeSelect.value;
    const amount = document.getElementById("rule-amount").value;
    const percent = document.getElementById("rule-percent").value;
    const declaredIncome = document.getElementById("rule-declared-income").value;
    const incomeDay = document.getElementById("rule-income-day").value;
    const destination = root.querySelector('input[name="rule-destination"]:checked')?.value || "balance";
    const goalId = destination === "goal" ? document.getElementById("rule-goal").value : undefined;
    const schedule = document.getElementById("rule-schedule")?.value;
    const errBox = document.getElementById("rule-error");
    const btn = root.querySelector("#rule-submit");

    if (type === "income_percent") {
      if (!percent || percent < 1) return showModalError(errBox, "Enter a valid percentage");
      if (!declaredIncome || declaredIncome < 100) return showModalError(errBox, "Enter your typical income amount");
      if (!incomeDay || incomeDay < 1 || incomeDay > 31) return showModalError(errBox, "Enter a valid pay day (1–31)");
    }
    if (["weekly", "monthly"].includes(type) && (!amount || amount < 100)) return showModalError(errBox, "Minimum amount is MWK 100");
    if (destination === "goal" && !goalId) return showModalError(errBox, "Select a goal");

    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.createAutosaveRule(state.user.uid, {
        type, amount, percent, destination, goalId,
        schedule: ["weekly", "monthly"].includes(type) ? schedule : null,
        declaredIncome: type === "income_percent" ? declaredIncome : undefined,
        incomeDay: type === "income_percent" ? incomeDay : undefined,
        enabled: true
      });
      closeModal();
      toast("Auto-save rule created!");
      navigate("autosave");
    } catch (e) {
      showModalError(errBox, e.data?.error || e.message);
      btn.disabled = false; btn.textContent = "Create Rule";
    }
  };
}
