"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../database/db");
const { optionalAuth, requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.use((req, res, next) => {
  console.log(`[apiRouter] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const paypalBaseUrl = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${Number(process.env.PORT) || 3000}`;

// ---------------------------------------------------------------------------
// PayPal token cache (in-memory is fine — it's just a short-lived credential)
// ---------------------------------------------------------------------------

let paypalAccessToken = null;
let paypalAccessTokenExpiresAt = 0;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function normalizeAgent(row) {
  if (!row) return null;
  return { ...row, verified: Boolean(row.verified) };
}

function normalizeRecord(row) {
  if (!row) return null;
  return { ...row, signals: JSON.parse(row.signals || "[]") };
}

function findAgent(agentId) {
  return normalizeAgent(
    db.prepare("SELECT * FROM agents WHERE id = ? AND status = 'active'").get(agentId)
  );
}

function getPolicy() {
  return db.prepare("SELECT * FROM policy WHERE id = 1").get();
}

function getRecord(recordId) {
  return normalizeRecord(
    db.prepare("SELECT * FROM records WHERE id = ?").get(recordId)
  );
}

function isPaidRecord(record) {
  return record.paymentState === "PAYPAL_CAPTURED" || record.paymentState === "DEMO_CONFIRMED";
}

function todaySpend() {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM records
    WHERE DATE(createdAt) = DATE('now')
      AND (paymentState = 'PAYPAL_CAPTURED' OR paymentState = 'DEMO_CONFIRMED')
  `).get();
  return row.total;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
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
  if (values.some((v) => !Number.isFinite(v) || v < 1 || v > 10000)) {
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

const riskyTerms = ["urgent", "crypto", "wallet", "gift card", "wire transfer", "bypass", "seed phrase", "guaranteed return"];

function assessRisk(agent, brief, policy) {
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

  return {
    decision,
    reason,
    score: Math.min(100, decision === "block" ? Math.max(score, 85) : score),
    signals
  };
}

function createAssessmentRecord(agent, brief, assessment) {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    agentId: agent.id,
    agentName: agent.name,
    agentMaker: agent.maker,
    amount: agent.price,
    brief,
    decision: assessment.decision,
    score: assessment.score,
    signals: assessment.signals,
    paymentState: "NOT_STARTED",
    paymentProvider: "PAYPAL_SANDBOX",
    paypalOrderId: null,
    paypalApprovalUrl: null,
    paypalStatus: null,
    taskState:
      assessment.decision === "block"
        ? "BLOCKED"
        : assessment.decision === "review"
        ? "AWAITING_USER_APPROVAL"
        : "AWAITING_CHECKOUT"
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
    const detail = body.details?.map((d) => d.description).filter(Boolean).join("; ");
    throw new Error(detail || body.message || `PayPal request failed with status ${response.status}.`);
  }
  return body;
}

async function getPayPalAccessToken() {
  if (!paypalConfigured()) {
    throw new Error("PayPal Sandbox is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  }
  if (paypalAccessToken && Date.now() < paypalAccessTokenExpiresAt) return paypalAccessToken;

  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

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
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || "Could not authenticate with PayPal Sandbox.");
  }

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

function paypalError(res, error) {
  const message = error instanceof Error ? error.message : "PayPal request failed.";
  const status = message.includes("not configured") ? 503 : 502;
  return sendError(res, status, message);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/health", (_req, res) => {
  res.json({ status: "ok", paypalSandboxConfigured: paypalConfigured() });
});

router.get("/agents", (req, res) => {
  const category = req.query.category;
  const search = String(req.query.search || "").trim().toLowerCase();

  let query = "SELECT * FROM agents WHERE status = 'active'";
  const params = [];

  if (category && category !== "All agents") {
    query += " AND category = ?";
    params.push(category);
  }

  const agents = db.prepare(query).all(...params)
    .map(normalizeAgent)
    .filter((a) => {
      if (!search) return true;
      return `${a.name} ${a.description} ${a.category} ${a.maker}`.toLowerCase().includes(search);
    });

  res.json({ agents, count: agents.length });
});

// GET /api/agents/mine — seller sees their own submissions (any status)
router.get("/agents/mine", requireAuth, (req, res) => {
  const agents = db.prepare(
    "SELECT * FROM agents WHERE submittedBy = ? ORDER BY createdAt DESC"
  ).all(req.user.email).map(normalizeAgent);
  res.json({ agents, count: agents.length });
});

router.get("/agents/pending", requireAuth, requireRole("admin"), (req, res) => {
  const agents = db.prepare(
    "SELECT * FROM agents WHERE status = 'pending' ORDER BY createdAt DESC"
  ).all().map(normalizeAgent);
  res.json({ agents, count: agents.length });
});

router.get("/agents/:agentId", (req, res) => {
  const agent = findAgent(req.params.agentId);
  if (!agent) return sendError(res, 404, "Agent not found.");
  res.json(agent);
});

router.get("/policy", (_req, res) => {
  const policy = getPolicy();
  const spend = todaySpend();
  res.json({ ...policy, todaySpend: spend, remainingBudget: Math.max(0, policy.dailyBudget - spend) });
});

router.put("/policy", (req, res) => {
  const nextPolicy = parsePolicy(req.body || {});
  const error = validatePolicy(nextPolicy);
  if (error) return sendError(res, 400, error);

  db.prepare(
    "UPDATE policy SET taskCeiling = ?, approvalThreshold = ?, dailyBudget = ? WHERE id = 1"
  ).run(nextPolicy.taskCeiling, nextPolicy.approvalThreshold, nextPolicy.dailyBudget);

  const updated = getPolicy();
  const spend = todaySpend();
  res.json({ ...updated, todaySpend: spend, remainingBudget: Math.max(0, updated.dailyBudget - spend) });
});

router.get("/history", optionalAuth, (req, res) => {
  let records;
  if (req.user) {
    records = db.prepare(
      "SELECT * FROM records WHERE userId = ? ORDER BY createdAt DESC"
    ).all(req.user.id).map(normalizeRecord);
  } else {
    records = db.prepare(
      "SELECT * FROM records WHERE userId IS NULL ORDER BY createdAt DESC"
    ).all().map(normalizeRecord);
  }
  res.json({ records, count: records.length });
});

router.post("/assess", optionalAuth, (req, res) => {
  const { agentId, brief = "" } = req.body || {};
  const agent = findAgent(agentId);
  if (!agent) return sendError(res, 404, "Agent not found.");
  if (typeof brief !== "string" || brief.length > 500) {
    return sendError(res, 400, "Brief must be a string of 500 characters or fewer.");
  }

  const policy = getPolicy();
  const assessment = assessRisk(agent, brief.trim(), policy);
  const record = createAssessmentRecord(agent, brief.trim(), assessment);

  db.prepare(`
    INSERT INTO records
      (id, createdAt, agentId, agentName, agentMaker, amount, brief, decision, score,
       signals, paymentState, paymentProvider, paypalOrderId, paypalApprovalUrl, paypalStatus, taskState, userId)
    VALUES
      (@id, @createdAt, @agentId, @agentName, @agentMaker, @amount, @brief, @decision, @score,
       @signals, @paymentState, @paymentProvider, @paypalOrderId, @paypalApprovalUrl, @paypalStatus, @taskState, @userId)
  `).run({ ...record, signals: JSON.stringify(record.signals), userId: req.user?.id ?? null });

  res.status(201).json({ assessment, record });
});

router.post("/records/:recordId/approve", (req, res) => {
  const record = getRecord(req.params.recordId);
  if (!record) return sendError(res, 404, "Audit record not found.");
  if (record.decision !== "review") {
    return sendError(res, 409, "Only requests awaiting review can be approved.");
  }

  db.prepare("UPDATE records SET taskState = 'APPROVED_FOR_CHECKOUT' WHERE id = ?").run(record.id);
  res.json(getRecord(record.id));
});

router.post("/records/:recordId/paypal/order", async (req, res) => {
  const record = getRecord(req.params.recordId);
  if (!record) return sendError(res, 404, "Audit record not found.");
  if (record.decision === "block") return sendError(res, 409, "Blocked requests cannot be paid.");
  if (record.decision === "review" && record.taskState !== "APPROVED_FOR_CHECKOUT") {
    return sendError(res, 409, "Approve this request before payment.");
  }
  if (isPaidRecord(record)) return sendError(res, 409, "This payment was already captured.");

  // Idempotent — return the existing order if one was already created
  if (record.paypalOrderId) {
    return res.json({ record, orderId: record.paypalOrderId, approvalUrl: record.paypalApprovalUrl });
  }

  try {
    const order = await createPayPalOrder(record);
    const approvalUrl = order.links?.find((l) => l.rel === "approve")?.href || null;

    db.prepare(`
      UPDATE records
      SET paypalOrderId = ?, paypalApprovalUrl = ?, paypalStatus = ?, paymentState = 'PAYPAL_ORDER_CREATED'
      WHERE id = ?
    `).run(order.id, approvalUrl, order.status, record.id);

    res.status(201).json({ record: getRecord(record.id), orderId: order.id, approvalUrl });
  } catch (error) {
    paypalError(res, error);
  }
});

router.post("/records/:recordId/paypal/capture", async (req, res) => {
  const record = getRecord(req.params.recordId);
  if (!record) return sendError(res, 404, "Audit record not found.");
  if (record.decision === "block") return sendError(res, 409, "Blocked requests cannot be paid.");
  if (record.decision === "review" && record.taskState !== "APPROVED_FOR_CHECKOUT") {
    return sendError(res, 409, "Approve this request before payment.");
  }

  const orderId = req.body?.orderId || record.paypalOrderId;
  if (!orderId || orderId !== record.paypalOrderId) {
    return sendError(res, 400, "A matching PayPal order is required.");
  }
  if (isPaidRecord(record)) return sendError(res, 409, "This payment was already captured.");

  try {
    const capture = await capturePayPalOrder(orderId);
    const captureStatus = capture.purchase_units?.[0]?.payments?.captures?.[0]?.status;

    if (capture.status !== "COMPLETED" && captureStatus !== "COMPLETED") {
      const status = capture.status || captureStatus || "UNKNOWN";
      db.prepare("UPDATE records SET paypalStatus = ? WHERE id = ?").run(status, record.id);
      return sendError(res, 409, `PayPal returned an incomplete payment status: ${status}.`);
    }

    db.prepare(`
      UPDATE records
      SET paypalStatus = ?, paymentState = 'PAYPAL_CAPTURED', taskState = 'COMPLETED'
      WHERE id = ?
    `).run(capture.status, record.id);

    res.json({ record: getRecord(record.id), paypalOrder: capture });
  } catch (error) {
    paypalError(res, error);
  }
});

router.get("/paypal/return", (req, res) => {
  const query = new URLSearchParams({
    paypal: "approved",
    recordId: String(req.query.recordId || ""),
    orderId: String(req.query.token || "")
  });
  res.redirect(`/?${query.toString()}`);
});

router.get("/paypal/cancel", (req, res) => {
  const query = new URLSearchParams({
    paypal: "cancelled",
    recordId: String(req.query.recordId || "")
  });
  res.redirect(`/?${query.toString()}`);
});

// ---------------------------------------------------------------------------
// Seller routes
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = ["Business", "Marketing", "Creative"];

router.post("/agents", requireAuth, requireRole("seller"), (req, res) => {
  const { name, description, category, price, agentUrl, icon = "🤖" } = req.body || {};

  if (!name || typeof name !== "string" || name.trim().length < 3) {
    return sendError(res, 400, "Agent name must be at least 3 characters.");
  }
  if (!description || typeof description !== "string" || description.trim().length < 10) {
    return sendError(res, 400, "Description must be at least 10 characters.");
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return sendError(res, 400, `Category must be one of: ${VALID_CATEGORIES.join(", ")}.`);
  }
  const parsedPrice = Number(price);
  if (!Number.isFinite(parsedPrice) || parsedPrice < 1 || parsedPrice > 10000) {
    return sendError(res, 400, "Price must be between $1 and $10,000.");
  }
  if (!agentUrl || typeof agentUrl !== "string" || !agentUrl.startsWith("http")) {
    return sendError(res, 400, "A valid URL is required (must start with http).");
  }

  const seller = db.prepare("SELECT email FROM users WHERE id = ?").get(req.user.id);
  const agent = {
    id:          crypto.randomUUID(),
    name:        name.trim(),
    maker:       seller?.email ?? "Unknown",
    icon:        icon.trim() || "🤖",
    tone:        "",
    category,
    description: description.trim(),
    price:       parsedPrice,
    rating:      "New",
    reviews:     "0",
    trust:       70,
    verified:    0,
    typicalMin:  parsedPrice * 0.8,
    typicalMax:  parsedPrice * 1.2,
    status:      "pending",
    agentUrl:    agentUrl.trim(),
    submittedBy: req.user.id,
  };

  db.prepare(`
    INSERT INTO agents
      (id, name, maker, icon, tone, category, description, price, rating, reviews,
       trust, verified, typicalMin, typicalMax, status, agentUrl, submittedBy)
    VALUES
      (@id, @name, @maker, @icon, @tone, @category, @description, @price, @rating, @reviews,
       @trust, @verified, @typicalMin, @typicalMax, @status, @agentUrl, @submittedBy)
  `).run(agent);

  res.status(201).json(normalizeAgent(db.prepare("SELECT * FROM agents WHERE id = ?").get(agent.id)));
});



// POST /api/agents/:agentId/approve — admin only
router.post("/agents/:agentId/approve", requireAuth, requireRole("admin"), (req, res) => {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.agentId);
  if (!agent) return sendError(res, 404, "Agent not found.");
  if (agent.status === "active") return sendError(res, 409, "Agent is already active.");
  db.prepare("UPDATE agents SET status = 'active', verified = 1 WHERE id = ?").run(agent.id);
  res.json(normalizeAgent(db.prepare("SELECT * FROM agents WHERE id = ?").get(agent.id)));
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { router, assessRisk, validatePolicy };