"use strict";
const {
  createHash,
  createHmac,
} = require("node:crypto");

function cfg() {
  const endpoint = String(process.env.OBJECT_STORAGE_ENDPOINT || "").replace(/\/$/, "");
  return {
    endpoint,
    bucket: String(process.env.OBJECT_STORAGE_BUCKET || "").trim(),
    accessKeyId: String(process.env.OBJECT_STORAGE_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || "").trim(),
    region: String(process.env.OBJECT_STORAGE_REGION || "auto").trim() || "auto",
    prefix: String(process.env.OBJECT_STORAGE_PREFIX || "sgo").replace(/^\/+|\/+$/g, ""),
  };
}
function available() {
  const c = cfg();
  return !!(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}
function amzDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
function encodePath(value) {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
function objectKey(id) {
  const c = cfg();
  return [c.prefix, "files", String(id)].filter(Boolean).join("/");
}
async function signedRequest(method, key, body = null, contentType = "") {
  const c = cfg();
  if (!available()) throw new Error("Object storage is not configured.");
  const now = new Date(), stamp = amzDate(now), short = stamp.slice(0, 8);
  const base = new URL(c.endpoint);
  const cleanBasePath = base.pathname.replace(/\/$/, "");
  const canonicalUri = encodePath(
    [cleanBasePath, c.bucket, key].filter(Boolean).join("/").replace(/\/+/g, "/")
  );
  const url = new URL(base.origin + canonicalUri);
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(body);
  const payloadHash = hash(payload);
  const canonicalHeaders =
    "host:" + url.host + "\n" +
    "x-amz-content-sha256:" + payloadHash + "\n" +
    "x-amz-date:" + stamp + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = [short, c.region, "s3", "aws4_request"].join("/");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    hash(Buffer.from(canonicalRequest)),
  ].join("\n");
  const kDate = hmac(Buffer.from("AWS4" + c.secretAccessKey), short);
  const kRegion = hmac(kDate, c.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign, "hex");
  const headers = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
    authorization:
      "AWS4-HMAC-SHA256 Credential=" + c.accessKeyId + "/" + scope +
      ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
  };
  if (contentType) headers["content-type"] = contentType;
  const response = await fetch(url, {
    method,
    headers,
    body: ["GET", "HEAD"].includes(method) ? undefined : payload,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      "Object storage " + method + " failed (" + response.status + "): " +
      detail.slice(0, 500)
    );
  }
  return response;
}
async function putObject(key, content, contentType = "application/octet-stream") {
  await signedRequest("PUT", key, content, contentType);
  return { key, size: Buffer.byteLength(content) };
}
async function getObject(key) {
  const response = await signedRequest("GET", key);
  return Buffer.from(await response.arrayBuffer());
}
async function deleteObject(key) {
  await signedRequest("DELETE", key);
}
async function saveFile(db, id, content, mime = "application/octet-stream") {
  const buffer = Buffer.from(content);
  if (!available()) {
    await db.query(
      `INSERT INTO file_contents(id,content) VALUES($1,$2)
       ON CONFLICT(id) DO UPDATE SET content=EXCLUDED.content`,
      [String(id), buffer],
    );
    return { provider: "postgres", size: buffer.length };
  }
  const key = objectKey(id);
  await putObject(key, buffer, mime);
  await db.query(
    `INSERT INTO file_objects(id,provider,object_key,mime,size,updated_at)
     VALUES($1,'s3',$2,$3,$4,NOW())
     ON CONFLICT(id) DO UPDATE SET
       provider='s3',object_key=EXCLUDED.object_key,mime=EXCLUDED.mime,
       size=EXCLUDED.size,updated_at=NOW()`,
    [String(id), key, mime, buffer.length],
  );
  return { provider: "s3", size: buffer.length };
}
async function loadFile(db, id) {
  const meta = (
    await db.query(
      "SELECT provider,object_key,mime,size FROM file_objects WHERE id=$1",
      [String(id)],
    )
  ).rows[0];
  if (meta?.provider === "s3" && meta.object_key && available()) {
    try {
      return {
        content: await getObject(meta.object_key),
        mime: meta.mime || "application/octet-stream",
        size: Number(meta.size || 0),
        provider: "s3",
      };
    } catch (error) {
      const fallback = (
        await db.query("SELECT content FROM file_contents WHERE id=$1", [String(id)])
      ).rows[0];
      if (!fallback) throw error;
      return {
        content: Buffer.from(fallback.content),
        mime: meta.mime || "application/octet-stream",
        size: fallback.content.length,
        provider: "postgres-fallback",
      };
    }
  }
  const row = (
    await db.query("SELECT content FROM file_contents WHERE id=$1", [String(id)])
  ).rows[0];
  return row
    ? {
        content: Buffer.from(row.content),
        mime: meta?.mime || "application/octet-stream",
        size: row.content.length,
        provider: "postgres",
      }
    : null;
}
async function removeFile(db, id) {
  const meta = (
    await db.query("SELECT object_key FROM file_objects WHERE id=$1", [String(id)])
  ).rows[0];
  if (meta?.object_key && available())
    await deleteObject(meta.object_key).catch(() => {});
  await db.query("DELETE FROM file_objects WHERE id=$1", [String(id)]);
  await db.query("DELETE FROM file_contents WHERE id=$1", [String(id)]);
}
async function migrateLegacyFiles(db, { deleteDatabaseCopy = false } = {}) {
  if (!available()) throw new Error("Object storage is not configured.");
  const rows = (
    await db.query(
      `SELECT f.id,f.content
       FROM file_contents f
       LEFT JOIN file_objects o ON o.id=f.id
       WHERE o.id IS NULL
       ORDER BY f.id`,
    )
  ).rows;
  let migrated = 0;
  for (const row of rows) {
    await saveFile(db, row.id, row.content);
    if (deleteDatabaseCopy)
      await db.query("DELETE FROM file_contents WHERE id=$1", [String(row.id)]);
    migrated++;
  }
  return { migrated, deleteDatabaseCopy };
}
module.exports = {
  available,
  objectKey,
  putObject,
  getObject,
  deleteObject,
  saveFile,
  loadFile,
  removeFile,
  migrateLegacyFiles,
};
