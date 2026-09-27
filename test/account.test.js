"use strict";
process.env.JWT_SECRET = "account-center-test-secret-2026-long-enough-value";
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const { emptyState } = require("../domain");
const { codeAt } = require("../account-security");

let db, server, url;
const PASSWORD = "Account-Center-Test-Password-2026";

async function call(path, token, body) {
  const r = await fetch(url + "/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = r.headers.get("content-type") || "";
  const data = type.includes("application/json")
    ? await r.json()
    : await r.text();
  return { status: r.status, data, headers: r.headers };
}
async function login(totpCode = "") {
  return call("auth/login", null, {
    email: "employee-account@test.invalid",
    password: PASSWORD,
    totpCode,
  });
}

test.before(async () => {
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash(PASSWORD, 4);
  await db.query(
    "INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      "employee-account@test.invalid",
      hash,
      "employee",
      "Employee Account",
      "",
      "home",
      "e1",
    ],
  );
  const d = emptyState();
  d.employees = [
    {
      id: "e1",
      name: "Employee Account",
      job: "Technicien",
      email: "employee-account@test.invalid",
      phone: "+41 00 000 00 00",
      salary: 5000,
      salaryPeriod: "monthly",
      activity: 100,
      vacation: 20,
      entry: "2026-01-01",
      company: "home",
      companies: ["home", "tech"],
      nationality: "Suisse",
      residencePermit: "",
      residencePermitExpiry: "",
    },
  ];
  d.projects = [
    {
      id: "p1",
      title: "Projet compte",
      company: "home",
      clientId: "c1",
      team: ["e1"],
      status: "En cours",
      progress: 40,
    },
  ];
  d.clients = [{ id: "c1", name: "Client", company: "home" }];
  d.time = [
    {
      id: "t1",
      employeeId: "e1",
      project: "p1",
      date: new Date().toISOString().slice(0, 7) + "-10",
      hours: 7.5,
    },
  ];
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.end();
});

test("account center exposes own profile, professional data and a tracked current session", async () => {
  const signed = await login();
  assert.equal(signed.status, 200);
  const token = signed.data.token;
  const summary = await call("account/summary", token);
  assert.equal(summary.status, 200);
  assert.equal(summary.data.account.email, "employee-account@test.invalid");
  assert.equal(summary.data.employee.job, "Technicien");
  assert.equal(summary.data.professional.monthHours, 7.5);
  assert.equal(summary.data.professional.activeProjects, 1);
  assert.equal(summary.data.security.sessions.length, 1);
  assert.equal(summary.data.security.sessions[0].current, true);
  assert.equal(summary.data.preferences.privacy.readReceipts, true);
});

test("employee can update only own contact profile and preferences", async () => {
  const token = (await login()).data.token;
  const updated = await call("account/profile", token, {
    phone: "+41 79 111 22 33",
    street: "Rue du Test 1",
    zip: "1000",
    city: "Lausanne",
    country: "CH",
    emergencyName: "Contact Test",
    emergencyPhone: "+41 79 999 88 77",
  });
  assert.equal(updated.status, 200);
  const prefs = await call("account/preferences", token, {
    preferences: {
      language: "fr",
      theme: "dark",
      defaultCompany: "home",
      defaultPage: "settings",
      dateFormat: "CH",
      textSize: "large",
      notifications: {
        messages: true,
        groups: false,
        calls: true,
        projects: true,
        planning: true,
        absences: true,
        finance: false,
        push: true,
        sound: false,
        vibration: true,
      },
      privacy: {
        lastSeen: false,
        online: false,
        readReceipts: false,
      },
    },
  });
  assert.equal(prefs.status, 200);
  assert.equal(prefs.data.preferences.textSize, "large");
  assert.equal(prefs.data.preferences.privacy.online, false);
  const summary = await call("account/summary", token);
  assert.equal(summary.data.employee.city, "Lausanne");
  assert.equal(summary.data.employee.phone, "+41 79 111 22 33");
});

test("TOTP two-factor authentication can be enabled and is required on later logins", async () => {
  const token = (await login()).data.token;
  const setup = await call("account/2fa/setup", token, {
    currentPassword: PASSWORD,
  });
  assert.equal(setup.status, 200);
  assert.match(setup.data.secret, /^[A-Z2-7]+$/);
  const code = codeAt(setup.data.secret, Math.floor(Date.now() / 30000));
  const enabled = await call("account/2fa/enable", token, { code });
  assert.equal(enabled.status, 200);

  const missing = await login();
  assert.equal(missing.status, 401);
  assert.equal(missing.data.code, "TOTP_REQUIRED");

  const accepted = await login(
    codeAt(setup.data.secret, Math.floor(Date.now() / 30000)),
  );
  assert.equal(accepted.status, 200);
  assert.ok(accepted.data.token);
});

test("session controls revoke other devices without invalidating the current one", async () => {
  const user = (
    await db.query("SELECT totp_secret FROM users WHERE email=$1", [
      "employee-account@test.invalid",
    ])
  ).rows[0];
  const code = () => codeAt(user.totp_secret, Math.floor(Date.now() / 30000));
  const first = (await login(code())).data.token;
  const second = (await login(code())).data.token;
  const summary = await call("account/summary", second);
  assert.ok(summary.data.security.sessions.length >= 2);

  const closed = await call("account/sessions/logout-others", second, {});
  assert.equal(closed.status, 200);
  assert.equal((await call("account/summary", second)).status, 200);
  assert.equal((await call("account/summary", first)).status, 401);
});

test("personal data export and deactivation request are available", async () => {
  const user = (
    await db.query("SELECT totp_secret FROM users WHERE email=$1", [
      "employee-account@test.invalid",
    ])
  ).rows[0];
  const token = (
    await login(codeAt(user.totp_secret, Math.floor(Date.now() / 30000)))
  ).data.token;
  const exported = await call("account/export", token);
  assert.equal(exported.status, 200);
  const parsed =
    typeof exported.data === "string"
      ? JSON.parse(exported.data)
      : exported.data;
  assert.equal(parsed.account.email, "employee-account@test.invalid");
  assert.equal(parsed.employee.id, "e1");

  const request = await call("account/deactivation-request", token, {
    reason: "Test de demande",
  });
  assert.equal(request.status, 200);
  const summary = await call("account/summary", token);
  assert.equal(summary.data.pendingDeactivation.status, "pending");
});
