"use strict";
const express = require("express");
const { randomUUID, createHmac } = require("node:crypto");
const dns = require("node:dns").promises;
const net = require("node:net");
const D = require("./domain");
const { auth } = require("./auth-middleware");

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const clean = (value, max = 500, optional = false) => {
  if (optional && (value == null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    D.fail("Texte invalide.");
  return value.trim();
};
const money = (value, min = 0, max = 1e9) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) D.fail("Montant invalide.");
  return Math.round(n * 100) / 100;
};
const oneOf = (value, allowed, label = "Valeur") => {
  if (!allowed.includes(value)) D.fail(label + " invalide.");
  return value;
};
const isoDate = (value, optional = true) => {
  if (optional && !value) return null;
  return D.iso(String(value));
};
const companyAllowed = (user, company) =>
  !!company && company !== "group" && D.inCompany(user, company);
const pageLimit = (value, fallback = 50, max = 200) => {
  const n = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};
const encodeCursor = (row) => {
  const createdAt = new Date(row.created_at);
  if (!Number.isFinite(createdAt.getTime())) D.fail("Date de pagination invalide.");
  return Buffer.from(
    createdAt.toISOString() + "|" + String(row.id),
    "utf8",
  ).toString("base64url");
};
const decodeCursor = (value) => {
  if (!value) return null;
  try {
    const raw = Buffer.from(String(value), "base64url").toString("utf8"),
      split = raw.lastIndexOf("|"),
      createdAt = raw.slice(0, split),
      id = raw.slice(split + 1);
    if (
      split < 1 ||
      !id ||
      !Number.isFinite(Date.parse(createdAt))
    )
      D.fail("Curseur de pagination invalide.");
    return { createdAt, id };
  } catch (error) {
    if (error?.status) throw error;
    D.fail("Curseur de pagination invalide.");
  }
};


async function stateContext(db, user) {
  const row = (await db.query("SELECT data,revision FROM app_state WHERE id=1"))
    .rows[0];
  const data = D.normalize(row?.data);
  return { data, view: D.viewState(data, user), revision: row?.revision || 0 };
}
function visibleProject(ctx, id) {
  const p = ctx.view.projects.find((x) => D.same(x.id, id));
  if (!p) D.fail("Chantier inaccessible.", 403);
  return p;
}
function fullProject(ctx, id) {
  visibleProject(ctx, id);
  return D.ref(ctx.data, "projects", id);
}
function canOperateProject(ctx, user, id) {
  const p = fullProject(ctx, id);
  if (
    D.privileged(user, [...D.OPS, "accounting"]) ||
    (user.role === "employee" &&
      (p.team || []).some((x) => D.same(x, user.employee_id)))
  )
    return p;
  D.fail("Modification chantier non autorisée.", 403);
}
function companyScopeSql(user, column = "company") {
  const companies = (user.companies || [user.company]).filter(
    (x) => x && x !== "group",
  );
  if (user.company === "group" && D.privileged(user, [...D.STAFF, "hr"]))
    return { sql: "TRUE", params: [] };
  return {
    sql: `${column}=ANY($1::text[])`,
    params: [companies],
  };
}
function isPrivateIp(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v = address.toLowerCase();
  return (
    v === "::1" ||
    v.startsWith("fc") ||
    v.startsWith("fd") ||
    v.startsWith("fe80:")
  );
}
async function safeWebhookUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    D.fail("URL webhook invalide.");
  }
  if (url.protocol !== "https:") D.fail("Le webhook doit utiliser HTTPS.");
  if (
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  )
    D.fail("Destination webhook interdite.");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((x) => isPrivateIp(x.address)))
    D.fail("Destination webhook privée interdite.");
  return url.toString();
}
function conditionsMatch(conditions, event) {
  if (!conditions || typeof conditions !== "object") return true;
  return Object.entries(conditions).every(([key, expected]) => {
    const actual =
      key === "company"
        ? event.company
        : key === "projectId"
          ? event.projectId
          : event.payload?.[key];
    return Array.isArray(expected)
      ? expected.map(String).includes(String(actual))
      : String(actual ?? "") === String(expected ?? "");
  });
}
async function projectParticipantUsers(db, ctx, project) {
  const employeeIds = (project.team || []).map(String);
  const clientId = project.clientId ? String(project.clientId) : "";
  const rows = (
    await db.query(
      `SELECT id,employee_id,client_id,role,company FROM users
       WHERE deleted_at IS NULL AND disabled=false`,
    )
  ).rows;
  return rows
    .filter(
      (u) =>
        (u.employee_id && employeeIds.includes(String(u.employee_id))) ||
        (u.client_id && clientId && String(u.client_id) === clientId) ||
        (["admin", "direction", "manager"].includes(u.role) &&
          (u.company === "group" || u.company === project.company)),
    )
    .map((u) => Number(u.id));
}
async function insertNotification(db, userIds, payload) {
  const ids = [...new Set((userIds || []).map(Number).filter(Number.isFinite))];
  for (const userId of ids)
    await db.query(
      `INSERT INTO user_notifications
       (id,user_id,category,title,body,url,entity_type,entity_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        randomUUID(),
        userId,
        String(payload.category || "system").slice(0, 60),
        String(payload.title || "Sousa Group One").slice(0, 200),
        String(payload.body || "").slice(0, 1000),
        String(payload.url || "").slice(0, 1000),
        payload.entityType ? String(payload.entityType).slice(0, 80) : null,
        payload.entityId ? String(payload.entityId).slice(0, 200) : null,
      ],
    );
}
async function deliverWebhook(db, hook, event) {
  const url = await safeWebhookUrl(hook.url);
  const body = JSON.stringify({
    id: event.id,
    type: event.eventType,
    createdAt: event.createdAt,
    company: event.company || null,
    projectId: event.projectId || null,
    entity: event.entityType
      ? { type: event.entityType, id: event.entityId || null }
      : null,
    data: event.payload || {},
  });
  const signature = createHmac("sha256", hook.secret).update(body).digest("hex");
  let statusCode = null,
    success = false,
    error = "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Sousa-Group-One-Webhook/1.0",
        "X-SGO-Event": event.eventType,
        "X-SGO-Signature": "sha256=" + signature,
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    clearTimeout(timeout);
    statusCode = response.status;
    success = response.ok;
    if (!success) error = "HTTP " + response.status;
  } catch (e) {
    error = String(e?.message || e).slice(0, 500);
  }
  await db.query(
    `INSERT INTO webhook_deliveries
     (webhook_id,event_type,status_code,success,error)
     VALUES($1,$2,$3,$4,$5)`,
    [hook.id, event.eventType, statusCode, success, error || null],
  );
  return { success, statusCode, error };
}
async function executeAutomation(db, rule, event, ctx) {
  if (!conditionsMatch(rule.conditions, event)) return;
  const actions = Array.isArray(rule.actions) ? rule.actions : [];
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    if (action.type === "notify") {
      let recipients = [];
      if (event.projectId) {
        const p = ctx.data.projects.find((x) => D.same(x.id, event.projectId));
        if (p) recipients = await projectParticipantUsers(db, ctx, p);
      }
      if (Array.isArray(action.userIds))
        recipients.push(...action.userIds.map(Number));
      await insertNotification(db, recipients, {
        category: action.category || "automation",
        title: action.title || rule.name,
        body: action.body || event.eventType,
        url: event.projectId ? "/?open=projects" : "/?open=pilotage",
        entityType: event.entityType,
        entityId: event.entityId,
      });
    } else if (action.type === "create_task" && event.projectId) {
      const p = ctx.data.projects.find((x) => D.same(x.id, event.projectId));
      if (p)
        await db.query(
          `INSERT INTO project_tasks
           (id,project_id,company,title,description,status,priority,created_by)
           VALUES($1,$2,$3,$4,$5,'todo',$6,$7)`,
          [
            randomUUID(),
            String(p.id),
            p.company,
            String(action.title || rule.name).slice(0, 200),
            String(action.description || event.eventType).slice(0, 2000),
            ["low", "normal", "high", "urgent"].includes(action.priority)
              ? action.priority
              : "normal",
            event.actorUserId || rule.created_by,
          ],
        );
    }
  }
}
async function emitEvent(db, input) {
  const event = {
    id: randomUUID(),
    eventType: String(input.eventType || "event").slice(0, 120),
    actorUserId: input.actorUserId ? Number(input.actorUserId) : null,
    company: input.company ? String(input.company).slice(0, 80) : null,
    projectId: input.projectId ? String(input.projectId).slice(0, 200) : null,
    entityType: input.entityType ? String(input.entityType).slice(0, 80) : null,
    entityId: input.entityId ? String(input.entityId).slice(0, 200) : null,
    payload: input.payload && typeof input.payload === "object" ? input.payload : {},
    createdAt: new Date().toISOString(),
  };
  await db.query(
    `INSERT INTO app_events
     (event_type,actor_user_id,company,project_id,entity_type,entity_id,payload,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      event.eventType,
      event.actorUserId,
      event.company,
      event.projectId,
      event.entityType,
      event.entityId,
      event.payload,
      event.createdAt,
    ],
  );
  const stateRow = (await db.query("SELECT data FROM app_state WHERE id=1")).rows[0];
  const fakeUser = input.user || {
    id: event.actorUserId,
    role: "admin",
    company: event.company || "group",
    companies: event.company ? [event.company] : [],
  };
  let ctx;
  try {
    ctx = {
      data: D.normalize(stateRow?.data),
      view: D.viewState(stateRow?.data || {}, fakeUser),
    };
  } catch {
    ctx = { data: D.normalize(stateRow?.data), view: D.emptyState() };
  }
  const rules = (
    await db.query(
      `SELECT * FROM automation_rules
       WHERE enabled=true AND event_type=$1
       AND (company IS NULL OR company=$2)`,
      [event.eventType, event.company],
    )
  ).rows;
  for (const rule of rules)
    await executeAutomation(db, rule, event, ctx).catch(() => {});
  const hooks = (
    await db.query(
      `SELECT * FROM outgoing_webhooks
       WHERE enabled=true
       AND (company IS NULL OR company=$1)
       AND ($2=ANY(event_types) OR '*'=ANY(event_types))`,
      [event.company, event.eventType],
    )
  ).rows;
  for (const hook of hooks)
    deliverWebhook(db, hook, event).catch(() => {});
  return event;
}
function routes(db) {
  const r = express.Router();
  r.use(auth(db));

  r.get(
    "/overview",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user);
      const taskProjects = new Set(ctx.view.projects.map((p) => String(p.id)));
      const taskRows = (
        await db.query(
          `SELECT * FROM project_tasks ORDER BY
           CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           due_date NULLS LAST,position,created_at`,
        )
      ).rows.filter((t) => taskProjects.has(String(t.project_id)));
      const scope = companyScopeSql(req.user);
      const crmRows = D.privileged(req.user, [...D.OPS, "accounting"])
        ? (
            await db.query(
              `SELECT stage,COUNT(*)::int AS count,COALESCE(SUM(value),0)::float8 AS value
               FROM crm_opportunities WHERE ${scope.sql} GROUP BY stage`,
              scope.params,
            )
          ).rows
        : [];
      const unread = Number(
        (
          await db.query(
            "SELECT COUNT(*)::int AS n FROM user_notifications WHERE user_id=$1 AND read_at IS NULL",
            [req.user.id],
          )
        ).rows[0]?.n || 0,
      );
      res.json({
        unreadNotifications: unread,
        tasks: {
          total: taskRows.length,
          todo: taskRows.filter((x) => x.status === "todo").length,
          inProgress: taskRows.filter((x) => x.status === "in_progress").length,
          blocked: taskRows.filter((x) => x.status === "blocked").length,
          done: taskRows.filter((x) => x.status === "done").length,
          urgent: taskRows.filter((x) => x.priority === "urgent" && x.status !== "done").length,
        },
        crm: crmRows,
      });
    }),
  );

  r.get(
    "/search",
    wrap(async (req, res) => {
      const q = String(req.query.q || "").trim().toLowerCase();
      if (q.length < 2) return res.json({ results: [] });
      const ctx = await stateContext(db, req.user);
      const results = [];
      const add = (type, id, title, subtitle, page, extra = {}) => {
        const hay = [id, title, subtitle, extra.search]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (hay.includes(q))
          results.push({
            type,
            id: String(id),
            title: String(title || id),
            subtitle: String(subtitle || ""),
            page,
            ...extra,
          });
      };
      for (const p of ctx.view.projects)
        add("project", p.id, p.title, p.status, "projects", {
          company: p.company,
          clientId: p.clientId,
        });
      for (const c of ctx.view.clients)
        add("client", c.id, c.name, c.email || c.phone || "", "clients", {
          search: [c.city, c.street, c.email, c.phone].join(" "),
        });
      for (const e of ctx.view.employees)
        add("employee", e.id, e.name, e.job || "", "employees", {
          search: [e.email, e.phone].join(" "),
        });
      for (const x of ctx.view.quotes)
        add("quote", x.id, x.title || x.id, x.status, "quotes", {
          search: [x.clientId, x.message].join(" "),
        });
      for (const x of ctx.view.invoices)
        add("invoice", x.id, x.title || x.id, x.status, "invoices", {
          search: [x.clientId, x.message].join(" "),
        });
      for (const x of ctx.view.documents)
        add("document", x.id, x.name || "Document", x.category || "", "documents", {
          search: [x.project, x.clientId, x.employeeId].join(" "),
        });
      for (const x of ctx.view.inventory)
        add("inventory", x.id, x.name, x.sku || "", "inventory");
      for (const x of ctx.view.maintenance)
        add("maintenance", x.id, x.title, x.frequency || "", "maintenance");
      for (const x of ctx.view.messages || []) {
        if (x.text)
          add(
            "message",
            x.id,
            x.sender || "Message",
            String(x.text).slice(0, 140),
            "messages",
            { threadId: x.threadId || "", senderId: x.senderId },
          );
      }
      if (D.privileged(req.user, [...D.OPS, "accounting"])) {
        const scope = companyScopeSql(req.user);
        const queryParam = "$" + (scope.params.length + 1),
          crm = (
            await db.query(
              `SELECT * FROM crm_opportunities WHERE ${scope.sql}
               AND (LOWER(name) LIKE ${queryParam} OR LOWER(COALESCE(notes,'')) LIKE ${queryParam})
               ORDER BY updated_at DESC LIMIT 30`,
              [...scope.params, "%" + q.replace(/[%_]/g, "") + "%"],
            )
          ).rows;
        for (const x of crm)
          add("crm", x.id, x.name, x.stage, "pilotage", { company: x.company });
      }
      res.json({ results: results.slice(0, 80) });
    }),
  );

  r.get(
    "/notifications",
    wrap(async (req, res) => {
      const limit = pageLimit(req.query.limit, 50, 100),
        cursor = decodeCursor(req.query.cursor),
        params = [req.user.id],
        where = ["user_id=$1"];
      if (cursor) {
        params.push(cursor.createdAt, cursor.id);
        where.push(
          `(created_at,id) < ($${params.length - 1}::timestamptz,$${params.length}::text)`,
        );
      }
      params.push(limit + 1);
      const rows = (
          await db.query(
            `SELECT id,category,title,body,url,entity_type,entity_id,read_at,created_at
             FROM user_notifications
             WHERE ${where.join(" AND ")}
             ORDER BY created_at DESC,id DESC
             LIMIT $${params.length}`,
            params,
          )
        ).rows,
        hasMore = rows.length > limit,
        page = rows.slice(0, limit);
      res.json({
        notifications: page,
        nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
      });
    }),
  );
  r.post(
    "/notifications/read",
    wrap(async (req, res) => {
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map(String).slice(0, 200)
        : [];
      if (req.body?.all)
        await db.query(
          "UPDATE user_notifications SET read_at=COALESCE(read_at,NOW()) WHERE user_id=$1",
          [req.user.id],
        );
      else if (ids.length)
        await db.query(
          `UPDATE user_notifications SET read_at=COALESCE(read_at,NOW())
           WHERE user_id=$1 AND id=ANY($2::text[])`,
          [req.user.id, ids],
        );
      res.json({ ok: true });
    }),
  );

  r.get(
    "/tasks",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user);
      const projects = new Set(ctx.view.projects.map((p) => String(p.id)));
      let rows = (await db.query("SELECT * FROM project_tasks ORDER BY position,due_date NULLS LAST,created_at")).rows;
      rows = rows.filter((x) => projects.has(String(x.project_id)));
      if (req.query.projectId)
        rows = rows.filter((x) => D.same(x.project_id, req.query.projectId));
      res.json({ tasks: rows });
    }),
  );
  r.post(
    "/tasks",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user),
        p = req.body || {},
        project = canOperateProject(ctx, req.user, p.projectId),
        id = p.id ? String(p.id) : randomUUID(),
        status = oneOf(
          p.status || "todo",
          ["todo", "in_progress", "blocked", "done"],
          "Statut",
        ),
        priority = oneOf(
          p.priority || "normal",
          ["low", "normal", "high", "urgent"],
          "Priorité",
        );
      const existing = (
        await db.query("SELECT id,created_by FROM project_tasks WHERE id=$1", [id])
      ).rows[0];
      if (existing)
        await db.query(
          `UPDATE project_tasks SET title=$1,description=$2,status=$3,priority=$4,
           assigned_employee_id=$5,due_date=$6,position=$7,updated_at=NOW()
           WHERE id=$8`,
          [
            clean(p.title, 200),
            clean(p.description, 3000, true) || null,
            status,
            priority,
            p.assignedEmployeeId ? String(p.assignedEmployeeId) : null,
            isoDate(p.dueDate),
            Number.isInteger(Number(p.position)) ? Number(p.position) : 0,
            id,
          ],
        );
      else
        await db.query(
          `INSERT INTO project_tasks
           (id,project_id,company,title,description,status,priority,assigned_employee_id,due_date,position,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            String(project.id),
            project.company,
            clean(p.title, 200),
            clean(p.description, 3000, true) || null,
            status,
            priority,
            p.assignedEmployeeId ? String(p.assignedEmployeeId) : null,
            isoDate(p.dueDate),
            Number.isInteger(Number(p.position)) ? Number(p.position) : 0,
            req.user.id,
          ],
        );
      await emitEvent(db, {
        eventType: existing ? "task.updated" : "task.created",
        actorUserId: req.user.id,
        user: req.user,
        company: project.company,
        projectId: project.id,
        entityType: "task",
        entityId: id,
        payload: { title: p.title, status, priority },
      });
      res.json({ ok: true, id });
    }),
  );
  r.post(
    "/tasks/delete",
    wrap(async (req, res) => {
      const row = (
        await db.query("SELECT * FROM project_tasks WHERE id=$1", [req.body?.id])
      ).rows[0];
      if (!row) D.fail("Tâche introuvable.", 404);
      const ctx = await stateContext(db, req.user);
      canOperateProject(ctx, req.user, row.project_id);
      await db.query("DELETE FROM project_tasks WHERE id=$1", [row.id]);
      res.json({ ok: true });
    }),
  );

  r.get(
    "/project/:id/ops",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user);
      visibleProject(ctx, req.params.id);
      const pid = String(req.params.id);
      const [tasks, checklist, reports, punch, changes, workOrders] =
        await Promise.all([
          db.query("SELECT * FROM project_tasks WHERE project_id=$1 ORDER BY position,created_at", [pid]),
          db.query("SELECT * FROM project_checklist_items WHERE project_id=$1 ORDER BY created_at", [pid]),
          db.query("SELECT * FROM project_daily_reports WHERE project_id=$1 ORDER BY report_date DESC,created_at DESC", [pid]),
          db.query("SELECT * FROM project_punch_items WHERE project_id=$1 ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,due_date NULLS LAST,created_at", [pid]),
          db.query("SELECT * FROM project_change_orders WHERE project_id=$1 ORDER BY created_at DESC", [pid]),
          db.query("SELECT * FROM work_orders WHERE project_id=$1 ORDER BY scheduled_at NULLS LAST,created_at DESC", [pid]),
        ]);
      res.json({
        tasks: tasks.rows,
        checklist: checklist.rows,
        reports: reports.rows,
        punch: punch.rows,
        changeOrders: changes.rows,
        workOrders: workOrders.rows,
      });
    }),
  );

  r.get(
    "/project/:id/daily-summary",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user),
        project = canOperateProject(ctx, req.user, req.params.id),
        reportDate = req.query.date
          ? isoDate(req.query.date, false)
          : new Intl.DateTimeFormat("sv-SE", {
              timeZone: "Europe/Zurich",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(new Date()),
        projectId = String(project.id),
        times = ctx.view.time.filter(
          (t) => D.same(t.project, projectId) && t.date === reportDate,
        ),
        totalHours =
          Math.round(
            times.reduce((sum, row) => sum + (Number(row.hours) || 0), 0) *
              100,
          ) / 100,
        byEmployee = new Map();
      for (const row of times) {
        const id = String(row.employeeId || "");
        byEmployee.set(id, (byEmployee.get(id) || 0) + (Number(row.hours) || 0));
      }
      const [tasks, reports, punch, changes] = await Promise.all([
        db.query(
          "SELECT status,COUNT(*)::int AS n FROM project_tasks WHERE project_id=$1 GROUP BY status",
          [projectId],
        ),
        db.query(
          "SELECT summary,issues,materials,team,weather FROM project_daily_reports WHERE project_id=$1 AND report_date=$2 ORDER BY created_at",
          [projectId, reportDate],
        ),
        db.query(
          "SELECT severity,COUNT(*)::int AS n FROM project_punch_items WHERE project_id=$1 AND status<>'resolved' GROUP BY severity",
          [projectId],
        ),
        db.query(
          "SELECT status,COUNT(*)::int AS n,COALESCE(SUM(amount),0)::float8 AS amount FROM project_change_orders WHERE project_id=$1 GROUP BY status",
          [projectId],
        ),
      ]);
      const taskCounts = Object.fromEntries(
          tasks.rows.map((row) => [row.status, Number(row.n) || 0]),
        ),
        punchCounts = Object.fromEntries(
          punch.rows.map((row) => [row.severity, Number(row.n) || 0]),
        ),
        changeCounts = Object.fromEntries(
          changes.rows.map((row) => [
            row.status,
            { count: Number(row.n) || 0, amount: Number(row.amount) || 0 },
          ]),
        ),
        team = [...byEmployee.entries()].map(([employeeId, hours]) => ({
          employeeId,
          name:
            ctx.view.employees.find((e) => D.same(e.id, employeeId))?.name ||
            employeeId ||
            "Salarié",
          hours: Math.round(hours * 100) / 100,
        })),
        reportSummaries = reports.rows
          .map((row) => row.summary)
          .filter(Boolean),
        issues = reports.rows.map((row) => row.issues).filter(Boolean),
        materials = reports.rows.map((row) => row.materials).filter(Boolean),
        openPunch = Object.values(punchCounts).reduce(
          (sum, value) => sum + Number(value || 0),
          0,
        ),
        pendingChanges = ["draft", "sent"].reduce(
          (sum, status) => sum + Number(changeCounts[status]?.count || 0),
          0,
        ),
        lines = [
          `Résumé automatique — ${project.title || project.id} — ${reportDate}`,
          totalHours
            ? `Heures enregistrées : ${totalHours.toFixed(2)} h pour ${team.length} salarié(s).`
            : "Aucune heure enregistrée pour cette date.",
          team.length
            ? "Équipe : " +
              team.map((row) => `${row.name} (${row.hours.toFixed(2)} h)`).join(", ") +
              "."
            : "",
          `Kanban actuel : ${taskCounts.todo || 0} à faire, ${taskCounts.in_progress || 0} en cours, ${taskCounts.blocked || 0} bloquée(s), ${taskCounts.done || 0} terminée(s).`,
          `Réserves ouvertes : ${openPunch}.`,
          `Plus-values en préparation ou attente : ${pendingChanges}.`,
          reportSummaries.length
            ? "Rapport terrain : " + reportSummaries.join(" | ")
            : "",
          issues.length ? "Points signalés : " + issues.join(" | ") : "",
          materials.length ? "Matériel : " + materials.join(" | ") : "",
        ].filter(Boolean);
      res.json({
        project: {
          id: project.id,
          title: project.title,
          company: project.company,
          status: project.status,
        },
        date: reportDate,
        totalHours,
        team,
        taskCounts,
        punchCounts,
        changeCounts,
        reports: reports.rows,
        summary: lines.join("\n"),
      });
    }),
  );

  r.post(
    "/project/:id/checklist",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user),
        project = canOperateProject(ctx, req.user, req.params.id),
        p = req.body || {},
        id = p.id ? String(p.id) : randomUUID();
      const existing = (
        await db.query("SELECT * FROM project_checklist_items WHERE id=$1", [id])
      ).rows[0];
      if (existing) {
        const completed =
          typeof p.completed === "boolean" ? p.completed : existing.completed;
        await db.query(
          `UPDATE project_checklist_items SET label=$1,completed=$2,
           completed_by=CASE WHEN $2 THEN $3 ELSE NULL END,
           completed_at=CASE WHEN $2 THEN NOW() ELSE NULL END WHERE id=$4`,
          [clean(p.label || existing.label, 300), completed, req.user.id, id],
        );
      } else
        await db.query(
          `INSERT INTO project_checklist_items(id,project_id,company,label,completed,completed_by,completed_at,created_by)
           VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5 THEN NOW() ELSE NULL END,$7)`,
          [
            id,
            String(project.id),
            project.company,
            clean(p.label, 300),
            !!p.completed,
            p.completed ? req.user.id : null,
            req.user.id,
          ],
        );
      res.json({ ok: true, id });
    }),
  );

  r.post(
    "/project/:id/report",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user),
        project = canOperateProject(ctx, req.user, req.params.id),
        p = req.body || {},
        id = p.id ? String(p.id) : randomUUID(),
        reportDate = isoDate(p.reportDate, false);
      await db.query(
        `INSERT INTO project_daily_reports
         (id,project_id,company,report_date,weather,summary,issues,materials,team,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(project_id,report_date,created_by) DO UPDATE SET
         weather=EXCLUDED.weather,summary=EXCLUDED.summary,issues=EXCLUDED.issues,
         materials=EXCLUDED.materials,team=EXCLUDED.team,updated_at=NOW()`,
        [
          id,
          String(project.id),
          project.company,
          reportDate,
          clean(p.weather, 200, true) || null,
          clean(p.summary, 5000),
          clean(p.issues, 5000, true) || null,
          clean(p.materials, 5000, true) || null,
          clean(p.team, 2000, true) || null,
          req.user.id,
        ],
      );
      await emitEvent(db, {
        eventType: "project.daily_report",
        actorUserId: req.user.id,
        user: req.user,
        company: project.company,
        projectId: project.id,
        entityType: "daily_report",
        entityId: id,
        payload: { reportDate },
      });
      res.json({ ok: true, id });
    }),
  );

  r.post(
    "/project/:id/punch",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user),
        project = canOperateProject(ctx, req.user, req.params.id),
        p = req.body || {},
        id = p.id ? String(p.id) : randomUUID(),
        status = oneOf(p.status || "open", ["open", "in_progress", "resolved"], "Statut"),
        severity = oneOf(p.severity || "normal", ["low", "normal", "high", "critical"], "Sévérité");
      const existing = (
        await db.query("SELECT id FROM project_punch_items WHERE id=$1", [id])
      ).rows[0];
      if (existing)
        await db.query(
          `UPDATE project_punch_items SET title=$1,description=$2,status=$3,severity=$4,
           assigned_employee_id=$5,due_date=$6,
           resolved_at=CASE WHEN $3='resolved' THEN COALESCE(resolved_at,NOW()) ELSE NULL END
           WHERE id=$7`,
          [
            clean(p.title, 200),
            clean(p.description, 3000, true) || null,
            status,
            severity,
            p.assignedEmployeeId ? String(p.assignedEmployeeId) : null,
            isoDate(p.dueDate),
            id,
          ],
        );
      else
        await db.query(
          `INSERT INTO project_punch_items
           (id,project_id,company,title,description,status,severity,assigned_employee_id,due_date,resolved_at,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $6='resolved' THEN NOW() ELSE NULL END,$10)`,
          [
            id,
            String(project.id),
            project.company,
            clean(p.title, 200),
            clean(p.description, 3000, true) || null,
            status,
            severity,
            p.assignedEmployeeId ? String(p.assignedEmployeeId) : null,
            isoDate(p.dueDate),
            req.user.id,
          ],
        );
      res.json({ ok: true, id });
    }),
  );

  r.post(
    "/project/:id/change-order",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user),
        project = fullProject(ctx, req.params.id),
        p = req.body || {};
      if (p.action === "approve") {
        if (
          !(
            req.user.role === "client" &&
            D.same(req.user.client_id, project.clientId)
          ) &&
          !D.privileged(req.user, [...D.OPS, "accounting"])
        )
          D.fail("Approbation non autorisée.", 403);
        const id = String(p.id || "");
        const row = (
          await db.query(
            "SELECT * FROM project_change_orders WHERE id=$1 AND project_id=$2",
            [id, String(project.id)],
          )
        ).rows[0];
        if (!row) D.fail("Plus-value introuvable.", 404);
        await db.query(
          `UPDATE project_change_orders SET status='approved',
           approved_by_user_id=$1,approved_at=NOW(),updated_at=NOW()
           WHERE id=$2`,
          [req.user.id, id],
        );
        await emitEvent(db, {
          eventType: "project.change_order.approved",
          actorUserId: req.user.id,
          user: req.user,
          company: project.company,
          projectId: project.id,
          entityType: "change_order",
          entityId: id,
          payload: { amount: row.amount, title: row.title },
        });
        return res.json({ ok: true, id });
      }
      canOperateProject(ctx, req.user, project.id);
      const id = p.id ? String(p.id) : randomUUID(),
        status = oneOf(
          p.status || "draft",
          ["draft", "sent", "approved", "rejected"],
          "Statut",
        );
      const existing = (
        await db.query("SELECT id FROM project_change_orders WHERE id=$1", [id])
      ).rows[0];
      if (existing)
        await db.query(
          `UPDATE project_change_orders SET title=$1,description=$2,amount=$3,status=$4,
           client_note=$5,updated_at=NOW() WHERE id=$6`,
          [
            clean(p.title, 200),
            clean(p.description, 4000, true) || null,
            money(p.amount),
            status,
            clean(p.clientNote, 2000, true) || null,
            id,
          ],
        );
      else
        await db.query(
          `INSERT INTO project_change_orders
           (id,project_id,company,title,description,amount,status,client_note,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            String(project.id),
            project.company,
            clean(p.title, 200),
            clean(p.description, 4000, true) || null,
            money(p.amount),
            status,
            clean(p.clientNote, 2000, true) || null,
            req.user.id,
          ],
        );
      res.json({ ok: true, id });
    }),
  );

  r.get(
    "/crm",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, [...D.OPS, "accounting"]))
        D.fail("Accès commercial requis.", 403);
      const scope = companyScopeSql(req.user);
      const rows = (
        await db.query(
          `SELECT * FROM crm_opportunities WHERE ${scope.sql}
           ORDER BY CASE stage WHEN 'lead' THEN 0 WHEN 'qualified' THEN 1
           WHEN 'proposal' THEN 2 WHEN 'won' THEN 3 ELSE 4 END,updated_at DESC`,
          scope.params,
        )
      ).rows;
      res.json({ opportunities: rows });
    }),
  );
  r.post(
    "/crm",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, [...D.OPS, "accounting"]))
        D.fail("Accès commercial requis.", 403);
      const p = req.body || {},
        company = clean(p.company || req.user.company, 80),
        id = p.id ? String(p.id) : randomUUID();
      if (!companyAllowed(req.user, company))
        D.fail("Entreprise non autorisée.", 403);
      const stage = oneOf(
        p.stage || "lead",
        ["lead", "qualified", "proposal", "won", "lost"],
        "Étape",
      );
      const probability = Math.max(0, Math.min(100, Number(p.probability) || 0));
      const existing = (
        await db.query("SELECT id FROM crm_opportunities WHERE id=$1", [id])
      ).rows[0];
      if (existing)
        await db.query(
          `UPDATE crm_opportunities SET client_id=$1,name=$2,stage=$3,value=$4,
           probability=$5,owner_user_id=$6,next_action=$7,next_action_at=$8,
           source=$9,notes=$10,updated_at=NOW() WHERE id=$11`,
          [
            p.clientId ? String(p.clientId) : null,
            clean(p.name, 250),
            stage,
            money(p.value || 0),
            probability,
            p.ownerUserId ? Number(p.ownerUserId) : null,
            clean(p.nextAction, 1000, true) || null,
            p.nextActionAt ? new Date(p.nextActionAt) : null,
            clean(p.source, 200, true) || null,
            clean(p.notes, 5000, true) || null,
            id,
          ],
        );
      else
        await db.query(
          `INSERT INTO crm_opportunities
           (id,company,client_id,name,stage,value,probability,owner_user_id,next_action,next_action_at,source,notes,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            company,
            p.clientId ? String(p.clientId) : null,
            clean(p.name, 250),
            stage,
            money(p.value || 0),
            probability,
            p.ownerUserId ? Number(p.ownerUserId) : null,
            clean(p.nextAction, 1000, true) || null,
            p.nextActionAt ? new Date(p.nextActionAt) : null,
            clean(p.source, 200, true) || null,
            clean(p.notes, 5000, true) || null,
            req.user.id,
          ],
        );
      await emitEvent(db, {
        eventType: stage === "won" ? "crm.won" : "crm.updated",
        actorUserId: req.user.id,
        user: req.user,
        company,
        entityType: "crm",
        entityId: id,
        payload: { name: p.name, stage, value: Number(p.value) || 0 },
      });
      res.json({ ok: true, id });
    }),
  );

  r.get(
    "/inventory/movements",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user),
        visibleIds = ctx.view.inventory.map((x) => String(x.id)),
        limit = pageLimit(req.query.limit, 100, 200),
        cursor = decodeCursor(req.query.cursor);
      if (!visibleIds.length)
        return res.json({ movements: [], nextCursor: null });
      if (
        req.query.inventoryId &&
        !visibleIds.some((id) => D.same(id, req.query.inventoryId))
      )
        D.fail("Article inaccessible.", 403);
      const params = [visibleIds],
        where = ["inventory_id=ANY($1::text[])"];
      if (req.query.inventoryId) {
        params.push(String(req.query.inventoryId));
        where.push(`inventory_id=$${params.length}`);
      }
      if (cursor) {
        params.push(cursor.createdAt, cursor.id);
        where.push(
          `(created_at,id) < ($${params.length - 1}::timestamptz,$${params.length}::text)`,
        );
      }
      params.push(limit + 1);
      const rows = (
          await db.query(
            `SELECT * FROM inventory_movements
             WHERE ${where.join(" AND ")}
             ORDER BY created_at DESC,id DESC
             LIMIT $${params.length}`,
            params,
          )
        ).rows,
        hasMore = rows.length > limit,
        page = rows.slice(0, limit);
      res.json({
        movements: page,
        nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
      });
    }),
  );
  r.post(
    "/inventory/movement",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, D.OPS) && req.user.role !== "employee")
        D.fail("Mouvement de stock non autorisé.", 403);
      const ctx = await stateContext(db, req.user),
        p = req.body || {},
        item = ctx.view.inventory.find((x) => D.same(x.id, p.inventoryId));
      if (!item) D.fail("Article inaccessible.", 403);
      const company =
        item.company ||
        ctx.data.inventory.find((x) => D.same(x.id, p.inventoryId))?.company ||
        req.user.company;
      if (!companyAllowed(req.user, company))
        D.fail("Entreprise non autorisée.", 403);
      const type = oneOf(
        p.movementType,
        ["in", "out", "adjustment", "transfer"],
        "Type de mouvement",
      );
      let quantity = Number(p.quantity);
      if (!Number.isFinite(quantity) || quantity === 0 || Math.abs(quantity) > 1e7)
        D.fail("Quantité invalide.");
      if (type === "out") quantity = -Math.abs(quantity);
      if (type === "in") quantity = Math.abs(quantity);
      const id = randomUUID();
      if (p.projectId) visibleProject(ctx, p.projectId);
      await db.query(
        `INSERT INTO inventory_movements
         (id,inventory_id,company,location_id,project_id,employee_id,quantity,movement_type,note,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          String(p.inventoryId),
          company,
          p.locationId ? String(p.locationId) : null,
          p.projectId ? String(p.projectId) : null,
          p.employeeId ? String(p.employeeId) : req.user.employee_id || null,
          quantity,
          type,
          clean(p.note, 1000, true) || null,
          req.user.id,
        ],
      );
      res.json({ ok: true, id, quantity });
    }),
  );

  r.get(
    "/work-orders",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user);
      const projects = new Set(ctx.view.projects.map((p) => String(p.id)));
      let rows = (await db.query("SELECT * FROM work_orders ORDER BY scheduled_at NULLS LAST,created_at DESC")).rows;
      rows = rows.filter(
        (x) =>
          (x.project_id && projects.has(String(x.project_id))) ||
          (!x.project_id && companyAllowed(req.user, x.company)),
      );
      res.json({ workOrders: rows });
    }),
  );
  r.post(
    "/work-orders",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, D.OPS) && req.user.role !== "employee")
        D.fail("Bon de travail non autorisé.", 403);
      const ctx = await stateContext(db, req.user),
        p = req.body || {},
        project = p.projectId ? visibleProject(ctx, p.projectId) : null,
        company = project?.company || clean(p.company || req.user.company, 80);
      if (!companyAllowed(req.user, company))
        D.fail("Entreprise non autorisée.", 403);
      const id = p.id ? String(p.id) : randomUUID(),
        status = oneOf(
          p.status || "planned",
          ["planned", "in_progress", "done", "cancelled"],
          "Statut",
        );
      const existing = (
        await db.query("SELECT id FROM work_orders WHERE id=$1", [id])
      ).rows[0];
      if (existing)
        await db.query(
          `UPDATE work_orders SET title=$1,description=$2,status=$3,priority=$4,
           scheduled_at=$5,assigned_employee_id=$6,customer_signature=$7,
           signed_at=CASE WHEN $7 IS NULL THEN signed_at ELSE NOW() END,updated_at=NOW()
           WHERE id=$8`,
          [
            clean(p.title, 250),
            clean(p.description, 5000, true) || null,
            status,
            oneOf(p.priority || "normal", ["low", "normal", "high", "urgent"], "Priorité"),
            p.scheduledAt ? new Date(p.scheduledAt) : null,
            p.assignedEmployeeId ? String(p.assignedEmployeeId) : null,
            clean(p.customerSignature, 500, true) || null,
            id,
          ],
        );
      else
        await db.query(
          `INSERT INTO work_orders
           (id,company,client_id,project_id,maintenance_id,title,description,status,priority,scheduled_at,assigned_employee_id,customer_signature,signed_at,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text,CASE WHEN $12::text IS NULL THEN NULL ELSE NOW() END,$13)`,
          [
            id,
            company,
            p.clientId ? String(p.clientId) : project?.clientId || null,
            p.projectId ? String(p.projectId) : null,
            p.maintenanceId ? String(p.maintenanceId) : null,
            clean(p.title, 250),
            clean(p.description, 5000, true) || null,
            status,
            oneOf(p.priority || "normal", ["low", "normal", "high", "urgent"], "Priorité"),
            p.scheduledAt ? new Date(p.scheduledAt) : null,
            p.assignedEmployeeId ? String(p.assignedEmployeeId) : null,
            clean(p.customerSignature, 500, true) || null,
            req.user.id,
          ],
        );
      res.json({ ok: true, id });
    }),
  );

  r.get(
    "/payroll-export",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, D.HR)) D.fail("Accès RH requis.", 403);
      const month = String(req.query.month || "").trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
        D.fail("Mois invalide. Utilisez AAAA-MM.");
      const ctx = await stateContext(db, req.user),
        employees = new Map(ctx.view.employees.map((e) => [String(e.id), e])),
        rows = new Map();
      const ensure = (employee, company) => {
        const key = String(employee.id) + "::" + String(company || employee.company || "");
        if (!rows.has(key))
          rows.set(key, {
            employeeId: String(employee.id),
            name: String(employee.name || employee.id),
            company: String(company || employee.company || ""),
            activity: Number(employee.activity) || 0,
            total: 0,
            validated: 0,
            pending: 0,
          });
        return rows.get(key);
      };
      for (const employee of employees.values())
        ensure(employee, employee.company);
      for (const time of ctx.view.time) {
        if (!String(time.date || "").startsWith(month + "-")) continue;
        const employee = employees.get(String(time.employeeId));
        if (!employee) continue;
        const project = ctx.data.projects.find((p) => D.same(p.id, time.project)),
          company = time.company || project?.company || employee.company,
          row = ensure(employee, company),
          hours = Number(time.hours) || 0;
        row.total += hours;
        if (time.status === "Validé") row.validated += hours;
        else row.pending += hours;
      }
      const cell = (value) => {
        const s = String(value ?? "");
        return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [
        [
          "Mois",
          "ID salarié",
          "Salarié",
          "Entreprise",
          "Taux activité %",
          "Heures totales",
          "Heures validées",
          "Heures à valider",
        ].join(";"),
        ...[...rows.values()]
          .sort((a, b) => a.name.localeCompare(b.name) || a.company.localeCompare(b.company))
          .map((row) =>
            [
              month,
              row.employeeId,
              row.name,
              row.company,
              row.activity,
              row.total.toFixed(2),
              row.validated.toFixed(2),
              row.pending.toFixed(2),
            ]
              .map(cell)
              .join(";"),
          ),
      ];
      res
        .status(200)
        .type("text/csv; charset=utf-8")
        .set(
          "Content-Disposition",
          `attachment; filename="sousa-payroll-${month}.csv"`,
        )
        .send("\uFEFF" + lines.join("\n"));
    }),
  );

  r.get(
    "/analytics",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, [...D.STAFF, "hr", "accounting", "manager"]))
        D.fail("Accès rapports requis.", 403);
      const ctx = await stateContext(db, req.user),
        sum = (arr, key) =>
          arr.reduce((n, x) => n + (Number(x[key]) || 0), 0),
        outstanding = ctx.view.invoices.reduce(
          (n, x) => n + Math.max(0, (Number(x.amount) || 0) - (Number(x.paid) || 0)),
          0,
        ),
        byProject = ctx.view.projects.map((p) => {
          const invoices = ctx.view.invoices.filter((i) => D.same(i.project, p.id)),
            revenue = sum(invoices, "amount"),
            paid = sum(invoices, "paid"),
            cost = Number(p.cost) || 0;
          return {
            id: p.id,
            title: p.title,
            company: p.company,
            revenue,
            paid,
            cost,
            margin: revenue - cost,
            progress: Number(p.progress) || 0,
          };
        });
      const byCompany = {};
      for (const c of ctx.view.companies.filter((x) => x.id !== "group"))
        byCompany[c.id] = {
          id: c.id,
          name: c.name,
          invoices: 0,
          revenue: 0,
          paid: 0,
          projectCost: 0,
          hours: 0,
        };
      for (const i of ctx.view.invoices) {
        const c = i.company || ctx.data.projects.find((p) => D.same(p.id, i.project))?.company;
        if (byCompany[c]) {
          byCompany[c].invoices++;
          byCompany[c].revenue += Number(i.amount) || 0;
          byCompany[c].paid += Number(i.paid) || 0;
        }
      }
      for (const p of ctx.view.projects)
        if (byCompany[p.company]) byCompany[p.company].projectCost += Number(p.cost) || 0;
      for (const t of ctx.view.time) {
        const p = ctx.data.projects.find((x) => D.same(x.id, t.project));
        const c = p?.company || ctx.data.employees.find((e) => D.same(e.id, t.employeeId))?.company;
        if (byCompany[c]) byCompany[c].hours += Number(t.hours) || 0;
      }
      const byClient = ctx.view.clients.map((client) => {
        const invoices = ctx.view.invoices.filter((i) => D.same(i.clientId, client.id));
        return {
          id: client.id,
          name: client.name,
          revenue: sum(invoices, "amount"),
          paid: sum(invoices, "paid"),
          outstanding: invoices.reduce(
            (n, x) => n + Math.max(0, (Number(x.amount) || 0) - (Number(x.paid) || 0)),
            0,
          ),
        };
      });
      const futurePlanning = ctx.view.planning.filter(
        (x) => x.date && x.date >= new Date().toISOString().slice(0, 10),
      );
      const teamLoad = {};
      for (const x of futurePlanning) {
        const start = String(x.start || "00:00").split(":").map(Number),
          end = String(x.end || "00:00").split(":").map(Number),
          hours = Math.max(0, end[0] + end[1] / 60 - start[0] - start[1] / 60);
        teamLoad[x.employeeId] = (teamLoad[x.employeeId] || 0) + hours;
      }
      res.json({
        kpis: {
          invoiceRevenue: sum(ctx.view.invoices, "amount"),
          collected: sum(ctx.view.payments, "amount"),
          outstanding,
          expenses: sum(ctx.view.expenses, "amount"),
          hours: sum(ctx.view.time, "hours"),
          openProjects: ctx.view.projects.filter((p) => p.status !== "Terminé").length,
          openQuotes: ctx.view.quotes.filter((q) => !["Accepté", "Refusé"].includes(q.status)).length,
        },
        byProject,
        byCompany: Object.values(byCompany),
        byClient,
        teamLoad: Object.entries(teamLoad).map(([employeeId, hours]) => ({
          employeeId,
          name:
            ctx.view.employees.find((e) => D.same(e.id, employeeId))?.name ||
            employeeId,
          hours: Math.round(hours * 100) / 100,
        })),
      });
    }),
  );

  r.get(
    "/insights",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user),
        today = new Date().toISOString().slice(0, 10),
        insights = [];
      for (const invoice of ctx.view.invoices) {
        const outstanding = Math.max(
          0,
          (Number(invoice.amount) || 0) - (Number(invoice.paid) || 0),
        );
        if (outstanding > 0 && invoice.due && invoice.due < today)
          insights.push({
            severity: "high",
            type: "invoice.overdue",
            title: "Facture en retard",
            body: invoice.id + " · " + outstanding.toFixed(2) + " CHF restant",
            page: "invoices",
            entityId: invoice.id,
          });
      }
      for (const project of ctx.view.projects) {
        const budget = Number(project.budget) || 0,
          cost = Number(project.cost) || 0;
        if (budget > 0 && cost > budget)
          insights.push({
            severity: "critical",
            type: "project.over_budget",
            title: "Budget chantier dépassé",
            body:
              project.title +
              " · " +
              (cost - budget).toFixed(2) +
              " CHF au-dessus du budget",
            page: "projects",
            entityId: project.id,
          });
        else if (budget > 0 && cost / budget >= 0.85)
          insights.push({
            severity: "high",
            type: "project.budget_warning",
            title: "Budget chantier à surveiller",
            body:
              project.title +
              " · " +
              Math.round((cost / budget) * 100) +
              " % du budget consommé",
            page: "projects",
            entityId: project.id,
          });
      }
      for (const item of ctx.view.inventory) {
        const stock = Number(item.stock) || 0,
          min = Number(item.min) || 0;
        if (min > 0 && stock <= min)
          insights.push({
            severity: stock <= 0 ? "critical" : "high",
            type: "inventory.low",
            title: "Stock à réapprovisionner",
            body: item.name + " · stock " + stock + " / minimum " + min,
            page: "inventory",
            entityId: item.id,
          });
      }
      const daysUntil = (date) =>
        Math.ceil(
          (Date.parse(String(date) + "T12:00:00Z") -
            Date.parse(today + "T12:00:00Z")) /
            86400000,
        );
      const complianceInsight = ({
        expiry,
        type,
        title,
        body,
        page,
        entityId,
      }) => {
        if (!expiry) return;
        const days = daysUntil(expiry);
        if (!Number.isFinite(days) || days > 60) return;
        insights.push({
          severity: days < 0 ? "critical" : days <= 30 ? "high" : "medium",
          type,
          title: days < 0 ? title + " expiré" : title + " à renouveler",
          body:
            body +
            " · " +
            expiry +
            (days < 0
              ? " · expiré depuis " + Math.abs(days) + " j"
              : " · dans " + days + " j"),
          page,
          entityId,
        });
      };
      for (const employee of ctx.view.employees) {
        if (!employee.residencePermitExpiry) continue;
        complianceInsight({
          expiry: employee.residencePermitExpiry,
          type: "employee.residence_permit_expiry",
          title: "Permis de séjour",
          body: employee.name || employee.id,
          page:
            req.user.role === "employee" && D.same(employee.id, req.user.employee_id)
              ? "settings"
              : "employees",
          entityId: employee.id,
        });
      }
      for (const document of ctx.view.documents) {
        if (document.category !== "identity" || !document.expiresAt) continue;
        const employee = ctx.view.employees.find((e) =>
          D.same(e.id, document.employeeId),
        );
        complianceInsight({
          expiry: document.expiresAt,
          type: "employee.document_expiry",
          title: document.documentType || "Document salarié",
          body: (employee?.name || document.employeeId || "Salarié") + " · " + document.name,
          page:
            req.user.role === "employee" &&
            D.same(document.employeeId, req.user.employee_id)
              ? "settings"
              : "employees",
          entityId: document.employeeId || document.id,
        });
      }

      const future = ctx.view.planning.filter(
        (x) => x.date && x.date >= today,
      );
      const byEmployee = {};
      for (const row of future) {
        const [sh, sm] = String(row.start || "00:00").split(":").map(Number),
          [eh, em] = String(row.end || "00:00").split(":").map(Number),
          hours = Math.max(0, eh + em / 60 - sh - sm / 60);
        byEmployee[row.employeeId] =
          (byEmployee[row.employeeId] || 0) + hours;
      }
      for (const [employeeId, hours] of Object.entries(byEmployee))
        if (hours > 50)
          insights.push({
            severity: "medium",
            type: "team.overload",
            title: "Charge équipe élevée",
            body:
              (ctx.view.employees.find((e) => D.same(e.id, employeeId))?.name ||
                employeeId) +
              " · " +
              Math.round(hours * 10) / 10 +
              " h planifiées",
            page: "planning",
            entityId: employeeId,
          });
      insights.sort(
        (a, b) =>
          ["critical", "high", "medium", "low"].indexOf(a.severity) -
          ["critical", "high", "medium", "low"].indexOf(b.severity),
      );
      res.json({ insights: insights.slice(0, 100) });
    }),
  );

  r.get(
    "/automations",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, D.STAFF)) D.fail("Accès direction requis.", 403);
      const scope = companyScopeSql(req.user);
      const rows = (
        await db.query(
          `SELECT * FROM automation_rules
           WHERE company IS NULL OR ${scope.sql.replace(/company/g, "automation_rules.company")}
           ORDER BY updated_at DESC`,
          scope.params,
        )
      ).rows;
      res.json({ rules: rows });
    }),
  );
  r.post(
    "/automations",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, D.STAFF)) D.fail("Accès direction requis.", 403);
      const p = req.body || {},
        id = p.id ? String(p.id) : randomUUID(),
        company = p.company ? clean(p.company, 80) : null;
      if (company && !companyAllowed(req.user, company))
        D.fail("Entreprise non autorisée.", 403);
      const eventType = clean(p.eventType, 120),
        conditions =
          p.conditions && typeof p.conditions === "object" ? p.conditions : {},
        actions = Array.isArray(p.actions) ? p.actions.slice(0, 20) : [];
      await db.query(
        `INSERT INTO automation_rules(id,company,name,event_type,conditions,actions,enabled,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(id) DO UPDATE SET company=EXCLUDED.company,name=EXCLUDED.name,
         event_type=EXCLUDED.event_type,conditions=EXCLUDED.conditions,actions=EXCLUDED.actions,
         enabled=EXCLUDED.enabled,updated_at=NOW()`,
        [
          id,
          company,
          clean(p.name, 200),
          eventType,
          conditions,
          actions,
          p.enabled !== false,
          req.user.id,
        ],
      );
      res.json({ ok: true, id });
    }),
  );

  r.get(
    "/webhooks",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, D.STAFF)) D.fail("Accès direction requis.", 403);
      const rows = (
        await db.query(
          `SELECT id,company,name,url,event_types,enabled,created_at FROM outgoing_webhooks
           ORDER BY created_at DESC`,
        )
      ).rows.filter((x) => !x.company || companyAllowed(req.user, x.company));
      res.json({ webhooks: rows });
    }),
  );
  r.post(
    "/webhooks",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, D.STAFF)) D.fail("Accès direction requis.", 403);
      const p = req.body || {},
        id = p.id ? String(p.id) : randomUUID(),
        company = p.company ? clean(p.company, 80) : null,
        url = await safeWebhookUrl(p.url),
        eventTypes = Array.isArray(p.eventTypes)
          ? p.eventTypes.map((x) => clean(String(x), 120)).slice(0, 30)
          : ["*"],
        secret =
          p.secret && String(p.secret).length >= 24
            ? String(p.secret)
            : randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      if (company && !companyAllowed(req.user, company))
        D.fail("Entreprise non autorisée.", 403);
      await db.query(
        `INSERT INTO outgoing_webhooks(id,company,name,url,secret,event_types,enabled,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(id) DO UPDATE SET company=EXCLUDED.company,name=EXCLUDED.name,
         url=EXCLUDED.url,event_types=EXCLUDED.event_types,enabled=EXCLUDED.enabled`,
        [
          id,
          company,
          clean(p.name, 200),
          url,
          secret,
          eventTypes,
          p.enabled !== false,
          req.user.id,
        ],
      );
      res.json({ ok: true, id, secret: p.id ? undefined : secret });
    }),
  );
  r.post(
    "/webhooks/test",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, D.STAFF)) D.fail("Accès direction requis.", 403);
      const hook = (
        await db.query("SELECT * FROM outgoing_webhooks WHERE id=$1", [req.body?.id])
      ).rows[0];
      if (!hook || (hook.company && !companyAllowed(req.user, hook.company)))
        D.fail("Webhook introuvable.", 404);
      const result = await deliverWebhook(db, hook, {
        id: randomUUID(),
        eventType: "webhook.test",
        createdAt: new Date().toISOString(),
        company: hook.company,
        projectId: null,
        entityType: "webhook",
        entityId: hook.id,
        payload: { test: true },
      });
      res.json(result);
    }),
  );

  r.get(
    "/errors",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, ["admin", "direction"]))
        D.fail("Accès administrateur requis.", 403);
      const rows = (
        await db.query(
          `SELECT id,request_id,user_id,method,path,status,message,metadata,created_at
           FROM application_errors
           ORDER BY created_at DESC LIMIT 200`,
        )
      ).rows;
      res.json({ errors: rows });
    }),
  );

  r.get(
    "/integrations",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, D.STAFF)) D.fail("Accès direction requis.", 403);
      const rows = (await db.query("SELECT provider,enabled,config,updated_at FROM integration_settings ORDER BY provider")).rows;
      res.json({
        integrations: rows,
        runtime: {
          turnConfigured: !!(
            process.env.RTC_TURN_URLS &&
            process.env.RTC_TURN_USERNAME &&
            process.env.RTC_TURN_CREDENTIAL
          ),
          aiConfigured: !!(process.env.AI_API_URL && process.env.AI_API_KEY),
          objectStorageConfigured: !!(
            process.env.OBJECT_STORAGE_ENDPOINT &&
            process.env.OBJECT_STORAGE_BUCKET
          ),
          errorMonitoringConfigured: !!process.env.ERROR_MONITOR_DSN,
        },
      });
    }),
  );

  return r;
}

async function runDueRecurringJobs(db) {
  const due = (
    await db.query(
      `SELECT * FROM recurring_jobs
       WHERE active=true AND next_run <= CURRENT_DATE
       ORDER BY next_run LIMIT 100`,
    )
  ).rows;
  for (const job of due) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO work_orders
       (id,company,maintenance_id,title,status,priority,scheduled_at,created_by)
       VALUES($1,$2,$3,$4,'planned','normal',$5,$6)`,
      [
        id,
        job.company,
        job.maintenance_id,
        job.title,
        new Date(job.next_run + "T08:00:00Z"),
        job.created_by,
      ],
    );
    const next = new Date(job.next_run + "T12:00:00Z");
    if (job.frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
    else if (job.frequency === "quarterly")
      next.setUTCMonth(next.getUTCMonth() + 3);
    else if (job.frequency === "yearly") next.setUTCFullYear(next.getUTCFullYear() + 1);
    else next.setUTCMonth(next.getUTCMonth() + 1);
    await db.query("UPDATE recurring_jobs SET next_run=$1 WHERE id=$2", [
      next.toISOString().slice(0, 10),
      job.id,
    ]);
  }
  return due.length;
}

module.exports = {
  routes,
  emitEvent,
  insertNotification,
  runDueRecurringJobs,
};
