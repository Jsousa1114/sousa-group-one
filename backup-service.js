"use strict";
const { gzipSync } = require("node:zlib");
const storage = require("./storage");

async function buildBackup(db) {
  const tables = (
    await db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'
       ORDER BY table_name`,
    )
  ).rows.map((x) => x.table_name);
  const backup = {
    format: "sgo-logical-backup-v1",
    createdAt: new Date().toISOString(),
    tables: {},
  };
  for (const table of tables) {
    const quoted = '"' + table.replace(/"/g, '""') + '"';
    const result = await db.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM ${quoted} t`,
    );
    backup.tables[table] = result.rows[0].rows || [];
  }
  return backup;
}
async function runBackup(db) {
  if (!storage.available()) return { ok: false, skipped: "object-storage-not-configured" };
  await db.query(
    `CREATE TABLE IF NOT EXISTS backup_runs(
      id BIGSERIAL PRIMARY KEY,
      object_key TEXT,
      bytes BIGINT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  const recent = (
    await db.query(
      "SELECT created_at FROM backup_runs WHERE status='ok' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  if (
    recent?.created_at &&
    Date.now() - new Date(recent.created_at).getTime() < 20 * 60 * 60 * 1000
  )
    return { ok: true, skipped: "recent-backup-exists" };
  try {
    const backup = await buildBackup(db);
    const bytes = gzipSync(Buffer.from(JSON.stringify(backup)));
    const prefix = String(process.env.BACKUP_OBJECT_PREFIX || "backups")
      .replace(/^\/+|\/+$/g, "");
    const filename =
      "sgo-" + backup.createdAt.replace(/[:]/g, "-").replace(/[^a-zA-Z0-9_.-]/g, "_") + ".json.gz";
    const key = [prefix, filename].filter(Boolean).join("/");
    await storage.putObject(key, bytes, "application/gzip");
    await db.query(
      "INSERT INTO backup_runs(object_key,bytes,status) VALUES($1,$2,'ok')",
      [key, bytes.length],
    );
    return { ok: true, key, bytes: bytes.length };
  } catch (error) {
    await db.query(
      "INSERT INTO backup_runs(status,error) VALUES('failed',$1)",
      [String(error.message || error).slice(0, 4000)],
    ).catch(() => {});
    throw error;
  }
}
function startBackupScheduler(db) {
  if (!storage.available()) return null;
  const execute = () =>
    runBackup(db).catch((error) =>
      console.error("Automatic backup failed", error),
    );
  setTimeout(execute, 60 * 1000).unref?.();
  const timer = setInterval(execute, 6 * 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}
module.exports = { buildBackup, runBackup, startBackupScheduler };
