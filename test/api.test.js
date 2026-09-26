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
test("only the seven explicit logo assets are publicly served", async () => {
  for (const id of [
    "group",
    "home",
    "electricite",
    "tech",
    "moving",
    "solar",
    "events",
  ]) {
    const response = await fetch(url + `/assets/logos/${id}.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/png/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  }
  assert.equal(
    (await fetch(url + "/assets/fonts/LiberationSans-Regular.ttf")).status,
    404,
  );
});
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
  d.employees[0].photo =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
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
test("messaging contacts expose profile photos without HR fields", async () => {
  const own = (await call("state", employee)).data;
  const contacts = (await call("state", admin)).data.contacts;
  const sender = contacts.find((c) => c.id === own.profile.id);
  assert.match(sender.photo, /^data:image\/png;base64,/);
  assert.equal(sender.photo, own.profile.photo);
  assert.deepEqual(Object.keys(sender).sort(), ["id", "name", "photo", "role"]);
  assert.equal(
    (await call("state", client)).data.contacts.some(
      (c) => c.id === own.profile.id,
    ),
    false,
  );
});
test("client deletion rejects linked accounts atomically and deletes an unused client", async () => {
  const created = await call(
    "state/command",
    admin,
    payload(await rev(), {
      action: "create",
      collection: "clients",
      payload: {
        name: "Temporary",
        company: "home",
        email: "temporary@test.invalid",
        city: "Nyon",
      },
    }),
  );
  assert.equal(created.status, 200);
  const id = created.data.result.id;
  await db.query("UPDATE users SET client_id=$1 WHERE email='c@test.invalid'", [
    id,
  ]);
  const before = await rev();
  const denied = await call(
    "state/command",
    admin,
    payload(before, { action: "client.delete", payload: { id } }),
  );
  assert.equal(denied.status, 400);
  assert.match(denied.data.error, /compte de connexion/);
  assert.equal(await rev(), before);
  assert.ok(
    (await call("state", admin)).data.data.clients.some((c) => c.id === id),
  );
  await db.query(
    "UPDATE users SET client_id='c1' WHERE email='c@test.invalid'",
  );
  const removed = await call(
    "state/command",
    admin,
    payload(await rev(), { action: "client.delete", payload: { id } }),
  );
  assert.equal(removed.status, 200);
  assert.equal(
    (await call("state", admin)).data.data.clients.some((c) => c.id === id),
    false,
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
test("identity photos persist and cannot be read or uploaded by employees or clients", async () => {
  const photo =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const doc = {
    company: "home",
    employeeId: "e1",
    category: "identity",
    documentType: "Carte d’identité",
    description: "Recto",
    name: "identity.png",
    mime: "image/png",
    content: photo,
  };
  const saved = await call(
    "state/documents",
    admin,
    payload(await rev(), { payload: doc }),
  );
  assert.equal(saved.status, 200);
  const id = saved.data.result.id;
  const response = await fetch(url + "/api/state/documents/" + id, {
    headers: { Authorization: "Bearer " + admin },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    Buffer.from(photo, "base64"),
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await call("state/documents/" + id, employee)).status, 403);
  assert.equal((await call("state/documents/" + id, client)).status, 403);
  assert.equal(
    (
      await call(
        "state/documents",
        employee,
        payload(await rev(), { payload: doc }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "state/documents",
        admin,
        payload(await rev(), {
          payload: { ...doc, content: Buffer.from("fake").toString("base64") },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "state/documents",
        admin,
        payload(await rev(), { payload: { ...doc, visibility: "client" } }),
      )
    ).status,
    400,
  );
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
test("multi-company membership changes apply to existing sessions and removal disables login", async () => {
  const login = await call("auth/login", null, {
    email: "e@test.invalid",
    password: "A-Strong-Test-Password",
  });
  const session = login.data.token;
  assert.equal(login.status, 200);
  const body = {
    action: "employee.companies",
    payload: { id: "e1", companies: ["home", "moving"] },
  };
  assert.equal(
    (await call("state/command", session, payload(await rev(), body))).status,
    403,
  );
  assert.equal(
    (await call("state/command", admin, payload(await rev(), body))).status,
    200,
  );
  let state = await call("state", session);
  assert.deepEqual(state.data.profile.companies, ["home", "moving"]);
  assert.ok(state.data.data.companies.some((c) => c.id === "moving"));
  assert.equal(
    (
      await call(
        "state/command",
        admin,
        payload(await rev(), {
          action: "employee.companies",
          payload: { id: "e1", companies: ["home"] },
        }),
      )
    ).status,
    200,
  );
  state = await call("state", session);
  assert.equal(
    state.data.data.companies.some((c) => c.id === "moving"),
    false,
  );
  assert.equal(
    (
      await call(
        "state/command",
        admin,
        payload(await rev(), {
          action: "employee.delete",
          payload: { id: "e1" },
        }),
      )
    ).status,
    200,
  );
  assert.equal((await call("state", session)).status, 401);
  assert.equal(
    (
      await call("auth/login", null, {
        email: "e@test.invalid",
        password: "A-Strong-Test-Password",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await db.query("SELECT disabled FROM users WHERE email=$1", [
        "e@test.invalid",
      ])
    ).rows[0].disabled,
    true,
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

test("account type validation and deletion revoke access without deleting business records", async () => {
  const employeeRecord = await call(
    "state/command",
    admin,
    payload(await rev(), {
      action: "create",
      collection: "employees",
      payload: {
        company: "home",
        name: "Account deletion test",
        job: "Tech",
        email: "removal@test.invalid",
        salary: 1000,
        activity: 100,
        vacation: 20,
        entry: "2026-09-15",
      },
    }),
  );
  const eid = employeeRecord.data.result.id;
  const body = {
    name: "Removal test",
    email: "removal@test.invalid",
    password: "Secure-Removal-Test-Password",
    role: "employee",
    company: "home",
    employeeId: eid,
    isEmployee: "no",
  };
  assert.equal(
    (await call("state/users", admin, payload(await rev(), { payload: body })))
      .status,
    400,
  );
  body.isEmployee = "yes";
  const created = await call(
    "state/users",
    admin,
    payload(await rev(), { payload: body }),
  );
  assert.equal(created.status, 200);
  const id = created.data.result.id;
  const token = (
    await call("auth/login", null, {
      email: body.email,
      password: body.password,
    })
  ).data.token;
  assert.ok(token);
  assert.equal(
    (
      await call(
        "state/users/delete",
        token,
        payload(await rev(), { payload: { id } }),
      )
    ).status,
    403,
  );
  const own = (await call("state/users", admin)).data.users.find(
    (x) => x.email === "a@test.invalid",
  );
  assert.equal(
    (
      await call(
        "state/users/delete",
        admin,
        payload(await rev(), { payload: { id: own.id } }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "state/users/delete",
        admin,
        payload(await rev(), { payload: { id } }),
      )
    ).status,
    200,
  );
  assert.equal((await call("state", token)).status, 401);
  assert.equal(
    (
      await call("auth/login", null, {
        email: body.email,
        password: body.password,
      })
    ).status,
    401,
  );
  assert.ok(
    !(await call("state/users", admin)).data.users.some((x) => x.id === id),
  );
  assert.ok(
    (await call("state", admin)).data.data.employees.some((x) => x.id === eid),
  );
  assert.equal(
    (
      await call(
        "state/users/password",
        admin,
        payload(await rev(), { payload: { id, password: body.password } }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        "state/users",
        admin,
        payload(await rev(), { payload: { ...body, id } }),
      )
    ).status,
    404,
  );
  assert.equal(
    (await call("state/users", admin, payload(await rev(), { payload: body })))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        "state/users",
        admin,
        payload(await rev(), {
          payload: {
            name: "External manager",
            email: "external@test.invalid",
            password: body.password,
            role: "manager",
            company: "home",
            isEmployee: "no",
          },
        }),
      )
    ).status,
    200,
  );
});

test("account and new employee are created atomically with retry and rollback protection", async () => {
  const body = {
    name: "Combined Employee",
    employeeCompanies: ["home", "tech"],
    email: "combined@test.invalid",
    password: "Combined-Strong-Password",
    company: "home",
    role: "employee",
    isEmployee: "yes",
    newEmployee: {
      job: "Technicien",
      phone: "",
      salary: 35.5,
      salaryPeriod: "hourly",
      activity: 80,
      vacation: 20,
      entry: "2026-09-24",
    },
  };
  const request = payload(await rev(), { payload: body });
  const created = await call("state/users", admin, request);
  assert.equal(created.status, 200);
  const eid = created.data.result.employeeId;
  assert.ok(eid);
  assert.equal(
    (await call("state/users", admin, request)).data.result.employeeId,
    eid,
  );
  const state = (await call("state", admin)).data.data;
  assert.equal(state.employees.filter((e) => e.id === eid).length, 1);
  assert.equal(state.employees.find((e) => e.id === eid).activity, 80);
  assert.equal(
    state.employees.find((e) => e.id === eid).salaryPeriod,
    "hourly",
  );
  assert.equal(state.employees.find((e) => e.id === eid).salary, 35.5);
  const login = await call("auth/login", null, {
    email: body.email,
    password: body.password,
  });
  assert.equal(login.data.profile.employee_id, eid);
  assert.deepEqual(
    (await call("state", login.data.token)).data.profile.companies,
    ["home", "tech"],
  );
  assert.deepEqual(state.employees.find((e) => e.id === eid).companies, [
    "home",
    "tech",
  ]);
  assert.equal((await call("state", login.data.token)).status, 200);
  const before = await rev(),
    count = state.employees.length;
  const failed = await call(
    "state/users",
    admin,
    payload(before, { payload: { ...body, email: "a@test.invalid" } }),
  );
  assert.notEqual(failed.status, 200);
  assert.equal(await rev(), before);
  assert.equal((await call("state", admin)).data.data.employees.length, count);
  assert.equal(
    (
      await call(
        "state/users",
        admin,
        payload(before, {
          payload: {
            ...body,
            email: "invalid-combined@test.invalid",
            newEmployee: { ...body.newEmployee, salary: -1 },
          },
        }),
      )
    ).status,
    400,
  );
  assert.equal(await rev(), before);
});

test("new client and account commit together with private access and full rollback", async () => {
  const body = {
    name: "Combined Client",
    email: "combined-client@test.invalid",
    password: "Combined-Client-Password",
    company: "home",
    role: "client",
    isEmployee: "no",
    newClient: {
      phone: "",
      street: "Rue Exemple",
      buildingNumber: "2",
      zip: "1000",
      city: "Lausanne",
      country: "CH",
      type: "Particulier",
    },
  };
  const request = payload(await rev(), { payload: body });
  const created = await call("state/users", admin, request);
  assert.equal(created.status, 200);
  const cid = created.data.result.clientId;
  assert.ok(cid);
  assert.equal(
    (await call("state/users", admin, request)).data.result.clientId,
    cid,
  );
  const state = (await call("state", admin)).data.data;
  assert.equal(state.clients.filter((c) => c.id === cid).length, 1);
  assert.equal(state.clients.find((c) => c.id === cid).city, "Lausanne");
  const login = await call("auth/login", null, {
    email: body.email,
    password: body.password,
  });
  assert.equal(login.data.profile.client_id, cid);
  const own = await call("state", login.data.token);
  assert.equal(own.status, 200);
  assert.equal(own.data.data.employees.length, 0);
  assert.ok(own.data.data.clients.every((c) => c.id === cid));
  const before = await rev(),
    count = state.clients.length;
  assert.notEqual(
    (
      await call(
        "state/users",
        admin,
        payload(before, { payload: { ...body, email: "a@test.invalid" } }),
      )
    ).status,
    200,
  );
  assert.equal(await rev(), before);
  assert.equal((await call("state", admin)).data.data.clients.length, count);
  assert.equal(
    (
      await call(
        "state/users",
        admin,
        payload(before, {
          payload: {
            ...body,
            email: "invalid-client@test.invalid",
            newClient: { ...body.newClient, city: "" },
          },
        }),
      )
    ).status,
    400,
  );
  assert.equal(await rev(), before);
});

test("editing employee companies without a new password preserves login credentials", async () => {
  const body = {
    name: "Membership edit",
    email: "membership-edit@test.invalid",
    password: "Membership-Strong-Password",
    company: "home",
    role: "employee",
    isEmployee: "yes",
    employeeCompanies: ["home"],
    newEmployee: {
      job: "Technicien",
      salary: 5000,
      activity: 100,
      vacation: 20,
      entry: "2026-09-24",
    },
  };
  const created = await call(
    "state/users",
    admin,
    payload(await rev(), { payload: body }),
  );
  assert.equal(created.status, 200);
  const id = created.data.result.id;
  const before = (
    await db.query("SELECT password_hash FROM users WHERE id=$1", [id])
  ).rows[0].password_hash;
  const edit = {
    ...body,
    id,
    employeeId: created.data.result.employeeId,
    employeeCompanies: ["home", "tech"],
  };
  delete edit.newEmployee;
  delete edit.password;
  const saved = await call(
    "state/users",
    admin,
    payload(await rev(), { payload: edit }),
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(
    (await db.query("SELECT password_hash FROM users WHERE id=$1", [id]))
      .rows[0].password_hash,
    before,
  );
  const login = await call("auth/login", null, {
    email: body.email,
    password: body.password,
  });
  assert.equal(login.status, 200);
  assert.deepEqual(
    (await call("state", login.data.token)).data.profile.companies,
    ["home", "tech"],
  );
  const invalid = await call(
    "state/users",
    admin,
    payload(await rev(), { payload: { ...edit, password: "short" } }),
  );
  assert.equal(invalid.status, 400);
  const changed = await call(
    "state/users",
    admin,
    payload(await rev(), {
      payload: { ...edit, password: "Replacement-Strong-Password" },
    }),
  );
  assert.equal(changed.status, 200);
  assert.equal(
    (
      await call("auth/login", null, {
        email: body.email,
        password: body.password,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call("auth/login", null, {
        email: body.email,
        password: "Replacement-Strong-Password",
      })
    ).status,
    200,
  );
});

test("manager company memberships apply to login, writes and an already open session", async () => {
  const body = {
    name: "Multi manager",
    email: "multi-manager@test.invalid",
    password: "Multi-Manager-Password",
    company: "home",
    role: "manager",
    isEmployee: "yes",
    employeeCompanies: ["home", "tech"],
    newEmployee: {
      job: "Responsable",
      salary: 5000,
      activity: 100,
      vacation: 20,
      entry: "2026-09-26",
    },
  };
  const created = await call(
    "state/users",
    admin,
    payload(await rev(), { payload: body }),
  );
  assert.equal(created.status, 200);
  const login = await call("auth/login", null, {
    email: body.email,
    password: body.password,
  });
  assert.equal(login.status, 200);
  const token = login.data.token;
  const state = await call("state", token);
  assert.deepEqual(state.data.profile.companies, ["home", "tech"]);
  assert.deepEqual(state.data.data.companies.map((c) => c.id).sort(), [
    "home",
    "tech",
  ]);
  const allowed = await call(
    "state/command",
    token,
    payload(await rev(), {
      action: "create",
      collection: "clients",
      payload: {
        company: "tech",
        name: "Allowed",
        email: "allowed@test.invalid",
        city: "Nyon",
        type: "Particulier",
      },
    }),
  );
  assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
  const forbidden = await call(
    "state/command",
    token,
    payload(await rev(), {
      action: "create",
      collection: "clients",
      payload: {
        company: "moving",
        name: "Denied",
        city: "Nyon",
        type: "Particulier",
      },
    }),
  );
  assert.equal(forbidden.status, 403);
  const removed = await call(
    "state/command",
    admin,
    payload(await rev(), {
      action: "employee.companies",
      payload: { id: created.data.result.employeeId, companies: ["home"] },
    }),
  );
  assert.equal(removed.status, 200);
  assert.deepEqual((await call("state", token)).data.profile.companies, [
    "home",
  ]);
  const revoked = await call(
    "state/command",
    token,
    payload(await rev(), {
      action: "create",
      collection: "clients",
      payload: {
        company: "tech",
        name: "Denied",
        city: "Nyon",
        type: "Particulier",
      },
    }),
  );
  assert.equal(revoked.status, 403);
});

test("employee dossier updates persist without changing linked login email", async () => {
  const create = await call(
    "state/users",
    admin,
    payload(await rev(), {
      payload: {
        name: "Dossier",
        email: "dossier@test.invalid",
        password: "Dossier-Test-Password",
        company: "home",
        role: "employee",
        isEmployee: "yes",
        newEmployee: {
          job: "Tech",
          salary: 30,
          salaryPeriod: "hourly",
          activity: 100,
          vacation: 20,
          entry: "2026-01-01",
        },
      },
    }),
  );
  assert.equal(create.status, 200);
  const id = create.data.result.employeeId;
  const photo =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const save = await call(
    "state/command",
    admin,
    payload(await rev(), {
      action: "employee.update",
      payload: {
        id,
        email: "contact@test.invalid",
        street: "Rue 1",
        zip: "1260",
        city: "Nyon",
        photo,
      },
    }),
  );
  assert.equal(save.status, 200, JSON.stringify(save.data));
  const e = (await call("state", admin)).data.data.employees.find(
    (e) => e.id === id,
  );
  assert.equal(e.city, "Nyon");
  assert.equal(e.photo, photo);
  assert.equal(e.salaryPeriod, "hourly");
  const login = await call("auth/login", null, {
    email: "dossier@test.invalid",
    password: "Dossier-Test-Password",
  });
  assert.equal(login.status, 200);
  const denied = await call(
    "state/command",
    login.data.token,
    payload(await rev(), {
      action: "employee.update",
      payload: { id, salary: 999 },
    }),
  );
  assert.equal(denied.status, 403);
});

test("deleting a document removes stored bytes transactionally", async () => {
  const uploaded = await call(
    "state/documents",
    admin,
    payload(await rev(), {
      payload: {
        company: "home",
        project: "p1",
        name: "delete-test.txt",
        mime: "text/plain",
        content: Buffer.from("test").toString("base64"),
      },
    }),
  );
  assert.equal(uploaded.status, 200);
  const id = uploaded.data.result.id;
  const removed = await call(
    "state/command",
    admin,
    payload(await rev(), {
      action: "record.delete",
      payload: { kind: "documents", id },
    }),
  );
  assert.equal(removed.status, 200);
  assert.equal(
    (await db.query("SELECT id FROM file_contents WHERE id=$1", [id])).rows
      .length,
    0,
  );
  assert.equal((await call("state/documents/" + id, admin)).status, 404);
});


test("advanced messaging supports groups, project threads, attachments, replies and read receipts", async () => {
  const users = (await call("state/users", admin)).data.users;
  const clientUser = users.find((u) => u.role === "client");
  assert.ok(clientUser);
  const freshClientLogin = await call("auth/login", null, {
    email: clientUser.email,
    password: "New-Test-Password-123",
  });
  assert.equal(freshClientLogin.status, 200);
  const freshClient = freshClientLogin.data.token;

  const group = await call(
    "state/message-threads",
    admin,
    payload(await rev(), {
      payload: {
        type: "group",
        name: "Equipe test",
        participants: [clientUser.id],
      },
    }),
  );
  assert.equal(group.status, 200);
  const groupId = group.data.result.id;

  const projectThread = await call(
    "state/message-threads",
    admin,
    payload(await rev(), {
      payload: {
        type: "project",
        name: "Chantier Project",
        projectId: "p1",
        participants: [clientUser.id],
      },
    }),
  );
  assert.equal(projectThread.status, 200);
  assert.ok(projectThread.data.result.id);

  const sent = await call(
    "state/messages",
    admin,
    payload(await rev(), {
      payload: {
        threadId: groupId,
        text: "Photo et document",
        attachment: {
          name: "preuve.txt",
          mime: "text/plain",
          content: Buffer.from("contenu-chat").toString("base64"),
        },
      },
    }),
  );
  assert.equal(sent.status, 200);
  const messageId = sent.data.result.id;

  let clientState = await call("state", freshClient);
  assert.equal(clientState.status, 200, JSON.stringify(clientState.data));
  assert.ok(
    clientState.data.data.messageThreads.some((t) => t.id === groupId),
  );
  const received = clientState.data.data.messages.find((m) => m.id === messageId);
  assert.ok(received);
  assert.equal(received.attachment.name, "preuve.txt");
  assert.equal(received.readBy.includes(String(clientUser.id)), false);

  const attachment = await fetch(
    url + "/api/state/messages/" + messageId + "/attachment",
    { headers: { Authorization: "Bearer " + freshClient } },
  );
  assert.equal(attachment.status, 200);
  assert.equal(await attachment.text(), "contenu-chat");

  const revisionBeforeRead = await rev();
  const read = await call(
    "state/messages/read",
    freshClient,
    payload(revisionBeforeRead, { payload: { threadId: groupId } }),
  );
  assert.equal(read.status, 200);
  assert.ok(read.data.result.changed >= 1);
  assert.equal(await rev(), revisionBeforeRead, "reading messages must not change the global business revision");

  let adminState = await call("state", admin);
  const readMessage = adminState.data.data.messages.find((m) => m.id === messageId);
  assert.ok(readMessage.readBy.includes(String(clientUser.id)));

  const reply = await call(
    "state/messages",
    freshClient,
    payload(await rev(), {
      payload: {
        threadId: groupId,
        text: "Bien reçu",
        replyToId: messageId,
      },
    }),
  );
  assert.equal(reply.status, 200);
  adminState = await call("state", admin);
  const replied = adminState.data.data.messages.find(
    (m) => m.id === reply.data.result.id,
  );
  assert.equal(replied.replyToId, messageId);

  const direct = await call(
    "state/messages",
    admin,
    payload(await rev(), {
      payload: { recipientId: clientUser.id, text: "Message direct séparé" },
    }),
  );
  assert.equal(direct.status, 200);
  const crossConversationReply = await call(
    "state/messages",
    freshClient,
    payload(await rev(), {
      payload: {
        threadId: groupId,
        text: "Tentative de citation croisée",
        replyToId: direct.data.result.id,
      },
    }),
  );
  assert.equal(crossConversationReply.status, 403);
  assert.match(crossConversationReply.data.error, /autre conversation/i);
});


test("audio call signaling supports ring, answer, ICE exchange, hangup and reject", async () => {
  const users = (await call("state/users", admin)).data.users,
    clientUser = users.find((u) => u.role === "client");
  assert.ok(clientUser);
  const login = await call("auth/login", null, {
    email: clientUser.email,
    password: "New-Test-Password-123",
  });
  assert.equal(login.status, 200);
  const freshClient = login.data.token,
    offer = { type: "offer", sdp: "v=0\r\no=sgo 1 1 IN IP4 127.0.0.1\r\ns=audio-call-test" },
    answer = { type: "answer", sdp: "v=0\r\no=sgo 2 2 IN IP4 127.0.0.1\r\ns=audio-call-test-answer" };

  const started = await call("state/calls/start", admin, {
    recipientId: clientUser.id,
    offer,
  });
  assert.equal(started.status, 200);
  const id = started.data.id;
  assert.ok(id);

  const pending = await call("state/calls/pending", freshClient);
  assert.equal(pending.status, 200);
  assert.equal(pending.data.call.id, id);
  assert.equal(pending.data.call.status, "ringing");

  const candidate = {
    candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 54321 typ host",
    sdpMid: "0",
    sdpMLineIndex: 0,
  };
  assert.equal(
    (
      await call("state/calls/" + id + "/candidates", admin, {
        candidate,
      })
    ).status,
    200,
  );
  const candidates = await call(
    "state/calls/" + id + "/candidates?after=0",
    freshClient,
  );
  assert.equal(candidates.status, 200);
  assert.equal(candidates.data.candidates.length, 1);
  assert.equal(candidates.data.candidates[0].candidate.candidate, candidate.candidate);

  const accepted = await call("state/calls/" + id + "/answer", freshClient, {
    answer,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.status, "accepted");

  const active = await call("state/calls/" + id, admin);
  assert.equal(active.status, 200);
  assert.equal(active.data.call.status, "accepted");
  assert.equal(active.data.call.answer.type, "answer");

  const ended = await call("state/calls/" + id + "/end", admin, {});
  assert.equal(ended.status, 200);
  assert.equal(ended.data.status, "ended");

  const second = await call("state/calls/start", admin, {
    recipientId: clientUser.id,
    offer,
  });
  assert.equal(second.status, 200);
  const rejected = await call(
    "state/calls/" + second.data.id + "/reject",
    freshClient,
    {},
  );
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.status, "rejected");
});


test("complete messaging suite secures presence, preferences, reactions, E2EE transport, shares, group calls and project events", async () => {
  const stamp = Date.now(),
    email = `suite-client-${stamp}@test.invalid`,
    password = "Messaging-Suite-Test-Password-2026",
    hash = await bcrypt.hash(password, 4);

  // Fresh business client and fresh login account avoid depending on earlier mutable fixtures.
  const clientCreated = await call(
    "state/command",
    admin,
    payload(await rev(), {
      action: "create",
      collection: "clients",
      payload: {
        company: "home",
        name: "Suite Client",
        email,
        phone: "",
        city: "Lausanne",
        street: "Rue Test",
        buildingNumber: "1",
        zip: "1000",
        country: "CH",
        type: "Test",
      },
    }),
  );
  assert.equal(clientCreated.status, 200, JSON.stringify(clientCreated.data));
  const suiteClientId = clientCreated.data.result.id,
    userInsert = await db.query(
      "INSERT INTO users(email,password_hash,role,name,avatar,company,client_id) VALUES($1,$2,'client','Suite Client','SC','home',$3) RETURNING id",
      [email, hash, String(suiteClientId)],
    ),
    suiteUserId = userInsert.rows[0].id,
    suiteLogin = await call("auth/login", null, { email, password });
  assert.equal(suiteLogin.status, 200);
  const suiteClient = suiteLogin.data.token;

  // Presence / typing.
  assert.equal(
    (await call("messaging/presence", suiteClient, { typingKey: null })).status,
    200,
  );
  let presence = await call("messaging/presence", admin);
  assert.equal(presence.status, 200);
  assert.ok(
    presence.data.presence.some(
      (p) => String(p.userId) === String(suiteUserId) && p.online,
    ),
  );

  // Conversation + pin/archive/mute preferences.
  const group = await call(
    "state/message-threads",
    admin,
    payload(await rev(), {
      payload: {
        type: "group",
        name: "Suite Messaging Group",
        participants: [suiteUserId],
      },
    }),
  );
  assert.equal(group.status, 200, JSON.stringify(group.data));
  const groupId = group.data.result.id,
    groupKey = "thread:" + groupId;
  assert.equal(
    (
      await call("messaging/preferences", suiteClient, {
        key: groupKey,
        pinned: true,
        archived: true,
        mutedUntil: new Date(Date.now() + 3600000).toISOString(),
      })
    ).status,
    200,
  );
  const prefs = await call("messaging/preferences", suiteClient);
  assert.ok(
    prefs.data.preferences.some(
      (p) => p.key === groupKey && p.pinned && p.archived && p.mutedUntil,
    ),
  );

  // Public E2EE keys are available to participants of a visible group.
  const adminPublic = {
      kty: "EC",
      crv: "P-256",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ext: true,
    },
    clientPublic = {
      kty: "EC",
      crv: "P-256",
      x: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      y: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      ext: true,
    };
  assert.equal(
    (await call("messaging/crypto/key", admin, { publicJwk: adminPublic })).status,
    200,
  );
  assert.equal(
    (await call("messaging/crypto/key", suiteClient, { publicJwk: clientPublic }))
      .status,
    200,
  );
  const clientKeys = await call(
    "messaging/crypto/keys?ids=" + encodeURIComponent(String((await call("state", admin)).data.profile.id)),
    suiteClient,
  );
  assert.equal(clientKeys.status, 200);
  assert.ok(clientKeys.data.keys.length >= 1);

  // E2EE transport: server stores ciphertext, never the plaintext.
  const envelopes = {
      [String((await call("state", admin)).data.profile.id)]: {
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "BBBBBBBBBBBBBBBBBBBBBBBB",
      },
      [String(suiteUserId)]: {
        iv: "CCCCCCCCCCCCCCCC",
        ciphertext: "DDDDDDDDDDDDDDDDDDDDDDDD",
      },
    },
    encryptedSent = await call(
      "state/messages",
      admin,
      payload(await rev(), {
        payload: {
          threadId: groupId,
          text: "",
          encryption: {
            algorithm: "SGO-E2EE-P256-AESGCM-v1",
            iv: "EEEEEEEEEEEEEEEE",
            ciphertext: "FFFFFFFFFFFFFFFFFFFFFFFF",
            envelopes,
          },
        },
      }),
    );
  assert.equal(encryptedSent.status, 200, JSON.stringify(encryptedSent.data));
  const encryptedId = encryptedSent.data.result.id,
    rawState = (await db.query("SELECT data FROM app_state WHERE id=1")).rows[0]
      .data,
    rawMessage = rawState.messages.find((m) => m.id === encryptedId);
  assert.equal(rawMessage.text, "");
  assert.equal(rawMessage.encryption.ciphertext, "FFFFFFFFFFFFFFFFFFFFFFFF");
  assert.equal(JSON.stringify(rawMessage).includes("secret plaintext"), false);

  // Reactions and favorites are per-user metadata.
  assert.equal(
    (
      await call(
        "messaging/messages/" + encryptedId + "/reaction",
        suiteClient,
        { emoji: "✅" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "messaging/messages/" + encryptedId + "/favorite",
        suiteClient,
        {},
      )
    ).status,
    200,
  );
  const meta = await call("messaging/message-meta", suiteClient);
  assert.ok(
    meta.data.reactions.some(
      (r) => r.messageId === encryptedId && r.emoji === "✅",
    ),
  );
  assert.ok(meta.data.favorites.includes(encryptedId));

  // Plain message edit then delete-for-all, including attachment purge.
  const attachmentSent = await call(
    "state/messages",
    admin,
    payload(await rev(), {
      payload: {
        threadId: groupId,
        text: "Texte avant modification",
        attachment: {
          name: "suite.txt",
          mime: "text/plain",
          content: Buffer.from("suite attachment").toString("base64"),
        },
      },
    }),
  );
  assert.equal(attachmentSent.status, 200);
  const editableId = attachmentSent.data.result.id;
  assert.equal(
    (
      await call("messaging/messages/" + editableId + "/edit", admin, {
        text: "Texte modifié",
      })
    ).status,
    200,
  );
  let suiteState = await call("state", suiteClient);
  assert.equal(
    suiteState.data.data.messages.find((m) => m.id === editableId).text,
    "Texte modifié",
  );
  assert.equal(
    (
      await call(
        "messaging/messages/" + editableId + "/delete-for-all",
        admin,
        {},
      )
    ).status,
    200,
  );
  suiteState = await call("state", suiteClient);
  assert.equal(
    suiteState.data.data.messages.find((m) => m.id === editableId).deletedForAll,
    true,
  );
  assert.equal(
    (
      await fetch(url + "/api/state/messages/" + editableId + "/attachment", {
        headers: { Authorization: "Bearer " + suiteClient },
      })
    ).status,
    404,
  );

  // Create and issue a visible quote, then share its reference in chat.
  const quote = await call(
    "state/command",
    admin,
    payload(await rev(), {
      action: "create",
      collection: "quotes",
      payload: {
        company: "home",
        clientId: suiteClientId,
        title: "Devis partagé dans le chat",
        date: "2026-09-27",
        valid: "2026-10-27",
        lines: [
          {
            description: "Prestation chat",
            quantity: 1,
            unitPrice: 120,
            vatRate: 0,
          },
        ],
      },
    }),
  );
  assert.equal(quote.status, 200);
  const quoteId = quote.data.result.id;
  assert.equal(
    (
      await call(
        "state/command",
        admin,
        payload(await rev(), {
          action: "quote.issue",
          payload: { id: quoteId },
        }),
      )
    ).status,
    200,
  );
  const shared = await call(
    "state/messages",
    admin,
    payload(await rev(), {
      payload: {
        threadId: groupId,
        text: "Voici le devis",
        sharedRef: { kind: "quotes", id: quoteId },
      },
    }),
  );
  assert.equal(shared.status, 200, JSON.stringify(shared.data));
  suiteState = await call("state", suiteClient);
  assert.equal(
    suiteState.data.data.messages.find((m) => m.id === shared.data.result.id)
      .sharedRef.id,
    quoteId,
  );

  // Group-call signaling lifecycle.
  const room = await call("messaging/group-calls", admin, {
    threadId: groupId,
    callType: "video",
  });
  assert.equal(room.status, 200, JSON.stringify(room.data));
  const roomId = room.data.id;
  let pendingGroups = await call("messaging/group-calls/pending", suiteClient);
  assert.ok(pendingGroups.data.rooms.some((r) => r.id === roomId));
  assert.equal(
    (
      await call(
        "messaging/group-calls/" + roomId + "/join",
        suiteClient,
        {},
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "messaging/group-calls/" + roomId + "/signal",
        admin,
        {
          toUser: suiteUserId,
          kind: "offer",
          payload: { type: "offer", sdp: "suite-group-offer" },
        },
      )
    ).status,
    200,
  );
  const groupSignals = await call(
    "messaging/group-calls/" + roomId + "/signals?after=0",
    suiteClient,
  );
  assert.equal(groupSignals.status, 200);
  assert.equal(groupSignals.data.signals[0].kind, "offer");
  assert.equal(
    (await call("messaging/group-calls/" + roomId + "/end", admin, {})).status,
    200,
  );

  // Direct video call appears correctly in history.
  const directVideo = await call("state/calls/start", admin, {
    recipientId: suiteUserId,
    callType: "video",
    offer: {
      type: "offer",
      sdp: "v=0\r\no=suite-video 1 1 IN IP4 127.0.0.1\r\ns=video",
    },
  });
  assert.equal(directVideo.status, 200);
  await call("state/calls/" + directVideo.data.id + "/reject", suiteClient, {});
  const history = await call("messaging/calls/history", admin);
  assert.ok(
    history.data.direct.some(
      (c) => c.id === directVideo.data.id && c.callType === "video",
    ),
  );

  // Project creation must create a project discussion and system activity.
  const project = await call(
    "state/command",
    admin,
    payload(await rev(), {
      action: "create",
      collection: "projects",
      payload: {
        company: "home",
        clientId: suiteClientId,
        title: "Projet auto-chat Suite",
        address: "Lausanne",
        start: "2026-09-28",
        end: "2026-10-10",
        budget: 500,
        team: [],
        description: "Test système",
      },
    }),
  );
  assert.equal(project.status, 200, JSON.stringify(project.data));
  const projectId = project.data.result.id;
  suiteState = await call("state", suiteClient);
  const projectThread = suiteState.data.data.messageThreads.find(
    (t) => t.type === "project" && String(t.projectId) === String(projectId),
  );
  assert.ok(projectThread, "project thread should be created automatically");
  assert.ok(
    suiteState.data.data.messages.some(
      (m) =>
        String(m.threadId) === String(projectThread.id) &&
        m.system &&
        /Chantier créé/i.test(m.text),
    ),
  );

  // Typing on visible group is allowed and retention is admin-only.
  assert.equal(
    (
      await call("messaging/presence", suiteClient, {
        typingKey: groupKey,
      })
    ).status,
    200,
  );
  presence = await call("messaging/presence", admin);
  assert.ok(
    presence.data.presence.some(
      (p) =>
        String(p.userId) === String(suiteUserId) && p.typingKey === groupKey,
    ),
  );
  assert.equal((await call("messaging/retention", suiteClient)).status, 403);
  assert.equal((await call("messaging/retention", admin)).status, 200);
});
