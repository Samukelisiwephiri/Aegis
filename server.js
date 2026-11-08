"use strict";

const express = require("express");
const path = require("path");

const { router: apiRouter } = require("./routes/api");
const { router: agentRouter } = require("./routes/agent");
const { router: authRouter } = require("./routes/auth");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", authRouter);
app.use("/api/agent", agentRouter);
app.use("/api", apiRouter);


// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

module.exports = app;

const path = require('path');

// Use /tmp on Vercel for the SQLite database, or local file for your PC
const dbPath = process.env.VERCEL 
  ? path.join('/tmp', 'aegis.db') 
  : path.join(__dirname, 'aegis.db');

// Pass dbPath into your better-sqlite3 initialization:
// const db = new Database(dbPath);