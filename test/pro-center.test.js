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
      "pro_role_templates",
      "pro_workspace_settings",
      "pro_notification_preferences",
      "pro_project_acceptance",
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
    "/notification-preferences",
    "/project/:id/acceptance",
    "/project/:id/acceptance.pdf",
    "/trash",
    "/trash/:id/restore",
    "/permissions",
    "/roles",
    "/roles/:id/apply/:userId",
    "/settings",
    "/planning/:id/move",
    "/planning/bulk",
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
    "Réception du chantier",
    "Préférences de notifications",
    "Rentabilité par entreprise",
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
  assert.match(suite, /optimizeVideoAttachment/);
  assert.match(app, /kind: file\.type\.startsWith\("image\/"\)/);
  assert.match(app, /file\.type\.startsWith\("video\/"\)/);
  assert.match(suite, /chat-video-wrap/);
  assert.match(suite, /downloadConversationFiles/);
  assert.match(suite, /application\/zip/);
  assert.match(suite, /download-files/);
});


test("granular permissions protect legacy sensitive commands", () => {
  const stateRoutes = fs.readFileSync("state-routes.js", "utf8");
  assert.match(stateRoutes, /enforceCommandPermission/);
  assert.match(stateRoutes, /client\.delete/);
  assert.match(stateRoutes, /project\.close/);
  assert.match(stateRoutes, /invoice\.edit/);
  assert.match(stateRoutes, /hr\.access/);
  assert.match(stateRoutes, /time\.edit/);
});

test("targeted notifications are enforced by the push engine", () => {
  const messaging = fs.readFileSync("messaging-routes.js", "utf8");
  const p1 = fs.readFileSync("p1-routes.js", "utf8");
  assert.match(messaging, /pro_notification_preferences/);
  assert.match(messaging, /quiet_hours/);
  assert.match(messaging, /Europe\/Zurich/);
  assert.match(p1, /notifyUsers/);
});

test("vehicle tracking covers fuel EV inventory and deadlines", () => {
  const api = fs.readFileSync("p1-routes.js", "utf8");
  const ui = fs.readFileSync("p1-suite.js", "utf8");
  assert.match(api, /"charge"/);
  assert.match(api, /"inventory"/);
  assert.match(ui, /Recharge électrique/);
  assert.match(ui, /Matériel embarqué/);
  assert.match(ui, /Échéances véhicules · 60 jours/);
});


test("field time clock supports atomic project switching and guided closeout", () => {
  const domain = fs.readFileSync("domain.js", "utf8");
  const ui = fs.readFileSync("p1-suite.js", "utf8");
  const runtime = fs.readFileSync("p2-runtime.js", "utf8");
  assert.match(domain, /clock\.switch/);
  assert.match(ui, /Pointage terrain/);
  assert.match(ui, /field-end-day/);
  assert.match(ui, /Photo de fin/);
  assert.match(runtime, /clock\.switch/);
});

test("long conversations use bounded state windows and cursor history", () => {
  const stateRoutes = fs.readFileSync("state-routes.js", "utf8");
  const messaging = fs.readFileSync("messaging-routes.js", "utf8");
  const app = fs.readFileSync("app.js", "utf8");
  assert.match(stateRoutes, /messageStats/);
  assert.match(stateRoutes, /slice\(-120\)/);
  assert.match(messaging, /"\/history"/);
  assert.match(app, /messaging\/history\?key=/);
  assert.match(app, /chatHistoryCache/);
});

test("sellable workspace supports reusable custom roles", () => {
  const routes = fs.readFileSync("pro-routes.js", "utf8");
  const suite = fs.readFileSync("pro-suite.js", "utf8");
  assert.match(routes, /pro_role_templates/);
  assert.match(routes, /role_template_id/);
  assert.match(routes, /roles\/:id\/apply\/:userId/);
  assert.match(suite, /Rôles personnalisés/);
  assert.match(suite, /role-template/);
});


test("workspace redesign keeps professional center navigation and assets", () => {
  const app = fs.readFileSync("app.js", "utf8");
  const index = fs.readFileSync("index.html", "utf8");
  assert.match(app, /navigationGroups/);
  assert.match(app, /"pro"/);
  assert.match(app, /data-shortcut/);
  assert.match(app, /workspace-welcome/);
  assert.match(index, /visual-refresh\.css\?v=20261004-suppliers/);
  assert.match(index, /app\.js\?v=20261004-suppliers/);
  assert.match(index, /pro-suite\.js/);
  assert.match(index, /pro\.css/);
  assert.match(index, /sectionLabel/);
});

test("client change orders require and expose electronic signatures", () => {
  const db = fs.readFileSync("db.js", "utf8");
  const operations = fs.readFileSync("operations-routes.js", "utf8");
  const p1 = fs.readFileSync("p1-suite.js", "utf8");
  const pro = fs.readFileSync("pro-suite.js", "utf8");
  assert.match(db, /client_signature TEXT/);
  assert.match(db, /signed_at TIMESTAMPTZ/);
  assert.match(operations, /approvalSignature/);
  assert.match(operations, /signature du client est requise/);
  assert.match(p1, /Signer et approuver/);
  assert.match(pro, /client_signature/);
});
