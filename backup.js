"use strict";
const {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} = require("node:crypto");
const { gzipSync, gunzipSync } = require("node:zlib");

function encryptionKey() {
  const raw = String(process.env.BACKUP_ENCRYPTION_KEY || "").trim();
  if (!raw)
    throw new Error("BACKUP_ENCRYPTION_KEY is required for encrypted backups.");
  let key = null;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, "hex");
  else {
    try {
      key = Buffer.from(raw, "base64");
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== 32)
    throw new Error(
      "BACKUP_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hex key.",
    );
  return key;
}

function jsonReplacer(_key, value) {
  if (Buffer.isBuffer(value))
    return { __sgoType: "buffer", base64: value.toString("base64") };
  if (
    value &&
    value.type === "Buffer" &&
    Array.isArray(value.data)
  )
    return {
      __sgoType: "buffer",
      base64: Buffer.from(value.data).toString("base64"),
    };
  return value;
}

function jsonReviver(_key, value) {
  if (value?.__sgoType === "buffer" && typeof value.base64 === "string")
    return Buffer.from(value.base64, "base64");
  return value;
}

async function collectBackup(db) {
  const tableRows = (
    await db.query(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname='public'
       ORDER BY tablename`,
    )
  ).rows;
  const tables = {};
  for (const { tablename } of tableRows) {
    if (!/^[a-z0-9_]+$/i.test(tablename))
      throw new Error("Unsafe database table name.");
    tables[tablename] = (
      await db.query(`SELECT * FROM "${tablename}"`)
    ).rows;
  }
  return {
    format: "sousa-group-one-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    tables,
  };
}

async function buildEncryptedBackup(db) {
  const backup = await collectBackup(db),
    json = Buffer.from(JSON.stringify(backup, jsonReplacer), "utf8"),
    compressed = gzipSync(json, { level: 9 }),
    sha256 = createHash("sha256").update(compressed).digest("hex"),
    key = encryptionKey(),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv),
    encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]),
    tag = cipher.getAuthTag(),
    envelope = {
      format: "sousa-group-one-encrypted-backup",
      version: 1,
      algorithm: "aes-256-gcm+gzip",
      createdAt: backup.createdAt,
      sha256,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encrypted.toString("base64"),
    };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function decryptBackup(buffer) {
  const envelope = JSON.parse(Buffer.from(buffer).toString("utf8"));
  if (
    envelope?.format !== "sousa-group-one-encrypted-backup" ||
    envelope?.version !== 1
  )
    throw new Error("Unsupported backup format.");
  const key = encryptionKey(),
    decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  if (sha256 !== envelope.sha256)
    throw new Error("Backup integrity verification failed.");
  return JSON.parse(gunzipSync(compressed).toString("utf8"), jsonReviver);
}

module.exports = {
  buildEncryptedBackup,
  decryptBackup,
};
