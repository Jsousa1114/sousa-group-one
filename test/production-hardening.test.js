"use strict";
process.env.JWT_SECRET = "production-hardening-test-secret-long-enough";
const test = require("node:test");
const assert = require("node:assert/strict");
const { database } = require("./database");
const { migrate } = require("../db");
const storage = require("../storage");
const { readiness } = require("../production-readiness");
const { createApp } = require("../server");

test("PostgreSQL fallback storage saves, loads and removes files", async () => {
  const db = await database();
  try {
    await migrate(db);
    delete process.env.OBJECT_STORAGE_ENDPOINT;
    delete process.env.OBJECT_STORAGE_BUCKET;
    delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
    delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
    await storage.saveFile(db, "hardening-file", Buffer.from("bonjour"), "text/plain");
    const loaded = await storage.loadFile(db, "hardening-file");
    assert.equal(loaded.content.toString(), "bonjour");
    assert.equal(loaded.provider, "postgres");
    await storage.removeFile(db, "hardening-file");
    assert.equal(await storage.loadFile(db, "hardening-file"), null);
  } finally {
    await db.end();
  }
});

test("readiness exposes production configuration without secrets", async () => {
  const db = await database();
  const before = {
    COOKIE_SECURE: process.env.COOKIE_SECURE,
    WEBAUTHN_RP_ID: process.env.WEBAUTHN_RP_ID,
    WEBAUTHN_ORIGIN: process.env.WEBAUTHN_ORIGIN,
  };
  try {
    await migrate(db);
    process.env.COOKIE_SECURE = "true";
    process.env.WEBAUTHN_RP_ID = "example.test";
    process.env.WEBAUTHN_ORIGIN = "https://example.test";
    const report = await readiness(db);
    assert.equal(report.ok, true);
    assert.equal(report.checks.database, true);
    assert.equal(report.checks.secureCookies, true);
    assert.equal(report.checks.webauthn, true);
    assert.equal("secret" in report, false);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await db.end();
  }
});

test("/readyz returns a safe readiness report", async () => {
  const db = await database();
  let server;
  const before = {
    COOKIE_SECURE: process.env.COOKIE_SECURE,
    WEBAUTHN_RP_ID: process.env.WEBAUTHN_RP_ID,
    WEBAUTHN_ORIGIN: process.env.WEBAUTHN_ORIGIN,
  };
  try {
    await migrate(db);
    process.env.COOKIE_SECURE = "true";
    process.env.WEBAUTHN_RP_ID = "127.0.0.1";
    process.env.WEBAUTHN_ORIGIN = "http://127.0.0.1";
    server = createApp(db).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = "http://127.0.0.1:" + server.address().port + "/readyz";
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.checks.turn, "boolean");
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.end();
  }
});


test("canonical entity mode compacts app_state and remains readable after rollback", async () => {
  const db = await database();
  const before = process.env.STATE_ENTITY_CANONICAL;
  try {
    delete process.env.STATE_ENTITY_CANONICAL;
    await migrate(db);
    const legacy = require("../domain").emptyState();
    legacy.clients = [
      { id: "c-canonical", name: "Canonical Client", company: "home" },
    ];
    legacy.projects = [
      {
        id: "p-canonical",
        title: "Canonical Project",
        clientId: "c-canonical",
        company: "home",
        team: [],
        status: "Nouveau",
      },
    ];
    await db.query("UPDATE app_state SET data=$1,revision=7 WHERE id=1", [
      JSON.stringify(legacy),
    ]);
    await require("../db").syncEntityMirror(db, legacy);

    process.env.STATE_ENTITY_CANONICAL = "true";
    await migrate(db);
    const compact = (await db.query("SELECT data FROM app_state WHERE id=1")).rows[0].data;
    assert.deepEqual(compact.clients, []);
    assert.deepEqual(compact.projects, []);
    const canonical = await require("../db").loadState(db);
    assert.equal(canonical.data.clients[0].name, "Canonical Client");
    assert.equal(canonical.data.projects[0].title, "Canonical Project");

    delete process.env.STATE_ENTITY_CANONICAL;
    await migrate(db);
    const rolledBack = await require("../db").loadState(db);
    assert.equal(rolledBack.data.clients[0].name, "Canonical Client");
    assert.equal(rolledBack.data.projects[0].title, "Canonical Project");
  } finally {
    if (before == null) delete process.env.STATE_ENTITY_CANONICAL;
    else process.env.STATE_ENTITY_CANONICAL = before;
    await db.end();
  }
});
