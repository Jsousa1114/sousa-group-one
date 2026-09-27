"use strict";
const fs = require("node:fs");
const { gunzipSync } = require("node:zlib");
const { Pool } = require("pg");

if (!process.argv.includes("--confirm-restore"))
  throw new Error("Refusing restore without --confirm-restore.");
const file = process.argv.find((x) => x.endsWith(".json.gz"));
if (!file) throw new Error("Provide a .json.gz backup file.");
const connectionString = process.env.RESTORE_DATABASE_URL;
if (!connectionString)
  throw new Error("RESTORE_DATABASE_URL is required. Production DATABASE_URL is intentionally ignored.");

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});
(async () => {
  const backup = JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
  if (backup.format !== "sgo-logical-backup-v1")
    throw new Error("Unsupported backup format.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = new Set(
      (
        await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
        )
      ).rows.map((x) => x.table_name),
    );
    for (const table of Object.keys(backup.tables))
      if (!existing.has(table))
        throw new Error("Target schema is missing table " + table);
    const quotedTables = Object.keys(backup.tables)
      .map((t) => '"' + t.replace(/"/g, '""') + '"')
      .join(",");
    if (quotedTables) await client.query("TRUNCATE " + quotedTables + " CASCADE");
    for (const [table, rows] of Object.entries(backup.tables)) {
      if (!rows.length) continue;
      const quoted = '"' + table.replace(/"/g, '""') + '"';
      await client.query(
        `INSERT INTO ${quoted}
         SELECT * FROM json_populate_recordset(NULL::${quoted}, $1::json)`,
        [JSON.stringify(rows)],
      );
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ ok: true, tables: Object.keys(backup.tables).length }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
