const express = require("express");
const paypalConfigured = require("./app.js");

// create an express app
export const app = express();

// Middleware to parse JSON request bodies
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Routes registration


// Health status endpoint -> App -> check if server is running
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: "OK", paypalSandboxConfigured: paypalConfigured() });
});