const test = require("node:test"),
  assert = require("node:assert/strict"),
  bcrypt = require("bcryptjs");
const { database } = require("./database"),
  { migrate } = require("../db"),
  { createApp } = require("../server"),
  { emptyState } = require("../domain");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";
delete process.env.AI_API_URL;
delete process.env.AI_API_KEY;
delete process.env.AI_TRANSCRIBE_API_URL;

let db, server, url, admin, client;

const day = (offset = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function call(path, token, body) {
  const response = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    data: await response.json().catch(() => ({})),
  };
}

test.before(async () => {
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, employeeId, clientId, company] of [
    ["p3-admin@test.invalid", "admin", null, null, "group"],
    ["p3-client@test.invalid", "client", null, "c1", "home"],
  ])
    await db.query(
      "INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [email, hash, role, role, "", company, employeeId, clientId],
    );

  const state = emptyState();
  state.clients = [
    {
      id: "c1",
      name: "Client P3",
      company: "home",
      email: "client-p3@example.com",
      city: "Lausanne",
    },
  ];
  state.employees = [
    {
      id: "e1",
      name: "Alex Electricien",
      job: "Electricien",
      salary: 5000,
      vacation: 20,
      company: "home",
      activity: 100,
      weeklyHours: 40,
      status: "Actif",
    },
    {
      id: "e2",
      name: "Sam Electricien",
      job: "Electricien photovoltaïque",
      salary: 5000,
      vacation: 20,
      company: "home",
      activity: 100,
      weeklyHours: 40,
      status: "Actif",
    },
  ];
  state.projects = [
    {
      id: "p1",
      company: "home",
      clientId: "c1",
      team: ["e1"],
      title: "Rénovation électrique",
      description: "Remplacement du tableau et des prises électriques",
      status: "En cours",
      progress: 20,
      budget: 1000,
      cost: 1250,
      start: day(-10),
      end: day(1),
    },
  ];
  state.invoices = [
    {
      id: "F-P3-1",
      company: "home",
      clientId: "c1",
      project: "p1",
      title: "Facture test",
      amount: 1000,
      paid: 100,
      due: day(-10),
      status: "Partiellement payée",
    },
  ];
  state.inventory = [
    {
      id: "mat1",
      company: "home",
      sku: "TEST-1",
      name: "Disjoncteur test",
      stock: 1,
      min: 2,
      unit: "pcs",
      buy: 10,
      sell: 20,
    },
  ];
  state.time = [
    {
      id: "time-p3",
      employeeId: "e1",
      company: "home",
      project: "p1",
      date: day(-1),
      hours: 12,
      status: "Validé",
    },
  ];
  state.planning = [
    {
      id: "planning-e1",
      employeeId: "e1",
      company: "home",
      project: "p1",
      date: day(3),
      start: "08:00",
      end: "17:00",
      location: "Lausanne",
    },
  ];
  state.absences = [
    {
      id: "absence-e1",
      employeeId: "e1",
      type: "Vacances",
      from: day(4),
      to: day(4),
      days: 1,
      status: "Approuvée",
    },
  ];

  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [
    JSON.stringify(state),
  ]);

  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = "http://127.0.0.1:" + server.address().port;

  admin = (
    await call("auth/login", null, {
      email: "p3-admin@test.invalid",
      password: "A-Strong-Test-Password",
    })
  ).data.token;
  client = (
    await call("auth/login", null, {
      email: "p3-client@test.invalid",
      password: "A-Strong-Test-Password",
    })
  ).data.token;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.end();
});

test("P3 status exposes the complete feature set and blocks clients", async () => {
  const status = await call("operations/p3/status", admin);
  assert.equal(status.status, 200, JSON.stringify(status.data));
  assert.deepEqual(status.data.features, {
    assistant: true,
    quoteDraft: true,
    supplierInvoiceOcr: true,
    materialOcr: true,
    voiceToText: true,
    dailySummary: true,
    anomalyDetection: true,
    workloadForecast: true,
    assistedPlanning: true,
  });
  assert.equal(status.data.providerConfigured, false);
  assert.equal((await call("operations/p3/status", client)).status, 403);
});

test("P3 local assistant works without an external AI provider", async () => {
  const result = await call("operations/p3/assistant", admin, {
    question: "Quelles factures sont en retard ?",
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.mode, "local");
  assert.match(result.data.answer, /facture/i);
  assert.match(result.data.answer, /900\.00 CHF/);
});

test("P3 workload forecast calculates employee capacity and planned hours", async () => {
  const result = await call("operations/p3/workload?weeks=4", admin);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.weeks.length, 4);
  const employee = result.data.employees.find((row) => row.employeeId === "e1");
  assert.ok(employee);
  assert.equal(employee.totalCapacity, 160);
  assert.ok(employee.totalPlanned >= 9);
});

test("P3 anomalies detect budget, invoices, stock and unusual hours", async () => {
  const result = await call("operations/p3/anomalies", admin);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const types = new Set(result.data.anomalies.map((row) => row.type));
  assert.ok(types.has("project.over_budget"));
  assert.ok(types.has("invoice.overdue"));
  assert.ok(types.has("inventory.low"));
  assert.ok(types.has("time.long_day"));
});

test("P3 planning suggestions exclude absent employees and propose an available match", async () => {
  const result = await call("operations/p3/planning-suggestions", admin, {
    projectId: "p1",
    date: day(4),
    start: "08:00",
    end: "17:00",
    limit: 5,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.data.suggestions.some((row) => row.employeeId === "e2"));
  assert.ok(!result.data.suggestions.some((row) => row.employeeId === "e1"));
});

test("P3 quote assistant creates a safe draft and never invents prices locally", async () => {
  const result = await call("operations/p3/quote-draft", admin, {
    company: "home",
    clientId: "c1",
    projectId: "p1",
    title: "Travaux complémentaires",
    brief: "Ajouter deux prises et remplacer un interrupteur.",
    vatRate: 8.1,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.mode, "local");
  assert.equal(result.data.draft.pricingRequired, true);
  assert.ok(result.data.draft.lines.length >= 1);
  assert.ok(result.data.draft.lines.every((line) => line.unitPrice === 0));
  assert.equal(
    (await call("operations/p3/quote-draft", client, {
      company: "home",
      clientId: "c1",
      brief: "Test",
    })).status,
    403,
  );
});

test("P3 OCR and server transcription report missing provider configuration cleanly", async () => {
  const image =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const ocr = await call("operations/p3/ocr", admin, {
    mode: "supplier_invoice",
    imageDataUrl: image,
  });
  assert.equal(ocr.status, 503);
  assert.match(ocr.data.error, /IA/i);

  const transcribe = await call("operations/p3/transcribe", admin, {
    audioDataUrl: "data:audio/webm;base64,AAAA",
  });
  assert.equal(transcribe.status, 503);
  assert.match(transcribe.data.error, /transcription/i);
});

test("P3 browser module is publicly served with the application shell", async () => {
  const response = await fetch(url + "/p3-center.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /javascript|text\/plain/);
  assert.match(await response.text(), /SGOP3Center/);
});
