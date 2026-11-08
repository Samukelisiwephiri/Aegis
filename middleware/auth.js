"use strict";

const jwt = require("jsonwebtoken");

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set in .env");
  return secret;
}

/**
 * Verifies the Bearer token in the Authorization header.
 * Attaches req.user = { id, email, role } on success.
 * Returns 401 if the token is missing or invalid.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }

  try {
    req.user = jwt.verify(token, getSecret());
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

/**
 * Like requireAuth but non-blocking — attaches req.user if a valid token is
 * present, leaves req.user undefined otherwise. Use for routes that behave
 * differently for authenticated vs anonymous callers.
 */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, getSecret()); } catch { /* ignore */ }
  }
  next();
}

/**
 * Requires a specific role after requireAuth has run.
 * Usage: router.post("/agents", requireAuth, requireRole("seller"), handler)
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required." });
    if (req.user.role !== role && req.user.role !== "admin") {
      return res.status(403).json({ error: `This action requires the '${role}' role.` });
    }
    next();
  };
}

module.exports = { requireAuth, optionalAuth, requireRole };