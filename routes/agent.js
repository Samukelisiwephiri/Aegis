"use strict";

const express = require("express");
const crypto = require("crypto");
const OpenAI = require("openai");

const router = express.Router();

// In-memory store for approvals waiting on the user.
// keyed by approvalId → { recordId, agentName, amount, reason, createdAt }
const pendingApprovals = new Map();

const BASE = `http://localhost:${Number(process.env.PORT) || 3000}`;

// ---------------------------------------------------------------------------
// Self-request helpers — agent mutates state through its own API, keeping a
// single source of truth for history, policy enforcement, and PayPal state.
// ---------------------------------------------------------------------------

async function selfGet(path) {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Internal request failed (${res.status})`);
  return body;
}

async function selfPost(path, data) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Internal request failed (${res.status})`);
  return body;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_agents",
      description:
        "List available AI agents in the marketplace. Call this to find the right agent for the user's task.",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Optional keyword to filter agents by name, description, or category."
          },
          category: {
            type: "string",
            enum: ["Business", "Marketing", "Creative"],
            description: "Optional category filter."
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_policy",
      description:
        "Get the active spending policy: per-task ceiling, auto-approval threshold, daily budget, and remaining budget for today.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "assess_request",
      description:
        "Run a risk and policy check for a task. Returns decision: 'allow' (auto-approve and pay), 'review' (needs explicit user sign-off), or 'block' (cannot proceed). Always call this before execute_payment.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent ID from list_agents." },
          brief: {
            type: "string",
            description: "Clear task description derived from the user's message. 500 characters max."
          }
        },
        required: ["agentId", "brief"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_human_approval",
      description:
        "Pause and surface an approval card to the user before payment. Call this ONLY when assess_request returns decision='review'. Never call this for 'allow' — that defeats autonomous payment.",
      parameters: {
        type: "object",
        properties: {
          recordId: { type: "string", description: "Record ID from assess_request." },
          agentName: { type: "string", description: "Display name of the agent being hired." },
          amount: { type: "number", description: "Task price in USD." },
          reason: { type: "string", description: "Short explanation of why manual sign-off is required." }
        },
        required: ["recordId", "agentName", "amount", "reason"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "execute_payment",
      description:
        "Create a PayPal Sandbox checkout order for an approved task. Call this immediately after assess_request returns 'allow', or after the user has explicitly approved a 'review' request. Never call for 'block' decisions.",
      parameters: {
        type: "object",
        properties: {
          recordId: { type: "string", description: "Record ID from assess_request." }
        },
        required: ["recordId"]
      }
    }
  }
];

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Aegis, an AI payment orchestrator. You hire AI agents on the user's behalf, run risk assessments, and handle payments — autonomously where policy allows.

## Workflow

1. Understand what the user wants done.
2. Call list_agents to find the best match. Pick the most relevant agent; avoid asking for clarification unless the request is genuinely ambiguous.
3. Call assess_request with the selected agent ID and a concise task brief derived from the user's message.
4. Act on the decision immediately:

  ALLOW  → Call execute_payment right away. Do not ask the user. Do not call request_human_approval.
  REVIEW → Call request_human_approval. Tell the user what needs sign-off and why, then stop and wait.
  BLOCK  → Explain clearly why the request is blocked. Do not call execute_payment or request_human_approval.

5. After execute_payment succeeds, tell the user their PayPal Sandbox checkout link is ready.

## Rules

- Never call execute_payment without a preceding assess_request in the same task flow.
- Never call request_human_approval for an 'allow' decision.
- Never attempt payment on a 'block' decision.
- If the user asks about their budget or policy limits, call get_policy.
- Be concise. Users want action, not narration of each step.`;

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

async function handleTool(name, args) {
  switch (name) {
    case "list_agents": {
      const params = new URLSearchParams();
      if (args.search) params.set("search", args.search);
      if (args.category) params.set("category", args.category);
      return selfGet(`/api/agents?${params}`);
    }

    case "get_policy":
      return selfGet("/api/policy");

    case "assess_request":
      return selfPost("/api/assess", { agentId: args.agentId, brief: args.brief });

    case "request_human_approval": {
      const approvalId = crypto.randomUUID();
      pendingApprovals.set(approvalId, {
        recordId: args.recordId,
        agentName: args.agentName,
        amount: args.amount,
        reason: args.reason,
        createdAt: new Date().toISOString()
      });
      return {
        approvalId,
        status: "pending",
        agentName: args.agentName,
        amount: args.amount,
        reason: args.reason
      };
    }

    case "execute_payment":
      return selfPost(`/api/records/${encodeURIComponent(args.recordId)}/paypal/order`, {});

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

async function runAgentLoop(messages) {
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
  });
  let pendingApproval = null;
  let paypalApprovalUrl = null;

  while (true) {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "openai/gpt-4o-mini",
      messages,
      tools: TOOLS,
      tool_choice: "auto"
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // Model finished — no more tool calls
    if (!assistantMessage.tool_calls?.length) {
      return { reply: assistantMessage.content, pendingApproval, paypalApprovalUrl, messages };
    }

    // Process all tool calls in this turn
    for (const toolCall of assistantMessage.tool_calls) {
      const name = toolCall.function.name;
      let result;

      try {
        const args = JSON.parse(toolCall.function.arguments);
        result = await handleTool(name, args);

        if (name === "execute_payment" && result.approvalUrl) {
          paypalApprovalUrl = result.approvalUrl;
        }
      } catch (err) {
        result = { error: err.message };
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });

      // After request_human_approval, force one final text response then pause.
      // tool_choice: "none" prevents the model from calling execute_payment
      // immediately, which would bypass the user's decision.
      if (name === "request_human_approval" && !result.error) {
        pendingApproval = result;

        const finalResponse = await client.chat.completions.create({
          model: process.env.OPENAI_MODEL || "openai/gpt-4o-mini",
          messages,
          tools: TOOLS,
          tool_choice: "none"
        });
        const finalMessage = finalResponse.choices[0].message;
        messages.push(finalMessage);
        return { reply: finalMessage.content, pendingApproval, paypalApprovalUrl, messages };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /api/agent/chat
// Accepts { message: string, history: Message[] }
// Returns { reply, pendingApproval, paypalApprovalUrl, history }
router.post("/chat", async (req, res) => {
  const { message, history = [] } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }
  if (message.trim().length > 1000) {
    return res.status(400).json({ error: "Message must be 1000 characters or fewer." });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "OpenAI is not configured. Add OPENROUTER_API_KEY to .env." });
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: message.trim() }
  ];

  try {
    const { reply, pendingApproval, paypalApprovalUrl, messages: updated } = await runAgentLoop(messages);
    res.json({
      reply,
      pendingApproval: pendingApproval ?? null,
      paypalApprovalUrl: paypalApprovalUrl ?? null,
      history: updated.slice(1) // strip system prompt before returning to client
    });
  } catch (err) {
    const status = err.status === 401 ? 503 : 500;
    res.status(status).json({ error: `Agent error: ${err.message}` });
  }
});

// POST /api/agent/approval/:approvalId/approve
// Calls /api/records/:recordId/approve and clears the pending entry.
router.post("/approval/:approvalId/approve", async (req, res) => {
  const approval = pendingApprovals.get(req.params.approvalId);
  if (!approval) return res.status(404).json({ error: "Approval not found or already resolved." });

  try {
    await selfPost(`/api/records/${encodeURIComponent(approval.recordId)}/approve`, {});
    pendingApprovals.delete(req.params.approvalId);
    res.json({
      approved: true,
      recordId: approval.recordId,
      agentName: approval.agentName,
      amount: approval.amount
    });
  } catch (err) {
    res.status(502).json({ error: `Approval failed: ${err.message}` });
  }
});

// POST /api/agent/approval/:approvalId/reject
// Clears the pending entry without touching the record.
router.post("/approval/:approvalId/reject", async (req, res) => {
  const approval = pendingApprovals.get(req.params.approvalId);
  if (!approval) return res.status(404).json({ error: "Approval not found or already resolved." });
  pendingApprovals.delete(req.params.approvalId);
  res.json({ approved: false, recordId: approval.recordId, agentName: approval.agentName });
});

module.exports = { router };