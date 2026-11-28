"use strict";
const Contacts = require("./contacts");
// E-mails sent by the application: invoices and quotes with their PDF, messages prepared with
// the assistant, payment reminders, quote follow-ups, appointment confirmations, client portal
// invitations and replies received from clients. Every e-mail is recorded in email_log
// (recipient, subject, outcome, Message-ID), never its content.
const express = require("express");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const bcrypt = require("bcryptjs");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { loadState } = require("./db");
const mailer = require("./mailer");
const MS = require("./mail-settings");
const { compose } = require("./mail-render");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const WEEKDAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

const swissDate = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || "") ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso || "");
const swissMoney = (n) => "CHF " + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
const remainingOf = (invoice) => Math.max(0, Math.round(((Number(invoice.amount) || 0) - (Number(invoice.paid) || 0)) * 100) / 100);
const text = (value, max) => String(value ?? "").replace(/\r/g, "").trim().slice(0, max);
const zurichParts = (date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit", hour12: false })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
const zurichDay = (date) => {
  const z = zurichParts(date);
  return `${z.year}-${z.month}-${z.day}`;
};
const addDays = (iso, days) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const weekday = (iso) => WEEKDAYS[new Date(iso + "T12:00:00Z").getUTCDay()];

// Address of the application in links. Password links only use the configured address
// (APP_URL, or the passkey origin): never the Host header of the request, which anyone can
// forge to make a reset link point elsewhere.
function trustedUrl() {
  const rpId = String(process.env.WEBAUTHN_RP_ID || "").trim();
  return String(process.env.APP_URL || process.env.WEBAUTHN_ORIGIN || (rpId && rpId !== "localhost" ? "https://" + rpId : ""))
    .trim()
    .replace(/\/+$/, "");
}
function publicUrl(req) {
  return trustedUrl() || (req ? `${req.protocol}://${req.get("host")}` : "");
}

async function log(db, entry) {
  await db.query(
    `INSERT INTO email_log(id,company,kind,entity_type,entity_id,recipient,subject,status,error,created_by,message_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
      entry.messageId || null,
    ],
  );
}

// Sends and records the outcome; a failure is recorded and then reported to the caller.
async function sendLogged(db, entry, message) {
  try {
    const info = await mailer.sendMail(message);
    await log(db, { ...entry, recipient: message.to, subject: message.subject, status: "sent", messageId: info?.messageId });
    return info;
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
// The company as the mail account lookup needs it (id, name, code): accounts are saved under
// the company's name ("Sousa Moving" → SMTP_USER_MOVING) or its id.
const companyOf = (state, id) => {
  const c = (state?.companies || []).find((x) => D.same(x.id, id));
  return c ? { id: String(c.id), name: c.name || "", code: c.code || "" } : { id: String(id || "") };
};
const companyRecord = (state, id) => (state?.companies || []).find((x) => D.same(x.id, id)) || { id: String(id || ""), name: "" };
const replyToFor = (issuer) => (mailer.validEmail(issuer?.billing?.email || "") ? issuer.billing.email : "");

// Values of the {fields} for a quote or an invoice.
function documentValues(kind, document, issuer, customer) {
  return {
    client: customer?.name || "",
    entreprise: issuer?.name || "",
    document: document.id,
    objet: document.title ? ` (${document.title})` : "",
    montant: swissMoney(document.amount),
    reste: swissMoney(kind === "invoices" ? remainingOf(document) : document.amount),
    echeance: swissDate(document.due),
    validite: swissDate(document.valid),
    date_document: swissDate(document.date),
  };
}

// A message from a template of the company's settings (or from texts written by the person),
// laid out with the logo and signature, with the company's hidden copy and reply address.
async function deliver(db, state, { entry, to, companyId, template, values = {}, subject, body, attachments = [], button = null, replyTo = "", sender = "", closing = true }) {
  const company = companyRecord(state, companyId);
  const settings = await MS.getSettings(db, company.id);
  const finalSubject = subject || MS.fill(settings.templates[template].subject, { entreprise: company.name, ...values });
  const finalBody = body || MS.fill(settings.templates[template].body, { entreprise: company.name, ...values });
  const composed = compose({ company, settings, subject: finalSubject, body: finalBody, button, sender, closing });
  return sendLogged(db, entry, {
    to,
    subject: composed.subject,
    text: composed.text,
    html: composed.html,
    attachments: [...attachments, ...composed.attachments],
    bcc: settings.bcc,
    replyTo: replyTo || replyToFor(company),
    company: companyOf(state, company.id),
    fromName: company.name,
  });
}

// A link to the client area, only for clients who have one.
async function portalButton(db, req, clientId, kind) {
  if (!clientId) return null;
  const account = (await db.query("SELECT id FROM users WHERE client_id=$1 AND disabled=false AND deleted_at IS NULL LIMIT 1", [String(clientId)])).rows[0];
  const base = publicUrl(req);
  if (!account || !base) return null;
  return { label: kind === "quotes" ? "Voir le devis dans mon espace client" : "Voir la facture dans mon espace client", url: `${base}/?open=${kind}` };
}

// Extra attachments: documents of the application the person can open, and files added now.
async function extraAttachments(db, data, user, documentIds, uploads) {
  const out = [];
  const ids = Array.isArray(documentIds) ? documentIds.slice(0, 5) : [];
  for (const id of ids) {
    const doc = (data.documents || []).find((d) => D.same(d.id, id) && !d.deletedAt);
    if (!doc || !D.canDocument(data, user, doc)) D.fail("Document joint inaccessible.", 403);
    const file = await require("./storage").loadFile(db, doc.id);
    if (!file) D.fail(`Fichier introuvable : ${doc.name}.`, 404);
    out.push({ filename: String(doc.name || "document").slice(0, 120), content: Buffer.from(file.content) });
  }
  const files = Array.isArray(uploads) ? uploads.slice(0, 3) : [];
  let total = 0;
  for (const f of files) {
    const content = Buffer.from(String(f?.content || ""), "base64");
    total += content.length;
    if (!content.length) D.fail("Pièce jointe vide.");
    if (total > 5 * 1024 * 1024) D.fail("Pièces jointes ajoutées : 5 Mo au maximum au total.");
    const name = String(f?.name || "piece-jointe").replace(/[\\/\r\n]/g, "_").slice(0, 120);
    out.push({ filename: name, content, contentType: String(f?.type || "application/octet-stream").slice(0, 100) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Automatic sendings: payment reminders, quote follow-ups, appointment confirmations and
// reminders. Each one is switched on per company and only concerns what happens after it was
// switched on; each is sent once (email_log), during the day.
// ---------------------------------------------------------------------------
async function alreadyDone(db, entityType, entityId, kind) {
  const rows = (await db.query("SELECT status FROM email_log WHERE entity_type=$1 AND entity_id=$2 AND kind=$3", [entityType, String(entityId), kind])).rows;
  return rows.some((h) => h.status === "sent" || h.status === "skipped") || rows.filter((h) => h.status === "failed").length >= 3;
}

function dueStage(invoice, today, enabledDay, stages = [7, 14, 30]) {
  if (invoice.deletedAt || invoice.archivedAt || ["Brouillon", "Payée"].includes(invoice.status) || !invoice.due) return 0;
  if (!(remainingOf(invoice) > 0)) return 0;
  const index = stages.map((stage) => addDays(invoice.due, stage) <= today).lastIndexOf(true);
  if (index < 0 || addDays(invoice.due, stages[index]) < enabledDay) return 0;
  return index + 1;
}

// The interventions of one project on one day, as one appointment.
function appointments(state, from, to) {
  const groups = new Map();
  for (const p of state.planning || []) {
    if (!p.date || p.date < from || p.date > to) continue;
    const key = String(p.project) + "|" + p.date;
    const g = groups.get(key) || { key, projectId: String(p.project), date: p.date, entries: [] };
    g.entries.push(p);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const project = (state.projects || []).find((x) => D.same(x.id, g.projectId) && !x.deletedAt);
    const firstName = (id) => String((state.employees || []).find((e) => D.same(e.id, id))?.name || "").split(" ")[0];
    return {
      ...g,
      project,
      start: g.entries.map((e) => e.start).sort()[0] || "",
      end: g.entries.map((e) => e.end).sort().at(-1) || "",
      createdAt: g.entries.map((e) => e.createdAt || "").sort()[0] || "",
      team: [...new Set(g.entries.map((e) => firstName(e.employeeId)).filter(Boolean))],
      address: g.entries.find((e) => e.location)?.location || project?.address || "",
    };
  });
}

async function processEmailAutomations(db, now = new Date()) {
  const result = { reminders: 0, quoteFollowups: 0, appointments: 0, appointmentReminders: 0 };
  if (!mailer.configured()) return result;
  const z = zurichParts(now);
  const clock = z.hour + ":" + z.minute;
  if (clock < "08:00" || clock >= "18:00") return result;
  const weekend = ["Sat", "Sun"].includes(z.weekday);
  const today = `${z.year}-${z.month}-${z.day}`;
  const state = (await loadState(db)).data;
  const settingsCache = new Map();
  const settingsOf = async (company) => {
    if (!settingsCache.has(company)) settingsCache.set(company, await MS.getSettings(db, company));
    return settingsCache.get(company);
  };
  const refused = new Set();
  let budget = 30;
  const attempt = async (company, fn) => {
    if (refused.has(company) || budget <= 0) return false;
    try {
      await fn();
      budget--;
      return true;
    } catch (error) {
      console.warn("mail.automation.failed", error?.status || "");
      // A refused login: the other e-mails of this company would fail the same way.
      if (/refusé la connexion/.test(error.message)) refused.add(company);
      return false;
    }
  };

  // Payment reminders (weekdays).
  for (const invoice of weekend ? [] : state.invoices || []) {
    const s = await settingsOf(invoice.company);
    const auto = s.automations.invoiceReminders;
    if (!auto.enabled || !auto.enabledAt || !mailer.configured(companyOf(state, invoice.company))) continue;
    const stage = dueStage(invoice, today, String(auto.enabledAt).slice(0, 10), s.reminderStages);
    if (!stage) continue;
    const kind = "reminder-" + stage;
    if (await alreadyDone(db, "invoices", invoice.id, kind)) continue;
    let issuer, customer;
    try {
      ({ issuer, customer } = financeParts(state, "invoices", invoice));
    } catch {
      continue;
    }
    const entry = { company: invoice.company, kind, entityType: "invoices", entityId: invoice.id };
    if (!mailer.validEmail(customer?.email || "")) {
      await log(db, { ...entry, recipient: "", subject: "Rappel de facture " + invoice.id, status: "skipped", error: "Pas d’adresse e-mail valide pour ce client." });
      continue;
    }
    if (
      await attempt(invoice.company, async () => {
        const pdf = await financePdf("invoices", invoice, issuer, customer, true, { fallback: true });
        await deliver(db, state, {
          entry,
          to: customer.email,
          companyId: invoice.company,
          template: "reminder" + stage,
          values: documentValues("invoices", invoice, issuer, customer),
          attachments: [{ filename: `${invoice.id}.pdf`, content: pdf, contentType: "application/pdf" }],
          replyTo: replyToFor(issuer),
          button: await portalButton(db, null, invoice.clientId, "invoices"),
        });
      })
    )
      result.reminders++;
  }

  // Quotes without an answer (weekdays): one follow-up, X days after they were sent.
  for (const quote of weekend ? [] : state.quotes || []) {
    if (quote.deletedAt || quote.archivedAt || quote.status !== "Émise" || (quote.valid && quote.valid < today)) continue;
    const s = await settingsOf(quote.company);
    const auto = s.automations.quoteFollowup;
    if (!auto.enabled || !auto.enabledAt || !mailer.configured(companyOf(state, quote.company))) continue;
    const sent = (await db.query("SELECT created_at FROM email_log WHERE entity_type='quotes' AND entity_id=$1 AND kind IN ('quote','quote-auto') AND status='sent' ORDER BY created_at DESC LIMIT 1", [String(quote.id)])).rows[0];
    const reference = sent ? zurichDay(new Date(sent.created_at)) : quote.date;
    if (!reference) continue;
    const due = addDays(reference, auto.days);
    if (due > today || due < String(auto.enabledAt).slice(0, 10)) continue;
    if (await alreadyDone(db, "quotes", quote.id, "quote-followup")) continue;
    let issuer, customer;
    try {
      ({ issuer, customer } = financeParts(state, "quotes", quote));
    } catch {
      continue;
    }
    const entry = { company: quote.company, kind: "quote-followup", entityType: "quotes", entityId: quote.id };
    if (!mailer.validEmail(customer?.email || "")) {
      await log(db, { ...entry, recipient: "", subject: "Relance du devis " + quote.id, status: "skipped", error: "Pas d’adresse e-mail valide pour ce client." });
      continue;
    }
    if (
      await attempt(quote.company, async () => {
        const pdf = await financePdf("quotes", quote, issuer, customer, false);
        await deliver(db, state, {
          entry,
          to: customer.email,
          companyId: quote.company,
          template: "quoteFollowup",
          values: documentValues("quotes", quote, issuer, customer),
          attachments: [{ filename: `${quote.id}.pdf`, content: pdf, contentType: "application/pdf" }],
          replyTo: replyToFor(issuer),
          button: await portalButton(db, null, quote.clientId, "quotes"),
        });
      })
    )
      result.quoteFollowups++;
  }

  // Appointments: confirmation once planned (for a later day), reminder the day before.
  const tomorrow = addDays(today, 1);
  for (const a of appointments(state, tomorrow, addDays(today, 60))) {
    if (!a.project || a.project.deletedAt || ["Terminé", "Archivé"].includes(a.project.status)) continue;
    const s = await settingsOf(a.project.company);
    const auto = s.automations.appointments;
    if (!auto.enabled || !auto.enabledAt || !mailer.configured(companyOf(state, a.project.company))) continue;
    const client = (state.clients || []).find((c) => D.same(c.id, a.project.clientId) && !c.deletedAt);
    const values = {
      client: client?.name || "",
      chantier: a.project.title || "",
      jour: weekday(a.date),
      date: swissDate(a.date),
      heure_debut: a.start,
      heure_fin: a.end,
      adresse: a.address,
      equipe: a.team.join(", ") || "notre équipe",
    };
    const confirmKind = "appointment";
    const reminderKind = "appointment-reminder";
    const entryBase = { company: a.project.company, entityType: "appointments", entityId: a.key };
    const hasEmail = mailer.validEmail(client?.email || "");
    // Confirmation: only for appointments planned after the sending was switched on (weekdays).
    if (!weekend && a.createdAt && a.createdAt >= auto.enabledAt && !(await alreadyDone(db, "appointments", a.key, confirmKind))) {
      if (!hasEmail)
        await log(db, { ...entryBase, kind: confirmKind, recipient: "", subject: "Confirmation d’intervention", status: "skipped", error: "Pas d’adresse e-mail valide pour ce client." });
      else if (await attempt(a.project.company, () => deliver(db, state, { entry: { ...entryBase, kind: confirmKind }, to: client.email, companyId: a.project.company, template: "appointment", values })))
        result.appointments++;
    }
    // Reminder the day before (any day of the week), if the confirmation went out or the
    // appointment was planned after the switch.
    if (auto.dayBefore && a.date === tomorrow && hasEmail && !(await alreadyDone(db, "appointments", a.key, reminderKind))) {
      const confirmed = await alreadyDone(db, "appointments", a.key, confirmKind);
      if ((confirmed || (a.createdAt && a.createdAt >= auto.enabledAt)) && (await attempt(a.project.company, () => deliver(db, state, { entry: { ...entryBase, kind: reminderKind }, to: client.email, companyId: a.project.company, template: "appointmentReminder", values }))))
        result.appointmentReminders++;
    }
  }
  return result;
}

// Sending at issue: when the company asked for it, the issued document goes to the client.
async function autoSendIssued(db, userId, kind, id) {
  try {
    const state = (await loadState(db)).data;
    const document = (state[kind] || []).find((x) => D.same(x.id, id));
    if (!document || document.status === "Brouillon") return;
    const s = await MS.getSettings(db, document.company);
    if (!s.automations[kind === "invoices" ? "autoSendInvoices" : "autoSendQuotes"].enabled) return;
    if (!mailer.configured(companyOf(state, document.company))) return;
    const { issuer, customer } = financeParts(state, kind, document);
    const entry = { company: document.company, kind: kind === "quotes" ? "quote-auto" : "invoice-auto", entityType: kind, entityId: document.id, createdBy: userId };
    if (!mailer.validEmail(customer?.email || "")) {
      await log(db, { ...entry, recipient: "", subject: (kind === "quotes" ? "Devis " : "Facture ") + document.id, status: "skipped", error: "Pas d’adresse e-mail valide pour ce client." });
      return;
    }
    const pdf = await financePdf(kind, document, issuer, customer, kind === "invoices", { fallback: true });
    await deliver(db, state, {
      entry,
      to: customer.email,
      companyId: document.company,
      template: kind === "quotes" ? "quote" : "invoice",
      values: documentValues(kind, document, issuer, customer),
      attachments: [{ filename: `${document.id}.pdf`, content: pdf, contentType: "application/pdf" }],
      replyTo: replyToFor(issuer),
      button: await portalButton(db, null, document.clientId, kind),
    });
  } catch (error) {
    console.warn("mail.auto_send.failed", kind, error?.status || "");
  }
}

// ---------------------------------------------------------------------------
// One-time links: client portal invitation and forgotten password. Only a hash of the link
// is stored; it can be used once, before it expires.
// ---------------------------------------------------------------------------
const tokenHash = (token) => createHash("sha256").update(String(token)).digest("hex");
async function createToken(db, userId, purpose, hours) {
  const token = randomBytes(32).toString("base64url");
  await db.query("UPDATE password_tokens SET used_at=NOW() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL", [userId, purpose]);
  await db.query("INSERT INTO password_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,NOW() + ($4 || ' hours')::interval)", [tokenHash(token), userId, purpose, String(hours)]);
  return token;
}

function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  const finance = (user) => D.privileged(user, D.FIN);
  const staff = (user) => user.role !== "client";
  const settingsEditor = (user) => D.privileged(user, ["admin", "direction", "accounting"]);
  const visibleCompany = (user, company) => (company ? D.inCompany(user, company) : user.company === "group");
  const viewOf = async (user) => {
    const data = (await loadState(db)).data;
    return { data, view: D.viewState(data, user) };
  };

  r.get(
    "/status",
    wrap(async (req, res) => {
      if (!staff(req.user)) D.fail("Accès non autorisé.", 403);
      const { view } = await viewOf(req.user);
      // Each company sends from its own Gmail account, or from the default one.
      const companies = [];
      for (const c of view.companies || []) {
        const from = mailer.sender(companyOf(view, c.id));
        const s = finance(req.user) ? await MS.getSettings(db, c.id) : null;
        companies.push({
          id: String(c.id),
          name: c.name || String(c.id),
          address: from?.address || "",
          own: from?.source === "company",
          automations: s ? Object.fromEntries(Object.entries(s.automations).map(([k, v]) => [k, !!v.enabled])) : undefined,
        });
      }
      const unread = finance(req.user)
        ? (await db.query("SELECT company FROM email_inbox WHERE read_at IS NULL")).rows.filter((row) => visibleCompany(req.user, row.company)).length
        : 0;
      res.json({ configured: mailer.configured(), companies, unread });
    }),
  );

  r.get(
    "/settings/:company",
    wrap(async (req, res) => {
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const { view } = await viewOf(req.user);
      const company = (view.companies || []).find((c) => D.same(c.id, req.params.company));
      if (!company) D.fail("Entreprise non autorisée.", 403);
      res.json({
        company: { id: String(company.id), name: company.name, billingEmail: company.billing?.email || "" },
        settings: await MS.getSettings(db, company.id),
        templates: Object.fromEntries(Object.entries(MS.TEMPLATES).map(([k, t]) => [k, { label: t.label, subject: t.subject, body: t.body }])),
        fields: MS.FIELDS,
        canEdit: settingsEditor(req.user),
      });
    }),
  );

  r.post(
    "/settings/:company",
    wrap(async (req, res) => {
      if (!settingsEditor(req.user)) D.fail("Accès non autorisé.", 403);
      const { view } = await viewOf(req.user);
      const company = (view.companies || []).find((c) => D.same(c.id, req.params.company));
      if (!company) D.fail("Entreprise non autorisée.", 403);
      const turningOn = Object.values(req.body?.automations || {}).some((a) => a?.enabled === true);
      if (turningOn && !mailer.configured(companyOf(view, company.id))) D.fail(`Configurez d’abord l’adresse Gmail de ${company.name}.`, 503);
      const settings = await MS.saveSettings(db, company.id, req.body || {}, req.user.id);
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [req.user.email || "", "mail.settings", JSON.stringify({ company: String(company.id) })]);
      res.json({ settings });
    }),
  );

  // The laid-out e-mail as the client will see it (sample values, or a real document).
  r.get(
    "/preview",
    wrap(async (req, res) => {
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const { view } = await viewOf(req.user);
      const company = (view.companies || []).find((c) => D.same(c.id, req.query.company));
      if (!company) D.fail("Entreprise non autorisée.", 403);
      const template = String(req.query.template || "invoice");
      if (!MS.TEMPLATES[template]) D.fail("Modèle inconnu.");
      const settings = await MS.getSettings(db, company.id);
      // The signature being edited (not saved yet) is shown as typed.
      for (const key of ["phone", "website", "extra"]) if (req.query[key] !== undefined) settings.signature[key] = text(req.query[key], 300);
      const sample = {
        client: "Sophie Bernard",
        entreprise: company.name,
        document: template.startsWith("quote") ? "D-2026-0012" : "F-2026-0042",
        objet: " (Rénovation salle de bain)",
        montant: "CHF 4'820.50",
        reste: "CHF 2'410.25",
        echeance: swissDate(addDays(zurichDay(new Date()), 30)),
        validite: swissDate(addDays(zurichDay(new Date()), 30)),
        date_document: swissDate(zurichDay(new Date())),
        chantier: "Rénovation salle de bain",
        jour: weekday(addDays(zurichDay(new Date()), 1)),
        date: swissDate(addDays(zurichDay(new Date()), 1)),
        heure_debut: "08:00",
        heure_fin: "16:30",
        adresse: "Rue du Lac 4, 1003 Lausanne",
        equipe: "Lucas, Nina",
      };
      const subject = req.query.subject ? text(req.query.subject, 200) : MS.fill(settings.templates[template].subject, sample);
      const body = req.query.body ? MS.fill(text(req.query.body, 6000), sample) : MS.fill(settings.templates[template].body, sample);
      const composed = compose({
        company,
        settings,
        subject,
        body,
        button: template === "invite" ? { label: "Créer mon mot de passe", url: publicUrl(req) + "/" } : null,
      });
      const logo = composed.attachments[0]?.content;
      const html = logo ? composed.html.replace("cid:logo@sousa", "data:image/png;base64," + logo.toString("base64")) : composed.html;
      // Shown inside the application in a frame: inline styles of the e-mail allowed, nothing else.
      res
        .set({
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'",
          "X-Frame-Options": "SAMEORIGIN",
          "Cache-Control": "no-store",
        })
        .type("html")
        .send(html);
    }),
  );

  r.post(
    "/test",
    wrap(async (req, res) => {
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const company = text(req.body?.company, 80);
      const { view } = await viewOf(req.user);
      const co = company ? (view.companies || []).find((c) => D.same(c.id, company)) : null;
      if (company && !co) D.fail("Entreprise non autorisée.", 403);
      const account = co ? companyOf(view, co.id) : "";
      const from = mailer.sender(account);
      if (!from) D.fail(`Aucune adresse Gmail n’est configurée pour ${co?.name || "l’envoi"}.`, 503);
      const to = text(req.body?.to, 254) || from.address;
      const body = `Bonjour,\n\nCet e-mail confirme que l’application Sousa Group One peut envoyer des e-mails${co ? " pour " + co.name : ""} depuis ${from.address}.\n\nEnvoyé par ${req.user.name || "un utilisateur"} le ${new Date().toLocaleString("fr-CH", { timeZone: "Europe/Zurich" })}.`;
      const subject = `Test d’envoi · ${co?.name || "Sousa Group One"}`;
      if (co) await deliver(db, view, { entry: { kind: "test", company: company, createdBy: req.user.id }, to, companyId: co.id, subject, body });
      else await sendLogged(db, { kind: "test", createdBy: req.user.id }, { to, subject, text: body, company: account });
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

  // What the send form starts from: recipient, subject and text from the company's templates,
  // and the documents that can be added (those of the same client or project).
  r.get(
    "/draft/:kind/:id",
    wrap(async (req, res) => {
      const { kind, id } = req.params;
      if (!["quotes", "invoices"].includes(kind)) D.fail("Document introuvable.", 404);
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const { view } = await viewOf(req.user);
      const document = view[kind].find((x) => D.same(x.id, id));
      if (!document) D.fail("Document introuvable.", 404);
      const { issuer, customer } = financeParts(view, kind, document);
      const settings = await MS.getSettings(db, document.company);
      const template = kind === "quotes" ? "quote" : "invoice";
      const values = { entreprise: issuer?.name || "", ...documentValues(kind, document, issuer, customer) };
      const documents = (view.documents || [])
        .filter((d) => !d.deletedAt && ((document.project && D.same(d.project, document.project)) || (d.clientId && D.same(d.clientId, document.clientId))))
        .slice(0, 30)
        .map((d) => ({ id: String(d.id), name: d.name, category: d.category || "" }));
      const client = (view.clients || []).find((c) => D.same(c.id, document.clientId));
      res.json({
        to: customer?.email || "",
        // Every address of the client's card, to choose who receives it.
        emails: Contacts.emails(client || customer || {}),
        from: mailer.sender(companyOf(view, document.company))?.address || "",
        subject: MS.fill(settings.templates[template].subject, values),
        body: MS.fill(settings.templates[template].body, values),
        bcc: settings.bcc,
        documents,
        portal: !!(await portalButton(db, req, document.clientId, kind)),
        companyHasAccount: mailer.configured(companyOf(view, document.company)),
      });
    }),
  );

  // An issued quote or invoice, with its PDF (and the QR payment slip for an invoice).
  r.post(
    "/finance/:kind/:id",
    wrap(async (req, res) => {
      const { kind, id } = req.params;
      if (!["quotes", "invoices"].includes(kind)) D.fail("Document introuvable.", 404);
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const { data, view } = await viewOf(req.user);
      const document = view[kind].find((x) => D.same(x.id, id));
      if (!document) D.fail("Document introuvable.", 404);
      if (document.status === "Brouillon") D.fail("Émettez le document avant de l’envoyer.");
      const { issuer, customer } = financeParts(view, kind, document);
      const account = companyOf(view, document.company);
      if (!mailer.configured(account)) D.fail(`Aucune adresse Gmail n’est configurée pour ${issuer?.name || document.company}.`, 503);
      // One or several addresses (the client's card may have several), five at most.
      const wanted = mailer.addressList(req.body?.to).slice(0, 6);
      if (!wanted.length && customer?.email) wanted.push(customer.email);
      if (!wanted.length || wanted.some((a) => !mailer.validEmail(a))) D.fail("Indiquez une adresse e-mail valide pour le client.");
      if (wanted.length > 5) D.fail("Cinq destinataires au maximum.");
      const to = [...new Set(wanted.map((a) => a.trim()))].join(", ");
      const qr = kind === "invoices" && req.body?.qr !== false && document.status !== "Payée";
      const pdf = await financePdf(kind, document, issuer, customer, qr);
      const extra = await extraAttachments(db, data, req.user, req.body?.documentIds, req.body?.uploads);
      await deliver(db, view, {
        entry: { company: document.company, kind: kind === "quotes" ? "quote" : "invoice", entityType: kind, entityId: document.id, createdBy: req.user.id },
        to,
        companyId: document.company,
        template: kind === "quotes" ? "quote" : "invoice",
        values: documentValues(kind, document, issuer, customer),
        subject: text(req.body?.subject, 200) || undefined,
        body: text(req.body?.text, 8000) || undefined,
        attachments: [{ filename: `${document.id}.pdf`, content: pdf, contentType: "application/pdf" }, ...extra],
        replyTo: replyToFor(issuer),
        button: req.body?.portal === false ? null : await portalButton(db, req, document.clientId, kind),
        sender: req.body?.signed === false ? "" : req.user.name || "",
      });
      res.json({ ok: true, to, from: mailer.sender(account)?.address || "", attachments: 1 + extra.length });
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
      const { data, view } = await viewOf(req.user);
      const ctx = { data, view };
      // The same check as for preparing the message: the person must see the record.
      const facts = require("./p3-intelligence-routes").emailFacts(ctx, kind, id);
      const to = text(req.body?.to, 254);
      const subject = text(req.body?.subject, 200);
      const body = text(req.body?.body, 8000);
      if (!mailer.validEmail(to)) D.fail("Adresse e-mail du destinataire invalide.");
      if (!subject || !body) D.fail("Objet et texte requis.");
      const entityType = kind === "invoice_reminder" ? "invoices" : kind === "quote_followup" ? "quotes" : "projects";
      const record = view[entityType].find((x) => D.same(x.id, id));
      const attachments = [];
      let replyTo = "";
      const companyName = (view.companies || []).find((c) => D.same(c.id, record?.company))?.name || "";
      if (!mailer.configured(companyOf(view, record?.company))) D.fail(`Aucune adresse Gmail n’est configurée pour ${companyName || "cette entreprise"}.`, 503);
      if (entityType !== "projects") {
        const { issuer, customer } = financeParts(view, entityType, record);
        replyTo = replyToFor(issuer);
        if (req.body?.attach !== false)
          attachments.push({
            filename: `${record.id}.pdf`,
            content: await financePdf(entityType, record, issuer, customer, entityType === "invoices", { fallback: true }),
            contentType: "application/pdf",
          });
      }
      // The assistant's text already ends with a greeting formula and a signature.
      await deliver(db, view, {
        entry: { company: record?.company || null, kind: "message-" + kind, entityType, entityId: id, createdBy: req.user.id },
        to,
        companyId: record?.company,
        subject,
        body,
        attachments,
        replyTo,
        closing: false,
      });
      res.json({ ok: true, to, attached: attachments.length > 0, facts: { client: facts.client } });
    }),
  );

  r.get(
    "/reminders",
    wrap(async (req, res) => {
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const { view } = await viewOf(req.user);
      const today = zurichDay(new Date());
      const overdue = [];
      for (const i of view.invoices || []) {
        if (i.archivedAt || ["Brouillon", "Payée"].includes(i.status) || !i.due || i.due >= today || !(remainingOf(i) > 0)) continue;
        let customer = null;
        try {
          customer = financeParts(view, "invoices", i).customer;
        } catch {
          customer = null;
        }
        const s = await MS.getSettings(db, i.company);
        const lateDays = Math.round((Date.parse(today + "T12:00:00Z") - Date.parse(i.due + "T12:00:00Z")) / 86400000);
        const next = s.reminderStages.find((stage) => stage > lateDays);
        overdue.push({
          id: i.id,
          company: String(i.company),
          client: customer?.name || "",
          email: mailer.validEmail(customer?.email || "") ? customer.email : "",
          due: i.due,
          lateDays,
          remaining: remainingOf(i),
          remindersOn: s.automations.invoiceReminders.enabled,
          nextReminder: next ? addDays(i.due, next) : "",
        });
      }
      overdue.sort((a, b) => b.lateDays - a.lateDays);
      res.json({ overdue });
    }),
  );

  // Kept for compatibility: switches the payment reminders of every visible company.
  r.post(
    "/reminders",
    wrap(async (req, res) => {
      if (!settingsEditor(req.user)) D.fail("Accès non autorisé.", 403);
      const enabled = req.body?.enabled === true;
      if (enabled && !mailer.configured()) D.fail("Configurez d’abord l’envoi d’e-mails sur le serveur.", 503);
      const { view } = await viewOf(req.user);
      for (const c of view.companies || []) await MS.saveSettings(db, c.id, { automations: { invoiceReminders: { enabled } } }, req.user.id);
      res.json({ enabled });
    }),
  );

  // ----- Client portal invitations -----
  const canInvite = (user) => D.privileged(user, ["admin", "direction"]);
  r.get(
    "/portal-clients",
    wrap(async (req, res) => {
      if (!canInvite(req.user)) D.fail("Accès non autorisé.", 403);
      const { view } = await viewOf(req.user);
      const accounts = (await db.query("SELECT id,client_id,last_login_at,disabled FROM users WHERE client_id IS NOT NULL AND deleted_at IS NULL")).rows;
      const invites = (await db.query("SELECT entity_id,MAX(created_at) AS at FROM email_log WHERE kind='invite' AND status='sent' GROUP BY entity_id")).rows;
      res.json({
        clients: (view.clients || [])
          .filter((c) => !c.deletedAt)
          .map((c) => {
            const account = accounts.find((u) => D.same(u.client_id, c.id));
            return {
              id: String(c.id),
              name: c.name || "",
              company: String(c.company || ""),
              email: mailer.validEmail(c.email || "") ? c.email : "",
              hasAccount: !!account && !account.disabled,
              lastLogin: account?.last_login_at || null,
              invitedAt: invites.find((x) => D.same(x.entity_id, c.id))?.at || null,
              canSend: mailer.configured(companyOf(view, c.company)),
            };
          }),
      });
    }),
  );

  r.post(
    "/invite-client",
    wrap(async (req, res) => {
      if (!canInvite(req.user)) D.fail("Accès non autorisé.", 403);
      const { view } = await viewOf(req.user);
      const client = (view.clients || []).find((c) => D.same(c.id, req.body?.clientId) && !c.deletedAt);
      if (!client || !client.company) D.fail("Client inaccessible.", 403);
      const email = String(client.email || "").trim().toLowerCase();
      if (!mailer.validEmail(email)) D.fail("Ajoutez d’abord une adresse e-mail valide sur la fiche du client.");
      if (!mailer.configured(companyOf(view, client.company))) D.fail("Aucune adresse Gmail n’est configurée pour cette entreprise.", 503);
      let user = (await db.query("SELECT * FROM users WHERE client_id=$1 AND deleted_at IS NULL", [String(client.id)])).rows[0];
      if (!user) {
        const other = (await db.query("SELECT id FROM users WHERE email=$1", [email])).rows[0];
        if (other) D.fail("Cette adresse e-mail est déjà utilisée par un autre compte.");
        // The account cannot be used before the client chooses a password through the link.
        const unusable = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
        const initials = String(client.name || "Client").split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase() || "CL";
        user = (
          await db.query(
            "INSERT INTO users(email,password_hash,role,name,avatar,company,client_id) VALUES($1,$2,'client',$3,$4,$5,$6) RETURNING *",
            [email, unusable, String(client.name || email).slice(0, 160), initials, String(client.company), String(client.id)],
          )
        ).rows[0];
        await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [req.user.email || "", "Compte client créé (invitation)", JSON.stringify({ clientId: String(client.id) })]);
      } else if (user.disabled) D.fail("Le compte de ce client est désactivé.");
      const token = await createToken(db, user.id, "invite", 24 * 7);
      const base = trustedUrl();
      if (!base) D.fail("Indiquez l’adresse de l’application (APP_URL) sur le serveur pour envoyer des liens d’invitation.", 503);
      await deliver(db, view, {
        entry: { company: client.company, kind: "invite", entityType: "clients", entityId: client.id, createdBy: req.user.id },
        to: email,
        companyId: client.company,
        template: "invite",
        values: { client: client.name || "" },
        button: { label: "Créer mon mot de passe", url: `${base}/?invite=${token}` },
      });
      res.json({ ok: true, to: email, created: true });
    }),
  );

  // ----- Replies from clients -----
  r.get(
    "/inbox",
    wrap(async (req, res) => {
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const params = [];
      const where = [];
      if (req.query.entityType && req.query.entityId) {
        params.push(String(req.query.entityType), String(req.query.entityId));
        where.push(`entity_type=$${params.length - 1} AND entity_id=$${params.length}`);
      }
      if (req.query.clientId) {
        params.push(String(req.query.clientId));
        where.push(`client_id=$${params.length}`);
      }
      const rows = (
        await db.query(
          `SELECT id,company,account,from_address,from_name,subject,body,attachments,received_at,client_id,entity_type,entity_id,read_at FROM email_inbox
           ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY received_at DESC NULLS LAST LIMIT 200`,
          params,
        )
      ).rows.filter((row) => visibleCompany(req.user, row.company));
      const { view } = await viewOf(req.user);
      res.json({
        replies: rows.slice(0, Math.min(200, Number(req.query.limit) || 50)).map(({ company, ...row }) => ({
          ...row,
          client: (view.clients || []).find((c) => D.same(c.id, row.client_id))?.name || "",
        })),
      });
    }),
  );
  r.post(
    "/inbox/:id/read",
    wrap(async (req, res) => {
      if (!finance(req.user)) D.fail("Accès non autorisé.", 403);
      const row = (await db.query("SELECT company FROM email_inbox WHERE id=$1", [String(req.params.id)])).rows[0];
      if (!row || !visibleCompany(req.user, row.company)) D.fail("Message introuvable.", 404);
      await db.query("UPDATE email_inbox SET read_at=COALESCE(read_at,NOW()),read_by=COALESCE(read_by,$2) WHERE id=$1", [String(req.params.id), req.user.id]);
      res.json({ ok: true });
    }),
  );

  return r;
}

// Public routes (no session): forgotten password and choosing a password from a link.
function publicRoutes(db) {
  const r = express.Router();
  const attempts = new Map();
  const limited = (key, max) => {
    const now = Date.now();
    if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
    let a = attempts.get(key);
    if (!a || a.until < now) attempts.set(key, (a = { count: 0, until: now + 60 * 60000 }));
    return ++a.count > max;
  };

  // The link is sent in the background: the answer is the same, and as fast, whether the
  // account exists or not.
  async function sendResetLink(email) {
    const base = trustedUrl();
    if (!base) return console.warn("mail.forgot.no_app_url");
    const user = (await db.query("SELECT * FROM users WHERE email=$1 AND disabled=false AND deleted_at IS NULL", [email])).rows[0];
    if (!user) return;
    const state = (await loadState(db)).data;
    // The client's company, or the person's company, or any company with an account.
    const client = user.client_id ? (state.clients || []).find((c) => D.same(c.id, user.client_id)) : null;
    const candidates = [client?.company, user.company, ...(state.companies || []).map((c) => c.id)].filter(Boolean);
    const companyId = candidates.find((id) => id !== "group" && mailer.configured(companyOf(state, id))) || candidates.find((id) => mailer.configured(companyOf(state, id)));
    if (!companyId) return;
    const token = await createToken(db, user.id, "reset", 1);
    await deliver(db, state, {
      entry: { company: companyId, kind: "password-reset", entityType: "users", entityId: user.id },
      to: user.email,
      companyId,
      subject: "Réinitialisation de votre mot de passe",
      body: `Bonjour ${user.name || ""},\n\nVous avez demandé à changer le mot de passe de votre compte Sousa Group One. Choisissez-en un nouveau avec le bouton ci-dessous (lien valable 1 heure, utilisable une seule fois).\n\nSi vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe actuel reste valable.`,
      button: { label: "Choisir un nouveau mot de passe", url: `${base}/?reset=${token}` },
    });
  }
  r.post(
    "/forgot",
    wrap(async (req, res) => {
      const email = text(req.body?.email, 255).toLowerCase();
      res.json({ ok: true, message: "Si un compte existe pour cette adresse, un e-mail avec un lien vient d’être envoyé." });
      if (!mailer.validEmail(email) || limited("ip:" + req.ip, 10) || limited("mail:" + email, 3)) return;
      sendResetLink(email).catch((error) => console.warn("mail.forgot.failed", error?.status || ""));
    }),
  );

  r.get(
    "/token",
    wrap(async (req, res) => {
      if (limited("token:" + req.ip, 30)) D.fail("Trop de tentatives. Réessayez plus tard.", 429);
      const row = (
        await db.query(
          "SELECT t.purpose,u.email,u.name FROM password_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.used_at IS NULL AND t.expires_at>NOW() AND u.disabled=false AND u.deleted_at IS NULL",
          [tokenHash(String(req.query.token || ""))],
        )
      ).rows[0];
      if (!row) return res.json({ valid: false });
      const [local, domain] = row.email.split("@");
      res.json({ valid: true, purpose: row.purpose, email: local.slice(0, 2) + "•••@" + domain, name: row.name });
    }),
  );

  r.post(
    "/password",
    wrap(async (req, res) => {
      if (limited("set:" + req.ip, 20)) D.fail("Trop de tentatives. Réessayez plus tard.", 429);
      const password = String(req.body?.password || "");
      if (password.length < 12 || password.length > 200) D.fail("Le mot de passe doit contenir au moins 12 caractères.");
      const hash = tokenHash(String(req.body?.token || ""));
      const row = (
        await db.query(
          "UPDATE password_tokens SET used_at=NOW() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() RETURNING user_id,purpose",
          [hash],
        )
      ).rows[0];
      if (!row) D.fail("Ce lien n’est plus valable. Demandez-en un nouveau.", 400);
      const user = (await db.query("SELECT id,email,disabled,deleted_at FROM users WHERE id=$1", [row.user_id])).rows[0];
      if (!user || user.disabled || user.deleted_at) D.fail("Ce compte n’est pas actif.", 403);
      // A new password ends the other sessions; two-factor authentication stays required.
      await db.query("UPDATE users SET password_hash=$1,session_version=session_version+1 WHERE id=$2", [await bcrypt.hash(password, 12), user.id]);
      await db.query("UPDATE password_tokens SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL", [user.id]);
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [user.email, row.purpose === "invite" ? "Mot de passe créé (invitation)" : "Mot de passe réinitialisé", "{}"]);
      res.json({ ok: true, email: user.email });
    }),
  );
  return r;
}

module.exports = {
  routes,
  publicRoutes,
  publicUrl,
  processEmailAutomations,
  processEmailReminders: processEmailAutomations,
  autoSendIssued,
  dueStage,
  appointments,
  documentValues,
  sendLogged,
  log,
  tokenHash,
  financeParts,
  financePdf,
};
