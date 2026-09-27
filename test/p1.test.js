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

test("P1 keeps the critical operational capabilities wired", () => {
  const api = fs.readFileSync("p1-routes.js", "utf8");
  for (const required of [
    "p1_project_milestones",
    "p1_recurring_invoices",
    "p1_credit_notes",
    "p1_invoice_reminders",
    "p1_purchase_orders",
    "p1_inventory_location_stock",
    "p1_tool_events",
    "p1_vehicle_events",
    "p1_maintenance_plans",
    "/client/work-order/:id/sign",
    "/time/auto-break",
    "/procurement/stock-move",
  ]) assert.ok(api.includes(required), "missing P1 capability: " + required);
});