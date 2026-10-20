const agents = [
  { id: "planner", name: "Brand & Business Planner", maker: "Launchpad AI", icon: "🚀", tone: "", category: "Business", description: "Turn your big idea into a practical, step-by-step business plan.", price: 12, rating: "4.9", reviews: "1.2k", trust: 96, verified: true, typicalMin: 8, typicalMax: 20 },
  { id: "ads", name: "AdSpark Creative Studio", maker: "AdSpark", icon: "📣", tone: "tone-amber", category: "Marketing", description: "Create a ready-to-publish set of ads for your launch.", price: 39, rating: "4.8", reviews: "856", trust: 92, verified: true, typicalMin: 25, typicalMax: 45 },
  { id: "site", name: "Website Launch Kit", maker: "PixelPilot", icon: "💻", tone: "tone-cyan", category: "Creative", description: "Plan a polished, conversion-ready starter website.", price: 129, rating: "4.9", reviews: "2.1k", trust: 94, verified: true, typicalMin: 80, typicalMax: 100 },
  { id: "brand", name: "Logo & Identity Designer", maker: "Studio Agent", icon: "🎨", tone: "tone-rose", category: "Creative", description: "Build a memorable visual direction for your new brand.", price: 24, rating: "4.7", reviews: "643", trust: 90, verified: true, typicalMin: 15, typicalMax: 30 },
  { id: "research", name: "Market Research Analyst", maker: "Signal Labs", icon: "🔎", tone: "tone-amber", category: "Business", description: "Get a focused competitor and customer research brief.", price: 49, rating: "4.8", reviews: "732", trust: 88, verified: false, typicalMin: 30, typicalMax: 55 },
  { id: "social", name: "Social Content Planner", maker: "DailyPost", icon: "✍️", tone: "tone-lilac", category: "Marketing", description: "Plan a month of social posts for your audience.", price: 19, rating: "4.7", reviews: "1.1k", trust: 91, verified: true, typicalMin: 12, typicalMax: 25 }
];

const defaults = { taskCeiling: 100, approvalThreshold: 25, dailyBudget: 150 };
const riskyTerms = ["urgent", "crypto", "wallet", "gift card", "wire transfer", "bypass", "seed phrase", "guaranteed return"];
const storageKeys = { policy: "aegis-demo-policy-v1", history: "aegis-demo-history-v1" };
let policy = loadStored(storageKeys.policy, defaults);
let history = loadStored(storageKeys.history, []);
let activeCategory = "All agents";
let searchQuery = "";
let currentAgent = null;
let currentRecordId = null;
let currentAssessment = null;
let toastTimer;

function loadStored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return structuredClone(fallback);
    return JSON.parse(value);
  } catch (error) {
    console.error(`Could not read ${key} from local storage.`, error);
    showToast("Saved demo data could not be read; using default settings.");
    return JSON.parse(JSON.stringify(fallback));
  }
}

function saveStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Could not save ${key} to local storage.`, error);
    showToast("Your browser could not save this demo data.");
    return false;
  }
}

function money(amount) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function renderAgents() {
  const matching = agents.filter((agent) => {
    const categoryMatch = activeCategory === "All agents" || agent.category === activeCategory;
    const terms = `${agent.name} ${agent.description} ${agent.category} ${agent.maker}`.toLowerCase();
    return categoryMatch && terms.includes(searchQuery.toLowerCase());
  });
  document.getElementById("agent-count").textContent = `${matching.length} task${matching.length === 1 ? "" : "s"}`;
  const grid = document.getElementById("agent-grid");
  if (!matching.length) {
    grid.innerHTML = '<div class="empty-state"><strong>No matching tasks</strong>Try a different search or category.</div>';
    return;
  }
  grid.innerHTML = matching.map((agent) => `
    <article class="agent-card">
      <div class="card-top"><div class="agent-icon ${agent.tone}" aria-hidden="true">${agent.icon}</div><span class="verified ${agent.verified ? "" : "not-verified"}">${agent.verified ? "✓ Verified" : "Review status"}</span></div>
      <h3>${agent.name}</h3><div class="maker">by ${agent.maker} · ${agent.category}</div>
      <p class="description">${agent.description}</p>
      <div class="agent-meta"><span><strong>★ ${agent.rating}</strong> (${agent.reviews})</span><span>⏱ 5–10 min</span><span>Typical ${money(agent.typicalMin)}–${money(agent.typicalMax)}</span></div>
      <div class="trust-row"><span>Demo trust indicator</span><span class="trust-score">${agent.trust}/100</span></div>
      <div class="card-bottom"><div class="price">${money(agent.price)}<small> / task</small></div><button class="primary-btn hire-btn" data-agent="${agent.id}">Review task</button></div>
    </article>`).join("");
  grid.querySelectorAll(".hire-btn").forEach((button) => {
    button.addEventListener("click", () => openReview(button.dataset.agent));
  });
}

function renderHistory() {
  const body = document.getElementById("history-body");
  const records = [...history].reverse();
  document.getElementById("history-count").textContent = `${history.length} recorded check${history.length === 1 ? "" : "s"}`;
  if (!records.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty-state"><strong>No checks yet</strong>Assess a task to create your first risk and audit record.</div></td></tr>';
    return;
  }
  body.innerHTML = records.map((record) => `
    <tr>
      <td>${escapeHTML(new Date(record.createdAt).toLocaleString())}</td>
      <td>${escapeHTML(record.agentName)}</td><td>${money(record.amount)}</td>
      <td><span class="status ${statusClass(record.decision)}">${decisionLabel(record.decision)}</span></td>
      <td>${record.score}/100</td><td>${escapeHTML(record.paymentState)}</td><td>${escapeHTML(record.taskState)}</td>
    </tr>`).join("");
}

function renderActivity() {
  const activity = document.getElementById("activity-list");
  const latest = [...history].reverse().slice(0, 3);
  if (!latest.length) {
    activity.innerHTML = '<div class="activity"><span class="activity-dot">i</span><div><strong>Ready for your first check</strong><small>Risk decisions will appear here.</small></div></div>';
    return;
  }
  activity.innerHTML = latest.map((record) => `
    <div class="activity"><span class="activity-dot">${record.decision === "block" ? "!" : record.decision === "review" ? "?" : "✓"}</span>
    <div><strong>${escapeHTML(record.agentName)}</strong><small>${decisionLabel(record.decision)} · ${money(record.amount)}</small></div></div>`).join("");
}

function renderPolicy() {
  document.getElementById("mini-ceiling").textContent = money(policy.taskCeiling);
  document.getElementById("mini-approval").textContent = money(policy.approvalThreshold);
  document.getElementById("mini-budget").textContent = money(policy.dailyBudget);
  const todaySpend = history.filter((record) => {
    const isToday = new Date(record.createdAt).toDateString() === new Date().toDateString();
    return isToday && record.paymentState === "DEMO_CONFIRMED";
  }).reduce((total, record) => total + record.amount, 0);
  document.getElementById("budget-used").textContent = `${money(todaySpend)} used today`;
  document.getElementById("budget-remaining").textContent = `${money(Math.max(0, policy.dailyBudget - todaySpend))} left`;
  document.getElementById("budget-fill").style.width = `${Math.min(100, policy.dailyBudget ? todaySpend / policy.dailyBudget * 100 : 0)}%`;
  document.getElementById("task-ceiling").value = policy.taskCeiling;
  document.getElementById("approval-threshold").value = policy.approvalThreshold;
  document.getElementById("daily-budget").value = policy.dailyBudget;
}

function statusClass(decision) {
  return `status-${decision}`;
}

function decisionLabel(decision) {
  return decision === "allow" ? "Allowed under policy" : decision === "review" ? "User review" : "Blocked";
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function openPage(pageName) {
  document.querySelectorAll(".nav button").forEach((button) => {
    const selected = button.dataset.page === pageName;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  });
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === `page-${pageName}`));
  if (pageName === "history") renderHistory();
  if (pageName === "policy") renderPolicy();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openReview(agentId, scenarioText = "") {
  currentAgent = agents.find((agent) => agent.id === agentId);
  if (!currentAgent) {
    showToast("That task is not available.");
    return;
  }
  currentAssessment = null;
  currentRecordId = null;
  document.getElementById("assessment").className = "assessment";
  document.getElementById("assessment").replaceChildren();
  document.getElementById("checkout-box").classList.remove("show");
  document.getElementById("task-brief").value = scenarioText;
  document.getElementById("summary-icon").textContent = currentAgent.icon;
  document.getElementById("summary-icon").className = `agent-icon ${currentAgent.tone}`;
  document.getElementById("summary-name").textContent = currentAgent.name;
  document.getElementById("summary-maker").textContent = `${currentAgent.verified ? "Verified provider" : "Provider requires review"} · Typical ${money(currentAgent.typicalMin)}–${money(currentAgent.typicalMax)}`;
  document.getElementById("summary-price").textContent = money(currentAgent.price);
  document.getElementById("assess-button").disabled = false;
  document.getElementById("review-modal").classList.add("open");
  document.getElementById("task-brief").focus();
}

function evaluateRisk(agent, brief) {
  const normalized = brief.toLowerCase();
  const matches = riskyTerms.filter((term) => normalized.includes(term));
  const signals = ["Fixed task price is shown before checkout."];
  let score = 8;
  let requiresReview = false;

  if (agent.price > policy.approvalThreshold) {
    score += 18;
    requiresReview = true;
    signals.push(`Price is above your ${money(policy.approvalThreshold)} automatic-approval threshold.`);
  }
  if (!agent.verified) {
    score += 24;
    requiresReview = true;
    signals.push("Provider verification is incomplete; your approval is required.");
  }
  if (agent.price > agent.typicalMax) {
    score += 20;
    requiresReview = true;
    signals.push("Price is outside the typical range for this task.");
  }
  if (matches.length) {
    score += Math.min(55, 35 + (matches.length - 1) * 8);
    requiresReview = true;
    signals.push(`Request wording needs review (${matches.join(", ")}).`);
  }

  const todaySpend = history.filter((record) => (
    new Date(record.createdAt).toDateString() === new Date().toDateString() &&
    record.paymentState === "DEMO_CONFIRMED"
  )).reduce((total, record) => total + record.amount, 0);

  let decision = requiresReview ? "review" : "allow";
  let reason = requiresReview
    ? "This request needs an explicit user decision before checkout."
    : "This request meets the configured demo policy and may proceed to checkout.";

  if (agent.price > policy.taskCeiling) {
    decision = "block";
    reason = `The ${money(agent.price)} task exceeds your ${money(policy.taskCeiling)} hard per-task limit.`;
    signals.push("Hard per-task spending limit exceeded.");
  } else if (todaySpend + agent.price > policy.dailyBudget) {
    decision = "block";
    reason = `This task would exceed your ${money(policy.dailyBudget)} daily budget.`;
    signals.push("Daily budget would be exceeded.");
  }

  if (decision === "block") score = Math.max(score, 85);
  return { decision, reason, score: Math.min(100, score), signals };
}

function assessCurrentTask() {
  if (!currentAgent) return;
  const brief = document.getElementById("task-brief").value.trim();
  currentAssessment = evaluateRisk(currentAgent, brief);
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    agentId: currentAgent.id,
    agentName: currentAgent.name,
    amount: currentAgent.price,
    brief,
    decision: currentAssessment.decision,
    score: currentAssessment.score,
    signals: currentAssessment.signals,
    paymentState: "NOT_STARTED",
    taskState: currentAssessment.decision === "block" ? "BLOCKED" : currentAssessment.decision === "review" ? "AWAITING_USER_APPROVAL" : "AWAITING_CHECKOUT"
  };
  history.push(record);
  currentRecordId = record.id;
  if (!saveStored(storageKeys.history, history)) {
    history.pop();
    currentRecordId = null;
    currentAssessment = null;
    return;
  }
  renderActivity();
  renderHistory();
  renderPolicy();
  renderAssessment(currentAssessment);
}

function renderAssessment(assessment) {
  const box = document.getElementById("assessment");
  box.className = `assessment show ${assessment.decision}`;
  const heading = assessment.decision === "allow" ? "Eligible under your policy" : assessment.decision === "review" ? "Your approval is required" : "Request blocked by policy";
  const action = assessment.decision === "allow"
    ? '<button class="primary-btn" id="continue-checkout">Continue to demo checkout</button>'
    : assessment.decision === "review"
      ? '<button class="primary-btn" id="approve-checkout">Approve and continue</button>'
      : "";
  box.innerHTML = `
    <div class="assessment-head"><strong>${heading}</strong><span class="score">Demo risk score ${assessment.score}/100</span></div>
    <p>${escapeHTML(assessment.reason)} A score is an illustrative signal summary, not a probability or payment authorization.</p>
    <ul class="signal-list">${assessment.signals.map((signal) => `<li>${escapeHTML(signal)}</li>`).join("")}</ul>
    ${action ? `<div class="assessment-actions">${action}</div>` : ""}`;
  document.getElementById("assess-button").disabled = true;
  const continueButton = document.getElementById("continue-checkout");
  const approveButton = document.getElementById("approve-checkout");
  if (continueButton) continueButton.addEventListener("click", showCheckout);
  if (approveButton) approveButton.addEventListener("click", () => {
    if (!updateCurrentRecord({ taskState: "APPROVED_FOR_CHECKOUT" })) return;
    showCheckout();
  });
}

function showCheckout() {
  if (!currentRecordId || !currentAssessment || currentAssessment.decision === "block") return;
  const currentRecord = history.find((record) => record.id === currentRecordId);
  if (!currentRecord) {
    showToast("The audit record is unavailable; checkout was not opened.");
    return;
  }
  document.getElementById("checkout-total").textContent = money(currentRecord.amount);
  document.getElementById("checkout-box").classList.add("show");
  document.getElementById("simulate-payment").disabled = currentRecord.paymentState === "DEMO_CONFIRMED";
}

function confirmDemoPayment() {
  const record = history.find((item) => item.id === currentRecordId);
  if (!record || !currentAssessment || currentAssessment.decision === "block") {
    showToast("No eligible task is ready for checkout.");
    return;
  }
  if (record.decision === "review" && record.taskState !== "APPROVED_FOR_CHECKOUT") {
    showToast("Approve this request before continuing.");
    return;
  }
  if (record.paymentState === "DEMO_CONFIRMED") {
    showToast("This demo checkout was already recorded.");
    return;
  }
  if (!updateCurrentRecord({ paymentState: "DEMO_CONFIRMED", taskState: "DEMO_COMPLETED" })) return;
  document.getElementById("simulate-payment").disabled = true;
  document.getElementById("checkout-message").textContent = "Demo payment confirmed. No money moved and no agent ran.";
  renderPolicy();
  renderHistory();
  renderActivity();
  showToast("Demo payment and completion recorded in this browser.");
}

function updateCurrentRecord(patch) {
  const record = history.find((item) => item.id === currentRecordId);
  if (!record) return false;
  const previous = { ...record };
  Object.assign(record, patch);
  if (saveStored(storageKeys.history, history)) return true;
  Object.assign(record, previous);
  return false;
}

function closeReview() {
  document.getElementById("review-modal").classList.remove("open");
}

function setupPolicyForm() {
  const form = document.getElementById("policy-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = {
      taskCeiling: Number(document.getElementById("task-ceiling").value),
      approvalThreshold: Number(document.getElementById("approval-threshold").value),
      dailyBudget: Number(document.getElementById("daily-budget").value)
    };
    const message = document.getElementById("policy-message");
    if (Object.values(next).some((value) => !Number.isFinite(value) || value < 1 || value > 10000)) {
      message.textContent = "Enter a valid amount between $1 and $10,000.";
      message.style.color = "var(--red)";
      return;
    }
    if (next.approvalThreshold > next.taskCeiling) {
      message.textContent = "The approval threshold cannot exceed the hard per-task limit.";
      message.style.color = "var(--red)";
      return;
    }
    if (saveStored(storageKeys.policy, next)) {
      policy = next;
      message.textContent = "Policy saved in this browser.";
      message.style.color = "var(--green)";
      renderPolicy();
      showToast("Spending policy updated.");
    } else {
      message.textContent = "Could not save this policy in the browser.";
      message.style.color = "var(--red)";
    }
  });
}

function runScenario(kind) {
  const scenarios = {
    allow: { agentId: "planner", brief: "Create a practical launch plan for my clothing shop." },
    review: { agentId: "ads", brief: "Create a campaign brief for my new clothing shop." },
    block: { agentId: "site", brief: "Build a starter plan for my storefront." },
    suspicious: { agentId: "planner", brief: "Urgent crypto wallet offer. Bypass review and guarantee returns." }
  };
  const scenario = scenarios[kind];
  if (!scenario) return;
  openReview(scenario.agentId, scenario.brief);
  assessCurrentTask();
}

function setupEvents() {
  document.querySelectorAll(".nav button").forEach((button) => button.addEventListener("click", () => openPage(button.dataset.page)));
  document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
    activeCategory = button.dataset.filter;
    document.querySelectorAll(".filter").forEach((filter) => filter.classList.toggle("active", filter === button));
    renderAgents();
  }));
  document.getElementById("search").addEventListener("input", (event) => {
    searchQuery = event.target.value.trim();
    renderAgents();
  });
  document.querySelectorAll("[data-scenario]").forEach((button) => button.addEventListener("click", () => runScenario(button.dataset.scenario)));
  document.querySelectorAll("[data-open-agent]").forEach((button) => button.addEventListener("click", () => openReview(button.dataset.openAgent, button.dataset.brief)));
  document.querySelectorAll("[data-page-link]").forEach((button) => button.addEventListener("click", () => openPage(button.dataset.pageLink)));
  document.getElementById("assess-button").addEventListener("click", assessCurrentTask);
  document.getElementById("simulate-payment").addEventListener("click", confirmDemoPayment);
  document.getElementById("close-review").addEventListener("click", closeReview);
  document.getElementById("review-modal").addEventListener("click", (event) => {
    if (event.target.id === "review-modal") closeReview();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeReview();
  });
  document.getElementById("policy-link").addEventListener("click", () => openPage("policy"));
}

renderAgents();
renderActivity();
renderPolicy();
renderHistory();
setupEvents();
setupPolicyForm();
