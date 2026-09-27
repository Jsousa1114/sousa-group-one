"use strict";
const fs = require("node:fs");
const path = require("node:path");

async function runMigrations(db) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations(
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  const dir = path.join(__dirname, "migrations");
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const applied = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const exists = (
      await db.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
        version,
      ])
    ).rows.length;
    if (exists) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const statements = sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    const client = typeof db.connect === "function" ? await db.connect() : db;
    try {
      await client.query("BEGIN");
      for (const statement of statements) await client.query(statement);
      await client.query(
        "INSERT INTO schema_migrations(version) VALUES($1)",
        [version],
      );
      await client.query("COMMIT");
      applied.push(version);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error("Migration " + version + " failed: " + error.message, {
        cause: error,
      });
    } finally {
      if (client !== db && typeof client.release === "function") client.release();
    }
  }
  return applied;
}

module.exports = { runMigrations };
