"use strict";
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { createHash } = require("node:crypto");
const { emptyState, normalize, AppError } = require("./domain");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: true },
});
async function migrate(db = pool) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,email VARCHAR(255) UNIQUE NOT NULL,password_hash TEXT NOT NULL,role VARCHAR(50) NOT NULL,name VARCHAR(160) NOT NULL,avatar VARCHAR(8) NOT NULL,company VARCHAR(50) NOT NULL DEFAULT 'group',created_at TIMESTAMPTZ DEFAULT NOW())`,
  );
  for (const column of [
    "employee_id TEXT",
    "client_id TEXT",
    "disabled BOOLEAN NOT NULL DEFAULT false",
    "session_version INTEGER NOT NULL DEFAULT 0",
  ])
    await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS " + column);
  await db.query(
    `CREATE TABLE IF NOT EXISTS app_state(id INTEGER PRIMARY KEY DEFAULT 1,data JSONB NOT NULL,updated_at TIMESTAMPTZ DEFAULT NOW(),updated_by VARCHAR(255))`,
  );
  await db.query(
    "ALTER TABLE app_state ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0",
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS audit_logs(id SERIAL PRIMARY KEY,user_email VARCHAR(255),action VARCHAR(100),metadata JSONB,created_at TIMESTAMPTZ DEFAULT NOW())`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS command_receipts(user_id INTEGER NOT NULL,request_id TEXT NOT NULL,result JSONB NOT NULL,PRIMARY KEY(user_id,request_id))`,
  );
  await db.query(
    "ALTER TABLE command_receipts ADD COLUMN IF NOT EXISTS request_hash TEXT",
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS file_contents(id TEXT PRIMARY KEY,content BYTEA NOT NULL)`,
  );
  await db.query(
    "INSERT INTO app_state(id,data) VALUES(1,$1) ON CONFLICT(id) DO NOTHING",
    [JSON.stringify(emptyState())],
  );
  // Disable the previously published demo credentials, even on an existing installation.
  const users = await db.query(
    "SELECT id,password_hash FROM users WHERE disabled=false",
  );
  for (const u of users.rows)
    if (await bcrypt.compare("demo1234", u.password_hash))
      await db.query(
        "UPDATE users SET disabled=true,session_version=session_version+1 WHERE id=$1",
        [u.id],
      );
  if (
    process.env.BOOTSTRAP_ADMIN_EMAIL &&
    process.env.BOOTSTRAP_ADMIN_PASSWORD
  ) {
    if (process.env.BOOTSTRAP_ADMIN_PASSWORD.length < 12)
      throw new Error(
        "BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters",
      );
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase(),
      hash = await bcrypt.hash(process.env.BOOTSTRAP_ADMIN_PASSWORD, 12);
    const existing = await db.query(
      "SELECT id,password_hash FROM users WHERE email=$1",
      [email],
    );
    if (!existing.rows.length)
      await db.query(
        "INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES($1,$2,'admin','Administration','AD','group')",
        [email, hash],
      );
    else if (await bcrypt.compare("demo1234", existing.rows[0].password_hash))
      await db.query(
        "UPDATE users SET password_hash=$1,role='admin',company='group',disabled=false,session_version=session_version+1 WHERE id=$2",
        [hash, existing.rows[0].id],
      );
  }
}
async function transaction(db, fn) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
// Serialize edits and reject stale views; retries after a lost response are idempotent.
async function mutate(db, user, body, fn) {
  if (
    typeof body.requestId !== "string" ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)
  )
    throw new AppError("Identifiant de requête invalide.");
  if (!Number.isSafeInteger(body.revision) || body.revision < 0)
    throw new AppError("Version de données requise.");
  return transaction(db, async (c) => {
    const row = (
      await c.query("SELECT data,revision FROM app_state WHERE id=1 FOR UPDATE")
    ).rows[0];
    const previous = (
      await c.query(
        "SELECT result,request_hash FROM command_receipts WHERE user_id=$1 AND request_id=$2",
        [user.id, body.requestId],
      )
    ).rows[0];
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          action: body.action,
          collection: body.collection,
          payload: body.payload,
        }),
      )
      .digest("hex");
    if (previous) {
      if (previous.request_hash !== hash)
        throw new AppError(
          "Cette requête a déjà été enregistrée avec une autre saisie. Actualisez et vérifiez les données.",
          409,
        );
      return previous.result;
    }
    if (row.revision !== body.revision)
      throw new AppError(
        "Les données ont changé. Actualisez puis vérifiez votre saisie avant de réessayer.",
        409,
      );
    const data = normalize(row.data),
      result = await fn(c, data);
    await c.query(
      "UPDATE app_state SET data=$1,revision=revision+1,updated_at=NOW(),updated_by=$2 WHERE id=1",
      [JSON.stringify(data), user.email],
    );
    await c.query(
      "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
      [
        user.email,
        String(body.action || "Modification").slice(0, 100),
        JSON.stringify({
          id: result?.id,
          collection: body.collection || null,
          company: user.company,
        }),
      ],
    );
    const receipt = { ok: true, revision: row.revision + 1, result };
    await c.query(
      "INSERT INTO command_receipts(user_id,request_id,result,request_hash) VALUES($1,$2,$3,$4)",
      [user.id, body.requestId, JSON.stringify(receipt), hash],
    );
    return receipt;
  });
}
module.exports = { pool, migrate, transaction, mutate };
