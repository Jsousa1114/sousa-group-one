"use strict";
// E-mails sent by the application: invoices and quotes with their PDF, messages prepared
// with the assistant, and automatic payment reminders. Every e-mail is recorded in email_log
// (recipient, subject, outcome), never its content.
const express = require("express");
const { randomUUID } = require("node:crypto");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { loadState } = require("./db");
const mailer = require("./mailer");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const REMINDER_SETTING = "invoice_email_reminders";
const STAGES = [7, 14, 30];

const swissDate = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || "") ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso || "");
const swissMoney = (n) => "CHF " + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
const remainingOf = (invoice) => Math.max(0, Math.round(((Number(invoice.amount) || 0) - (Number(invoice.paid) || 0)) * 100) / 100);
const text = (value, max) => String(value ?? "").replace(/\r/g, "").trim().slice(0, max);

async function log(db, entry) {
  await db.query(
    `INSERT INTO email_log(id,company,kind,entity_type,entity_id,recipient,subject,status,error,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      entry.company || null,
      entry.kind,
      entry.entityType || null,
      entry.entityId ? String(entry.entityId) : null,
      String(entry.recipient || "").slice(0, 254),
      String(entry.subject || "").slice(0, 250),
      entry.status,
      entry.error ? String(entry.error).slice(0, 500) : null,
      entry.createdBy || null,
    ],
  );
}

// Sends and records the outcome; a failure is recorded and then reported to the caller.
async function sendLogged(db, entry, message) {
  try {
    await mailer.sendMail(message);
    await log(db, { ...entry, recipient: message.to, subject: message.subject, status: "sent" });
  } catch (error) {
    await log(db, { ...entry, recipient: message.to, subject: message.subject, status: "failed", error: error.message });
    throw error;
  }
}

// The document, its issuer and its customer as the PDF shows them.
function financeParts(state, kind, document) {
  const issuer = document.issuer || D.ref(state, "companies", document.company);
  const customer = document.customer || D.ref(state, "clients", document.clientId);
  return { issuer, customer };
}
// With fallback, an invoice whose QR slip cannot be produced (missing IBAN or address)
// is still sent, without the slip; otherwise the reason is reported to the person.
async function financePdf(kind, document, issuer, customer, qr, { fallback = false } = {}) {
  const { renderPDF } = require("./finance-pdf");
  try {
    return await renderPDF(document, kind, issuer, customer, qr);
  } catch (error) {
    if (!qr || !fallback || !(error?.status < 500)) throw error;
    return renderPDF(document, kind, issuer, customer, false);
  }
}
const replyToFor = (issuer) => (mailer.validEmail(issuer?.billing?.email || "") ? issuer.billing.email : "");

function defaultFinanceMessage(kind, document, issuer, customer) {
  const name = customer?.name ? " " + customer.name : "";
  const what = kind === "quotes" ? `notre devis ${document.id}` : `notre facture ${document.id}`;
  const due = kind === "invoices" && document.due ? `, payable jusqu’au ${swissDate(document.due)}` : "";
  const validity = kind === "quotes" && document.valid ? `, valable jusqu’au ${swissDate(document.valid)}` : "";
  return (
    `Bonjour${name},\n\nVous trouverez en pièce jointe ${what}${document.title ? " (" + document.title + ")" : ""} d’un montant de ${swissMoney(document.amount)}${due}${validity}.\n\n` +
    (kind === "quotes" ? "Nous restons à votre disposition pour toute question.\n\n" : "Le bulletin de versement QR figure sur la dernière page.\n\n") +
    `Meilleures salutations\n${issuer?.name || "Sousa Group One"}`
  );
}

// Payment reminders: polite at 7 days, firmer at 14, last reminder at 30.
function reminderMessage(stage, invoice, issuer, customer) {
  const hello = "Bonjour" + (customer?.name ? " " + customer.name : "") + ",";
  const facts = `la facture ${invoice.id}${invoice.title ? " (" + invoice.title + ")" : ""} du ${swissDate(invoice.date)}, échue le ${swissDate(invoice.due)}, présente un solde de ${swissMoney(remainingOf(invoice))}`;
  const bye = `Meilleures salutations\n${issuer?.name || "Sousa Group One"}`;
  const attached = "Vous trouverez la facture avec le bulletin de versement QR en pièce jointe.";
  if (stage === 7)
    return {
      subject: `Rappel : facture ${invoice.id}`,
      text: `${hello}\n\nSauf erreur de notre part, ${facts}.\n\n${attached} Si le paiement a été effectué entre-temps, merci de ne pas tenir compte de ce message.\n\n${bye}`,
    };
  if (stage === 14)
    return {
      subject: `Deuxième rappel : facture ${invoice.id}`,
      text: `${hello}\n\nMalgré notre précédent rappel, ${facts}.\n\nNous vous remercions de bien vouloir procéder au règlement dans les 10 jours. ${attached}\n\nSi vous rencontrez une difficulté, n’hésitez pas à nous contacter en répondant à ce message.\n\n${bye}`,
    };
  return {
    subject: `Dernier rappel : facture ${invoice.id}`,
    text: `${hello}\n\nMalgré nos rappels, ${facts}.\n\nNous vous prions de régler ce montant dans les 10 jours. Sans paiement ni nouvelles de votre part dans ce délai, nous devrons engager la procédure de recouvrement.\n\n${attached}\n\n${bye}`,
  };
}

async function reminderSettings(db) {
  const row = (await db.query("SELECT enabled,config FROM integration_settings WHERE provider=$1", [REMINDER_SETTING])).rows[0];
  return { enabled: !!row?.enabled, enabledAt: row?.config?.enabledAt || null };
}

const zurichParts = (date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit", hour12: false })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
const addDays = (iso, days) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Which reminder an invoice is due for today, if any. Stages reached before the reminders
// were switched on are never sent afterwards (no burst of old reminders).
function dueStage(invoice, today, enabledDay) {
  if (invoice.deletedAt || invoice.archivedAt || ["Brouillon", "Payée"].includes(invoice.status) || !invoice.due) return 0;
  if (!(remainingOf(invoice) > 0)) return 0;
  const reached = STAGES.filter((stage) => addDays(invoice.due, stage) <= today);
  const stage = reached.at(-1) || 0;
  if (!stage || addDays(invoice.due, stage) < enabledDay) return 0;
  return stage;
}

async function processEmailReminders(db, now = new Date()) {
  if (!mailer.configured()) return { sent: 0 };
  const settings = await reminderSettings(db);
  if (!settings.enabled || !settings.enabledAt) return { sent: 0 };
  // Weekdays, office hours (Zurich).
  const z = zurichParts(now);
  const clock = z.hour + ":" + z.minute;
  if (["Sat", "Sun"].includes(z.weekday) || clock < "08:00" || clock >= "18:00") return { sent: 0 };
  const today = `${z.year}-${z.month}-${z.day}`;
  const enabledDay = String(settings.enabledAt).slice(0, 10);
  const state = (await loadState(db)).data;
  let sent = 0;
  const refused = new Set();
  for (const invoice of state.invoices || []) {
    if (sent >= 20) break;
    if (refused.has(invoice.company)) continue;
    const stage = dueStage(invoice, today, enabledDay);
    if (!stage) continue;
    const kind = "reminder-" + stage;
    const history = (
      await db.query("SELECT status FROM email_log WHERE entity_type='invoices' AND entity_id=$1 AND kind=$2", [String(invoice.id), kind])
    ).rows;
    if (history.some((h) => h.status === "sent" || h.status === "skipped") || history.filter((h) => h.status === "failed").length >= 3) continue;
    let issuer, customer;
    try {
      ({ issuer, customer } = financeParts(state, "invoices", invoice));
    } catch {
      continue;
    }
    // No Gmail account for this company (nor a default one): wait until there is one.
    if (!mailer.configured(invoice.company)) continue;
    const message = reminderMessage(stage, invoice, issuer, customer);
    const entry = { company: invoice.company, kind, entityType: "invoices", entityId: invoice.id };
    if (!mailer.validEmail(customer?.email || "")) {
      await log(db, { ...entry, recipient: "", subject: message.subject, status: "skipped", error: "Pas d’adresse e-mail valide pour ce client." });
      continue;
    }
    try {
      const pdf = await financePdf("invoices", invoice, issuer, customer, true, { fallback: true });
      await sendLogged(db, entry, {
        to: customer.email,
        subject: message.subject,
        text: message.text,
        company: invoice.company,
        fromName: issuer?.name,
        replyTo: replyToFor(issuer),
        attachments: [{ filename: `${invoice.id}.pdf`, content: pdf, contentType: "application/pdf" }],
      });
      sent++;
    } catch (error) {
      console.warn("mail.reminder.failed", invoice.id, error?.status || "");
      // A refused login: the other invoices of this company would fail the same way.
      if (/refusé la connexion/.test(error.message)) refused.add(invoice.company);
    }
  }
  return { sent };
}

function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  const finance = (user) => D.privileged(user, D.FIN);
  const staff = (user) => user.role !== "client";
  const visibleCompany = (user, company) => (company ? D.inCompany(user, company) : user.company === "group");

  r.get(
    "/status",
    wrap(async (req, res) => {
      if (!staff(req.user)) D.fail("Accès non autorisé.", 403);
      const state = D.viewState((await loadState(db)).data, req.user);
      // Each company sends from its own Gmail account, or from the default one.
      const companies = (state.companies || []).map((c) => {
        const from = mailer.sender(c.id);
        return { id: String(c.id), name: c.name || String(c.id), address: from?.address || "", own: from?.source === "company" };
      });
      res.json({
        configured: mailer.configured(),
        companies,
        reminders: finance(req.user) ? await reminderSettings(db) : undefined,
      });
    }),
  );

  r.post(
    "/test",
    wrap(async (req, res) => {
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const company = text(req.body?.company, 80);
      const state = D.viewState((await loadState(db)).data, req.user);
      const co = company ? (state.companies || []).find((c) => D.same(c.id, company)) : null;
      if (company && !co) D.fail("Entreprise non autorisée.", 403);
      const from = mailer.sender(company);
      if (!from) D.fail(`Aucune adresse Gmail n’est configurée pour ${co?.name || "l’envoi"}.`, 503);
      const to = text(req.body?.to, 254) || from.address;
      await sendLogged(
        db,
        { kind: "test", company: company || null, createdBy: req.user.id },
        {
          to,
          company,
          fromName: co?.name,
          subject: `Test d’envoi · ${co?.name || "Sousa Group One"}`,
          text: `Bonjour,\n\nCet e-mail confirme que l’application Sousa Group One peut envoyer des e-mails${co ? " pour " + co.name : ""} depuis ${from.address}.\n\nEnvoyé par ${req.user.name || "un utilisateur"} le ${new Date().toLocaleString("fr-CH", { timeZone: "Europe/Zurich" })}.`,
        },
      );
      res.json({ ok: true, to, from: from.address });
    }),
  );

  r.get(
    "/log",
    wrap(async (req, res) => {
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const params = [];
      const where = [];
      if (req.query.entityType && req.query.entityId) {
        params.push(String(req.query.entityType), String(req.query.entityId));
        where.push("entity_type=$1 AND entity_id=$2");
      }
      const rows = (
        await db.query(
          `SELECT kind,entity_type,entity_id,recipient,subject,status,error,created_at,company FROM email_log
           ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 200`,
          params,
        )
      ).rows.filter((row) => row.kind === "test" || visibleCompany(req.user, row.company));
      res.json({ emails: rows.slice(0, Math.min(200, Number(req.query.limit) || 50)).map(({ company, ...row }) => row) });
    }),
  );

  // An issued quote or invoice, with its PDF (and the QR payment slip for an invoice).
  r.post(
    "/finance/:kind/:id",
    wrap(async (req, res) => {
      const { kind, id } = req.params;
      if (!["quotes", "invoices"].includes(kind)) D.fail("Document introuvable.", 404);
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const state = D.viewState((await loadState(db)).data, req.user);
      const document = state[kind].find((x) => D.same(x.id, id));
      if (!document) D.fail("Document introuvable.", 404);
      if (document.status === "Brouillon") D.fail("Émettez le document avant de l’envoyer.");
      const { issuer, customer } = financeParts(state, kind, document);
      if (!mailer.configured(document.company)) D.fail(`Aucune adresse Gmail n’est configurée pour ${issuer?.name || document.company}.`, 503);
      const to = text(req.body?.to, 254) || customer?.email || "";
      if (!mailer.validEmail(to)) D.fail("Indiquez une adresse e-mail valide pour le client.");
      const qr = kind === "invoices" && req.body?.qr !== false && document.status !== "Payée";
      const pdf = await financePdf(kind, document, issuer, customer, qr);
      const subject = text(req.body?.subject, 200) || `${kind === "quotes" ? "Devis" : "Facture"} ${document.id} — ${issuer?.name || "Sousa Group One"}`;
      const body = text(req.body?.text, 8000) || defaultFinanceMessage(kind, document, issuer, customer);
      await sendLogged(
        db,
        { company: document.company, kind: kind === "quotes" ? "quote" : "invoice", entityType: kind, entityId: document.id, createdBy: req.user.id },
        { to, subject, text: body, company: document.company, fromName: issuer?.name, replyTo: replyToFor(issuer), attachments: [{ filename: `${document.id}.pdf`, content: pdf, contentType: "application/pdf" }] },
      );
      res.json({ ok: true, to, from: mailer.sender(document.company)?.address || "" });
    }),
  );

  // A message prepared with the assistant (reminder, quote follow-up, progress update).
  r.post(
    "/client-message",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, [...new Set([...D.FIN, ...D.OPS])])) D.fail("Accès non autorisé.", 403);
      const kind = String(req.body?.kind || "");
      if (!["invoice_reminder", "quote_followup", "project_update"].includes(kind)) D.fail("Type de message invalide.");
      const id = text(req.body?.id, 200);
      const row = await loadState(db);
      const ctx = { data: row.data, view: D.viewState(row.data, req.user) };
      // The same check as for preparing the message: the person must see the record.
      const facts = require("./p3-intelligence-routes").emailFacts(ctx, kind, id);
      const to = text(req.body?.to, 254);
      const subject = text(req.body?.subject, 200);
      const body = text(req.body?.body, 8000);
      if (!mailer.validEmail(to)) D.fail("Adresse e-mail du destinataire invalide.");
      if (!subject || !body) D.fail("Objet et texte requis.");
      const entityType = kind === "invoice_reminder" ? "invoices" : kind === "quote_followup" ? "quotes" : "projects";
      const record = ctx.view[entityType].find((x) => D.same(x.id, id));
      const attachments = [];
      let replyTo = "";
      const companyName = (ctx.view.companies || []).find((c) => D.same(c.id, record?.company))?.name || "";
      if (!mailer.configured(record?.company || "")) D.fail(`Aucune adresse Gmail n’est configurée pour ${companyName || "cette entreprise"}.`, 503);
      if (entityType !== "projects") {
        const { issuer, customer } = financeParts(ctx.view, entityType, record);
        replyTo = replyToFor(issuer);
        if (req.body?.attach !== false)
          attachments.push({
            filename: `${record.id}.pdf`,
            content: await financePdf(entityType, record, issuer, customer, entityType === "invoices", { fallback: true }),
            contentType: "application/pdf",
          });
      }
      await sendLogged(
        db,
        { company: record?.company || null, kind: "message-" + kind, entityType, entityId: id, createdBy: req.user.id },
        { to, subject, text: body, replyTo, attachments, company: record?.company || "", fromName: companyName },
      );
      res.json({ ok: true, to, attached: attachments.length > 0, facts: { client: facts.client } });
    }),
  );

  r.get(
    "/reminders",
    wrap(async (req, res) => {
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const settings = await reminderSettings(db);
      const state = D.viewState((await loadState(db)).data, req.user);
      const z = zurichParts(new Date());
      const today = `${z.year}-${z.month}-${z.day}`;
      const overdue = (state.invoices || [])
        .filter((i) => !i.archivedAt && !["Brouillon", "Payée"].includes(i.status) && i.due && i.due < today && remainingOf(i) > 0)
        .map((i) => {
          let customer = null;
          try {
            customer = financeParts(state, "invoices", i).customer;
          } catch {
            customer = null;
          }
          const lateDays = Math.round((Date.parse(today + "T12:00:00Z") - Date.parse(i.due + "T12:00:00Z")) / 86400000);
          const next = STAGES.find((stage) => stage > lateDays);
          return {
            id: i.id,
            client: customer?.name || "",
            email: mailer.validEmail(customer?.email || "") ? customer.email : "",
            due: i.due,
            lateDays,
            remaining: remainingOf(i),
            nextReminder: next ? addDays(i.due, next) : "",
          };
        })
        .sort((a, b) => b.lateDays - a.lateDays);
      res.json({ ...settings, stages: STAGES, overdue });
    }),
  );

  r.post(
    "/reminders",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, ["admin", "direction", "accounting"])) D.fail("Accès non autorisé.", 403);
      const enabled = req.body?.enabled === true;
      if (enabled && !mailer.configured()) D.fail("Configurez d’abord l’envoi d’e-mails sur le serveur.", 503);
      const current = await reminderSettings(db);
      const config = enabled ? { enabledAt: current.enabled && current.enabledAt ? current.enabledAt : new Date().toISOString(), enabledBy: req.user.id } : {};
      await db.query(
        `INSERT INTO integration_settings(provider,enabled,config,updated_by,updated_at) VALUES($1,$2,$3,$4,NOW())
         ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,config=EXCLUDED.config,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
        [REMINDER_SETTING, enabled, JSON.stringify(config), req.user.id],
      );
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [req.user.email || "", "mail.reminders." + (enabled ? "on" : "off"), JSON.stringify({})]);
      res.json(await reminderSettings(db));
    }),
  );

  return r;
}

module.exports = { routes, processEmailReminders, reminderMessage, dueStage };
