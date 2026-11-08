"use strict";

const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "aegis.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    maker       TEXT NOT NULL,
    icon        TEXT NOT NULL,
    tone        TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL,
    description TEXT NOT NULL,
    price       REAL NOT NULL,
    rating      TEXT NOT NULL,
    reviews     TEXT NOT NULL,
    trust       INTEGER NOT NULL,
    verified    INTEGER NOT NULL DEFAULT 1,
    typicalMin  REAL NOT NULL,
    typicalMax  REAL NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    createdAt   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS records (
    id               TEXT PRIMARY KEY,
    createdAt        TEXT NOT NULL,
    agentId          TEXT NOT NULL,
    agentName        TEXT NOT NULL,
    agentMaker       TEXT NOT NULL,
    amount           REAL NOT NULL,
    brief            TEXT NOT NULL,
    decision         TEXT NOT NULL,
    score            INTEGER NOT NULL,
    signals          TEXT NOT NULL DEFAULT '[]',
    paymentState     TEXT NOT NULL DEFAULT 'NOT_STARTED',
    paymentProvider  TEXT NOT NULL DEFAULT 'PAYPAL_SANDBOX',
    paypalOrderId    TEXT,
    paypalApprovalUrl TEXT,
    paypalStatus     TEXT,
    taskState        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS policy (
    id                INTEGER PRIMARY KEY DEFAULT 1,
    taskCeiling       REAL NOT NULL DEFAULT 100,
    approvalThreshold REAL NOT NULL DEFAULT 25,
    dailyBudget       REAL NOT NULL DEFAULT 150
  );

  CREATE TABLE IF NOT EXISTS users (
    id        TEXT PRIMARY KEY,
    email     TEXT NOT NULL UNIQUE,
    password  TEXT NOT NULL,
    role      TEXT NOT NULL DEFAULT 'buyer',
    createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

// ---------------------------------------------------------------------------
// Seed data — INSERT OR IGNORE so re-starts are safe
// ---------------------------------------------------------------------------

const insertAgent = db.prepare(`
  INSERT OR IGNORE INTO agents
    (id, name, maker, icon, tone, category, description, price, rating, reviews, trust, verified, typicalMin, typicalMax)
  VALUES
    (@id, @name, @maker, @icon, @tone, @category, @description, @price, @rating, @reviews, @trust, @verified, @typicalMin, @typicalMax)
`);

const seed = db.transaction(() => {
  const agents = [
    { id: "planner",  name: "Brand & Business Planner",  maker: "Launchpad AI",  icon: "🚀", tone: "",           category: "Business",  description: "Turn your big idea into a practical, step-by-step business plan.", price: 12,  rating: "4.9", reviews: "1.2k", trust: 96, verified: 1, typicalMin: 8,  typicalMax: 20  },
    { id: "ads",      name: "AdSpark Creative Studio",   maker: "AdSpark",        icon: "📣", tone: "tone-amber",  category: "Marketing", description: "Create a ready-to-publish set of ads for your launch.",              price: 39,  rating: "4.8", reviews: "856",  trust: 92, verified: 1, typicalMin: 25, typicalMax: 45  },
    { id: "site",     name: "Website Launch Kit",        maker: "PixelPilot",     icon: "💻", tone: "tone-cyan",   category: "Creative",  description: "Plan a polished, conversion-ready starter website.",                price: 129, rating: "4.9", reviews: "2.1k", trust: 94, verified: 1, typicalMin: 80, typicalMax: 100 },
    { id: "brand",    name: "Logo & Identity Designer",  maker: "Studio Agent",   icon: "🎨", tone: "tone-rose",   category: "Creative",  description: "Build a memorable visual direction for your new brand.",            price: 24,  rating: "4.7", reviews: "643",  trust: 90, verified: 1, typicalMin: 15, typicalMax: 30  },
    { id: "research", name: "Market Research Analyst",   maker: "Signal Labs",    icon: "🔎", tone: "tone-amber",  category: "Business",  description: "Get a focused competitor and customer research brief.",            price: 49,  rating: "4.8", reviews: "732",  trust: 88, verified: 0, typicalMin: 30, typicalMax: 55  },
    { id: "social",   name: "Social Content Planner",    maker: "DailyPost",      icon: "✍️", tone: "tone-lilac",  category: "Marketing", description: "Plan a month of social posts for your audience.",                  price: 19,  rating: "4.7", reviews: "1.1k", trust: 91, verified: 1, typicalMin: 12, typicalMax: 25  }
  ];

  for (const agent of agents) insertAgent.run(agent);

  db.prepare(
    "INSERT OR IGNORE INTO policy (id, taskCeiling, approvalThreshold, dailyBudget) VALUES (1, 100, 25, 150)"
  ).run();
});

seed();

const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");

// At the bottom of db.js, after your existing seeds
function seedAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?")
                     .get("admin@aegis.ai");
  if (existing) return; // already seeded, skip

  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "changeme123", 10);
  db.prepare(`
    INSERT INTO users (id, email, password, role, createdAt)
    VALUES (?, ?, ?, 'admin', datetime('now'))
  `).run(uuidv4(), "admin@aegis.ai", hash);

  console.log("Admin user seeded: admin@aegis.ai");
}

seedAdmin();

// ---------------------------------------------------------------------------
// Safe migrations — idempotent ALTER TABLE for columns added after initial
// release. SQLite throws if the column already exists; we ignore that error.
// ---------------------------------------------------------------------------

const migrate = (sql) => { try { db.exec(sql); } catch { /* column exists */ } };

migrate("ALTER TABLE records ADD COLUMN userId TEXT");
migrate("ALTER TABLE agents  ADD COLUMN agentUrl    TEXT NOT NULL DEFAULT ''");
migrate("ALTER TABLE agents  ADD COLUMN submittedBy TEXT");

module.exports = db;