"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../database/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const SALT_ROUNDS = 10;
const TOKEN_TTL = "7d";

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set in .env");
  return secret;
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    getSecret(),
    { expiresIn: TOKEN_TTL }
  );
}

function safeUser(row) {
  // Never return the password hash to the client
  const { password: _pw, ...rest } = row;
  return rest;
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function validateEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function validatePassword(password) {
  return typeof password === "string" && password.length >= 8;
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------

router.post("/register", async (req, res) => {
  const { email = "", password = "", role = "buyer" } = req.body || {};

  if (!validateEmail(email)) {
    return sendError(res, 400, "A valid email address is required.");
  }
  if (!validatePassword(password)) {
    return sendError(res, 400, "Password must be at least 8 characters.");
  }
  // Only allow buyer or seller at registration — admin is set manually
  if (!["buyer", "seller"].includes(role)) {
    return sendError(res, 400, "Role must be 'buyer' or 'seller'.");
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.trim().toLowerCase());
  if (existing) {
    return sendError(res, 409, "An account with that email already exists.");
  }

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = {
    id: crypto.randomUUID(),
    email: email.trim().toLowerCase(),
    password: hash,
    role
  };

  db.prepare(
    "INSERT INTO users (id, email, password, role) VALUES (@id, @email, @password, @role)"
  ).run(user);

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  res.status(201).json({ token: signToken(row), user: safeUser(row) });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

router.post("/login", async (req, res) => {
  const { email = "", password = "" } = req.body || {};

  if (!validateEmail(email) || !validatePassword(password)) {
    return sendError(res, 400, "Email and password are required.");
  }

  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase());
  if (!row) {
    // Constant-time-ish: still hash even on miss to avoid timing attacks
    await bcrypt.hash(password, SALT_ROUNDS);
    return sendError(res, 401, "Invalid email or password.");
  }

  const match = await bcrypt.compare(password, row.password);
  if (!match) return sendError(res, 401, "Invalid email or password.");

  res.json({ token: signToken(row), user: safeUser(row) });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

router.get("/me", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!row) return sendError(res, 404, "User not found.");
  res.json(safeUser(row));
});

module.exports = { router };