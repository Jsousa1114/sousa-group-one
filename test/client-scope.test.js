"use strict";
process.env.JWT_SECRET = "client-scope-test-secret-long-enough-2026";
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const { emptyState } = require("../domain");

const PASSWORD = "Client-Scope-Test-2026";

async function session(base, email) {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, "login " + email);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return (path) => fetch(base + path, { headers: { Cookie: cookie } });
}

test("clients never see other clients' work orders, CRM prospects or intervention reports", async () => {
  const db = await database();
  let server;
  try {
    await migrate(db);
    const hash = await bcrypt.hash(PASSWORD, 4);
    for (const [email, role, company, employeeId, clientId] of [
      ["admin@test.invalid", "admin", "group", null, null],
      ["employee@test.invalid", "employee", "home", "e1", null],
      ["client1@test.invalid", "client", "home", null, "c1"],
    ])
      await db.query(
        "INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,'',$5,$6,$7)",
        [email, hash, role, email, company, employeeId, clientId],
      );
    const d = emptyState();
    d.employees = [{ id: "e1", name: "Salarié", company: "home", companies: ["home"], status: "Actif" }];
    d.clients = [
      { id: "c1", name: "Client Un", company: "home" },
      { id: "c2", name: "Client Deux", company: "home" },
    ];
    d.projects = [
      { id: "P1", title: "Chantier un", clientId: "c1", company: "home", team: ["e1"], status: "En cours" },
      { id: "P2", title: "Chantier deux", clientId: "c2", company: "home", team: ["e1"], status: "En cours" },
    ];
    await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
    server = createApp(db).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = "http://127.0.0.1:" + server.address().port;
    const admin = await session(base, "admin@test.invalid");
    const employee = await session(base, "employee@test.invalid");
    const client = await session(base, "client1@test.invalid");

    // Make sure the pro and operations tables exist before inserting test rows.
    assert.equal((await admin("/api/pro/dashboard")).status, 200);
    assert.equal((await admin("/api/operations/crm")).status, 200);
    for (const [id, clientId, projectId, title] of [
      ["wo-own", "c1", "P1", "Urgence Client Un"],
      ["wo-other", "c2", "P2", "Urgence Client Deux"],
    ])
      await db.query(
        "INSERT INTO work_orders(id,company,client_id,project_id,title,status,priority,created_by) VALUES($1,'home',$2,$3,$4,'planned','urgent',1)",
        [id, clientId, projectId, title],
      );
    const crmColumns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='crm_opportunities'")).rows.map((r) => r.column_name);
    const prospect = { id: "crm-1", company: "home", name: "Prospect Confidentiel", stage: "lead", value: 25000, created_by: 1 };
    const keys = Object.keys(prospect).filter((k) => crmColumns.includes(k));
    await db.query(
      `INSERT INTO crm_opportunities(${keys.join(",")}) VALUES(${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
      keys.map((k) => prospect[k]),
    );

    const clientDashboard = await (await client("/api/pro/dashboard")).json();
    assert.deepEqual(clientDashboard.lists.urgentWork.map((x) => x.id), ["wo-own"]);
    assert.equal(clientDashboard.actions.urgentWork, 1);
    const adminDashboard = await (await admin("/api/pro/dashboard")).json();
    assert.deepEqual(adminDashboard.lists.urgentWork.map((x) => x.id).sort(), ["wo-other", "wo-own"]);

    const search = async (who) => (await (await who("/api/pro/search?q=confidentiel")).json()).results.filter((x) => x.type === "crm");
    assert.equal((await search(client)).length, 0, "client must not find CRM prospects");
    assert.equal((await search(employee)).length, 0, "employee must not find CRM prospects");
    assert.equal((await search(admin)).length, 1, "admin still finds CRM prospects");

    assert.equal((await client("/api/pro/intervention/wo-other.pdf")).status, 404);
    const ownReport = await client("/api/pro/intervention/wo-own.pdf");
    assert.equal(ownReport.status, 200);
    assert.match(String(ownReport.headers.get("content-type")), /pdf/);
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
    await db.end();
  }
});
