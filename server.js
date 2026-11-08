// --- DATABASE PATH FIX FOR VERCEL ---
// Use /tmp for Vercel's read-only filesystem, or local file for your PC
const path = require('path');
const dbPath = process.env.VERCEL 
  ? path.join('/tmp', 'aegis.db') 
  : path.join(__dirname, 'aegis.db');
// (Make sure your database connection uses `dbPath` above!)

// --- SERVER STARTUP FIX ---
if (process.env.NODE_ENV !== 'production') {
  // Runs normally when you test locally with `node server.js`
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally on port ${PORT}`);
  });
}

// Export the Express app so Vercel's serverless function can handle requests
module.exports = app;