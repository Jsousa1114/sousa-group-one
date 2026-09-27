"use strict";
const express = require("express");
const { randomUUID } = require("node:crypto");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const realtime = require("./realtime-hub");

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function clean(value, max = 1000, optional = false) {
  if (optional && (value == null || value === "")) return "";
  const out = String(value == null ? "" : value).trim();
  if (!out || out.length > max) D.fail("Valeur invalide.");
  return out;
}

function isoDateTime(value, optional = false) {
  if (optional && !value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) D.fail("Date invalide.");
  return date.toISOString();
}

function companyAllowed(user, company) {
  return !!company && company !== "group" && D.inCompany(user, company);
}

function privileged(user, roles) {
  return D.privileged(user, roles);
}

async function stateContext(db, user) {
  const row = (
    await db.query("SELECT data,revision FROM app_state WHERE id=1")
  ).rows[0];
  const data = D.normalize(row && row.data);
  return {
    data,
    view: D.viewState(data, user),
    revision: (row && row.revision) || 0,
  };
}

async function effectiveUserById(db, id) {
  const raw = (
    await db.query(
      "SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL AND disabled=false",
      [id],
    )
  ).rows[0];
  if (!raw) return null;
  const state = (
    await db.query("SELECT data FROM app_state WHERE id=1")
  ).rows[0];
  return D.effectiveUser((state && state.data) || {}, raw);
}

function escapeIcs(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsStamp(date, time) {
  return (
    String(date || "").replace(/-/g, "") +
    "T" +
    String(time || "08:00").replace(":", "") +
    "00"
  );
}

function eventVisibleTo(user, event) {
  if (Array.isArray(event.userIds) && event.userIds.length)
    return event.userIds.some((id) => Number(id) === Number(user.id));
  if (!event.company) return true;
  return D.inCompany(user, event.company);
}

async function permissionOverride(db, userId, permission) {
  const row = (
    await db.query(
      "SELECT allowed FROM user_permission_overrides WHERE user_id=$1 AND permission=$2",
      [Number(userId), String(permission)],
    )
  ).rows[0];
  return row ? row.allowed : undefined;
}

async function canFeature(db, user, permission, fallbackRoles = []) {
  if (user.role === "admin" && user.company === "group") return true;
  const override = await permissionOverride(db, user.id, permission);
  if (typeof override === "boolean") return override;
  return privileged(user, fallbackRoles);
}

function ensureFeature(ok, message = "Permission insuffisante.") {
  if (!ok) D.fail(message, 403);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function publish(type, payload = {}) {
  realtime.publish({
    type,
    eventType: type,
    ...payload,
    createdAt: new Date().toISOString(),
  });
}

async function dispatchOutbound(db, row) {
  const isEmail = row.channel === "email";
  const url = isEmail
    ? process.env.EMAIL_WEBHOOK_URL
    : process.env.SMS_WEBHOOK_URL;
  const key = isEmail
    ? process.env.EMAIL_WEBHOOK_KEY
    : process.env.SMS_WEBHOOK_KEY;
  if (!url) {
    await db.query(
      "UPDATE outbound_messages SET status='waiting_configuration',updated_at=NOW() WHERE id=$1",
      [row.id],
    );
    return { status: "waiting_configuration", providerStatus: null };
  }
  let status = "failed";
  let providerStatus = null;
  let providerResponse = "";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: "Bearer " + key } : {}),
      },
      body: JSON.stringify({
        id: row.id,
        channel: row.channel,
        to: row.recipient,
        subject: row.subject || "",
        message: row.message,
        metadata: row.metadata || {},
      }),
      signal: AbortSignal.timeout(10000),
    });
    providerStatus = response.status;
    providerResponse = (await response.text()).slice(0, 1500);
    status = response.ok ? "sent" : "failed";
  } catch (error) {
    providerResponse = String((error && error.message) || error).slice(0, 1500);
  }
  await db.query(
    "UPDATE outbound_messages " +
      "SET status=$1,provider_status=$2,provider_response=$3," +
      "sent_at=CASE WHEN $1='sent' THEN NOW() ELSE sent_at END,updated_at=NOW() " +
      "WHERE id=$4",
    [status, providerStatus, providerResponse || null, row.id],
  );
  return { status, providerStatus };
}

function routes(db) {
  const r = express.Router();

  r.get(
    "/calendar/feed/:token.ics",
    wrap(async (req, res) => {
      const feed = (
        await db.query(
          "SELECT user_id,token FROM calendar_feeds " +
            "WHERE token=$1 AND revoked_at IS NULL",
          [String(req.params.token || "")],
        )
      ).rows[0];
      if (!feed)
        return res
          .status(404)
          .type("text/plain")
          .send("Calendrier introuvable.");

      const user = await effectiveUserById(db, feed.user_id);
      if (!user)
        return res
          .status(404)
          .type("text/plain")
          .send("Calendrier introuvable.");

      const ctx = await stateContext(db, user);
      let planning = ctx.view.planning || [];
      if (user.employee_id)
        planning = planning.filter((x) =>
          D.same(x.employeeId, user.employee_id),
        );

      const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Sousa Group One//Planning//FR",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Sousa Group One",
        "X-WR-TIMEZONE:Europe/Zurich",
      ];

      for (const item of planning) {
        if (!item.date) continue;
        const project = ctx.view.projects.find((p) =>
          D.same(p.id, item.project),
        );
        const description = [
          project && project.status,
          project && project.clientId ? "Client " + project.clientId : "",
          item.note || "",
        ]
          .filter(Boolean)
          .join(" · ");
        lines.push(
          "BEGIN:VEVENT",
          "UID:" +
            escapeIcs(String(item.id || randomUUID())) +
            "@sousa-group-one",
          "DTSTAMP:" +
            new Date()
              .toISOString()
              .replace(/[-:]/g, "")
              .replace(/\.\d{3}Z$/, "Z"),
          "DTSTART;TZID=Europe/Zurich:" +
            icsStamp(item.date, item.start || "08:00"),
          "DTEND;TZID=Europe/Zurich:" +
            icsStamp(item.date, item.end || "17:00"),
          "SUMMARY:" +
            escapeIcs(
              (project && project.title) ||
                item.title ||
                "Intervention Sousa Group",
            ),
          item.location ? "LOCATION:" + escapeIcs(item.location) : "",
          "DESCRIPTION:" + escapeIcs(description),
          "END:VEVENT",
        );
      }
      lines.push("END:VCALENDAR");
      res
        .set({
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition":
            'inline; filename="sousa-group-one.ics"',
          "Cache-Control": "private, max-age=300",
        })
        .send(lines.filter(Boolean).join("\r\n"));
    }),
  );

  r.use(auth(db));

  r.get(
    "/status",
    wrap(async (req, res) => {
      const feed = (
        await db.query(
          "SELECT token,created_at FROM calendar_feeds " +
            "WHERE user_id=$1 AND revoked_at IS NULL " +
            "ORDER BY created_at DESC LIMIT 1",
          [req.user.id],
        )
      ).rows[0];
      const counts = (
        await db.query(
          "SELECT channel,status,COUNT(*)::int AS count " +
            "FROM outbound_messages " +
            "WHERE created_by=$1 GROUP BY channel,status",
          [req.user.id],
        )
      ).rows;
      res.json({
        realtime: true,
        offlineQueue: true,
        installable: true,
        calendarFeed: feed || null,
        outbound: counts,
        configured: {
          email: !!process.env.EMAIL_WEBHOOK_URL,
          sms: !!process.env.SMS_WEBHOOK_URL,
        },
      });
    }),
  );

  r.get("/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders && res.flushHeaders();
    res.write("retry: 3000\n");
    res.write("event: ready\ndata: {}\n\n");

    const off = realtime.subscribe((event) => {
      if (!eventVisibleTo(req.user, event)) return;
      res.write("event: update\n");
      res.write("data: " + JSON.stringify(event) + "\n\n");
    });
    const heartbeat = setInterval(
      () => res.write(": heartbeat\n\n"),
      20000,
    );
    const cleanup = () => {
      clearInterval(heartbeat);
      off();
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
  });

  r.post(
    "/calendar/feed",
    wrap(async (req, res) => {
      if (req.body && req.body.action === "revoke") {
        await db.query(
          "UPDATE calendar_feeds SET revoked_at=NOW() " +
            "WHERE user_id=$1 AND revoked_at IS NULL",
          [req.user.id],
        );
        publish("calendar.feed.revoked", { userIds: [req.user.id] });
        return res.json({ ok: true });
      }

      await db.query(
        "UPDATE calendar_feeds SET revoked_at=NOW() " +
          "WHERE user_id=$1 AND revoked_at IS NULL",
        [req.user.id],
      );
      const token =
        randomUUID().replace(/-/g, "") +
        randomUUID().replace(/-/g, "");
      await db.query(
        "INSERT INTO calendar_feeds(user_id,token) VALUES($1,$2)",
        [req.user.id, token],
      );
      const base = req.protocol + "://" + req.get("host");
      const url =
        base + "/api/p2/calendar/feed/" + token + ".ics";
      publish("calendar.feed.created", { userIds: [req.user.id] });
      res.json({ ok: true, url, token });
    }),
  );

  r.get(
    "/permissions",
    wrap(async (req, res) => {
      ensureFeature(
        req.user.role === "admin" && req.user.company === "group",
        "Accès administrateur groupe requis.",
      );
      const users = (
        await db.query(
          "SELECT id,email,name,role,company FROM users " +
            "WHERE deleted_at IS NULL ORDER BY name,id",
        )
      ).rows;
      const overrides = (
        await db.query(
          "SELECT user_id,permission,allowed,updated_at " +
            "FROM user_permission_overrides ORDER BY user_id,permission",
        )
      ).rows;
      res.json({ users, overrides });
    }),
  );

  r.post(
    "/permissions",
    wrap(async (req, res) => {
      ensureFeature(
        req.user.role === "admin" && req.user.company === "group",
        "Accès administrateur groupe requis.",
      );
      const userId = Number(req.body && req.body.userId);
      const permission = clean(
        req.body && req.body.permission,
        120,
      );
      const action = String(
        (req.body && req.body.action) || "set",
      );
      if (!Number.isInteger(userId) || userId <= 0)
        D.fail("Utilisateur invalide.");
      if (action === "clear")
        await db.query(
          "DELETE FROM user_permission_overrides " +
            "WHERE user_id=$1 AND permission=$2",
          [userId, permission],
        );
      else
        await db.query(
          "INSERT INTO user_permission_overrides" +
            "(user_id,permission,allowed,updated_by) " +
            "VALUES($1,$2,$3,$4) " +
            "ON CONFLICT(user_id,permission) DO UPDATE SET " +
            "allowed=EXCLUDED.allowed,updated_by=EXCLUDED.updated_by," +
            "updated_at=NOW()",
          [
            userId,
            permission,
            !req.body || req.body.allowed !== false,
            req.user.id,
          ],
        );
      publish("permission.updated", {
        userIds: [userId],
        payload: { permission },
      });
      res.json({ ok: true });
    }),
  );

  r.get(
    "/approvals",
    wrap(async (req, res) => {
      let rows = (
        await db.query(
          "SELECT * FROM approval_requests " +
            "ORDER BY created_at DESC LIMIT 250",
        )
      ).rows;
      const canSeeAll = await canFeature(
        db,
        req.user,
        "approvals.view_all",
        ["admin", "direction", "manager", "hr", "accounting"],
      );
      if (!canSeeAll)
        rows = rows.filter(
          (x) => Number(x.requested_by) === Number(req.user.id),
        );
      rows = rows.filter(
        (x) =>
          !x.company ||
          companyAllowed(req.user, x.company) ||
          x.company === req.user.company,
      );
      res.json({ approvals: rows });
    }),
  );

  r.post(
    "/approvals",
    wrap(async (req, res) => {
      const p = req.body || {};
      if (p.action === "decide") {
        ensureFeature(
          await canFeature(
            db,
            req.user,
            "approvals.decide",
            ["admin", "direction", "manager", "hr", "accounting"],
          ),
        );
        const id = String(p.id || "");
        const decision = ["approved", "rejected"].includes(
          p.decision,
        )
          ? p.decision
          : "";
        if (!decision) D.fail("Décision invalide.");
        const row = (
          await db.query(
            "SELECT * FROM approval_requests WHERE id=$1",
            [id],
          )
        ).rows[0];
        if (!row) D.fail("Demande introuvable.", 404);
        if (
          row.company &&
          !companyAllowed(req.user, row.company) &&
          row.company !== req.user.company
        )
          D.fail("Entreprise non autorisée.", 403);

        await db.query(
          "UPDATE approval_requests SET " +
            "status=$1,decided_by=$2,decision_note=$3," +
            "decided_at=NOW(),updated_at=NOW() WHERE id=$4",
          [
            decision,
            req.user.id,
            clean(p.note, 1500, true) || null,
            id,
          ],
        );
        publish("approval." + decision, {
          company: row.company,
          userIds: [row.requested_by, req.user.id],
          entityType: "approval",
          entityId: id,
          payload: { type: row.request_type },
        });
        return res.json({ ok: true, id, status: decision });
      }

      const company = clean(p.company || req.user.company, 80);
      if (!companyAllowed(req.user, company))
        D.fail("Entreprise non autorisée.", 403);
      const type = String(p.type || "");
      if (
        ![
          "expense",
          "quote",
          "purchase",
          "absence",
          "invoice",
          "change_order",
          "other",
        ].includes(type)
      )
        D.fail("Type d’approbation invalide.");
      const id = randomUUID();
      await db.query(
        "INSERT INTO approval_requests" +
          "(id,company,request_type,title,amount,entity_type," +
          "entity_id,payload,requested_by) " +
          "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          company,
          type,
          clean(p.title, 240),
          p.amount == null || p.amount === ""
            ? null
            : Number(p.amount),
          clean(p.entityType, 80, true) || null,
          clean(p.entityId, 180, true) || null,
          safeObject(p.payload),
          req.user.id,
        ],
      );
      publish("approval.created", {
        company,
        entityType: "approval",
        entityId: id,
        payload: { type, title: p.title },
      });
      res.json({ ok: true, id });
    }),
  );

  r.get(
    "/appointments",
    wrap(async (req, res) => {
      let rows = (
        await db.query(
          "SELECT * FROM appointment_requests " +
            "ORDER BY start_at DESC LIMIT 300",
        )
      ).rows;
      if (req.user.role === "client")
        rows = rows.filter((x) =>
          D.same(x.client_id, req.user.client_id),
        );
      else
        rows = rows.filter(
          (x) =>
            companyAllowed(req.user, x.company) ||
            x.company === req.user.company,
        );
      res.json({ appointments: rows });
    }),
  );

  r.post(
    "/appointments",
    wrap(async (req, res) => {
      const p = req.body || {};
      if (p.action === "status") {
        const row = (
          await db.query(
            "SELECT * FROM appointment_requests WHERE id=$1",
            [String(p.id || "")],
          )
        ).rows[0];
        if (!row) D.fail("Rendez-vous introuvable.", 404);
        const status = String(p.status || "");
        if (
          !["confirmed", "rejected", "cancelled"].includes(status)
        )
          D.fail("Statut invalide.");
        const clientOwn =
          req.user.role === "client" &&
          D.same(row.client_id, req.user.client_id) &&
          status === "cancelled";
        const staff = await canFeature(
          db,
          req.user,
          "appointments.manage",
          ["admin", "direction", "manager", "employee"],
        );
        if (!clientOwn && !staff)
          D.fail("Modification non autorisée.", 403);
        await db.query(
          "UPDATE appointment_requests SET " +
            "status=$1,updated_by=$2,updated_at=NOW() WHERE id=$3",
          [status, req.user.id, row.id],
        );
        publish("appointment." + status, {
          company: row.company,
          userIds: [row.requested_by, req.user.id],
          entityType: "appointment",
          entityId: row.id,
        });
        return res.json({ ok: true, id: row.id, status });
      }

      const ctx = await stateContext(db, req.user);
      const clientId =
        req.user.role === "client"
          ? String(req.user.client_id || "")
          : String(p.clientId || "");
      const client = ctx.view.clients.find((x) =>
        D.same(x.id, clientId),
      );
      if (!client) D.fail("Client inaccessible.", 403);
      const company =
        client.company || p.company || req.user.company;
      if (
        req.user.role !== "client" &&
        !companyAllowed(req.user, company)
      )
        D.fail("Entreprise non autorisée.", 403);
      const startAt = isoDateTime(p.startAt);
      const endAt = isoDateTime(p.endAt);
      if (Date.parse(endAt) <= Date.parse(startAt))
        D.fail("La fin doit être après le début.");
      const id = randomUUID();
      await db.query(
        "INSERT INTO appointment_requests" +
          "(id,company,client_id,title,start_at,end_at,notes," +
          "status,requested_by) " +
          "VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8)",
        [
          id,
          company,
          clientId,
          clean(p.title, 240),
          startAt,
          endAt,
          clean(p.notes, 2000, true) || null,
          req.user.id,
        ],
      );
      publish("appointment.created", {
        company,
        entityType: "appointment",
        entityId: id,
        payload: { clientId, startAt },
      });
      res.json({ ok: true, id, status: "pending" });
    }),
  );

  r.get(
    "/client/:id/history",
    wrap(async (req, res) => {
      const ctx = await stateContext(db, req.user);
      const client = ctx.view.clients.find((x) =>
        D.same(x.id, req.params.id),
      );
      if (!client) D.fail("Client inaccessible.", 403);
      const projects = ctx.view.projects.filter((x) =>
        D.same(x.clientId, client.id),
      );
      const quotes = ctx.view.quotes.filter((x) =>
        D.same(x.clientId, client.id),
      );
      const invoices = ctx.view.invoices.filter((x) =>
        D.same(x.clientId, client.id),
      );
      const invoiceIds = new Set(
        invoices.map((x) => String(x.id)),
      );
      const payments = ctx.view.payments.filter((x) =>
        invoiceIds.has(String(x.invoice)),
      );
      const maintenance = ctx.view.maintenance.filter((x) =>
        D.same(x.clientId, client.id),
      );
      const documents = ctx.view.documents.filter((x) =>
        D.same(x.clientId, client.id),
      );
      res.json({
        client,
        projects,
        quotes,
        invoices,
        payments,
        maintenance,
        documents,
      });
    }),
  );

  r.get(
    "/quote-followups",
    wrap(async (req, res) => {
      ensureFeature(
        await canFeature(
          db,
          req.user,
          "quotes.followup",
          ["admin", "direction", "manager", "accounting"],
        ),
      );
      const ctx = await stateContext(db, req.user);
      const today = new Date();
      const rows = ctx.view.quotes
        .filter(
          (q) =>
            !["Accepté", "Refusé", "Annulé"].includes(q.status),
        )
        .map((q) => {
          const valid = q.valid
            ? new Date(q.valid + "T12:00:00")
            : null;
          const days =
            valid && Number.isFinite(valid.getTime())
              ? Math.ceil((valid - today) / 86400000)
              : null;
          const client = ctx.view.clients.find((c) =>
            D.same(c.id, q.clientId),
          );
          return {
            id: q.id,
            title: q.title || q.id,
            status: q.status,
            amount: Number(q.amount) || 0,
            valid: q.valid || null,
            daysToValidity: days,
            needsFollowup: days == null || days <= 7,
            clientId: q.clientId,
            client: (client && client.name) || q.clientId || "",
            email: (client && client.email) || "",
          };
        })
        .filter((x) => x.needsFollowup)
        .sort(
          (a, b) =>
            (a.daysToValidity == null
              ? 9999
              : a.daysToValidity) -
            (b.daysToValidity == null
              ? 9999
              : b.daysToValidity),
        );
      res.json({ followups: rows });
    }),
  );

  r.get(
    "/analytics/forecast",
    wrap(async (req, res) => {
      ensureFeature(
        await canFeature(
          db,
          req.user,
          "analytics.forecast",
          ["admin", "direction", "manager", "accounting"],
        ),
      );
      const ctx = await stateContext(db, req.user);
      const today = new Date();
      const horizon = Math.max(
        30,
        Math.min(365, Number(req.query.days) || 90),
      );
      const end = new Date(
        today.getTime() + horizon * 86400000,
      );
      const entries = [];

      for (const invoice of ctx.view.invoices) {
        const amount = Math.max(
          0,
          (Number(invoice.amount) || 0) -
            (Number(invoice.paid) || 0),
        );
        if (!amount) continue;
        const due = invoice.due
          ? new Date(invoice.due + "T12:00:00")
          : new Date(today.getTime() + 14 * 86400000);
        if (due <= end)
          entries.push({
            date: due.toISOString().slice(0, 10),
            type: "inflow",
            amount,
            ref: invoice.id,
          });
      }

      for (const quote of ctx.view.quotes) {
        if (!["Envoyé", "Émis"].includes(quote.status))
          continue;
        const amount = (Number(quote.amount) || 0) * 0.35;
        if (!amount) continue;
        const due = quote.valid
          ? new Date(quote.valid + "T12:00:00")
          : new Date(today.getTime() + 30 * 86400000);
        if (due <= end)
          entries.push({
            date: due.toISOString().slice(0, 10),
            type: "weighted_quote",
            amount,
            ref: quote.id,
          });
      }

      const buckets = new Map();
      for (const entry of entries) {
        const date = new Date(entry.date + "T12:00:00");
        const monday = new Date(date);
        monday.setDate(
          date.getDate() - ((date.getDay() + 6) % 7),
        );
        const key = monday.toISOString().slice(0, 10);
        if (!buckets.has(key))
          buckets.set(key, {
            week: key,
            inflow: 0,
            weightedQuotes: 0,
          });
        const row = buckets.get(key);
        if (entry.type === "inflow")
          row.inflow += entry.amount;
        else row.weightedQuotes += entry.amount;
      }

      const weeks = [...buckets.values()]
        .sort((a, b) => a.week.localeCompare(b.week))
        .map((x) => ({
          ...x,
          inflow: Math.round(x.inflow * 100) / 100,
          weightedQuotes:
            Math.round(x.weightedQuotes * 100) / 100,
          projected:
            Math.round(
              (x.inflow + x.weightedQuotes) * 100,
            ) / 100,
        }));

      res.json({
        horizonDays: horizon,
        outstandingInvoices:
          Math.round(
            entries
              .filter((x) => x.type === "inflow")
              .reduce((n, x) => n + x.amount, 0) * 100,
          ) / 100,
        weightedQuotes:
          Math.round(
            entries
              .filter((x) => x.type === "weighted_quote")
              .reduce((n, x) => n + x.amount, 0) * 100,
          ) / 100,
        weeks,
      });
    }),
  );

  r.get(
    "/automations/templates",
    wrap(async (req, res) => {
      ensureFeature(
        await canFeature(
          db,
          req.user,
          "automations.manage",
          ["admin", "direction"],
        ),
      );
      res.json({
        templates: [
          {
            id: "quote-accepted",
            name: "Devis accepté → notifier l’équipe",
            eventType: "quote.accepted",
            conditions: {},
            actions: [
              {
                type: "notify",
                category: "finance",
                title: "Devis accepté",
                body:
                  "Préparer le chantier et le planning.",
              },
            ],
          },
          {
            id: "change-order-approved",
            name:
              "Plus-value approuvée → créer une tâche",
            eventType:
              "project.change_order.approved",
            conditions: {},
            actions: [
              {
                type: "create_task",
                title:
                  "Intégrer la plus-value approuvée",
                priority: "high",
              },
            ],
          },
          {
            id: "crm-won",
            name:
              "Opportunité gagnée → notifier",
            eventType: "crm.won",
            conditions: {},
            actions: [
              {
                type: "notify",
                category: "crm",
                title: "Opportunité gagnée",
                body:
                  "Créer le dossier client et planifier la suite.",
              },
            ],
          },
        ],
      });
    }),
  );

  r.get(
    "/outbound",
    wrap(async (req, res) => {
      ensureFeature(
        await canFeature(
          db,
          req.user,
          "outbound.view",
          ["admin", "direction", "manager", "accounting"],
        ),
      );
      const rows = (
        await db.query(
          "SELECT id,channel,recipient,subject,message,status," +
            "provider_status,created_at,sent_at " +
            "FROM outbound_messages " +
            "ORDER BY created_at DESC LIMIT 200",
        )
      ).rows;
      res.json({ messages: rows });
    }),
  );

  r.post(
    "/outbound",
    wrap(async (req, res) => {
      ensureFeature(
        await canFeature(
          db,
          req.user,
          "outbound.send",
          ["admin", "direction", "manager", "accounting"],
        ),
      );
      const p = req.body || {};
      const channel = String(p.channel || "");
      if (!["email", "sms"].includes(channel))
        D.fail("Canal invalide.");
      const recipient = clean(p.recipient, 320);
      if (
        channel === "email" &&
        !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(
          recipient,
        )
      )
        D.fail("Adresse e-mail invalide.");
      if (
        channel === "sms" &&
        !/^\+?[0-9 ()-]{7,25}$/.test(recipient)
      )
        D.fail("Numéro de téléphone invalide.");

      const id = randomUUID();
      await db.query(
        "INSERT INTO outbound_messages" +
          "(id,channel,recipient,subject,message,metadata," +
          "status,created_by) " +
          "VALUES($1,$2,$3,$4,$5,$6,'queued',$7)",
        [
          id,
          channel,
          recipient,
          clean(p.subject, 300, true) || null,
          clean(p.message, 5000),
          safeObject(p.metadata),
          req.user.id,
        ],
      );
      const row = (
        await db.query(
          "SELECT * FROM outbound_messages WHERE id=$1",
          [id],
        )
      ).rows[0];
      const result = await dispatchOutbound(db, row);
      publish("outbound." + result.status, {
        userIds: [req.user.id],
        entityType: "outbound",
        entityId: id,
        payload: { channel, recipient },
      });
      res.json({ ok: true, id, ...result });
    }),
  );

  return r;
}

module.exports = { routes, dispatchOutbound };
