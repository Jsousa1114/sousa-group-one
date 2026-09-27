"use strict";

function configured(name) {
  return !!String(process.env[name] || "").trim();
}
function objectStorageConfigured() {
  return [
    "OBJECT_STORAGE_ENDPOINT",
    "OBJECT_STORAGE_BUCKET",
    "OBJECT_STORAGE_ACCESS_KEY_ID",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  ].every(configured);
}
function turnConfigured() {
  return configured("RTC_TURN_URLS") &&
    configured("RTC_TURN_USERNAME") &&
    configured("RTC_TURN_CREDENTIAL");
}
async function readiness(db) {
  let database = false;
  let schema = false;
  try {
    await db.query("SELECT 1");
    database = true;
    const row = await db.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations' LIMIT 1"
    );
    schema = !!row.rows.length;
  } catch {
    database = false;
  }
  const checks = {
    database,
    schema,
    secureCookies:
      process.env.COOKIE_SECURE === "true" || !!process.env.RENDER,
    webauthn:
      configured("WEBAUTHN_RP_ID") && configured("WEBAUTHN_ORIGIN"),
    totpEncryption: configured("TOTP_ENCRYPTION_KEY"),
    turn: turnConfigured(),
    objectStorage: objectStorageConfigured(),
    persistentDatabaseConfirmed:
      process.env.DB_PERSISTENCE_CONFIRMED === "true",
    backupConfigured:
      objectStorageConfigured() &&
      String(process.env.BACKUP_OBJECT_PREFIX || "backups").trim().length > 0,
  };
  const critical = ["database", "schema", "secureCookies", "webauthn"];
  const recommended = [
    "totpEncryption",
    "turn",
    "objectStorage",
    "persistentDatabaseConfirmed",
    "backupConfigured",
  ];
  return {
    ok: critical.every((key) => checks[key]),
    productionReady:
      critical.concat(recommended).every((key) => checks[key]),
    checks,
    missingCritical: critical.filter((key) => !checks[key]),
    missingRecommended: recommended.filter((key) => !checks[key]),
  };
}
module.exports = { readiness, objectStorageConfigured, turnConfigured };
