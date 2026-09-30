"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { database } = require("./database");
const { migrate } = require("../db");
const { nextOccurrence, swissMorning, runDueRecurringJobs } = require("../recurring");

test("recurrences preserve month-end and Swiss morning across DST", () => {
  assert.equal(nextOccurrence("2026-01-31", "monthly", 31), "2026-02-28");
  assert.equal(nextOccurrence("2026-02-28", "monthly", 31), "2026-03-31");
  assert.equal(nextOccurrence("2024-02-29", "yearly", 29), "2025-02-28");
  assert.equal(nextOccurrence("2026-12-28", "weekly"), "2027-01-04");
  assert.equal(swissMorning("2026-01-10").toISOString(), "2026-01-10T07:00:00.000Z");
  assert.equal(swissMorning("2026-07-10").toISOString(), "2026-07-10T06:00:00.000Z");
});

test("recurrence migration is additive and concurrent workers cannot duplicate an occurrence", async () => {
  const db = await database();
  try {
    await migrate(db);
    await migrate(db);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    await db.query("INSERT INTO recurring_jobs(id,company,title,frequency,next_run,created_by) VALUES('repeat','home','Entretien','monthly',$1,1)", [day]);
    const counts = await Promise.all([runDueRecurringJobs(db), runDueRecurringJobs(db)]);
    assert.equal(counts.reduce((a,b) => a+b, 0), 1);
    const rows = (await db.query("SELECT * FROM work_orders WHERE recurring_job_id='repeat'")).rows;
    assert.equal(rows.length, 1);
    assert.equal(new Date(rows[0].scheduled_at).toISOString(), swissMorning(day).toISOString());
    // Replay an already inserted occurrence after an interrupted administrative retry.
    await db.query("UPDATE recurring_jobs SET next_run=$1 WHERE id='repeat'", [day]);
    assert.equal(await runDueRecurringJobs(db), 0);
    assert.equal((await db.query("SELECT * FROM work_orders WHERE recurring_job_id='repeat'")).rows.length, 1);
  } finally { await db.end(); }
});

test("service worker serves fresh code online, cached code offline, and never caches API data", async () => {
  const handlers = {};
  let online = true;
  let networkRequests = 0;
  const cache = { match: async () => new Response("old"), put: async () => {} };
  vm.runInNewContext(fs.readFileSync("service-worker.js", "utf8"), {
    self: { location: { origin: "https://app.test" }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    caches: { open: async () => cache },
    fetch: async () => { networkRequests++; if (!online) throw new Error("offline"); return new Response("new"); },
    URL, Response,
  });
  async function request(path) {
    let response;
    handlers.fetch({ request: { url: "https://app.test" + path, method: "GET", mode: "cors" }, respondWith: value => { response = value; } });
    return response;
  }
  assert.equal(await (await request("/app.js")).text(), "new");
  online = false;
  assert.equal(await (await request("/app.js")).text(), "old");
  const before = networkRequests;
  assert.equal(await request("/api/state"), undefined);
  assert.equal(networkRequests, before);
  const source = fs.readFileSync("service-worker.js", "utf8");
  assert.match(source, /"\/pro-suite\.js"/);
  assert.match(source, /"\/pro\.css"/);
});
