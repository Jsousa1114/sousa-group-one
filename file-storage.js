"use strict";
const { createHash, createHmac } = require("node:crypto");

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}
function objectConfig() {
  const endpoint = String(process.env.OBJECT_STORAGE_ENDPOINT || "").replace(/\/+$/, "");
  const bucket = String(process.env.OBJECT_STORAGE_BUCKET || "").trim();
  const accessKeyId = String(process.env.OBJECT_STORAGE_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || "");
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: String(process.env.OBJECT_STORAGE_REGION || "auto"),
    prefix: String(process.env.OBJECT_STORAGE_PREFIX || "sousa-group-one").replace(/^\/+|\/+$/g, ""),
  };
}
function storageAvailable() {
  return !!objectConfig();
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}
function objectKey(id, cfg) {
  const safe = String(id || "").replace(/[^A-Za-z0-9._-]/g, "_");
  return [cfg.prefix, safe].filter(Boolean).join("/");
}
function objectUrl(cfg, key) {
  const base = new URL(cfg.endpoint);
  const pathname = [base.pathname.replace(/^\/+|\/+$/g, ""), cfg.bucket, key]
    .filter(Boolean)
    .flatMap((part) => String(part).split("/"))
    .map(rfc3986)
    .join("/");
  base.pathname = "/" + pathname;
  base.search = "";
  base.hash = "";
  return base;
}
async function objectRequest(method, key, body = Buffer.alloc(0)) {
  const cfg = objectConfig();
  if (!cfg) throw new Error("Stockage objet non configuré.");
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  const url = objectUrl(cfg, key);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = amzDate.slice(0, 8);
  const payloadHash = hash(payload);
  const canonicalUri = url.pathname;
  const canonicalHeaders =
    "host:" + url.host + "\n" +
    "x-amz-content-sha256:" + payloadHash + "\n" +
    "x-amz-date:" + amzDate + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = shortDate + "/" + cfg.region + "/s3/aws4_request";
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hash(Buffer.from(canonicalRequest)),
  ].join("\n");
  const kDate = hmac(Buffer.from("AWS4" + cfg.secretAccessKey), shortDate);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign, "hex");
  const authorization =
    "AWS4-HMAC-SHA256 Credential=" +
    cfg.accessKeyId +
    "/" +
    scope +
    ", SignedHeaders=" +
    signedHeaders +
    ", Signature=" +
    signature;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(method === "PUT" ? { "Content-Type": "application/octet-stream" } : {}),
    },
    ...(method === "PUT" ? { body: payload } : {}),
  });
  if (!response.ok)
    throw new Error(
      "Stockage objet: HTTP " + response.status + " lors de " + method + ".",
    );
  return response;
}

async function putFile(db, id, content) {
  const buffer = Buffer.from(content);
  const cfg = objectConfig();
  if (!cfg) {
    await db.query(
      `INSERT INTO file_contents(id,content,storage_backend,storage_key,size)
       VALUES($1,$2,'database',NULL,$3)`,
      [String(id), buffer, buffer.length],
    );
    return { backend: "database", size: buffer.length };
  }
  const key = objectKey(id, cfg);
  await objectRequest("PUT", key, buffer);
  try {
    await db.query(
      `INSERT INTO file_contents(id,content,storage_backend,storage_key,size)
       VALUES($1,NULL,'object',$2,$3)`,
      [String(id), key, buffer.length],
    );
  } catch (error) {
    await objectRequest("DELETE", key).catch(() => {});
    throw error;
  }
  return { backend: "object", size: buffer.length };
}

async function getFile(db, id) {
  const row = (
    await db.query(
      "SELECT content,storage_backend,storage_key FROM file_contents WHERE id=$1",
      [String(id)],
    )
  ).rows[0];
  if (!row) return null;
  if (row.storage_backend === "object" && row.storage_key) {
    const response = await objectRequest("GET", row.storage_key);
    return Buffer.from(await response.arrayBuffer());
  }
  return row.content == null ? null : Buffer.from(row.content);
}

async function deleteFile(db, id) {
  const row = (
    await db.query(
      `DELETE FROM file_contents WHERE id=$1
       RETURNING storage_backend,storage_key`,
      [String(id)],
    )
  ).rows[0];
  if (row?.storage_backend === "object" && row.storage_key)
    await db.query(
      `INSERT INTO object_deletion_queue(storage_key)
       VALUES($1) ON CONFLICT(storage_key) DO NOTHING`,
      [row.storage_key],
    );
  return !!row;
}

async function migrateDatabaseFilesToObjectStorage(db, limit = 50) {
  const cfg = objectConfig();
  if (!cfg) return { migrated: 0, pending: 0, configured: false };
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  const rows = (
    await db.query(
      `SELECT id,content
       FROM file_contents
       WHERE content IS NOT NULL
         AND COALESCE(storage_backend,'database')='database'
       ORDER BY id
       LIMIT $1`,
      [cap],
    )
  ).rows;
  let migrated = 0;
  for (const row of rows) {
    const buffer = Buffer.from(row.content);
    const key = objectKey(row.id, cfg);
    await objectRequest("PUT", key, buffer);
    try {
      const result = await db.query(
        `UPDATE file_contents
         SET content=NULL,
             storage_backend='object',
             storage_key=$2,
             size=COALESCE(size,$3)
         WHERE id=$1 AND content IS NOT NULL
         RETURNING id`,
        [String(row.id), key, buffer.length],
      );
      if (result.rows.length) migrated++;
    } catch (error) {
      await objectRequest("DELETE", key).catch(() => {});
      throw error;
    }
  }
  const pending = Number(
    (
      await db.query(
        `SELECT COUNT(*)::int AS count
         FROM file_contents
         WHERE content IS NOT NULL
           AND COALESCE(storage_backend,'database')='database'`,
      )
    ).rows[0]?.count || 0,
  );
  return { migrated, pending, configured: true };
}

async function cleanupObjectDeletions(db, limit = 50) {
  if (!storageAvailable()) return { deleted: 0, pending: 0 };
  const rows = (
    await db.query(
      "SELECT storage_key FROM object_deletion_queue ORDER BY created_at LIMIT $1",
      [Math.max(1, Math.min(Number(limit) || 50, 200))],
    )
  ).rows;
  let deleted = 0;
  for (const row of rows) {
    try {
      await objectRequest("DELETE", row.storage_key);
      await db.query(
        "DELETE FROM object_deletion_queue WHERE storage_key=$1",
        [row.storage_key],
      );
      deleted++;
    } catch (error) {
      console.error("Object storage cleanup failed:", error.message);
    }
  }
  return { deleted, pending: Math.max(0, rows.length - deleted) };
}

module.exports = {
  storageAvailable,
  putFile,
  getFile,
  deleteFile,
  cleanupObjectDeletions,
  migrateDatabaseFilesToObjectStorage,
};
