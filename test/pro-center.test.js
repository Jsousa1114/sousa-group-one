"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { database } = require("./database");
const Pro = require("../pro-routes");

test("professional center browser module has valid JavaScript syntax", () => {
  const source = fs.readFileSync("pro-suite.js", "utf8");
  assert.doesNotThrow(() => new vm.Script(source, { filename: "pro-suite.js" }));
});

test("professional center backend loads and exposes schema/routes", () => {
  assert.equal(typeof Pro.routes, "function");
  assert.equal(typeof Pro.ensureSchema, "function");
  assert.ok(Array.isArray(Pro.PERMISSIONS));
  assert.ok(Pro.PERMISSIONS.length >= 10);
});

test("professional center schema is idempotent and complete", async () => {
  const db = await database();
  try {
    const { migrate } = require("../db");
    await migrate(db);
    await Pro.ensureSchema(db);
    await Pro.ensureSchema(db);
    for (const table of [
      "pro_trash",
      "pro_user_permissions",
      "pro_workspace_settings",
      "p1_project_milestones",
      "p1_project_photo_meta",
      "p2_appointments",
    ]) {
      const row = (await db.query("SELECT to_regclass($1) AS name", ["public." + table])).rows[0];
      assert.ok(row.name, "missing professional-center table: " + table);
    }
    const migration = (await db.query(
      "SELECT version FROM schema_migrations WHERE version=$1",
      ["2026-09-27-pro-centre"],
    )).rows[0];
    assert.equal(migration.version, "2026-09-27-pro-centre");
  } finally {
    await db.end();
  }
});

test("professional center stays mounted in server and application shell", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const index = fs.readFileSync("index.html", "utf8");
  const app = fs.readFileSync("app.js", "utf8");
  assert.match(server, /\/api\/pro/);
  assert.match(server, /pro-suite\.js/);
  assert.match(server, /pro\.css/);
  assert.match(index, /pro-suite\.js/);
  assert.match(index, /pro\.css/);
  assert.match(app, /Centre de gestion/);
  assert.match(app, /proStandalone/);
});

test("requested professional capabilities are wired", () => {
  const api = fs.readFileSync("pro-routes.js", "utf8");
  const ui = fs.readFileSync("pro-suite.js", "utf8");
  for (const endpoint of [
    "/config",
    "/dashboard",
    "/project/:id",
    "/search",
    "/activity",
    "/notifications/read",
    "/trash",
    "/trash/:id/restore",
    "/permissions",
    "/settings",
    "/planning/:id/move",
    "/intervention/:id.pdf",
  ]) assert.ok(api.includes(endpoint), "missing pro endpoint: " + endpoint);
  for (const label of [
    "Fiche chantier centrale",
    "Planning visuel",
    "Corbeille 30 jours",
    "Permissions fines",
    "Préparation à la vente",
    "Recherche globale",
    "Centre de notifications & activités",
  ]) assert.ok(ui.includes(label), "missing pro UI: " + label);
});

test("trash and sellable workspace keep safety semantics", () => {
  const api = fs.readFileSync("pro-routes.js", "utf8");
  assert.match(api, /INTERVAL '30 days'/);
  assert.match(api, /snapshot JSONB NOT NULL/);
  assert.match(api, /restored_at/);
  assert.match(api, /purged_at/);
  assert.match(api, /database-per-customer/);
  assert.match(api, /settings\.branding/);
  assert.match(api, /margin\.view/);
});

test("messaging professional upgrades stay wired", () => {
  const app = fs.readFileSync("app.js", "utf8");
  const suite = fs.readFileSync("messaging-suite.js", "utf8");
  assert.match(app, /chatMessageLimits/);
  assert.match(app, /chat-load-older/);
  assert.match(suite, /optimizeImageAttachment/);
  assert.match(suite, /downloadConversationFiles/);
  assert.match(suite, /application\/zip/);
  assert.match(suite, /download-files/);
});
