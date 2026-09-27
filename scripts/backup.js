"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
const { pool, migrate } = require("../db");
const storage = require("../storage");

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}
(async () => {
  await migrate(pool);
  const tables = (
    await pool.query(
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
    const result = await pool.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM ${quoted} t`,
    );
    backup.tables[table] = result.rows[0].rows || [];
  }
  const bytes = gzipSync(Buffer.from(JSON.stringify(backup)));
  const filename =
    "sgo-" + safeName(backup.createdAt.replace(/[:]/g, "-")) + ".json.gz";
  if (storage.available()) {
    const prefix = String(process.env.BACKUP_OBJECT_PREFIX || "backups")
      .replace(/^\/+|\/+$/g, "");
    const key = [prefix, filename].filter(Boolean).join("/");
    await storage.putObject(key, bytes, "application/gzip");
    console.log(JSON.stringify({ ok: true, destination: "object-storage", key, bytes: bytes.length }));
  } else {
    const dir = path.resolve(process.env.BACKUP_DIR || "backups");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, filename);
    fs.writeFileSync(target, bytes);
    console.log(JSON.stringify({ ok: true, destination: target, bytes: bytes.length }));
  }
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
