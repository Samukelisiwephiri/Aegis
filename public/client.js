"use strict";

// =============================================================================
// Aegis AI — Frontend
// =============================================================================

// ---------------------------------------------------------------------------
// Auth helpers (must come first — api client reads these)
// ---------------------------------------------------------------------------

const AUTH_TOKEN_KEY = "aegis_token";
const AUTH_USER_KEY  = "aegis_user";

function authGetToken() {
  try { return localStorage.getItem(AUTH_TOKEN_KEY); } catch { return null; }
}
function authGetUser() {
  try { return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || "null"); } catch { return null; }
}
function authSave(token, user) {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  } catch { /* storage blocked */ }
}
function authClear() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  } catch { /* storage blocked */ }
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const api = {
  _headers(extra = {}) {
    const token = authGetToken();
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  },
  async get(path) {
    const res = await fetch(path, { headers: this._headers() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: "PUT",
      headers: this._headers(),
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
  if (page === "seller") {
    loadMyAgents()
    loadPendingApprovals();
  };
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
        <td>${r.agentMaker || "—"}</td>
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
  button.textContent = "Creating order…";
  setCheckoutMessage("", "");

  try {
    const { approvalUrl } = await api.post(`/api/records/${activeRecord.id}/paypal/order`, {});
    if (!approvalUrl) throw new Error("PayPal did not return an approval URL.");
    setCheckoutMessage("Redirecting to PayPal Sandbox…", "redirecting");
    window.location.assign(approvalUrl);
  } catch (err) {
    button.disabled = false;
    button.textContent = "Pay with PayPal Sandbox";
    setCheckoutMessage(`Could not start checkout: ${err.message}`, "error");
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
      setCheckoutMessage("Payment captured via PayPal Sandbox.", "captured");
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
  if (type === "redirecting") {
    msg.innerHTML = `<div class="paypal-redirecting">${text}</div>`;
    return;
  }
  if (type === "captured") {
    msg.innerHTML = `<div class="paypal-success">${text}</div>`;
    return;
  }
  msg.innerHTML = "";
  msg.textContent = text;
  msg.style.color = type === "error" ? "var(--red)" : "var(--muted)";
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
// Agent chat
// ---------------------------------------------------------------------------

// Conversation history sent back to the server each turn (excludes system prompt)
let chatHistory = [];
// approvalId of a pending human-approval request from the agent
let pendingApprovalId = null;
// recordId linked to a pending approval (needed after approve to trigger payment)
let pendingApprovalRecordId = null;

function setAgentStatus(state) {
  const pill = document.getElementById("agent-status-pill");
  if (!pill) return;
  pill.textContent = state === "thinking" ? "Thinking…" : state === "error" ? "Error" : "Ready";
  pill.className = "status " + (state === "thinking" ? "status-review" : state === "error" ? "status-block" : "status-allow");
}

function appendChatBubble(role, text) {
  const thread = document.getElementById("chat-thread");
  const empty = document.getElementById("chat-empty");
  if (empty) empty.style.display = "none";

  const bubble = document.createElement("div");
  bubble.className = `chat-bubble chat-bubble-${role}`;
  bubble.textContent = text;
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
  return bubble;
}

function appendPayPalLinkBubble(approvalUrl) {
  const thread = document.getElementById("chat-thread");
  const wrapper = document.createElement("div");
  wrapper.className = "chat-bubble chat-bubble-agent chat-paypal-bubble";
  wrapper.innerHTML = `
    <span>PayPal Sandbox checkout is ready.</span>
    <a class="chat-paypal-link" href="${approvalUrl}" target="_blank" rel="noopener">
      Pay with PayPal Sandbox
    </a>`;
  thread.appendChild(wrapper);
  thread.scrollTop = thread.scrollHeight;
}

function showApprovalCard(pendingApproval) {
  pendingApprovalId = pendingApproval.approvalId;
  pendingApprovalRecordId = pendingApproval.recordId;

  const card = document.getElementById("approval-card");
  const body = document.getElementById("approval-card-body");
  body.innerHTML = `
    <p><strong>${pendingApproval.agentName}</strong> — $${Number(pendingApproval.amount).toFixed(2)}</p>
    <p>${pendingApproval.reason}</p>`;
  card.style.display = "";
}

function hideApprovalCard() {
  document.getElementById("approval-card").style.display = "none";
  pendingApprovalId = null;
  pendingApprovalRecordId = null;
}

async function sendChatMessage(message) {
  const sendBtn = document.getElementById("chat-send");
  const input = document.getElementById("chat-input");

  sendBtn.disabled = true;
  input.disabled = true;
  setAgentStatus("thinking");
  appendChatBubble("user", message);

  try {
    const data = await api.post("/api/agent/chat", { message, history: chatHistory });

    // Persist updated history for next turn
    chatHistory = data.history || [];

    if (data.reply) appendChatBubble("agent", data.reply);

    if (data.pendingApproval) {
      showApprovalCard(data.pendingApproval);
    }

    if (data.paypalApprovalUrl) {
      appendPayPalLinkBubble(data.paypalApprovalUrl);
    }

    loadPolicyMini();
    loadActivityList();
    setAgentStatus("ready");
  } catch (err) {
    appendChatBubble("agent", `Error: ${err.message}`);
    setAgentStatus("error");
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

async function approveAgentPayment() {
  if (!pendingApprovalId) return;
  const btn = document.getElementById("approve-btn");
  btn.disabled = true;
  btn.textContent = "Approving…";

  try {
    await api.post(`/api/agent/approval/${pendingApprovalId}/approve`, {});
    hideApprovalCard();
    appendChatBubble("agent", "Approved. Creating your PayPal Sandbox checkout order…");

    // Now trigger payment for the approved record
    const { approvalUrl } = await api.post(`/api/records/${pendingApprovalRecordId}/paypal/order`, {});
    if (approvalUrl) {
      appendPayPalLinkBubble(approvalUrl);
    } else {
      appendChatBubble("agent", "Order created but no approval URL returned. Check the History tab.");
    }

    loadPolicyMini();
    loadActivityList();
  } catch (err) {
    appendChatBubble("agent", `Approval failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = "Approve payment";
  }
}

async function rejectAgentPayment() {
  if (!pendingApprovalId) return;
  try {
    await api.post(`/api/agent/approval/${pendingApprovalId}/reject`, {});
  } catch (_) {
    // best-effort
  }
  hideApprovalCard();
  appendChatBubble("agent", "Request rejected. No payment was made.");
}

// ---------------------------------------------------------------------------
// Auth UI
// ---------------------------------------------------------------------------

function authUpdateTopbar() {
  const user = authGetUser();
  const pill    = document.getElementById("auth-user-pill");
  const signIn  = document.getElementById("auth-open-btn");
  const signOut = document.getElementById("auth-signout-btn");
  const sellerNav = document.getElementById("nav-seller");
  const adminSection = document.getElementById("admin-approvals-section");

  if (!user) {
    // reset topbar to logged-out state
    // hide seller tab, show sign-in button, etc.
    return;
  }

  if (adminSection) {
    adminSection.style.display = user.role === "admin" ? "block" : "none";
  }

  if (user) {
    pill.textContent = `${user.email} · ${user.role}`;
    pill.style.display = "";
    signIn.style.display  = "none";
    signOut.style.display = "";
    if (sellerNav) sellerNav.style.display = user.role === "seller" || user.role === "admin" ? "" : "none";
  } else {
    pill.style.display    = "none";
    signIn.style.display  = "";
    signOut.style.display = "none";
    if (sellerNav) sellerNav.style.display = "none";
  }
}

function authOpenModal(tab = "login") {
  const modal = document.getElementById("auth-modal");
  modal.style.display = "flex";
  document.querySelectorAll(".auth-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.authTab === tab);
  });
  document.querySelectorAll(".auth-form").forEach((f) => {
    f.style.display = f.dataset.authPanel === tab ? "" : "none";
  });
  document.getElementById(tab === "login" ? "login-email" : "reg-email").focus();
}

function authCloseModal() {
  document.getElementById("auth-modal").style.display = "none";
  document.getElementById("login-message").textContent   = "";
  document.getElementById("register-message").textContent = "";
}

async function authSubmitLogin(e) {
  e.preventDefault();
  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const msg      = document.getElementById("login-message");
  msg.textContent = "Signing in…";

  try {
    const res  = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) { msg.textContent = data.error || "Sign in failed."; return; }
    authSave(data.token, data.user);
    authUpdateTopbar();
    authCloseModal();
    showToast(`Welcome back, ${data.user.email}`);
  } catch {
    msg.textContent = "Network error. Try again.";
  }
}

async function authSubmitRegister(e) {
  e.preventDefault();
  const email    = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  const role     = document.getElementById("reg-role").value;
  const msg      = document.getElementById("register-message");
  msg.textContent = "Creating account…";

  try {
    const res  = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, role })
    });
    const data = await res.json();
    if (!res.ok) { msg.textContent = data.error || "Registration failed."; return; }
    authSave(data.token, data.user);
    authUpdateTopbar();
    authCloseModal();
    showToast(`Account created — welcome, ${data.user.email}`);
  } catch {
    msg.textContent = "Network error. Try again.";
  }
}

function authSignOut() {
  authClear();
  authUpdateTopbar();
  showToast("Signed out.");
}

// ---------------------------------------------------------------------------
// Seller portal
// ---------------------------------------------------------------------------

async function submitAgent(e) {
  e.preventDefault();
  const msg = document.getElementById("seller-message");
  msg.textContent = "Submitting…";

  const payload = {
    name:        document.getElementById("seller-name").value.trim(),
    description: document.getElementById("seller-desc").value.trim(),
    category:    document.getElementById("seller-category").value,
    price:       parseFloat(document.getElementById("seller-price").value),
    agentUrl:    document.getElementById("seller-url").value.trim(),
    icon:        document.getElementById("seller-icon").value.trim() || "🤖",
  };

  try {
    await api.post("/api/agents", payload);
    document.getElementById("seller-form").reset();
    msg.textContent = "Submitted for review. It will appear in the marketplace once approved.";
    loadMyAgents();
  } catch (err) {
    msg.textContent = err.message || "Submission failed.";
  }
}

// AGENT Approvals
async function loadPendingApprovals() {
  const container = document.getElementById("pending-approvals-list");
  if (!container) return;
  try {
    // Reuse the existing agents endpoint — filter client-side for pending
    const { agents } = await api.get("/api/agents/pending");
    const pending = agents;
    if (!pending.length) {
      container.innerHTML = `<p class="muted-note">No pending approvals.</p>`;
      return;
    }
    container.innerHTML = pending.map(a => `
      <div class="my-agent-row" id="approval-row-${a.id}">
        <span class="my-agent-icon">${a.icon}</span>
        <div class="my-agent-info">
          <strong>${a.name}</strong>
          <small>${a.category} · $${a.price} · ${a.submittedBy}</small>
          <small><a href="${a.agentUrl}" target="_blank">${a.agentUrl}</a></small>
        </div>
        <button class="btn-approve" data-id="${a.id}">Approve</button>
      </div>`).join("");

    container.querySelectorAll(".btn-approve").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = "Approving...";
        try {
          await api.post(`/api/agents/${id}/approve`, {});
          document.getElementById(`approval-row-${id}`)?.remove();
          showToast("Agent approved.");
        } catch (err) {
          btn.disabled = false;
          btn.textContent = "Approve";
          showToast("Approval failed.");
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<p class="muted-note">Could not load pending approvals.</p>`;
  }
}

async function loadMyAgents() {
  const container = document.getElementById("my-agents-list");
  if (!container) return;
  try {
    const { agents } = await api.get("/api/agents/mine");
    if (!agents.length) {
      container.innerHTML = `<p class="muted-note">No submissions yet.</p>`;
      return;
    }
    container.innerHTML = agents.map((a) => `
      <div class="my-agent-row">
        <span class="my-agent-icon">${a.icon}</span>
        <div class="my-agent-info">
          <strong>${a.name}</strong>
          <small>${a.category} · $${a.price}</small>
        </div>
        <span class="status status-${a.status === "active" ? "allow" : a.status === "rejected" ? "block" : "review"}">
          ${a.status}
        </span>
      </div>`).join("");
  } catch (err) {
    console.error("loadMyAgents failed:", err);
    container.innerHTML = `<p class="muted-note">Could not load your submissions.</p>`;
  }
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

  // Agent chat form
  document.getElementById("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    input.style.height = "";
    sendChatMessage(message);
  });

  // Auto-grow textarea
  document.getElementById("chat-input").addEventListener("input", (e) => {
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
  });

  // Quick-start buttons
  document.querySelectorAll(".chat-quickstart[data-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById("chat-input");
      input.value = btn.dataset.prompt;
      input.focus();
    });
  });

  // Approval card buttons
  document.getElementById("approve-btn").addEventListener("click", approveAgentPayment);
  document.getElementById("reject-btn").addEventListener("click", rejectAgentPayment);

  // Auth
  document.getElementById("auth-open-btn").addEventListener("click", () => authOpenModal("login"));
  document.getElementById("auth-signout-btn").addEventListener("click", authSignOut);
  document.getElementById("auth-close-btn").addEventListener("click", authCloseModal);
  document.getElementById("auth-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) authCloseModal();
  });
  document.getElementById("auth-login-form").addEventListener("submit", authSubmitLogin);
  document.getElementById("auth-register-form").addEventListener("submit", authSubmitRegister);
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => authOpenModal(tab.dataset.authTab));
  });

  // Show / hide password toggles
  document.querySelectorAll(".show-pass-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      btn.querySelector(".eye-open").style.display  = isHidden ? "none" : "";
      btn.querySelector(".eye-closed").style.display = isHidden ? "" : "none";
      btn.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    });
  });

  // Seller portal
  const sellerForm = document.getElementById("seller-form");
  if (sellerForm) sellerForm.addEventListener("submit", submitAgent);

  // Restore session and show/hide seller nav
  authUpdateTopbar();
  loadMyAgents();

  // Initial data load
  loadAgents();
  loadPolicyMini();
  loadActivityList();
  handlePayPalReturn();
}

document.addEventListener("DOMContentLoaded", init);