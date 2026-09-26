const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs");
const { JSDOM } = require("jsdom"),
  D = require("../domain");
const html = fs.readFileSync(require.resolve("../index.html"), "utf8"),
  script = fs.readFileSync(require.resolve("../app.js"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));
async function setup(
  role = "admin",
  empty = false,
  generatedCompanyIds = false,
  configure = () => {},
) {
  const dom = new JSDOM(html, {
      url: "http://localhost",
      runScripts: "outside-only",
    }),
    w = dom.window;
  let d = D.emptyState(),
    revision = 0;
  if (generatedCompanyIds) {
    for (const c of d.companies) {
      if (["events", "moving", "solar"].includes(c.id))
        c.id = "company-" + c.id + "-123";
    }
  }
  const profile = {
    id: 1,
    role,
    name: "Test User",
    company: role === "admin" ? "group" : "home",
    employee_id: role === "employee" ? "e1" : null,
    client_id: role === "client" ? "c1" : null,
  };
  if (!empty) {
    d.employees = [
      {
        id: "e1",
        name: "Employee",
        email: "employee@test.invalid",
        company: "home",
        vacation: 20,
      },
    ];
    d.clients = [{ id: "c1", name: "Client", company: "home" }];
    d.projects = [
      {
        id: "p1",
        title: "Project",
        clientId: "c1",
        company: "home",
        team: ["e1"],
        progress: 0,
      },
    ];
  }
  configure(d);
  const h = { dom, w, requests: [], failure: null };
  w.sessionStorage.setItem("sgo_session", "unit-test-session");
  w.setInterval = () => 0;
  w.confirm = () => true;
  w.fetch = async (url, opts = {}) => {
    h.requests.push({ url, opts });
    if (opts.method === "POST") {
      if (h.failure)
        return {
          ok: false,
          status: h.failure,
          json: async () => ({ error: "Test save failure" }),
        };
      const body = JSON.parse(opts.body);
      if (url.endsWith("/command")) {
        const out = D.applyCommand(d, profile, body);
        d = out.data;
        revision++;
        return {
          ok: true,
          json: async () => ({ ok: true, revision, result: out.result }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (url.endsWith("/users"))
      return { ok: true, json: async () => ({ users: [] }) };
    if (url.endsWith("/audit"))
      return { ok: true, json: async () => ({ rows: [] }) };
    return {
      ok: true,
      json: async () => ({
        data: D.viewState(d, profile),
        revision,
        profile,
        contacts: [{ id: 2, name: "Contact", role: "manager" }],
      }),
    };
  };
  w.eval(fs.readFileSync(require.resolve("../finance.js"), "utf8"));
  w.eval(script);
  await flush();
  h.close = () => w.close();
  return h;
}
function click(h, selector) {
  const e = h.w.document.querySelector(selector);
  assert.ok(e, "Missing " + selector);
  e.click();
}
function fill(h, name, value) {
  const e = h.w.document.querySelector(`#entityForm [name="${name}"]`);
  assert.ok(e, "Missing input " + name);
  e.value = value;
}
function submit(h) {
  h.w.document
    .getElementById("entityForm")
    .dispatchEvent(
      new h.w.Event("submit", { bubbles: true, cancelable: true }),
    );
}
test("company logos resolve generated IDs in navigation and company rows", async () => {
  const h = await setup("admin", false, true);
  try {
    const d = h.w.document;
    assert.ok(d.querySelector('.login-logo[src="/assets/logos/group.png"]'));
    click(h, '[data-page="companies"]');
    for (const id of [
      "home",
      "electricite",
      "tech",
      "moving",
      "solar",
      "events",
    ]) {
      assert.ok(
        d.querySelector(`.company-row-logo[src="/assets/logos/${id}.png"]`),
        id,
      );
      d.getElementById("companyFilter").value = [
        "events",
        "moving",
        "solar",
      ].includes(id)
        ? "company-" + id + "-123"
        : id;
      d.getElementById("companyFilter").dispatchEvent(new h.w.Event("change"));
      assert.equal(d.body.dataset.brand, id);
      click(h, '[data-action="theme"]');
      assert.equal(d.body.dataset.brand, id);
      assert.ok(
        d
          .getElementById("activeCompanyLogo")
          .src.endsWith(`/assets/logos/${id}.png`),
      );
      d.getElementById("companyFilter").value = "";
      d.getElementById("companyFilter").dispatchEvent(new h.w.Event("change"));
      assert.equal(d.body.dataset.brand, "group");
    }
    assert.equal(
      d.getElementById("activeCompanyLogo").getAttribute("src"),
      "/assets/logos/group.png",
    );
  } finally {
    h.close();
  }
});
test("quote UI preview edit issue acceptance conversion and invoice payment work together", async () => {
  const h = await setup();
  const settle = async () => {
    await flush();
    await flush();
  };
  try {
    click(h, '[data-page="quotes"]');
    click(h, '[data-action="new"]');
    fill(h, "title", "Entretien");
    fill(h, "valid", "2099-10-17");
    fill(h, "lineDescription", "Service");
    fill(h, "linePrice", "100");
    fill(h, "lineVat", "8.1");
    fill(h, "lineDiscount", "10");
    h.w.document
      .querySelector('[name="linePrice"]')
      .dispatchEvent(new h.w.Event("input", { bubbles: true }));
    assert.match(
      h.w.document.getElementById("financeTotals").textContent,
      /97[.,]29/,
    );
    submit(h);
    await settle();
    click(h, '[data-action="quote"]');
    click(h, '[data-action="finance-edit"]');
    assert.equal(h.w.document.querySelector('[name="lineVat"]').value, "8.1");
    fill(h, "title", "Entretien corrigé");
    submit(h);
    await settle();
    click(h, '[data-action="quote"]');
    click(h, '[data-action="quote.issue"]');
    await settle();
    click(h, '[data-action="quote"]');
    click(h, '[data-action="quote-decision"]');
    fill(h, "note", "Accord fictif");
    submit(h);
    await settle();
    click(h, '[data-action="quote"]');
    click(h, '[data-action="quote-convert"]');
    submit(h);
    await settle();
    click(h, '[data-page="invoices"]');
    click(h, '[data-action="invoice"]');
    assert.match(
      h.w.document.getElementById("modalBody").textContent,
      /97[.,]29/,
    );
    click(h, '[data-action="invoice.issue"]');
    await settle();
    click(h, '[data-action="invoice"]');
    click(h, '[data-action="invoice-payment"]');
    fill(h, "amount", "50");
    submit(h);
    await settle();
    assert.match(
      h.w.document.getElementById("content").textContent,
      /47[.,]29/,
    );
  } finally {
    h.close();
  }
});
test("creating a client inside a quote returns to the unsaved lines", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="quotes"]');
    click(h, '[data-action="new"]');
    fill(h, "title", "Brouillon conservé");
    fill(h, "lineDescription", "Nettoyage");
    fill(h, "linePrice", "150");
    click(h, '[data-action="finance-client"]');
    fill(h, "name", "Nouveau client");
    fill(h, "city", "Lausanne");
    fill(h, "email", "new@example.com");
    submit(h);
    await flush();
    await flush();
    assert.ok(
      h.w.document.querySelector('[name="linePrice"]'),
      h.w.document.getElementById("formError")?.textContent ||
        h.w.document.getElementById("notice").textContent,
    );
    assert.equal(h.w.document.querySelector('[name="linePrice"]').value, "150");
    assert.equal(
      h.w.document.querySelector('[name="title"]').value,
      "Brouillon conservé",
    );
    assert.equal(
      h.w.document.querySelector('[name="clientId"]').selectedOptions[0]
        .textContent,
      "Nouveau client",
    );
  } finally {
    h.close();
  }
});
test("all role navigation and empty dashboards render without errors", async () => {
  for (const role of D.ROLES) {
    const h = await setup(role, true);
    try {
      assert.equal(
        h.w.document.getElementById("app").classList.contains("hidden"),
        false,
      );
      const buttons = [...h.w.document.querySelectorAll("[data-page]")].map(
        (b) => b.dataset.page,
      );
      for (const p of buttons) {
        click(h, `[data-page="${p}"]`);
        await flush();
        assert.ok(h.w.document.getElementById("content").textContent.trim());
        assert.equal(
          h.w.document
            .getElementById("content")
            .textContent.includes("undefined"),
          false,
          role + ":" + p,
        );
      }
    } finally {
      h.close();
    }
  }
});
test("planning creation through form renders saved appointment and closes dialog", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="planning"]');
    h.w.document.getElementById("planningDate").value = "2026-09-20";
    h.w.document
      .getElementById("planningDate")
      .dispatchEvent(new h.w.Event("change"));
    click(h, '[data-action="new"]');
    fill(h, "date", "2026-09-20");
    fill(h, "start", "08:00");
    fill(h, "end", "12:00");
    fill(h, "location", "Test location");
    submit(h);
    await flush();
    await flush();
    assert.ok(
      h.w.document
        .getElementById("content")
        .textContent.includes("Test location"),
    );
    assert.equal(
      h.w.document.getElementById("modalWrap").classList.contains("hidden"),
      true,
    );
  } finally {
    h.close();
  }
});
test("weekly calendar handles year boundaries, slot creation, copy and employee read-only access", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="planning"]');
    const d = h.w.document;
    d.getElementById("planningDate").value = "2027-01-01";
    d.getElementById("planningDate").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.match(
      d.querySelector(".planning-calendar caption").textContent,
      /28.12.2026.*03.01.2027/,
    );
    click(h, '[data-action="planning-slot"][data-date="2027-01-01"]');
    assert.equal(d.getElementById("f_employeeId").value, "e1");
    assert.equal(d.getElementById("f_date").value, "2027-01-01");
    submit(h);
    await flush();
    await flush();
    assert.equal(d.querySelectorAll(".planning-shift").length, 1);
    assert.match(
      d.querySelector(".planning-shift").textContent,
      /08:00–12:00.*Project/,
    );
    assert.match(
      d.querySelector(".planning-calendar tbody th").textContent,
      /4 h/,
    );
    click(h, '[data-action="planning-detail"]');
    click(h, '[data-action="planning-copy"]');
    assert.equal(d.getElementById("f_date").value, "2027-01-02");
    submit(h);
    await flush();
    await flush();
    assert.equal(d.querySelectorAll(".planning-shift").length, 2);
    click(h, '[data-action="planning-mode"][data-id="list"]');
    assert.match(d.getElementById("content").textContent, /02.01.2027/);
    click(h, '[data-action="planning-nav"][data-id="7"]');
    assert.equal(
      d.querySelectorAll('[data-action="planning-detail"]').length,
      0,
    );
  } finally {
    h.close();
  }
  const employee = await setup("employee");
  try {
    click(employee, '[data-page="planning"]');
    assert.equal(
      employee.w.document.querySelectorAll('[data-action="planning-slot"]')
        .length,
      0,
    );
    assert.equal(
      employee.w.document.querySelectorAll(".planning-calendar tbody tr")
        .length,
      1,
    );
  } finally {
    employee.close();
  }
});
test("calendar separates employees and blocks approved absence slots", async () => {
  const h = await setup("admin", false, false, (d) => {
    d.employees.push({ id: "e2", name: "Second employee", company: "home" });
    d.absences.push({
      id: "a1",
      employeeId: "e2",
      from: "2027-01-01",
      to: "2027-01-01",
      status: "Approuvée",
      company: "home",
    });
  });
  try {
    click(h, '[data-page="planning"]');
    const d = h.w.document;
    d.getElementById("planningDate").value = "2027-01-01";
    d.getElementById("planningDate").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.equal(d.querySelectorAll(".planning-calendar tbody tr").length, 2);
    assert.equal(d.querySelectorAll(".planning-absence").length, 1);
    assert.equal(
      d.querySelectorAll('[data-employee="e2"][data-date="2027-01-01"]').length,
      0,
    );
    d.getElementById("planningEmployee").value = "e2";
    d.getElementById("planningEmployee").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.equal(d.querySelectorAll(".planning-calendar tbody tr").length, 1);
    assert.match(
      d.querySelector(".planning-calendar tbody th").textContent,
      /Second employee/,
    );
  } finally {
    h.close();
  }
});
test("HR can select multiple companies and remove employee from active screens", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="employees"]');
    click(h, '[data-action="employee-companies"]');
    h.w.document.querySelector(
      'input[name="companies"][value="moving"]',
    ).checked = true;
    submit(h);
    await flush();
    await flush();
    assert.match(
      h.w.document.getElementById("content").textContent,
      /Sousa Moving/,
    );
    h.w.document.getElementById("companyFilter").value = "moving";
    h.w.document
      .getElementById("companyFilter")
      .dispatchEvent(new h.w.Event("change"));
    assert.match(
      h.w.document.getElementById("content").textContent,
      /Employee/,
    );
    click(h, '[data-action="employee-delete"]');
    await flush();
    await flush();
    assert.equal(
      h.w.document.querySelectorAll('[data-action="employee-delete"]').length,
      0,
    );
    click(h, '[data-page="planning"]');
    assert.equal(
      h.w.document.querySelectorAll(".planning-calendar tbody tr").length,
      0,
    );
  } finally {
    h.close();
  }
});
test("manual hours can be added by an administrator without a linked employee account", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="time"]');
    click(h, '[data-action="time-add"]');
    fill(h, "date", "2026-01-15");
    fill(h, "start", "08:00");
    fill(h, "end", "12:00");
    fill(h, "break", "30");
    submit(h);
    await flush();
    await flush();
    assert.equal(
      h.w.document.getElementById("modalWrap").classList.contains("hidden"),
      true,
    );
    assert.match(h.w.document.getElementById("content").textContent, /3.50/);
    assert.match(h.w.document.getElementById("content").textContent, /Project/);
  } finally {
    h.close();
  }
});
test("HTTP errors retain form and never claim saved", async () => {
  const h = await setup();
  try {
    h.failure = 500;
    click(h, '[data-page="clients"]');
    click(h, '[data-action="new"]');
    fill(h, "name", "Unsaved client");
    submit(h);
    await flush();
    assert.equal(
      h.w.document.getElementById("modalWrap").classList.contains("hidden"),
      false,
    );
    assert.equal(
      h.w.document.querySelector("[name=name]").value,
      "Unsaved client",
    );
    assert.match(
      h.w.document.getElementById("formError").textContent,
      /failure/,
    );
    assert.notEqual(
      h.w.document.getElementById("toast").textContent,
      "Modification enregistrée.",
    );
  } finally {
    h.close();
  }
});
test("invoice displays cents and escapes user text in document", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="invoices"]');
    click(h, '[data-action="new"]');
    fill(h, "company", "home");
    fill(h, "title", "<img src=x onerror=alert(1)>");
    fill(h, "date", "2026-09-15");
    fill(h, "due", "2026-10-15");
    fill(h, "lineDescription", "<b>Literal</b>");
    fill(h, "lineQuantity", "1");
    fill(h, "linePrice", "123.45");
    submit(h);
    await flush();
    await flush();
    click(h, '[data-action="invoice"]');
    assert.equal(
      h.w.document.querySelectorAll("#modalBody img:not(.document-logo)")
        .length,
      0,
    );
    assert.equal(
      h.w.document
        .querySelector("#modalBody .document-logo")
        .getAttribute("src"),
      "/assets/logos/home.png",
    );
    assert.equal(
      h.w.document.querySelectorAll("#modalBody [onerror]").length,
      0,
    );
    assert.ok(
      h.w.document
        .getElementById("modalBody")
        .textContent.includes("<b>Literal</b>"),
    );
    assert.match(
      h.w.document.getElementById("modalBody").textContent,
      /123[.,]45/,
    );
  } finally {
    h.close();
  }
});
test("conflict preserves entered fields and offers explicit retry", async () => {
  const h = await setup();
  try {
    h.failure = 409;
    click(h, '[data-page="clients"]');
    click(h, '[data-action="new"]');
    fill(h, "name", "Preserved");
    submit(h);
    await flush();
    await flush();
    assert.equal(h.w.document.querySelector("[name=name]").value, "Preserved");
    assert.match(
      h.w.document.getElementById("formError").textContent,
      /conservé/,
    );
    assert.equal(
      h.w.document.getElementById("entityForm").dataset.requestId,
      undefined,
    );
  } finally {
    h.close();
  }
});

test("quote acceptance to completed project invoice and draft deletion are accessible", async () => {
  const h = await setup();
  const settle = async () => {
    await flush();
    await flush();
  };
  try {
    click(h, '[data-page="quotes"]');
    click(h, '[data-action="new"]');
    fill(h, "title", "Chantier complet");
    fill(h, "valid", "2099-10-17");
    fill(h, "lineDescription", "Travaux");
    fill(h, "linePrice", "250");
    submit(h);
    await settle();
    click(h, '[data-action="quote"]');
    click(h, '[data-action="quote.issue"]');
    await settle();
    click(h, '[data-action="quote"]');
    click(h, '[data-action="quote-decision"]');
    fill(h, "note", "Accord");
    submit(h);
    await settle();
    click(h, '[data-action="quote"]');
    click(h, '[data-action="quote-project"]');
    await settle();
    click(h, '[data-action="project-finish"]');
    await settle();
    assert.match(
      h.w.document.getElementById("modalBody").textContent,
      /Récapitulatif du chantier/,
    );
    assert.match(
      h.w.document.getElementById("modalBody").textContent,
      /Brouillon/,
    );
    click(h, '[data-action="finance-delete"]');
    await settle();
    assert.equal(
      h.w.document.querySelectorAll('#content [data-action="invoice"]').length,
      0,
    );
    click(h, '[data-page="quotes"]');
    click(h, '[data-action="quote"]');
    click(h, '[data-action="finance-archive"]');
    await settle();
    assert.equal(
      h.w.document.querySelectorAll('#content [data-action="quote"]').length,
      0,
    );
    click(h, '[data-action="finance-archives"]');
    assert.equal(
      h.w.document.querySelectorAll('#content [data-action="quote"]').length,
      1,
    );
  } finally {
    h.close();
  }
});

test("account form explicitly switches employee and non-employee access", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="employees"]');
    await flush();
    click(h, '[data-action="user-form"]');
    const d = h.w.document;
    assert.equal(d.getElementById("f_employeeId").disabled, true);
    fill(h, "isEmployee", "yes");
    d.getElementById("f_isEmployee").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.equal(d.getElementById("f_role").value, "employee");
    assert.equal(d.getElementById("newEmployeeFields").disabled, false);
    assert.equal(d.getElementById("f_employeeId").hidden, false);
    fill(h, "employeeId", "e1");
    fill(h, "role", "manager");
    d.getElementById("f_role").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.equal(d.getElementById("f_employeeId").value, "e1");
    fill(h, "isEmployee", "no");
    d.getElementById("f_isEmployee").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.equal(d.getElementById("f_employeeId").disabled, true);
    assert.equal(d.getElementById("f_employeeId").value, "");
    fill(h, "role", "client");
    d.getElementById("f_role").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.equal(d.getElementById("newClientFields").disabled, false);
  } finally {
    h.close();
  }
});

test("employee dossier combines personal details and account without a separate accounts menu", async () => {
  const h = await setup();
  try {
    const original = h.w.fetch;
    h.w.fetch = async (url, opts = {}) =>
      url.endsWith("/users") && (!opts.method || opts.method === "GET")
        ? {
            ok: true,
            json: async () => ({
              users: [
                {
                  id: 2,
                  name: "Employee",
                  email: "employee@test.invalid",
                  role: "employee",
                  company: "home",
                  employee_id: "e1",
                  disabled: false,
                },
                {
                  id: 3,
                  name: "External",
                  email: "outside@test.invalid",
                  role: "manager",
                  company: "home",
                },
              ],
            }),
          }
        : original(url, opts);
    click(h, '[data-page="employees"]');
    await flush();
    await flush();
    assert.equal(h.w.document.querySelector('[data-page="users"]'), null);
    assert.match(
      h.w.document.querySelector('[data-employee-account="e1"]').textContent,
      /Compte actif/,
    );
    assert.doesNotMatch(
      h.w.document.getElementById("usersList").textContent,
      /employee@test.invalid/,
    );
    assert.match(
      h.w.document.getElementById("usersList").textContent,
      /outside@test.invalid/,
    );
    click(h, '[data-action="employee-detail"]');
    await flush();
    await flush();
    const body = h.w.document.getElementById("modalBody");
    assert.match(body.textContent, /Employee/);
    assert.match(body.textContent, /employee@test.invalid/);
    assert.ok(body.querySelector('[data-action="edit-user"]'));
    assert.ok(body.querySelector('[data-action="delete-user"]'));
    click(h, '#modalBody [data-action="edit-user"]');
    assert.equal(h.w.document.getElementById("f_password").required, false);
    assert.equal(h.w.document.getElementById("f_password").value, "");
    h.w.document.querySelector(
      '[name="employeeCompanies"][value="tech"]',
    ).checked = true;
    assert.equal(
      h.w.document.getElementById("entityForm").checkValidity(),
      true,
    );
    submit(h);
    await flush();
    const update = h.requests.findLast(
      (r) => r.url.endsWith("/users") && r.opts.method === "POST",
    );
    assert.deepEqual(JSON.parse(update.opts.body).payload.employeeCompanies, [
      "home",
      "tech",
    ]);
    assert.equal(JSON.parse(update.opts.body).payload.password, "");
  } finally {
    h.close();
  }
});

test("new employee details submit together with the account and existing links hide those fields", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="employees"]');
    await flush();
    await flush();
    click(h, '[data-action="user-form"]');
    const d = h.w.document;
    fill(h, "isEmployee", "yes");
    d.getElementById("f_isEmployee").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.equal(d.getElementById("newEmployeeFields").disabled, false);
    fill(h, "employeeId", "e1");
    d.getElementById("f_employeeId").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.equal(d.getElementById("newEmployeeFields").disabled, true);
    fill(h, "employeeId", "");
    d.getElementById("f_employeeId").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    fill(h, "name", "Combined");
    fill(h, "email", "combined@test.invalid");
    fill(h, "password", "Combined-Test-Password");
    fill(h, "company", "home");
    d.getElementById("f_company").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    fill(h, "employeeJob", "Technicien");
    fill(h, "employeeSalaryPeriod", "hourly");
    d.getElementById("f_employeeSalaryPeriod").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.match(
      d.getElementById("f_employeeSalary").labels[0].textContent,
      /CHF\/heure/,
    );
    fill(h, "employeeSalary", "35.50");
    d.querySelector('[name="employeeCompanies"][value="tech"]').checked = true;
    fill(h, "employeeActivity", "80");
    fill(h, "employeeVacation", "20");
    fill(h, "employeeEntry", "2026-09-24");
    submit(h);
    await flush();
    await flush();
    const req = h.requests.find(
      (r) => r.url.endsWith("/users") && r.opts.method === "POST",
    );
    assert.ok(req);
    const p = JSON.parse(req.opts.body).payload;
    assert.equal(p.newEmployee.job, "Technicien");
    assert.equal(p.newEmployee.salary, "35.50");
    assert.equal(p.newEmployee.salaryPeriod, "hourly");
    assert.ok(p.employeeCompanies.includes("tech"));
    assert.ok(p.employeeCompanies.includes("home"));
    assert.equal(p.role, "employee");
  } finally {
    h.close();
  }
});

test("new client address submits with the account and existing client links skip creation", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="employees"]');
    await flush();
    await flush();
    click(h, '[data-action="user-form"]');
    const d = h.w.document;
    fill(h, "role", "client");
    d.getElementById("f_role").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.equal(d.getElementById("newClientFields").disabled, false);
    assert.equal(d.getElementById("newEmployeeFields").disabled, true);
    fill(h, "clientId", "c1");
    d.getElementById("f_clientId").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.equal(d.getElementById("newClientFields").disabled, true);
    fill(h, "clientId", "");
    d.getElementById("f_clientId").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    fill(h, "name", "New Client");
    fill(h, "email", "newclient@test.invalid");
    fill(h, "password", "New-Client-Password");
    fill(h, "company", "home");
    fill(h, "clientCity", "Lausanne");
    fill(h, "clientZip", "1000");
    submit(h);
    await flush();
    await flush();
    const req = h.requests.find(
      (r) => r.url.endsWith("/users") && r.opts.method === "POST",
    );
    assert.ok(req);
    const p = JSON.parse(req.opts.body).payload;
    assert.equal(p.newClient.city, "Lausanne");
    assert.equal(p.newClient.zip, "1000");
    assert.equal(p.newEmployee, undefined);
    assert.equal(p.role, "client");
  } finally {
    h.close();
  }
});

test("named id input cannot bypass submit interception in a real browser", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="employees"]');
    click(h, '[data-action="employee-companies"]');
    const form = h.w.document.getElementById("entityForm");
    const hiddenId = form.querySelector('[name="id"]');
    // jsdom does not implement Chromium's named property override for form.id.
    Object.defineProperty(form, "id", { configurable: true, value: hiddenId });
    assert.equal(form.id.tagName, "INPUT");
    form.querySelector('[name="companies"][value="tech"]').checked = true;
    const event = new h.w.Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    assert.equal(
      event.defaultPrevented,
      true,
      "must not navigate with form values in URL",
    );
    assert.equal(form.getAttribute("method"), "post");
    await flush();
    await flush();
    const request = h.requests.findLast(
      (r) => r.url.endsWith("/command") && r.opts.method === "POST",
    );
    assert.equal(JSON.parse(request.opts.body).action, "employee.companies");
    assert.deepEqual(JSON.parse(request.opts.body).payload.companies, [
      "home",
      "tech",
    ]);
    assert.match(
      h.w.document.getElementById("toast").textContent,
      /enregistrée/,
    );
    click(h, '[data-action="employee-companies"]');
    assert.equal(
      h.w.document.querySelector('[name="companies"][value="tech"]').checked,
      true,
    );
  } finally {
    h.close();
  }
});

test("standalone employee creation supports hourly salary and shows its unit", async () => {
  const h = await setup();
  try {
    click(h, '[data-page="employees"]');
    click(h, '[data-action="new"]');
    const d = h.w.document;
    assert.equal(d.getElementById("f_salaryPeriod").value, "monthly");
    fill(h, "salaryPeriod", "hourly");
    d.getElementById("f_salaryPeriod").dispatchEvent(
      new h.w.Event("change", { bubbles: true }),
    );
    assert.match(
      d.getElementById("f_salary").labels[0].textContent,
      /CHF\/heure/,
    );
    assert.equal(d.getElementById("f_salary").required, true);
    for (const [k, v] of Object.entries({
      name: "Hourly employee",
      job: "Technicien",
      company: "home",
      email: "hourly@test.invalid",
      salary: "35.50",
      entry: "2026-09-26",
    }))
      fill(h, k, v);
    submit(h);
    await flush();
    await flush();
    await flush();
    assert.match(d.getElementById("modalBody").textContent, /Salaire horaire/);
    assert.match(
      d.getElementById("modalBody").textContent,
      /35\.50\sCHF \/ heure/,
    );
  } finally {
    h.close();
  }
});

test("employee dossier edits profile and assigns tools from the same screen", async () => {
  const h = await setup("admin", false, false, (d) => {
    Object.assign(d.employees[0], {
      job: "Tech",
      salary: 5000,
      activity: 100,
      entry: "2026-01-01",
    });
    d.tools = [{ id: "t1", name: "Drill", serial: "ABC", company: "home" }];
    d.vehicles = [
      {
        id: "v1",
        plate: "VD 123",
        brand: "Van",
        model: "One",
        company: "home",
        km: 100,
      },
    ];
  });
  try {
    click(h, '[data-page="employees"]');
    click(h, '[data-action="employee-detail"]');
    await flush();
    await flush();
    click(h, '[data-action="employee-edit"]');
    fill(h, "nationality", "Portugaise");
    fill(h, "residencePermit", "C");
    fill(h, "city", "Nyon");
    fill(h, "street", "Rue 1");
    fill(h, "phone", "+41 00 000 00 00");
    assert.equal(h.w.document.getElementById("f_birthDate").value, "");
    submit(h);
    await flush();
    await flush();
    await flush();
    assert.match(
      h.w.document.getElementById("modalBody").textContent,
      /Rue 1, Nyon/,
    );
    assert.match(
      h.w.document.getElementById("modalBody").textContent,
      /Portugaise/,
    );
    click(h, '[data-action="employee-document"]');
    assert.equal(h.w.document.querySelector('[name="employeeId"]').value, "e1");
    assert.equal(
      h.w.document.querySelector('[name="category"]').value,
      "identity",
    );
    assert.match(
      h.w.document.querySelector('[name="documentType"]').textContent,
      /Permis de séjour/,
    );
    click(h, '[data-action="close-modal"]');
    click(h, '[data-action="employee-detail"]');
    await flush();
    await flush();
    click(h, '[data-action="employee-assets"]');
    h.w.document.querySelector('[name="tools"]').checked = true;
    h.w.document.querySelector('[name="vehicles"]').checked = true;
    submit(h);
    await flush();
    await flush();
    await flush();
    assert.match(h.w.document.getElementById("modalBody").textContent, /Drill/);
    assert.match(
      h.w.document.getElementById("modalBody").textContent,
      /VD 123/,
    );
  } finally {
    h.close();
  }
});

test("client edit is prefilled and saves contact changes from the list", async () => {
  const h = await setup("admin", false, false, (d) => {
    Object.assign(d.clients[0], {
      email: "contact@test.invalid",
      city: "Nyon",
    });
  });
  try {
    click(h, '[data-page="clients"]');
    click(h, '[data-action="client-edit"]');
    assert.equal(h.w.document.getElementById("f_city").value, "Nyon");
    fill(h, "city", "Lausanne");
    submit(h);
    await flush();
    await flush();
    assert.match(h.w.document.body.textContent, /Lausanne/);
  } finally {
    h.close();
  }
});
