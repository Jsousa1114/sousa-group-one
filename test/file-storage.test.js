"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { database } = require("./database");
const { migrate } = require("../db");
const {
  putFile,
  getFile,
  deleteFile,
  cleanupObjectDeletions,
  migrateDatabaseFilesToObjectStorage,
} = require("../file-storage");

const ENV_KEYS = [
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_PREFIX",
];

test("file storage falls back to PostgreSQL and migrates legacy bytes to S3-compatible storage", async () => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;
  const db = await database();
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    await migrate(db);

    const localBytes = Buffer.from("postgres-fallback");
    await putFile(db, "db-only", localBytes);
    assert.deepEqual(await getFile(db, "db-only"), localBytes);
    assert.equal(
      (await db.query("SELECT storage_backend FROM file_contents WHERE id='db-only'")).rows[0]
        .storage_backend,
      "database",
    );
    await deleteFile(db, "db-only");
    assert.equal(
      Number((await db.query("SELECT COUNT(*)::int AS count FROM object_deletion_queue")).rows[0].count),
      0,
    );

    const legacyBytes = Buffer.from("legacy-file-to-object-storage");
    await db.query(
      "INSERT INTO file_contents(id,content,storage_backend,size) VALUES($1,$2,'database',$3)",
      ["legacy", legacyBytes, legacyBytes.length],
    );

    process.env.OBJECT_STORAGE_ENDPOINT = "https://storage.example.test";
    process.env.OBJECT_STORAGE_BUCKET = "sousa-test";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "test-access";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "test-secret";
    process.env.OBJECT_STORAGE_REGION = "auto";
    process.env.OBJECT_STORAGE_PREFIX = "p0";

    const remote = new Map();
    global.fetch = async (input, options = {}) => {
      const url = String(input);
      const method = String(options.method || "GET").toUpperCase();
      if (method === "PUT") {
        remote.set(url, Buffer.from(options.body || ""));
        return new Response("", { status: 200 });
      }
      if (method === "GET") {
        if (!remote.has(url)) return new Response("missing", { status: 404 });
        return new Response(remote.get(url), { status: 200 });
      }
      if (method === "DELETE") {
        remote.delete(url);
        return new Response("", { status: 204 });
      }
      return new Response("unsupported", { status: 405 });
    };

    const migrated = await migrateDatabaseFilesToObjectStorage(db, 10);
    assert.deepEqual(
      { migrated: migrated.migrated, pending: migrated.pending, configured: migrated.configured },
      { migrated: 1, pending: 0, configured: true },
    );
    const metadata = (
      await db.query(
        "SELECT content,storage_backend,storage_key,size FROM file_contents WHERE id='legacy'",
      )
    ).rows[0];
    assert.equal(metadata.content, null);
    assert.equal(metadata.storage_backend, "object");
    assert.match(metadata.storage_key, /^p0\/legacy$/);
    assert.equal(Number(metadata.size), legacyBytes.length);
    assert.deepEqual(await getFile(db, "legacy"), legacyBytes);

    await deleteFile(db, "legacy");
    assert.equal(
      Number((await db.query("SELECT COUNT(*)::int AS count FROM object_deletion_queue")).rows[0].count),
      1,
    );
    const cleaned = await cleanupObjectDeletions(db);
    assert.equal(cleaned.deleted, 1);
    assert.equal(
      Number((await db.query("SELECT COUNT(*)::int AS count FROM object_deletion_queue")).rows[0].count),
      0,
    );
    assert.equal(remote.size, 0);
  } finally {
    global.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await db.end();
  }
});
