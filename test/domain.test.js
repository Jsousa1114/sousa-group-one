const test = require("node:test"),
  assert = require("node:assert/strict");
const D = require("../domain");
const admin = {
  id: 1,
  role: "admin",
  company: "group",
  email: "admin@test.invalid",
};
const employee = {
  id: 2,
  role: "employee",
  company: "home",
  employee_id: "e1",
};
const client = { id: 3, role: "client", company: "home", client_id: "c1" };
function fixture() {
  const d = D.emptyState();
  d.employees = [
    { id: "e1", name: "Employee", salary: 5000, vacation: 20, company: "home" },
  ];
  d.clients = [
    { id: "c1", name: "Client 1", company: "home" },
    { id: "c2", name: "Client 2", company: "home" },
  ];
  d.projects = [
    {
      id: "p1",
      title: "Project 1",
      company: "home",
      clientId: "c1",
      team: ["e1"],
      hours: 0,
      cost: 0,
      budget: 1000,
    },
    {
      id: "p2",
      title: "Other client",
      company: "home",
      clientId: "c2",
      team: [],
    },
  ];
  return d;
}
test("manual hours deduct pause, update project totals and prevent duplicate or unauthorized entries", () => {
  const d = fixture(),
    now = "2026-09-16T18:00:00Z";
  const p = {
    employeeId: "e1",
    project: "p1",
    date: "2026-09-15",
    start: "08:00",
    end: "12:00",
    break: 30,
  };
  const r = command(d, admin, "time.add", p, undefined, now).result;
  assert.equal(r.hours, 3.5);
  assert.equal(r.startedAt, "2026-09-15T06:00:00.000Z");
  assert.equal(r.status, "À valider");
  assert.equal(d.projects[0].hours, 3.5);
  assert.throws(() => command(d, admin, "time.add", p, undefined, now), /déjà/);
  assert.throws(
    () =>
      command(
        fixture(),
        employee,
        "time.add",
        { ...p, employeeId: "someone-else" },
        undefined,
        now,
      ),
    /uniquement vos/,
  );
  assert.throws(
    () =>
      command(
        fixture(),
        employee,
        "time.add",
        { ...p, project: "p2" },
        undefined,
        now,
      ),
    /non autorisée/,
  );
  assert.throws(
    () => command(fixture(), client, "time.add", p, undefined, now),
    /non autorisée/,
  );
  assert.throws(
    () =>
      command(
        fixture(),
        admin,
        "time.add",
        { ...p, break: 240 },
        undefined,
        now,
      ),
    /pause/,
  );
  assert.throws(
    () =>
      command(
        fixture(),
        admin,
        "time.add",
        { ...p, date: "2027-01-01" },
        undefined,
        now,
      ),
    /futur/,
  );
  const winter = command(
    fixture(),
    employee,
    "time.add",
    { ...p, date: "2026-01-15" },
    undefined,
    now,
  ).result;
  assert.equal(winter.startedAt, "2026-01-15T07:00:00.000Z");
  assert.throws(
    () =>
      command(
        fixture(),
        admin,
        "time.add",
        { ...p, date: "2026-03-29", start: "02:30", end: "04:00" },
        undefined,
        now,
      ),
    /inexistant/,
  );
});
test("employee multi-company access preserves project permissions and global conflict checks", () => {
  let d = fixture();
  d.projects.push({ id: "pm", title: "Moving", company: "moving", team: [] });
  d.projects.push({
    id: "pt",
    title: "Tech private",
    company: "tech",
    team: ["e1"],
  });
  d = command(d, admin, "employee.companies", {
    id: "e1",
    companies: ["home", "moving"],
  }).data;
  assert.deepEqual(
    D.viewState(d, employee)
      .companies.map((c) => c.id)
      .sort(),
    ["home", "moving"],
  );
  assert.equal(
    D.viewState(d, employee).projects.some((p) => p.id === "pm"),
    false,
  );
  d = command(
    d,
    admin,
    "create",
    {
      employeeId: "e1",
      project: "pm",
      date: "2026-09-15",
      start: "08:00",
      end: "12:00",
    },
    "planning",
  ).data;
  assert.ok(D.viewState(d, employee).projects.some((p) => p.id === "pm"));
  assert.equal(
    D.viewState(d, employee).projects.some((p) => p.id === "pt"),
    false,
  );
  assert.throws(
    () =>
      command(
        d,
        admin,
        "create",
        {
          employeeId: "e1",
          project: "p1",
          date: "2026-09-15",
          start: "10:00",
          end: "13:00",
        },
        "planning",
      ),
    /déjà une affectation/,
  );
  assert.throws(
    () =>
      command(d, employee, "employee.companies", {
        id: "e1",
        companies: ["home", "tech"],
      }),
    /Accès RH/,
  );
  assert.throws(
    () =>
      command(
        d,
        { ...admin, role: "hr", company: "home" },
        "employee.companies",
        { id: "e1", companies: ["home", "moving"] },
      ),
    /Accès RH/,
  );
  assert.throws(
    () =>
      command(d, admin, "employee.companies", {
        id: "e1",
        companies: ["home", "group"],
      }),
    /non autorisée/,
  );
  assert.throws(
    () =>
      command(d, admin, "employee.companies", {
        id: "e1",
        companies: ["home"],
      }),
    /affectations futures/,
  );
  d = command(
    d,
    admin,
    "employee.companies",
    { id: "e1", companies: ["home"] },
    undefined,
    "2026-09-16T08:00:00Z",
  ).data;
  assert.equal(
    D.viewState(d, employee).projects.some((p) => p.id === "pm"),
    false,
  );
  assert.throws(
    () => command(d, employee, "clock.start", { project: "pm" }),
    /non autorisé/,
  );
});
test("employee removal preserves history and rejects active clocks and future assignments", () => {
  let d = fixture();
  d.time.push({ id: "t1", employeeId: "e1", project: "p1", hours: 4 });
  d.planning.push(
    { id: "past", employeeId: "e1", project: "p1", date: "2026-09-14" },
    { id: "future", employeeId: "e1", project: "p1", date: "2026-09-16" },
  );
  d.clocks.push({ employeeId: "e1", userId: 2 });
  assert.throws(
    () => command(d, admin, "employee.delete", { id: "e1" }),
    /pointage/,
  );
  d.clocks = [];
  d = command(d, admin, "employee.delete", { id: "e1" }).data;
  assert.ok(d.employees[0].deletedAt);
  assert.equal(d.time.length, 1);
  assert.deepEqual(
    d.planning.map((p) => p.id),
    ["past"],
  );
  assert.throws(() => D.viewState(d, employee), /désactivé/);
  assert.throws(
    () =>
      command(
        d,
        admin,
        "create",
        {
          employeeId: "e1",
          project: "p1",
          date: "2026-09-16",
          start: "08:00",
          end: "12:00",
        },
        "planning",
      ),
    /non autorisée/,
  );
});
function command(
  d,
  u,
  action,
  payload,
  collection,
  now = "2026-09-15T08:00:00Z",
) {
  return D.applyCommand(d, u, { action, payload, collection }, now);
}
test("client cannot create or access salaries / another client project", () => {
  const d = fixture(),
    v = D.viewState(d, client);
  assert.equal(v.employees.length, 0);
  assert.deepEqual(
    v.projects.map((p) => p.id),
    ["p1"],
  );
  assert.equal(v.projects[0].budget, undefined);
  assert.throws(
    () => command(d, client, "create", {}, "employees"),
    /autorisée/,
  );
});
test("employee cannot see another employee time or unrestricted client data", () => {
  const d = fixture();
  d.time = [
    { id: "t1", employeeId: "e1" },
    { id: "t2", employeeId: "e2" },
  ];
  const v = D.viewState(d, employee);
  assert.equal(v.time.length, 1);
  assert.equal(v.clients[0].email, undefined);
  assert.equal(v.projects.length, 1);
});
test("clock start pause resume stop computes hours and project total", () => {
  const d = fixture();
  command(
    d,
    employee,
    "clock.start",
    { project: "p1" },
    null,
    "2026-09-15T08:00:00Z",
  );
  assert.throws(
    () => command(d, employee, "clock.start", { project: "p1" }),
    /déjà/,
  );
  command(d, employee, "clock.pause", {}, null, "2026-09-15T10:00:00Z");
  command(d, employee, "clock.resume", {}, null, "2026-09-15T10:30:00Z");
  const out = command(
    d,
    employee,
    "clock.stop",
    {},
    null,
    "2026-09-15T12:00:00Z",
  );
  assert.equal(out.data.time[0].hours, 3.5);
  assert.equal(out.data.time[0].break, 30);
  assert.equal(out.data.clocks.length, 0);
  assert.equal(out.data.projects[0].hours, 3.5);
});
test("clock cannot target unauthorized project", () =>
  assert.throws(
    () => command(fixture(), employee, "clock.start", { project: "p2" }),
    /autorisé/,
  ));
test("planning saves and rejects overlap", () => {
  const d = fixture(),
    p = {
      employeeId: "e1",
      project: "p1",
      date: "2026-09-16",
      start: "08:00",
      end: "12:00",
    };
  command(d, admin, "create", p, "planning");
  assert.equal(d.planning.length, 1);
  assert.throws(() => command(d, admin, "create", p, "planning"), /déjà/);
  assert.throws(
    () =>
      command(
        d,
        admin,
        "create",
        { ...p, date: "2026-09-17", end: "07:00" },
        "planning",
      ),
    /suivre/,
  );
});
test("invoice cents and full payment reconcile atomically", () => {
  const d = fixture();
  const inv = command(
    d,
    admin,
    "create",
    {
      company: "home",
      clientId: "c1",
      title: "Work",
      date: "2026-09-15",
      due: "2026-10-15",
      lines: [{ description: "Service", quantity: 1.5, unitPrice: 82.3 }],
    },
    "invoices",
  ).result;
  assert.equal(inv.amount, 123.45);
  command(d, admin, "invoice.issue", { id: inv.id });
  command(
    d,
    admin,
    "create",
    { invoice: inv.id, amount: 23.45, date: "2026-09-15", method: "Virement" },
    "payments",
  );
  assert.equal(inv.paid, 23.45);
  assert.equal(inv.status, "Partiellement payée");
  command(
    d,
    admin,
    "create",
    { invoice: inv.id, amount: 100, date: "2026-09-15", method: "Virement" },
    "payments",
  );
  assert.equal(inv.paid, 123.45);
  assert.equal(inv.status, "Payée");
  assert.throws(
    () =>
      command(
        d,
        admin,
        "create",
        { invoice: inv.id, amount: 1, date: "2026-09-15", method: "Virement" },
        "payments",
      ),
    /dépasse/,
  );
});
test("invalid money / invoice rejected", () => {
  for (const v of [-1, 0, "", NaN, "abc", 1.001])
    assert.throws(() => D.cents(v));
  assert.throws(() =>
    command(fixture(), admin, "create", { amount: -100 }, "invoices"),
  );
  assert.throws(() => D.iso("2026-02-30"));
});
test("approved leave deducts weekdays once and blocks duplicate decision", () => {
  const d = fixture();
  const a = command(d, employee, "absence.request", {
    type: "Vacances",
    from: "2026-09-18",
    to: "2026-09-21",
  }).result;
  assert.equal(a.days, 2);
  command(d, admin, "absence.decide", { id: a.id, status: "Approuvée" });
  assert.equal(d.employees[0].vacation, 18);
  assert.throws(() =>
    command(d, admin, "absence.decide", { id: a.id, status: "Approuvée" }),
  );
  assert.equal(d.employees[0].vacation, 18);
});
test("employee cannot decide absences or impersonate request owner", () => {
  const d = fixture();
  const a = command(d, employee, "absence.request", {
    employeeId: "someoneelse",
    type: "Vacances",
    from: "2026-09-16",
    to: "2026-09-16",
  }).result;
  assert.equal(a.employeeId, "e1");
  assert.throws(
    () =>
      command(d, employee, "absence.decide", { id: a.id, status: "Approuvée" }),
    /refusé/,
  );
});
test("new clients are linked by actual ID not hardcoded ID", () => {
  const d = fixture();
  d.projects[0].clientId = "new-client";
  assert.equal(
    D.viewState(d, { ...client, client_id: "new-client" }).projects[0].id,
    "p1",
  );
  assert.equal(
    D.viewState(d, { ...client, client_id: "missing" }).projects.length,
    0,
  );
});
test("messages are visible only to participants", () => {
  const d = fixture();
  d.messages = [
    { id: "a", senderId: 1, recipientId: 3 },
    { id: "b", senderId: 1, recipientId: 2 },
  ];
  assert.deepEqual(
    D.viewState(d, client).messages.map((x) => x.id),
    ["a"],
  );
  assert.equal(
    D.canContact(client, { id: 2, role: "client", company: "home" }),
    false,
  );
});
test("HR cannot create invoices; manager cannot read salaries", () => {
  const d = fixture();
  assert.throws(() =>
    command(d, { ...admin, role: "hr" }, "create", {}, "invoices"),
  );
  assert.equal(
    D.viewState(d, { ...admin, role: "manager", company: "home" }).employees[0]
      .salary,
    undefined,
  );
});
test("expenses update actual project costs", () => {
  const d = fixture();
  command(
    d,
    admin,
    "create",
    {
      company: "home",
      project: "p1",
      supplier: "Supplier",
      amount: 21.75,
      date: "2026-09-15",
    },
    "expenses",
  );
  assert.equal(d.projects[0].cost, 21.75);
});
test("quote acceptance requires correct client and unexpired issued quote", () => {
  const d = fixture();
  const q = command(
    d,
    admin,
    "create",
    {
      company: "home",
      clientId: "c1",
      title: "Work",
      date: "2026-09-15",
      valid: "2026-10-15",
      lines: [{ description: "Service", quantity: 1, unitPrice: 100 }],
    },
    "quotes",
  ).result;
  assert.throws(() => command(d, client, "quote.accept", { id: q.id }));
  command(d, admin, "quote.issue", { id: q.id });
  assert.throws(() =>
    command(d, { ...client, client_id: "c2" }, "quote.accept", { id: q.id }),
  );
  command(d, client, "quote.accept", { id: q.id });
  assert.equal(q.status, "Accepté");
  assert.equal(q.acceptedBy, 3);
});
test("project documents stay private unless explicitly shared with the client", () => {
  const d = fixture();
  d.documents = [
    { id: "private", project: "p1", company: "home", visibility: "team" },
    { id: "shared", project: "p1", company: "home", visibility: "client" },
  ];
  assert.deepEqual(
    D.viewState(d, client).documents.map((x) => x.id),
    ["shared"],
  );
  assert.equal(D.viewState(d, employee).documents.length, 2);
});

test("adding company access works during a clock but removing its company is blocked", () => {
  const d = fixture();
  d.clocks.push({
    employeeId: "e1",
    project: "p1",
    startedAt: "2026-09-24T09:00:00Z",
  });
  D.applyCommand(d, admin, {
    action: "employee.companies",
    payload: { id: "e1", companies: ["home", "tech"] },
  });
  assert.deepEqual(d.employees[0].companies, ["home", "tech"]);
  d.projects.push({
    id: "tech1",
    company: "tech",
    team: ["e1"],
    clientId: "c1",
  });
  d.clocks[0].project = "tech1";
  assert.throws(
    () =>
      D.applyCommand(d, admin, {
        action: "employee.companies",
        payload: { id: "e1", companies: ["home"] },
      }),
    /pointage/,
  );
  assert.deepEqual(d.employees[0].companies, ["home", "tech"]);
});

test("linked staff roles use employee companies without gaining new role permissions", () => {
  const d = fixture();
  d.employees[0].companies = ["home", "tech"];
  d.projects.push({ id: "pt", title: "Tech", company: "tech", team: [] });
  d.projects.push({ id: "pm", title: "Moving", company: "moving", team: [] });
  for (const role of [
    "admin",
    "direction",
    "manager",
    "hr",
    "accounting",
    "employee",
  ]) {
    const u = { ...employee, role };
    const effective = D.effectiveUser(d, u);
    assert.deepEqual(
      D.viewState(d, u)
        .companies.map((c) => c.id)
        .sort(),
      ["home", "tech"],
      role,
    );
    assert.equal(D.inCompany(effective, "moving"), false);
    assert.equal(D.inCompany(effective, "group"), false);
    assert.equal(
      D.canProject(
        d,
        effective,
        d.projects.find((p) => p.id === "pt"),
      ),
      ["admin", "direction", "manager", "accounting"].includes(role),
    );
    d.employees[0].companies = ["home"];
    assert.equal(
      D.inCompany(D.effectiveUser(d, effective), "tech"),
      false,
      "revokes stale memberships",
    );
    d.employees[0].companies = ["home", "tech"];
  }
  assert.equal(
    D.inCompany(D.effectiveUser(d, { ...admin, employee_id: "e1" }), "moving"),
    true,
  );
  assert.equal(
    D.inCompany(
      D.effectiveUser(d, { role: "manager", company: "home" }),
      "tech",
    ),
    false,
  );
  assert.equal(
    D.canContact(
      { role: "employee", company: "tech", companies: ["tech"] },
      { ...employee, role: "manager" },
      d,
    ),
    true,
  );
  d.employees[0].deletedAt = new Date().toISOString();
  assert.throws(
    () => D.effectiveUser(d, { ...employee, role: "manager" }),
    /désactivé/,
  );
});

test("employee salary period defaults to monthly and validates hourly amounts", () => {
  const p = {
    name: "Salary test",
    job: "Technicien",
    company: "home",
    email: "salary@test.invalid",
    phone: "",
    salary: "35.50",
    activity: 100,
    vacation: 20,
    entry: "2026-09-26",
  };
  const create = (extra = {}) =>
    command(fixture(), admin, "create", { ...p, ...extra }, "employees");
  assert.equal(create().result.salaryPeriod, "monthly");
  assert.equal(
    create({ salaryPeriod: "hourly" }).result.salaryPeriod,
    "hourly",
  );
  assert.equal(create({ salaryPeriod: "hourly" }).result.salary, 35.5);
  assert.throws(() => create({ salaryPeriod: "weekly" }), /Type de salaire/);
  assert.throws(() => create({ salary: "" }), /Renseignez le salaire/);
  assert.throws(() => create({ salary: -1 }), /./);
});

test("employee profile edits preserve identity, scope and account linkage", () => {
  const d = fixture();
  Object.assign(d.employees[0], {
    job: "Tech",
    email: "before@test.invalid",
    activity: 100,
    entry: "2026-01-01",
  });
  const photo =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const r = command(d, admin, "employee.update", {
    id: "e1",
    name: "Updated",
    email: "new@test.invalid",
    street: "Rue 1",
    city: "Nyon",
    photo,
    nationality: "Portugaise",
    residencePermit: "C",
    residencePermitExpiry: "2029-01-01",
    notes: "Private",
    company: "moving",
    companies: ["moving"],
  }).result;
  assert.equal(r.company, "home");
  assert.equal(r.name, "Updated");
  assert.equal(r.photo, photo);
  assert.equal(r.nationality, "Portugaise");
  assert.equal(r.residencePermit, "C");
  assert.equal(r.residencePermitExpiry, "2029-01-01");
  assert.equal(r.companies, undefined);
  assert.throws(
    () => command(d, employee, "employee.update", { id: "e1", name: "Self" }),
    /Accès RH/,
  );
  assert.throws(
    () =>
      command(d, { ...admin, role: "manager" }, "employee.update", {
        id: "e1",
      }),
    /Accès RH/,
  );
  const view = D.viewState(d, { ...admin, role: "manager", company: "home" })
    .employees[0];
  assert.equal(view.street, undefined);
  assert.equal(view.notes, undefined);
  assert.throws(
    () =>
      command(d, admin, "employee.update", {
        id: "e1",
        photo: "https://tracking.invalid/photo.png",
      }),
    /Photo invalide/,
  );
  assert.throws(
    () =>
      command(d, admin, "employee.update", {
        id: "e1",
        photo: "data:image/png;base64,PHN2Zz4=",
      }),
    /Format/,
  );
  assert.equal(
    command(d, admin, "employee.update", { id: "e1", photo: "" }).result.photo,
    "",
  );
});

test("employee equipment assignments validate scope, exclusivity, history and returns", () => {
  let d = fixture();
  d.employees[0].companies = ["home", "tech"];
  d.employees.push({ id: "e2", company: "home", name: "Other" });
  d.tools = [
    { id: "t1", company: "home", name: "Drill", serial: "S1" },
    { id: "t2", company: "home", employeeId: "e2" },
    { id: "t3", company: "moving" },
  ];
  d.vehicles = [{ id: "v1", company: "tech", plate: "VD 123" }];
  d = command(d, admin, "employee.assets", {
    id: "e1",
    tools: ["t1"],
    vehicles: ["v1"],
  }).data;
  assert.equal(d.tools[0].employeeId, "e1");
  assert.equal(d.vehicles[0].employeeId, "e1");
  assert.equal(D.viewState(d, employee).vehicles.length, 1);
  assert.equal(
    D.viewState(d, employee).tools.some((t) => t.id === "t2"),
    false,
  );
  assert.throws(
    () =>
      command(d, admin, "employee.assets", {
        id: "e1",
        tools: ["t2"],
        vehicles: [],
      }),
    /déjà attribué/,
  );
  assert.throws(
    () =>
      command(d, admin, "employee.assets", {
        id: "e1",
        tools: ["t3"],
        vehicles: [],
      }),
    /non autorisée/,
  );
  assert.throws(
    () =>
      command(d, admin, "employee.companies", {
        id: "e1",
        companies: ["home"],
      }),
    /Restituez/,
  );
  assert.throws(
    () => command(d, admin, "employee.delete", { id: "e1" }),
    /Restituez/,
  );
  d = command(d, admin, "employee.assets", {
    id: "e1",
    tools: [],
    vehicles: [],
  }).data;
  assert.equal(d.tools[0].employeeId, "");
  assert.equal(d.tools[0].assignmentHistory.length, 2);
});

test("identity documents are restricted to HR in employee companies", () => {
  const d = fixture();
  d.employees[0].nationality = "Portugaise";
  d.documents = [
    {
      id: "identity1",
      employeeId: "e1",
      company: "home",
      category: "identity",
      visibility: "hr",
    },
  ];
  assert.equal(D.viewState(d, admin).documents.length, 1);
  assert.equal(D.viewState(d, employee).documents.length, 0);
  assert.equal(
    D.viewState(d, { ...admin, role: "manager" }).documents.length,
    0,
  );
  assert.equal(
    D.viewState(d, { ...admin, role: "manager" }).employees[0].nationality,
    undefined,
  );
  assert.equal(
    D.viewState(d, { ...admin, role: "hr", company: "moving" }).documents
      .length,
    0,
  );
  assert.equal(
    D.viewState(d, { ...admin, role: "hr", company: "home" }).documents.length,
    1,
  );
});

test("project deletion respects roles, company boundaries and linked records", () => {
  const d = fixture();
  const result = command(d, admin, "project.delete", { id: "p1" });
  assert.equal(
    result.data.projects.some((p) => p.id === "p1"),
    false,
  );
  for (const user of [
    employee,
    client,
    { ...admin, role: "hr" },
    { ...admin, role: "manager", company: "moving" },
  ])
    assert.throws(
      () => command(fixture(), user, "project.delete", { id: "p1" }),
      /non autorisée/,
    );
  for (const kind of [
    "time",
    "clocks",
    "planning",
    "documents",
    "quotes",
    "invoices",
    "expenses",
  ]) {
    const state = fixture();
    state[kind].push({ id: "linked", project: "p1" });
    assert.throws(
      () => command(state, admin, "project.delete", { id: "p1" }),
      /données liées/,
    );
    assert.equal(
      state.projects.some((p) => p.id === "p1"),
      true,
    );
  }
});

test("client deletion protects linked records and company access", () => {
  const unlinked = () => {
    const d = fixture();
    d.projects = [];
    return d;
  };
  assert.equal(
    command(unlinked(), admin, "client.delete", { id: "c2" }).data.clients.some(
      (c) => c.id === "c2",
    ),
    false,
  );
  for (const u of [
    employee,
    client,
    { ...admin, role: "hr" },
    { ...admin, company: "moving" },
  ])
    assert.throws(
      () => command(unlinked(), u, "client.delete", { id: "c2" }),
      /non autorisée/,
    );
  for (const kind of [
    "projects",
    "quotes",
    "invoices",
    "documents",
    "payments",
  ]) {
    const d = unlinked();
    d[kind].push({ id: "linked", clientId: "c2" });
    assert.throws(
      () => command(d, admin, "client.delete", { id: "c2" }),
      /liés/,
    );
  }
});

test("record deletion updates payments, project costs/hours and vacation balances", () => {
  const d = fixture();
  d.invoices = [
    {
      id: "i1",
      company: "home",
      clientId: "c1",
      amount: 100,
      paid: 50,
      status: "Partiellement payée",
    },
  ];
  d.payments = [{ id: "pay", company: "home", invoice: "i1", amount: 50 }];
  let out = command(d, admin, "record.delete", {
    kind: "payments",
    id: "pay",
  }).data;
  assert.equal(out.invoices[0].paid, 0);
  assert.equal(out.invoices[0].status, "Émise");
  d.projects[0].cost = 30;
  d.expenses = [{ id: "ex", company: "home", project: "p1", amount: 20 }];
  out = command(d, admin, "record.delete", { kind: "expenses", id: "ex" }).data;
  assert.equal(out.projects[0].cost, 10);
  d.time = [
    {
      id: "t1",
      project: "p1",
      employeeId: "e1",
      hours: 2,
      status: "À valider",
    },
    { id: "t2", project: "p1", employeeId: "e1", hours: 3, status: "Validé" },
  ];
  out = command(d, employee, "record.delete", { kind: "time", id: "t1" }).data;
  assert.equal(out.projects[0].hours, 3);
  assert.throws(
    () => command(d, employee, "record.delete", { kind: "time", id: "t2" }),
    /non validées/,
  );
  d.absences = [
    {
      id: "a",
      employeeId: "e1",
      status: "Approuvée",
      type: "Vacances",
      days: 2,
    },
  ];
  out = command(d, admin, "record.delete", { kind: "absences", id: "a" }).data;
  assert.equal(out.employees[0].vacation, 22);
});
test("record deletion isolates companies, attachments, and message participants", () => {
  const d = fixture();
  d.tools = [{ id: "tool", company: "home", employeeId: "e1" }];
  assert.throws(
    () => command(d, admin, "record.delete", { kind: "tools", id: "tool" }),
    /attribution/,
  );
  d.inventory = [{ id: "stock", company: "moving" }];
  assert.throws(
    () =>
      command(d, { ...admin, company: "home" }, "record.delete", {
        kind: "inventory",
        id: "stock",
      }),
    /Accès refusé/,
  );
  assert.throws(
    () => command(d, admin, "record.delete", { kind: "projects", id: "p1" }),
    /non autorisée/,
  );
  assert.throws(
    () => command(d, admin, "record.delete", { kind: "companies", id: "home" }),
    /données liées/,
  );
  d.messages = [
    { id: "m", senderId: admin.id, recipientId: employee.id, text: "hello" },
  ];
  const out = command(d, employee, "record.delete", {
    kind: "messages",
    id: "m",
  }).data;
  assert.equal(D.viewState(out, employee).messages.length, 0);
  assert.equal(D.viewState(out, admin).messages.length, 1);
  assert.throws(
    () => command(d, client, "record.delete", { kind: "messages", id: "m" }),
    /Accès refusé/,
  );
  d.documents = [
    { id: "doc", employeeId: "e1", company: "home", uploadedBy: admin.id },
  ];
  assert.throws(
    () =>
      command(d, employee, "record.delete", { kind: "documents", id: "doc" }),
    /Seul l’auteur/,
  );
  assert.equal(
    command(d, admin, "record.delete", { kind: "documents", id: "doc" }).data
      .documents.length,
    0,
  );
});
