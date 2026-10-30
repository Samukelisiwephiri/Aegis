"use strict";

const express = require("express");
const path = require("path");
const { router: apiRouter } = require("./routes/api");

const app = express();

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", apiRouter);

// Catch-all: serve the SPA for any non-API route
app.get("*", (request, response) => {
  response.sendFile(path.join(__dirname, "public", "index.html"));
});

module.exports = { app };