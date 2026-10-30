"use strict";

const express = require("express");
const crypto = require("crypto");

const router = express.Router();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const paypalBaseUrl = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${Number(process.env.PORT) || 3000}`;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const agents = [
  { id: "planner", name: "Brand & Business Planner", maker: "Launchpad AI", icon: "🚀", tone: "", category: "Business", description: "Turn your big idea into a practical, step-by-step business plan.", price: 12, rating: "4.9", reviews: "1.2k", trust: 96, verified: true, typicalMin: 8, typicalMax: 20 },
  { id: "ads", name: "AdSpark Creative Studio", maker: "AdSpark", icon: "📣", tone: "tone-amber", category: "Marketing", description: "Create a ready-to-publish set of ads for your launch.", price: 39, rating: "4.8", reviews: "856", trust: 92, verified: true, typicalMin: 25, typicalMax: 45 },
  { id: "site", name: "Website Launch Kit", maker: "PixelPilot", icon: "💻", tone: "tone-cyan", category: "Creative", description: "Plan a polished, conversion-ready starter website.", price: 129, rating: "4.9", reviews: "2.1k", trust: 94, verified: true, typicalMin: 80, typicalMax: 100 },
  { id: "brand", name: "Logo & Identity Designer", maker: "Studio Agent", icon: "🎨", tone: "tone-rose", category: "Creative", description: "Build a memorable visual direction for your new brand.", price: 24, rating: "4.7", reviews: "643", trust: 90, verified: true, typicalMin: 15, typicalMax: 30 },
  { id: "research", name: "Market Research Analyst", maker: "Signal Labs", icon: "🔎", tone: "tone-amber", category: "Business", description: "Get a focused competitor and customer research brief.", price: 49, rating: "4.8", reviews: "732", trust: 88, verified: false, typicalMin: 30, typicalMax: 55 },
  { id: "social", name: "Social Content Planner", maker: "DailyPost", icon: "✍️", tone: "tone-lilac", category: "Marketing", description: "Plan a month of social posts for your audience.", price: 19, rating: "4.7", reviews: "1.1k", trust: 91, verified: true, typicalMin: 12, typicalMax: 25 }
];

const riskyTerms = ["urgent", "crypto", "wallet", "gift card", "wire transfer", "bypass", "seed phrase", "guaranteed return"];
const defaultPolicy = { taskCeiling: 100, approvalThreshold: 25, dailyBudget: 150 };
let policy = { ...defaultPolicy };
let history = [];

// ---------------------------------------------------------------------------
// PayPal token cache
// ---------------------------------------------------------------------------

let paypalAccessToken = null;
let paypalAccessTokenExpiresAt = 0;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function sendError(response, status, message) {
  return response.status(status).json({ error: message });
}

function findAgent(agentId) {
  return agents.find((agent) => agent.id === agentId);
}

function isToday(date) {
  return new Date(date).toDateString() === new Date().toDateString();
}

function todaySpend() {
  return history
    .filter((record) => isToday(record.createdAt) && isPaidRecord(record))
    .reduce((total, record) => total + record.amount, 0);
}

function isPaidRecord(record) {
  return record.paymentState === "PAYPAL_CAPTURED" || record.paymentState === "DEMO_CONFIRMED";
}

function getRecord(recordId) {
  return history.find((record) => record.id === recordId);
}

function parsePolicy(body) {
  return {
    taskCeiling: Number(body.taskCeiling),
    approvalThreshold: Number(body.approvalThreshold),
    dailyBudget: Number(body.dailyBudget)
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePolicy(candidate) {
  const values = [candidate.taskCeiling, candidate.approvalThreshold, candidate.dailyBudget];
  if (values.some((value) => !Number.isFinite(value) || value < 1 || value > 10000)) {
    return "Policy amounts must be between $1 and $10,000.";
  }
  if (candidate.approvalThreshold > candidate.taskCeiling) {
    return "The approval threshold cannot exceed the hard per-task limit.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Risk assessment
// ---------------------------------------------------------------------------

function assessRisk(agent, brief) {
  const normalizedBrief = brief.toLowerCase();
  const matches = riskyTerms.filter((term) => normalizedBrief.includes(term));
  const signals = ["Fixed task price is shown before checkout."];
  let score = 8;
  let requiresReview = false;

  if (agent.price > policy.approvalThreshold) {
    score += 18;
    requiresReview = true;
    signals.push(`Price is above your $${policy.approvalThreshold} automatic-approval threshold.`);
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

  let decision = requiresReview ? "review" : "allow";
  let reason = requiresReview
    ? "This request needs an explicit user decision before checkout."
    : "This request meets the configured demo policy and may proceed to checkout.";

  if (agent.price > policy.taskCeiling) {
    decision = "block";
    reason = `The $${agent.price} task exceeds your $${policy.taskCeiling} hard per-task limit.`;
    signals.push("Hard per-task spending limit exceeded.");
  } else if (todaySpend() + agent.price > policy.dailyBudget) {
    decision = "block";
    reason = `This task would exceed your $${policy.dailyBudget} daily budget.`;
    signals.push("Daily budget would be exceeded.");
  }

  return { decision, reason, score: Math.min(100, decision === "block" ? Math.max(score, 85) : score), signals };
}

function createAssessmentRecord(agent, brief, assessment) {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    agentId: agent.id,
    agentName: agent.name,
    amount: agent.price,
    brief,
    decision: assessment.decision,
    score: assessment.score,
    signals: assessment.signals,
    paymentState: "NOT_STARTED",
    paymentProvider: "PAYPAL_SANDBOX",
    paypalOrderId: null,
    paypalApprovalUrl: null,
    taskState: assessment.decision === "block" ? "BLOCKED" : assessment.decision === "review" ? "AWAITING_USER_APPROVAL" : "AWAITING_CHECKOUT"
  };
}

// ---------------------------------------------------------------------------
// PayPal helpers
// ---------------------------------------------------------------------------

function paypalConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

async function paypalRequest(endpoint, options = {}) {
  const response = await fetch(`${paypalBaseUrl}${endpoint}`, {
    ...options,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.details?.map((item) => item.description).filter(Boolean).join("; ");
    throw new Error(detail || body.message || `PayPal request failed with status ${response.status}.`);
  }
  return body;
}

async function getPayPalAccessToken() {
  if (!paypalConfigured()) {
    throw new Error("PayPal Sandbox is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  }
  if (paypalAccessToken && Date.now() < paypalAccessTokenExpiresAt) return paypalAccessToken;

  const credentials = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${paypalBaseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(body.error_description || "Could not authenticate with PayPal Sandbox.");

  paypalAccessToken = body.access_token;
  paypalAccessTokenExpiresAt = Date.now() + Math.max(0, (body.expires_in - 60) * 1000);
  return paypalAccessToken;
}

async function createPayPalOrder(record) {
  const accessToken = await getPayPalAccessToken();
  return paypalRequest("/v2/checkout/orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "PayPal-Request-Id": record.id },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: record.id,
        description: `${record.agentName} task`,
        amount: { currency_code: "USD", value: record.amount.toFixed(2) }
      }],
      application_context: {
        brand_name: "Aegis AI",
        user_action: "PAY_NOW",
        return_url: `${appBaseUrl}/api/paypal/return?recordId=${record.id}`,
        cancel_url: `${appBaseUrl}/api/paypal/cancel?recordId=${record.id}`
      }
    })
  });
}

async function capturePayPalOrder(orderId) {
  const accessToken = await getPayPalAccessToken();
  return paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "PayPal-Request-Id": `capture-${orderId}` },
    body: "{}"
  });
}

function paypalError(response, error) {
  const message = error instanceof Error ? error.message : "PayPal request failed.";
  const status = message.includes("not configured") ? 503 : 502;
  return sendError(response, status, message);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/health", (request, response) => {
  response.json({ status: "ok", paypalSandboxConfigured: paypalConfigured() });
});

router.get("/agents", (request, response) => {
  const category = request.query.category;
  const search = String(request.query.search || "").trim().toLowerCase();
  const matchingAgents = agents.filter((agent) => {
    const categoryMatches = !category || category === "All agents" || agent.category === category;
    const searchableText = `${agent.name} ${agent.description} ${agent.category} ${agent.maker}`.toLowerCase();
    return categoryMatches && searchableText.includes(search);
  });
  response.json({ agents: matchingAgents, count: matchingAgents.length });
});

router.get("/agents/:agentId", (request, response) => {
  const agent = findAgent(request.params.agentId);
  if (!agent) return sendError(response, 404, "Agent not found.");
  response.json(agent);
});

router.get("/policy", (request, response) => {
  response.json({ ...policy, todaySpend: todaySpend(), remainingBudget: Math.max(0, policy.dailyBudget - todaySpend()) });
});

router.put("/policy", (request, response) => {
  const nextPolicy = parsePolicy(request.body || {});
  const validationError = validatePolicy(nextPolicy);
  if (validationError) return sendError(response, 400, validationError);
  policy = nextPolicy;
  response.json({ ...policy, todaySpend: todaySpend(), remainingBudget: Math.max(0, policy.dailyBudget - todaySpend()) });
});

router.get("/history", (request, response) => {
  response.json({ records: [...history].reverse(), count: history.length });
});

router.post("/assess", (request, response) => {
  const { agentId, brief = "" } = request.body || {};
  const agent = findAgent(agentId);
  if (!agent) return sendError(response, 404, "Agent not found.");
  if (typeof brief !== "string" || brief.length > 500) return sendError(response, 400, "Brief must be a string of 500 characters or fewer.");
  const assessment = assessRisk(agent, brief.trim());
  const record = createAssessmentRecord(agent, brief.trim(), assessment);
  history.push(record);
  response.status(201).json({ assessment, record });
});

router.post("/records/:recordId/approve", (request, response) => {
  const record = getRecord(request.params.recordId);
  if (!record) return sendError(response, 404, "Audit record not found.");
  if (record.decision !== "review") return sendError(response, 409, "Only requests awaiting review can be approved.");
  record.taskState = "APPROVED_FOR_CHECKOUT";
  response.json(record);
});

router.post("/records/:recordId/paypal/order", async (request, response) => {
  const record = getRecord(request.params.recordId);
  if (!record) return sendError(response, 404, "Audit record not found.");
  if (record.decision === "block") return sendError(response, 409, "Blocked requests cannot be paid.");
  if (record.decision === "review" && record.taskState !== "APPROVED_FOR_CHECKOUT") return sendError(response, 409, "Approve this request before payment.");
  if (isPaidRecord(record)) return sendError(response, 409, "This payment was already captured.");
  if (record.paypalOrderId) {
    return response.json({
      record,
      orderId: record.paypalOrderId,
      approvalUrl: record.paypalApprovalUrl
    });
  }

  try {
    const order = await createPayPalOrder(record);
    const approvalUrl = order.links?.find((link) => link.rel === "approve")?.href || null;
    record.paypalOrderId = order.id;
    record.paypalApprovalUrl = approvalUrl;
    record.paypalStatus = order.status;
    record.paymentState = "PAYPAL_ORDER_CREATED";
    response.status(201).json({
      record,
      orderId: order.id,
      approvalUrl
    });
  } catch (error) {
    paypalError(response, error);
  }
});

router.post("/records/:recordId/paypal/capture", async (request, response) => {
  const record = getRecord(request.params.recordId);
  if (!record) return sendError(response, 404, "Audit record not found.");
  if (record.decision === "block") return sendError(response, 409, "Blocked requests cannot be paid.");
  if (record.decision === "review" && record.taskState !== "APPROVED_FOR_CHECKOUT") return sendError(response, 409, "Approve this request before payment.");
  const orderId = request.body?.orderId || record.paypalOrderId;
  if (!orderId || orderId !== record.paypalOrderId) return sendError(response, 400, "A matching PayPal order is required.");
  if (isPaidRecord(record)) return sendError(response, 409, "This payment was already captured.");

  try {
    const capture = await capturePayPalOrder(orderId);
    const captureStatus = capture.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (capture.status !== "COMPLETED" && captureStatus !== "COMPLETED") {
      record.paypalStatus = capture.status || captureStatus || "UNKNOWN";
      return sendError(response, 409, `PayPal returned an incomplete payment status: ${record.paypalStatus}.`);
    }
    record.paypalStatus = capture.status;
    record.paymentState = "PAYPAL_CAPTURED";
    record.taskState = "COMPLETED";
    response.json({ record, paypalOrder: capture });
  } catch (error) {
    paypalError(response, error);
  }
});

router.get("/paypal/return", (request, response) => {
  const query = new URLSearchParams({
    paypal: "approved",
    recordId: String(request.query.recordId || ""),
    orderId: String(request.query.token || "")
  });
  response.redirect(`/?${query.toString()}`);
});

router.get("/paypal/cancel", (request, response) => {
  const query = new URLSearchParams({
    paypal: "cancelled",
    recordId: String(request.query.recordId || "")
  });
  response.redirect(`/?${query.toString()}`);
});

// ---------------------------------------------------------------------------
// Exports (used by tests and sandbox demos)
// ---------------------------------------------------------------------------

module.exports = { router, assessRisk, validatePolicy };
