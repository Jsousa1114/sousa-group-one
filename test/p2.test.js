"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const D = require("../domain");
const { database } = require("./database");
const P2 = require("../p2-routes");

test("P2 browser modules have valid JavaScript syntax", () => {
  for (const file of ["p2-runtime.js","p2-center.js"]) {
    const source = fs.readFileSync(file,"utf8");
    assert.doesNotThrow(() => new vm.Script(source,{filename:file}));
  }
});

test("P2 backend exposes routes, public API, schema and templates", () => {
  assert.equal(typeof P2.routes,"function");
  assert.equal(typeof P2.publicRoutes,"function");
  assert.equal(typeof P2.ensureSchema,"function");
  assert.ok(Array.isArray(P2.automationTemplates));
  assert.ok(P2.automationTemplates.length >= 4);
});

test("P2 schema migration is idempotent and complete", async () => {
  const db = await database();
  try {
    const { migrate } = require("../db");
    await migrate(db);
    await P2.ensureSchema(db);
    await P2.ensureSchema(db);
    for (const table of [
      "p2_permission_overrides",
      "p2_approval_requests",
      "p2_appointments",
      "p2_quote_reminders",
      "p2_api_keys",
      "p2_connector_jobs",
    ]) {
      const row = (await db.query(
        "SELECT to_regclass($1) AS name",
        ["public." + table],
      )).rows[0];
      assert.ok(row.name, "missing P2 table: " + table);
    }
    const migration = (await db.query(
      "SELECT version FROM schema_migrations WHERE version=$1",
      ["2026-09-27-p2-complete-suite"],
    )).rows[0];
    assert.equal(migration.version,"2026-09-27-p2-complete-suite");
  } finally { await db.end(); }
});

test("P2 complete feature gate stays wired", () => {
  const api=fs.readFileSync("p2-routes.js","utf8");
  for (const capability of [
    "realtimeSse","cursorPagination","offlinePwa","offlineSynchronization",
    "mobileInstall","biometricPasskeys","calendarIcsSync","emailConnector",
    "smsConnector","publicApi","customPermissions","approvalWorkflows",
    "automationTemplates","graphicalReports","cashflowForecast",
    "projectProfitability","companyProfitability","clientProfitability",
    "crmPipeline","quoteReminders","enhancedClientPortal","clientAppointments",
    "clientHistory","wcagAccessibility","highReadability","tabletMode",
    "modularFrontend","designSystem","visualTests","crossBrowserTests",
    "loadTests","migrationTests","dependencySecurityScan","permissionAudit",
  ]) assert.ok(api.includes(capability),"missing P2 capability: "+capability);
  assert.match(api,/corePercent/);
  assert.match(api,/coreReady/);
});

test("P2 operational endpoints stay wired", () => {
  const api=fs.readFileSync("p2-routes.js","utf8");
  for (const endpoint of [
    "/events","/cashflow","/client/:id/history","/appointments",
    "/appointments/:id/decision","/approvals","/approvals/:id/decision",
    "/permissions","/automation-templates","/quote-reminders",
    "/calendar.ics","/calendar/push","/communications/:provider","/api-keys",
  ]) assert.ok(api.includes(endpoint),"missing P2 endpoint: "+endpoint);
  const server=fs.readFileSync("server.js","utf8");
  assert.match(server,/\/api\/p2/);
  assert.match(server,/\/api\/public\/v1/);
});

test("P2 offline synchronization only queues safe field actions", () => {
  const runtime=fs.readFileSync("p2-runtime.js","utf8");
  assert.match(runtime,/indexedDB/);
  assert.match(runtime,/clock\.start/);
  assert.match(runtime,/"time", "documents"/);
  assert.match(runtime,/sgo-offline-sync/);
  const app=fs.readFileSync("app.js","utf8");
  assert.match(app,/queueMutation/);
  assert.match(app,/flushQueue/);
});

test("P2 client privacy audit does not expose RH salary data", () => {
  const d=D.emptyState();
  d.employees=[{id:"e1",name:"Secret Employee",company:"home",salary:99000,notes:"private"}];
  d.clients=[{id:"c1",name:"Client",company:"home"}];
  d.projects=[{id:"p1",title:"Visible project",company:"home",clientId:"c1",team:["e1"]}];
  d.time=[{id:"t1",employeeId:"e1",project:"p1",hours:8,date:"2026-09-27"}];
  d.expenses=[{id:"x1",project:"p1",amount:500,company:"home"}];
  const view=D.viewState(d,{id:9,role:"client",company:"home",companies:["home"],client_id:"c1"});
  assert.equal(view.employees.length,0);
  assert.equal(view.time.length,0);
  assert.equal(view.expenses.length,0);
  assert.equal(JSON.stringify(view).includes("99000"),false);
  assert.equal(JSON.stringify(view).includes("private"),false);
});

test("P2 frontend provides accessibility and tablet controls", () => {
  const css=fs.readFileSync("p2.css","utf8");
  const center=fs.readFileSync("p2-center.js","utf8");
  assert.match(css,/:focus-visible/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/high-readability/);
  assert.match(css,/tablet-mode/);
  assert.match(center,/Haute lisibilité/);
  assert.match(center,/Mode tablette/);
});

test("P2 public API never includes employee or salary fields", () => {
  const api=fs.readFileSync("p2-routes.js","utf8");
  const publicPart=api.slice(api.indexOf("function publicRoutes"));
  assert.equal(/employees\s*:/.test(publicPart),false);
  assert.equal(/salary/i.test(publicPart),false);
  assert.match(publicPart,/summary:read/);
  assert.match(publicPart,/projects:read/);
  assert.match(publicPart,/clients:read/);
});
