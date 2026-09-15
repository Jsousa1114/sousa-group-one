const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add it in the Render service's environment variables.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
});

// Demo accounts created on first boot if the users table is empty.
// Every account uses the password "demo1234" (change these once you have real users).
const DEMO_USERS = [
  { email: "admin@sousagroup.ch",      role: "admin",      name: "Joao Sousa",       avatar: "JS", company: "group" },
  { email: "direction@sousagroup.ch",  role: "direction",  name: "Joao Sousa",       avatar: "JS", company: "group" },
  { email: "hr@sousagroup.ch",         role: "hr",         name: "Ana Martins",      avatar: "AM", company: "group" },
  { email: "manager@sousagroup.ch",    role: "manager",    name: "Sohan De Sousa",   avatar: "SD", company: "home" },
  { email: "accounting@sousagroup.ch", role: "accounting", name: "Ana Martins",      avatar: "AM", company: "group" },
  { email: "employee@sousagroup.ch",   role: "employee",   name: "Lucas Moreira",    avatar: "LM", company: "electricite" },
  { email: "client@sousagroup.ch",     role: "client",     name: "Marie Dupont",     avatar: "MD", company: "group" }
];

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(50) NOT NULL,
      name VARCHAR(160) NOT NULL,
      avatar VARCHAR(8) NOT NULL,
      company VARCHAR(50) NOT NULL DEFAULT 'group',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by VARCHAR(255)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(255),
      action VARCHAR(100),
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users");
  if (rows[0].n === 0) {
    console.log("No users found — creating demo accounts (password: demo1234)...");
    const hash = await bcrypt.hash("demo1234", 10);
    for (const u of DEMO_USERS) {
      await pool.query(
        `INSERT INTO users (email, password_hash, role, name, avatar, company)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (email) DO NOTHING`,
        [u.email, hash, u.role, u.name, u.avatar, u.company]
      );
    }
  }
}

module.exports = { pool, migrate };
