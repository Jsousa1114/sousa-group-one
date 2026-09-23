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
