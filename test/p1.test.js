"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("P1 browser modules have valid JavaScript syntax", () => {
  for (const file of ["p1-suite.js", "pay.js"]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }));
  }
});

test("P1 backend module loads and exposes schema/jobs/routes", () => {
  const p1 = require("../p1-routes");
  assert.equal(typeof p1.routes, "function");
  assert.equal(typeof p1.ensureSchema, "function");
  assert.equal(typeof p1.runDueJobs, "function");
  assert.equal(typeof p1.processInvoiceReminders, "function");
});

test("P1 is mounted and loaded by the application shell", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const index = fs.readFileSync("index.html", "utf8");
  const operations = fs.readFileSync("operations-center.js", "utf8");
  assert.match(server, /\/api\/p1/);
  assert.match(index, /p1-suite\.js/);
  assert.match(index, /p1\.css/);
  assert.match(operations, /P1 complet/);
});

test("P1 complete schema stays wired", () => {
  const api = fs.readFileSync("p1-routes.js", "utf8");
  for (const required of [
    "p1_dashboard_preferences",
    "p1_project_milestones",
    "p1_project_photo_meta",
    "p1_time_policies",
    "p1_time_geolocation",
    "p1_finance_templates",
    "p1_price_catalog",
    "p1_client_pricing",
    "p1_recurring_invoices",
    "p1_credit_notes",
    "p1_invoice_reminders",
    "p1_payment_links",
    "p1_purchase_orders",
    "p1_inventory_barcodes",
    "p1_inventory_location_stock",
    "p1_tool_events",
    "p1_vehicle_events",
    "p1_maintenance_plans",
    "p1_integration_profiles",
  ]) assert.ok(api.includes(required), "missing P1 schema: " + required);
});

test("P1 complete feature checklist stays wired", () => {
  const p1 = fs.readFileSync("p1-routes.js", "utf8");
  const ops = fs.readFileSync("operations-routes.js", "utf8");
  const ui = fs.readFileSync("p1-suite.js", "utf8");

  for (const endpoint of [
    "/dashboard",
    "/client/work-order/:id/sign",
    "/project/:id/full",
    "/project/:id/milestone",
    "/project/:id/subtask",
    "/project/:id/photo-meta",
    "/project/:id/history",
    "/time/policy",
    "/time/geolocation",
    "/time/auto-break",
    "/time/summary",
    "/finance/template",
    "/finance/catalog",
    "/finance/client-pricing",
    "/finance/recurring",
    "/finance/credit-note",
    "/finance/payment-link",
    "/finance/run-reminders",
    "/procurement/location",
    "/procurement/order",
    "/procurement/stock-move",
    "/procurement/barcode",
    "/procurement/lookup/:code",
    "/assets/tool-event",
    "/assets/vehicle-event",
    "/maintenance/plan",
    "/employee/:id/history",
    "/integrations",
    "/run-jobs",
  ]) assert.ok(p1.includes(endpoint), "missing P1 endpoint: " + endpoint);

  for (const endpoint of [
    "/search",
    "/notifications",
    "/notifications/read",
    "/tasks",
    "/project/:id/checklist",
    "/project/:id/report",
    "/project/:id/punch",
    "/project/:id/change-order",
    "/inventory/movements",
    "/inventory/movement",
    "/work-orders",
    "/hr/lifecycle",
    "/payroll-export",
  ]) assert.ok(ops.includes(endpoint), "missing operational P1 endpoint: " + endpoint);

  for (const label of [
    "Jalons",
    "Tâches & sous-tâches",
    "Checklist",
    "Rapports journaliers",
    "Réserves",
    "Plus-values",
    "Albums & annotations photo",
    "QR chantier",
    "Stock minimum",
    "Commandes fournisseurs",
    "Historique outillage",
    "Historique véhicules",
    "Contrats & interventions automatiques",
  ]) assert.ok(ui.includes(label), "missing P1 UI: " + label);
});

test("P1 status exposes a 100 percent internal completion gate", () => {
  const api = fs.readFileSync("p1-routes.js", "utf8");
  const ui = fs.readFileSync("p1-suite.js", "utf8");
  for (const capability of [
    "globalSearch",
    "notifications",
    "projectTasks",
    "photoAlbumsAnnotations",
    "optionalGeolocation",
    "overtimeNightSunday",
    "payrollExport",
    "onboardingOffboarding",
    "recurringInvoices",
    "stockMovements",
    "minimumStockAlerts",
    "recurringMaintenance",
    "automaticMaintenanceBilling",
    "p1Translations",
  ]) assert.ok(api.includes(capability), "missing P1 readiness flag: " + capability);
  assert.match(api, /corePercent/);
  assert.match(api, /coreReady/);
  assert.match(ui, /Socle P1 interne terminé/);
  assert.match(ui, /P1 terminé/);
});

test("P1 keeps all requested interface languages", () => {
  const ui = fs.readFileSync("p1-suite.js", "utf8");
  for (const lang of ["en", "de", "it", "pt", "es", "sq"]) {
    assert.match(ui, new RegExp("\\b" + lang + "\\s*:"), "missing P1 language: " + lang);
  }
  for (const key of [
    "P1 complet",
    "Chantier+",
    "Pointage+",
    "Finance+",
    "Achats & stock",
    "Parc & outillage",
    "Maintenance+",
    "Connecteurs",
  ]) assert.ok(ui.includes(key), "missing translated P1 key: " + key);
});

test("External accounting connectors are optional and do not fake P1 completion", () => {
  const api = fs.readFileSync("p1-routes.js", "utf8");
  const ui = fs.readFileSync("p1-suite.js", "utf8");
  for (const env of [
    "EBILL_API_KEY",
    "BANKING_API_KEY",
    "BEXIO_API_TOKEN",
    "ABACUS_API_TOKEN",
    "WINBIZ_API_TOKEN",
  ]) assert.ok(api.includes(env), "missing external connector flag: " + env);
  assert.match(ui, /Configuration externe optionnelle/);
});
