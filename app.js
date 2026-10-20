const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const port = Number(process.env.PORT) || 3000;

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
    .filter((record) => isToday(record.createdAt) && record.paymentState === "DEMO_CONFIRMED")
    .reduce((total, record) => total + record.amount, 0);
}

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
    taskState: assessment.decision === "block" ? "BLOCKED" : assessment.decision === "review" ? "AWAITING_USER_APPROVAL" : "AWAITING_CHECKOUT"
  };
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

app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

app.get("/api/health", (request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/agents", (request, response) => {
  const category = request.query.category;
  const search = String(request.query.search || "").trim().toLowerCase();
  const matchingAgents = agents.filter((agent) => {
    const categoryMatches = !category || category === "All agents" || agent.category === category;
    const searchableText = `${agent.name} ${agent.description} ${agent.category} ${agent.maker}`.toLowerCase();
    return categoryMatches && searchableText.includes(search);
  });
  response.json({ agents: matchingAgents, count: matchingAgents.length });
});

app.get("/api/agents/:agentId", (request, response) => {
  const agent = findAgent(request.params.agentId);
  if (!agent) return sendError(response, 404, "Agent not found.");
  response.json(agent);
});

app.get("/api/policy", (request, response) => {
  response.json({ ...policy, todaySpend: todaySpend(), remainingBudget: Math.max(0, policy.dailyBudget - todaySpend()) });
});

app.put("/api/policy", (request, response) => {
  const nextPolicy = parsePolicy(request.body || {});
  const validationError = validatePolicy(nextPolicy);
  if (validationError) return sendError(response, 400, validationError);
  policy = nextPolicy;
  response.json({ ...policy, todaySpend: todaySpend(), remainingBudget: Math.max(0, policy.dailyBudget - todaySpend()) });
});

app.get("/api/history", (request, response) => {
  response.json({ records: [...history].reverse(), count: history.length });
});

app.post("/api/assess", (request, response) => {
  const { agentId, brief = "" } = request.body || {};
  const agent = findAgent(agentId);
  if (!agent) return sendError(response, 404, "Agent not found.");
  if (typeof brief !== "string" || brief.length > 500) return sendError(response, 400, "Brief must be a string of 500 characters or fewer.");
  const assessment = assessRisk(agent, brief.trim());
  const record = createAssessmentRecord(agent, brief.trim(), assessment);
  history.push(record);
  response.status(201).json({ assessment, record });
});

app.post("/api/records/:recordId/approve", (request, response) => {
  const record = getRecord(request.params.recordId);
  if (!record) return sendError(response, 404, "Audit record not found.");
  if (record.decision !== "review") return sendError(response, 409, "Only requests awaiting review can be approved.");
  record.taskState = "APPROVED_FOR_CHECKOUT";
  response.json(record);
});

app.post("/api/records/:recordId/payment", (request, response) => {
  const record = getRecord(request.params.recordId);
  if (!record) return sendError(response, 404, "Audit record not found.");
  if (record.decision === "block") return sendError(response, 409, "Blocked requests cannot be paid.");
  if (record.decision === "review" && record.taskState !== "APPROVED_FOR_CHECKOUT") return sendError(response, 409, "Approve this request before payment.");
  if (record.paymentState === "DEMO_CONFIRMED") return sendError(response, 409, "This demo payment was already recorded.");
  record.paymentState = "DEMO_CONFIRMED";
  record.taskState = "DEMO_COMPLETED";
  response.json(record);
});

app.get("*", (request, response) => {
  response.sendFile(path.join(__dirname, "index.html"));
});

if (require.main === module) {
  app.listen(port, () => console.log(`Aegis API listening on http://localhost:${port}`));
}

module.exports = { app, assessRisk, validatePolicy };
