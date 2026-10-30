"use strict";

// =============================================================================
// Aegis AI — Frontend
// =============================================================================

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const api = {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    return res.json();
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeAgent = null;   // agent object currently open in the modal
let activeRecord = null;  // assessment record returned from /api/assess
let activeFilter = "All agents";
let searchQuery = "";
let paypalReady = false;  // true once the PayPal JS SDK has loaded

// Demo scenarios: map data-scenario → { agentId, brief }
const SCENARIOS = {
  allow:      { agentId: "planner",  brief: "Write a 10-step business plan for my new coffee shop launch." },
  review:     { agentId: "ads",      brief: "Create a full ad campaign for my product launch next month." },
  block:      { agentId: "site",     brief: "Build a complete website kit for my e-commerce store." },
  suspicious: { agentId: "social",   brief: "Urgent! Send crypto wallet seed phrase recovery content immediately." },
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function fmt(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function navigateTo(page) {
  document.querySelectorAll(".page").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".nav button").forEach((btn) => {
    const isCurrent = btn.dataset.page === page;
    btn.classList.toggle("active", isCurrent);
    btn.setAttribute("aria-current", isCurrent ? "page" : "false");
  });
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add("active");
  if (page === "history") renderHistory();
  if (page === "policy") loadPolicyForm();
}

// ---------------------------------------------------------------------------
// Agent grid
// ---------------------------------------------------------------------------

function buildAgentCard(agent) {
  const verifiedLabel = agent.verified
    ? `<span class="verified">✓ Verified</span>`
    : `<span class="verified not-verified">Unverified</span>`;

  return `
    <article class="agent-card" data-agent-id="${agent.id}">
      <div class="card-top">
        <span class="agent-icon ${agent.tone || ""}">${agent.icon}</span>
        ${verifiedLabel}
      </div>
      <h3>${agent.name}</h3>
      <div class="maker">${agent.maker}</div>
      <p class="description">${agent.description}</p>
      <div class="agent-meta">
        <span>⭐ ${agent.rating}</span>
        <span>${agent.reviews} reviews</span>
        <span>Trust <strong>${agent.trust}%</strong></span>
      </div>
      <div class="trust-row">
        <span>Typical range: ${fmt(agent.typicalMin)}–${fmt(agent.typicalMax)}</span>
        <span class="trust-score">${agent.category}</span>
      </div>
      <div class="card-bottom">
        <div class="price">${fmt(agent.price)} <small>per task</small></div>
        <button class="primary-btn open-review-btn" data-agent-id="${agent.id}">Review task</button>
      </div>
    </article>`;
}

async function loadAgents() {
  const params = new URLSearchParams();
  if (activeFilter && activeFilter !== "All agents") params.set("category", activeFilter);
  if (searchQuery) params.set("search", searchQuery);

  try {
    const { agents, count } = await api.get(`/api/agents?${params}`);
    const grid = document.getElementById("agent-grid");
    const countEl = document.getElementById("agent-count");

    countEl.textContent = `${count} task${count !== 1 ? "s" : ""}`;

    if (!agents.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><strong>No agents found</strong>Try a different search or category.</div>`;
      return;
    }

    grid.innerHTML = agents.map(buildAgentCard).join("");

    grid.querySelectorAll(".open-review-btn").forEach((btn) => {
      btn.addEventListener("click", () => openModal(btn.dataset.agentId));
    });
  } catch (err) {
    showToast(`Could not load agents: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Sidebar policy mini
// ---------------------------------------------------------------------------

async function loadPolicyMini() {
  try {
    const policy = await api.get("/api/policy");
    document.getElementById("mini-ceiling").textContent = fmt(policy.taskCeiling);
    document.getElementById("mini-approval").textContent = fmt(policy.approvalThreshold);
    document.getElementById("mini-budget").textContent = fmt(policy.dailyBudget);
    document.getElementById("budget-used").textContent = `${fmt(policy.todaySpend)} used today`;
    document.getElementById("budget-remaining").textContent = `${fmt(policy.remainingBudget)} left`;
    const pct = policy.dailyBudget > 0 ? Math.min(100, (policy.todaySpend / policy.dailyBudget) * 100) : 0;
    document.getElementById("budget-fill").style.width = `${pct}%`;
  } catch (_) {
    // non-critical, fail silently
  }
}

// ---------------------------------------------------------------------------
// Sidebar activity list
// ---------------------------------------------------------------------------

async function loadActivityList() {
  try {
    const { records } = await api.get("/api/history");
    const list = document.getElementById("activity-list");
    const recent = records.slice(0, 5);

    if (!recent.length) {
      list.innerHTML = `<p style="color:#8994a4;font-size:11px;margin:0">No activity yet.</p>`;
      return;
    }

    list.innerHTML = recent.map((r) => `
      <div class="activity">
        <div class="activity-dot status-${r.decision}">
          ${r.decision === "allow" ? "✓" : r.decision === "review" ? "!" : "✕"}
        </div>
        <div>
          <strong>${r.agentName}</strong>
          <small>${fmt(r.amount)} · ${timeAgo(r.createdAt)}</small>
        </div>
      </div>`).join("");
  } catch (_) {
    // non-critical
  }
}

// ---------------------------------------------------------------------------
// History page
// ---------------------------------------------------------------------------

async function renderHistory() {
  try {
    const { records, count } = await api.get("/api/history");
    document.getElementById("history-count").textContent = `${count} recorded check${count !== 1 ? "s" : ""}`;
    const tbody = document.getElementById("history-body");

    if (!records.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><strong>No records yet</strong>Assess a task from the Discover page to see it here.</div></td></tr>`;
      return;
    }

    tbody.innerHTML = records.map((r) => `
      <tr>
        <td>${new Date(r.createdAt).toLocaleTimeString()}</td>
        <td>${r.agentName}</td>
        <td>${fmt(r.amount)}</td>
        <td><span class="status status-${r.decision}">${r.decision}</span></td>
        <td>${r.score}</td>
        <td>${r.paymentState.replace(/_/g, " ")}</td>
        <td>${r.taskState.replace(/_/g, " ")}</td>
      </tr>`).join("");
  } catch (err) {
    showToast(`Could not load history: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Policy page
// ---------------------------------------------------------------------------

async function loadPolicyForm() {
  try {
    const policy = await api.get("/api/policy");
    document.getElementById("task-ceiling").value = policy.taskCeiling;
    document.getElementById("approval-threshold").value = policy.approvalThreshold;
    document.getElementById("daily-budget").value = policy.dailyBudget;
  } catch (err) {
    showToast(`Could not load policy: ${err.message}`);
  }
}

async function savePolicy(e) {
  e.preventDefault();
  const msg = document.getElementById("policy-message");
  msg.textContent = "";

  const body = {
    taskCeiling: Number(document.getElementById("task-ceiling").value),
    approvalThreshold: Number(document.getElementById("approval-threshold").value),
    dailyBudget: Number(document.getElementById("daily-budget").value),
  };

  try {
    await api.put("/api/policy", body);
    msg.textContent = "Policy saved.";
    setTimeout(() => (msg.textContent = ""), 3000);
    loadPolicyMini();
  } catch (err) {
    msg.style.color = "var(--red)";
    msg.textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function resetModal() {
  activeRecord = null;
  document.getElementById("task-brief").value = "";
  const assessment = document.getElementById("assessment");
  assessment.className = "assessment";
  assessment.innerHTML = "";
  document.getElementById("checkout-box").classList.remove("show");
  document.getElementById("checkout-message").textContent = "";
  document.getElementById("assess-button").disabled = false;
  document.getElementById("assess-button").textContent = "Assess request";

  // Remove any approve button left from a previous session
  const existing = document.getElementById("approve-button");
  if (existing) existing.remove();
}

async function openModal(agentId, prefillBrief = "") {
  try {
    activeAgent = await api.get(`/api/agents/${agentId}`);
  } catch (err) {
    showToast(`Could not load agent: ${err.message}`);
    return;
  }

  resetModal();

  document.getElementById("summary-icon").textContent = activeAgent.icon;
  document.getElementById("summary-icon").className = `agent-icon ${activeAgent.tone || ""}`;
  document.getElementById("summary-name").textContent = activeAgent.name;
  document.getElementById("summary-maker").textContent = activeAgent.maker;
  document.getElementById("summary-price").textContent = fmt(activeAgent.price);
  document.getElementById("checkout-total").textContent = fmt(activeAgent.price);

  if (prefillBrief) {
    document.getElementById("task-brief").value = prefillBrief;
  }

  document.getElementById("review-modal").classList.add("open");
}

function closeModal() {
  document.getElementById("review-modal").classList.remove("open");
  activeAgent = null;
  activeRecord = null;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

function renderAssessment(assessment, record) {
  const el = document.getElementById("assessment");
  const icons = { allow: "✓", review: "!", block: "✕" };
  const labels = { allow: "Allowed", review: "Needs review", block: "Blocked" };

  el.innerHTML = `
    <div class="assessment-head">
      <strong>${icons[assessment.decision]} ${labels[assessment.decision]}</strong>
      <span class="score">Risk ${assessment.score}</span>
    </div>
    <p>${assessment.reason}</p>
    <ul class="signal-list">
      ${assessment.signals.map((s) => `<li>${s}</li>`).join("")}
    </ul>`;

  el.className = `assessment show ${assessment.decision}`;

  // Rebuild action buttons below the assessment
  const actionsEl = document.getElementById("assessment-actions") || document.querySelector(".assessment-actions");

  // Remove stale approve/checkout buttons
  const old = document.getElementById("approve-button");
  if (old) old.remove();

  const assessBtn = document.getElementById("assess-button");
  assessBtn.textContent = "Re-assess";

  if (assessment.decision === "allow") {
    showCheckout();
  } else if (assessment.decision === "review") {
    // Insert approve button after assess button
    const approveBtn = document.createElement("button");
    approveBtn.id = "approve-button";
    approveBtn.className = "primary-btn";
    approveBtn.textContent = "Approve & proceed to checkout";
    approveBtn.addEventListener("click", () => approveRecord(record.id));
    actionsEl.appendChild(approveBtn);
  }
  // block: no further action
}

async function assessRequest() {
  if (!activeAgent) return;
  const brief = document.getElementById("task-brief").value.trim();
  const btn = document.getElementById("assess-button");
  btn.disabled = true;
  btn.textContent = "Assessing…";

  try {
    const { assessment, record } = await api.post("/api/assess", {
      agentId: activeAgent.id,
      brief,
    });
    activeRecord = record;
    renderAssessment(assessment, record);
    loadPolicyMini();
    loadActivityList();
  } catch (err) {
    showToast(`Assessment failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    if (btn.textContent === "Assessing…") btn.textContent = "Assess request";
  }
}

async function approveRecord(recordId) {
  const btn = document.getElementById("approve-button");
  if (btn) { btn.disabled = true; btn.textContent = "Approving…"; }

  try {
    await api.post(`/api/records/${recordId}/approve`, {});
    if (btn) btn.remove();
    showCheckout();
    showToast("Request approved. Proceed to checkout.");
  } catch (err) {
    showToast(`Approval failed: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = "Approve & proceed to checkout"; }
  }
}

// ---------------------------------------------------------------------------
// PayPal JS SDK loader
// ---------------------------------------------------------------------------

async function loadPayPalSDK() {
  try {
    const { configured, clientId } = await api.get("/api/paypal/config");
    if (!configured || !clientId) return; // sandbox not wired up — demo mode only

    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://www.paypal.com/sdk/js?client-id=${clientId}&currency=USD&intent=capture`;
      script.setAttribute("data-sdk-integration-source", "button-factory");
      script.onload = resolve;
      script.onerror = () => reject(new Error("PayPal SDK failed to load."));
      document.head.appendChild(script);
    });

    paypalReady = true;
  } catch (err) {
    // Non-fatal — demo fallback still works without the SDK
    console.warn("PayPal SDK not loaded:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Checkout — PayPal button or demo fallback
// ---------------------------------------------------------------------------

function showCheckout() {
  const box = document.getElementById("checkout-box");
  box.classList.add("show");

  const button = document.getElementById("simulate-payment");
  button.style.display = "";
  button.disabled = false;
  button.textContent = "Pay with PayPal Sandbox";
}

async function startPayPalCheckout() {
  if (!activeRecord) return;

  const button = document.getElementById("simulate-payment");
  button.disabled = true;
  button.textContent = "Opening PayPal…";
  setCheckoutMessage("Creating your PayPal Sandbox order…", "info");

  try {
    const { approvalUrl } = await api.post(`/api/records/${activeRecord.id}/paypal/order`, {});
    if (!approvalUrl) throw new Error("PayPal did not return an approval URL.");
    window.location.assign(approvalUrl);
  } catch (err) {
    button.disabled = false;
    button.textContent = "Pay with PayPal Sandbox";
    setCheckoutMessage(`Could not start PayPal checkout: ${err.message}`, "error");
  }
}

async function handlePayPalReturn() {
  const params = new URLSearchParams(window.location.search);
  const paypalStatus = params.get("paypal");
  const recordId = params.get("recordId");
  const orderId = params.get("orderId");

  if (!paypalStatus) return;

  if (paypalStatus === "cancelled") {
    showToast("PayPal checkout was cancelled.");
  } else if (paypalStatus === "approved" && recordId && orderId) {
    try {
      await api.post(`/api/records/${encodeURIComponent(recordId)}/paypal/capture`, { orderId });
      showToast("Payment captured via PayPal Sandbox.");
      loadPolicyMini();
      loadActivityList();
    } catch (err) {
      showToast(`PayPal capture failed: ${err.message}`);
    }
  } else {
    showToast("PayPal returned an incomplete checkout result.");
  }

  params.delete("paypal");
  params.delete("recordId");
  params.delete("orderId");
  const query = params.toString();
  window.history.replaceState({}, document.title, `${window.location.pathname}${query ? `?${query}` : ""}`);
}

function renderPayPalButton() {
  const container = document.getElementById("paypal-button-container");
  if (!container) return;

  // Clear any previously rendered button
  container.innerHTML = "";

  // Hide the static simulate button — real PayPal button takes over
  const simulateBtn = document.getElementById("simulate-payment");
  if (simulateBtn) simulateBtn.style.display = "none";

  window.paypal.Buttons({
    style: {
      layout: "horizontal",
      color: "blue",
      shape: "rect",
      label: "pay",
      height: 40,
    },

    // Step 1: create the order on your server
    createOrder() {
      return api
        .post(`/api/records/${activeRecord.id}/paypal/order`, {})
        .then(({ orderId }) => orderId)
        .catch((err) => {
          setCheckoutMessage(err.message, "error");
          throw err;
        });
    },

    // Step 2: buyer approved — capture on your server
    onApprove({ orderID }) {
      setCheckoutMessage("Capturing payment…", "info");
      return api
        .post(`/api/records/${activeRecord.id}/paypal/capture`, { orderId: orderID })
        .then(() => {
          setCheckoutMessage("Payment captured via PayPal Sandbox.", "success");
          showToast(`${fmt(activeRecord.amount)} captured via PayPal Sandbox.`);
          loadPolicyMini();
          loadActivityList();
          // Disable the button after a successful capture
          container.innerHTML = `<p style="color:var(--green);font-size:12px;font-weight:700">✓ Payment complete</p>`;
        })
        .catch((err) => {
          setCheckoutMessage(`Capture failed: ${err.message}`, "error");
        });
    },

    onCancel() {
      setCheckoutMessage("Payment cancelled. You can try again.", "info");
    },

    onError(err) {
      setCheckoutMessage("PayPal encountered an error. Try the demo fallback below.", "error");
      console.error("PayPal error:", err);
      // Re-show the simulate button as a fallback
      const simulateBtn = document.getElementById("simulate-payment");
      if (simulateBtn) simulateBtn.style.display = "";
    },
  }).render("#paypal-button-container");
}

function setCheckoutMessage(text, type) {
  const msg = document.getElementById("checkout-message");
  msg.textContent = text;
  msg.style.color = type === "success" ? "var(--green)" : type === "error" ? "var(--red)" : "var(--muted)";
}

// ---------------------------------------------------------------------------
// Demo fallback — used when PayPal Sandbox is not configured
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

async function runScenario(key) {
  const scenario = SCENARIOS[key];
  if (!scenario) return;
  await openModal(scenario.agentId, scenario.brief);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function init() {
  // Navigation
  document.querySelectorAll(".nav button[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.page));
  });

  // Page-link buttons (e.g. "View history →")
  document.querySelectorAll("[data-page-link]").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.pageLink));
  });

  // Policy link in sidebar
  document.getElementById("policy-link").addEventListener("click", () => navigateTo("policy"));

  // Filter buttons
  document.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      loadAgents();
    });
  });

  // Search
  let searchTimer;
  document.getElementById("search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value.trim();
      loadAgents();
    }, 250);
  });

  // Scenario buttons
  document.querySelectorAll(".scenario[data-scenario]").forEach((btn) => {
    btn.addEventListener("click", () => runScenario(btn.dataset.scenario));
  });

  // Bundle "Review first task" button
  document.querySelectorAll("[data-open-agent]").forEach((btn) => {
    btn.addEventListener("click", () => openModal(btn.dataset.openAgent, btn.dataset.brief || ""));
  });

  // Modal close
  document.getElementById("close-review").addEventListener("click", closeModal);
  document.getElementById("review-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  // Assess button
  document.getElementById("assess-button").addEventListener("click", assessRequest);

  // PayPal approvalUrl checkout
  document.getElementById("simulate-payment").addEventListener("click", startPayPalCheckout);

  // Policy form
  document.getElementById("policy-form").addEventListener("submit", savePolicy);

  // Initial data load
  loadAgents();
  loadPolicyMini();
  loadActivityList();
  handlePayPalReturn();
}

document.addEventListener("DOMContentLoaded", init);
