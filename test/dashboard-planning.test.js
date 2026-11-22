"use strict";
process.env.JWT_SECRET = "dashboard-planning-test-secret-long-enough";
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const { emptyState } = require("../domain");

const PASSWORD = "Dashboard-Planning-2026";
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function session(base, email) {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, "login " + email);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return async (path) => {
    const r = await fetch(base + path, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200, path);
    return r.json();
  };
}

test("dashboard upcoming work is shown to managers, employees and clients", async () => {
  const db = await database();
  let server;
  try {
    await migrate(db);
    const hash = await bcrypt.hash(PASSWORD, 4);
    for (const [email, role, company, employeeId, clientId] of [
      ["admin@test.invalid", "admin", "group", null, null],
      ["employee@test.invalid", "employee", "home", "e1", null],
      ["client@test.invalid", "client", "home", null, "c1"],
    ])
      await db.query(
        "INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,'',$5,$6,$7)",
        [email, hash, role, email, company, employeeId, clientId],
      );
    const d = emptyState();
    d.employees = [
      { id: "e1", name: "Lucas Martin", company: "home", companies: ["home"], status: "Actif" },
      { id: "e2", name: "Emma Rochat", company: "home", companies: ["home"], status: "Actif" },
    ];
    d.clients = [
      { id: "c1", name: "Client Un", company: "home" },
      { id: "c2", name: "Client Deux", company: "home" },
    ];
    d.projects = [
      { id: "P1", title: "Chantier client un", clientId: "c1", company: "home", team: ["e1"], status: "En cours" },
      { id: "P2", title: "Chantier client deux", clientId: "c2", company: "home", team: ["e2"], status: "En cours" },
    ];
    d.planning = [
      { id: "past", employeeId: "e1", project: "P1", date: day(-2), start: "08:00", end: "12:00", company: "home" },
      { id: "e2-later", employeeId: "e2", project: "P2", date: day(3), start: "08:00", end: "17:00", company: "home" },
      { id: "e1-soon", employeeId: "e1", project: "P1", date: day(1), start: "07:30", end: "16:00", company: "home" },
    ];
    await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
    server = createApp(db).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = "http://127.0.0.1:" + server.address().port;

    const admin = await (await session(base, "admin@test.invalid"))("/api/p1/dashboard");
    assert.deepEqual(admin.planning.map((x) => x.id), ["e1-soon", "e2-later"]);
    assert.equal(admin.planning[0].employeeName, "Lucas Martin");

    const employee = await (await session(base, "employee@test.invalid"))("/api/p1/dashboard");
    assert.deepEqual(employee.planning.map((x) => x.id), ["e1-soon"]);

    const client = await (await session(base, "client@test.invalid"))("/api/p1/dashboard");
    assert.deepEqual(client.planning.map((x) => x.id), ["e1-soon"]);
    assert.deepEqual(Object.keys(client.planning[0]).sort(), ["date", "end", "id", "project", "start"]);
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
    await db.end();
  }
});
