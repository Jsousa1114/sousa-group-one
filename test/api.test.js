const test = require("node:test"),
  assert = require("node:assert/strict"),
  bcrypt = require("bcryptjs");
const { database } = require("./database"),
  { migrate } = require("../db"),
  { createApp } = require("../server");
const { emptyState } = require("../domain");
process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";
let db, server, url, admin, client, employee;
async function call(path, token, body) {
  const r = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
const payload = (revision, rest) => ({
  revision,
  requestId: crypto.randomUUID(),
  ...rest,
});
async function rev() {
  return (await call("state", admin)).data.revision;
}
test.before(async () => {
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, e, c] of [
    ["a@test.invalid", "admin", null, null],
    ["c@test.invalid", "client", null, "c1"],
    ["e@test.invalid", "employee", "e1", null],
  ])
    await db.query(
      "INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [email, hash, role, role, "", role === "admin" ? "group" : "home", e, c],
    );
  const d = emptyState();
  d.clients = [
    { id: "c1", name: "Client", company: "home", email: "test@example.com" },
  ];
  d.employees = [
    { id: "e1", name: "Employee", salary: 5000, vacation: 20, company: "home" },
  ];
  d.projects = [
    {
      id: "p1",
      company: "home",
      clientId: "c1",
      team: ["e1"],
      title: "Project",
    },
  ];
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [
    JSON.stringify(d),
  ]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  admin = (
    await call("auth/login", null, {
      email: "a@test.invalid",
      password: "A-Strong-Test-Password",
    })
  ).data.token;
  client = (
    await call("auth/login", null, {
      email: "c@test.invalid",
      password: "A-Strong-Test-Password",
    })
  ).data.token;
  employee = (
    await call("auth/login", null, {
      email: "e@test.invalid",
      password: "A-Strong-Test-Password",
    })
  ).data.token;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});
test("finance PDF and email draft exports require authentication and document access", async () => {
  const created = await call(
    "state/command",
    admin,
    payload(await rev(), {
      action: "create",
      collection: "quotes",
      payload: {
        company: "home",
        clientId: "c1",
        title: "PDF test",
        date: "2026-09-17",
        valid: "2026-10-17",
        lines: [
          { description: "Service", quantity: 1, unitPrice: 100, vatRate: 8.1 },
        ],
      },
    }),
  );
  assert.equal(created.status, 200);
  const id = created.data.result.id,
    path = url + `/api/state/finance/quotes/${id}.pdf`;
  assert.equal((await fetch(path)).status, 401);
  assert.equal(
    (await fetch(path, { headers: { Authorization: "Bearer " + client } }))
      .status,
    404,
  );
  const response = await fetch(path, {
    headers: { Authorization: "Bearer " + admin },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/pdf/);
  assert.equal(
    Buffer.from(await response.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    "%PDF",
  );
  assert.equal(
    (
      await fetch(path.replace(".pdf", ".eml"), {
        headers: { Authorization: "Bearer " + admin },
      })
    ).status,
    403,
  );
  await call(
    "state/command",
    admin,
    payload(await rev(), { action: "quote.issue", payload: { id } }),
  );
  assert.equal(
    (await fetch(path, { headers: { Authorization: "Bearer " + client } }))
      .status,
    200,
  );
  const eml = await fetch(path.replace(".pdf", ".eml"), {
    headers: { Authorization: "Bearer " + admin },
  });
  assert.equal(eml.status, 200);
  const draft = await eml.text();
  assert.match(draft, /X-Unsent: 1/);
  assert.match(draft, /To: test@example.com/);
  assert.match(draft, /Content-Type: application\/pdf/);
  assert.equal(
    (await fetch(path, { headers: { Authorization: "Bearer " + employee } }))
      .status,
    404,
  );
});
test("API authentication, filtered state and disabled snapshot overwrite", async () => {
  assert.equal((await call("state")).status, 401);
  const r = await call("state", client);
  assert.equal(r.status, 200);
  assert.equal(r.data.data.employees.length, 0);
  assert.equal(
    (await call("state", client, { data: { employees: [] } })).status,
    405,
  );
  assert.equal(
    (
      await call(
        "state/command",
        client,
        payload(await rev(), {
          action: "create",
          collection: "employees",
          payload: {},
        }),
      )
    ).status,
    403,
  );
});
test("concurrent edits reject stale revision without data loss, idempotent retry", async () => {
  const v = await rev(),
    b = payload(v, {
      action: "create",
      collection: "companies",
      payload: { name: "Test company", code: "TEST", type: "Test" },
    });
  assert.equal((await call("state/command", admin, b)).status, 200);
  assert.equal((await call("state/command", admin, b)).status, 200);
  const stale = await call(
    "state/command",
    admin,
    payload(v, {
      action: "create",
      collection: "companies",
      payload: { name: "Second", code: "TWO", type: "Test" },
    }),
  );
  assert.equal(stale.status, 409);
  const s = (await call("state", admin)).data;
  assert.equal(s.data.companies.filter((x) => x.code === "TEST").length, 1);
  assert.equal(s.revision, v + 1);
});
test("validation errors roll back transaction and revision", async () => {
  const v = await rev();
  const r = await call(
    "state/command",
    admin,
    payload(v, {
      action: "create",
      collection: "invoices",
      payload: {
        company: "home",
        clientId: "c1",
        title: "Bad",
        date: "2026-09-15",
        due: "2026-09-10",
        lines: [{ description: "A", quantity: 1, unitPrice: 10 }],
      },
    }),
  );
  assert.equal(r.status, 400);
  assert.equal(await rev(), v);
});
test("message delivery isolates recipients and escapes via UI boundary", async () => {
  const accounts = (await call("state/users", admin)).data.users,
    c = accounts.find((u) => u.role === "client");
  const r = await call(
    "state/messages",
    admin,
    payload(await rev(), {
      payload: { recipientId: c.id, text: "<b>literal text</b>" },
    }),
  );
  assert.equal(r.status, 200);
  assert.equal((await call("state", client)).data.data.messages.length, 1);
  assert.equal((await call("state", employee)).data.data.messages.length, 0);
});
test("document upload and download authorization", async () => {
  const r = await call(
    "state/documents",
    admin,
    payload(await rev(), {
      payload: {
        company: "home",
        employeeId: "e1",
        name: "private.txt",
        mime: "text/plain",
        content: Buffer.from("private").toString("base64"),
      },
    }),
  );
  assert.equal(r.status, 200);
  const id = r.data.result.id;
  assert.equal((await call("state/documents/" + id, client)).status, 403);
  const file = await fetch(url + "/api/state/documents/" + id, {
    headers: { Authorization: "Bearer " + employee },
  });
  assert.equal(file.status, 200);
  assert.equal(await file.text(), "private");
  assert.match(file.headers.get("content-disposition"), /attachment/);
});
test("account creation links to real employee; duplicate account rolls back", async () => {
  const record = await call(
    "state/command",
    admin,
    payload(await rev(), {
      action: "create",
      collection: "employees",
      payload: {
        company: "home",
        name: "New Person",
        job: "Tech",
        email: "new@test.invalid",
        salary: 5000,
        activity: 100,
        vacation: 20,
        entry: "2026-09-15",
      },
    }),
  );
  const e = record.data.result;
  assert.ok(e.id);
  const body = {
    name: "New Person",
    email: "new@test.invalid",
    password: "Another-Strong-Password",
    role: "employee",
    company: "home",
    employeeId: e.id,
  };
  assert.equal(
    (await call("state/users", admin, payload(await rev(), { payload: body })))
      .status,
    200,
  );
  const v = await rev();
  assert.equal(
    (
      await call(
        "state/users",
        admin,
        payload(v, { payload: { ...body, email: "duplicate@test.invalid" } }),
      )
    ).status,
    400,
  );
  assert.equal(await rev(), v);
  const login = await call("auth/login", null, {
    email: body.email,
    password: body.password,
  });
  assert.equal(login.data.profile.employee_id, e.id);
  assert.equal(
    (await call("state", login.data.token)).data.data.employees[0].name,
    "New Person",
  );
});
test("demo password disabled by migration", async () => {
  await db.query(
    "INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES($1,$2,'admin','Old demo','','group')",
    ["demo@test.invalid", await bcrypt.hash("demo1234", 4)],
  );
  await migrate(db);
  assert.equal(
    (
      await call("auth/login", null, {
        email: "demo@test.invalid",
        password: "demo1234",
      })
    ).status,
    401,
  );
});
test("logout revokes issued token", async () => {
  assert.equal((await call("auth/logout", employee, {})).status, 200);
  assert.equal((await call("state", employee)).status, 401);
});
test("reusing request ID with changed payload is rejected", async () => {
  const v = await rev(),
    b = payload(v, {
      action: "create",
      collection: "companies",
      payload: { name: "Receipt", code: "REC", type: "Test" },
    });
  assert.equal((await call("state/command", admin, b)).status, 200);
  assert.equal(
    (
      await call("state/command", admin, {
        ...b,
        payload: { ...b.payload, name: "Changed" },
      })
    ).status,
    409,
  );
});
test("administrator can relink existing account and sessions are revoked", async () => {
  const users = (await call("state/users", admin)).data.users,
    u = users.find((x) => x.role === "client");
  const r = await call(
    "state/users",
    admin,
    payload(await rev(), {
      payload: {
        id: u.id,
        name: "Client relinked",
        email: u.email,
        password: "New-Test-Password-123",
        role: "client",
        company: "home",
        clientId: "c1",
      },
    }),
  );
  assert.equal(r.status, 200);
  assert.equal((await call("state", client)).status, 401);
  const login = await call("auth/login", null, {
    email: u.email,
    password: "New-Test-Password-123",
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.profile.client_id, "c1");
});
