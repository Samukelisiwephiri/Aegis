"use strict";

const express = require("express");
const path = require("path");

const { router: apiRouter } = require("./routes/api");
const { router: agentRouter } = require("./routes/agent");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", apiRouter);
app.use("/api/agent", agentRouter);

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

module.exports = { app };