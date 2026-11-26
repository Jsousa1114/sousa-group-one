"use strict";
// « Avis Google »: a few days after a job is finished and paid, the client receives an e-mail
// asking for their opinion. The page it opens offers the Google review to everyone (Google forbids
// sending only satisfied clients there) and, next to it, a private message to the company and a
// way to stop such e-mails. Each job is asked once.
const express = require("express");
const { createHash, randomBytes } = require("node:crypto");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { loadState } = require("./db");
const mailer = require("./mailer");

const schemas = new WeakMap();
function ensureSchema(db) {
  if (!schemas.has(db))
    schemas.set(
      db,
      (async () => {
        await db.query(`CREATE TABLE IF NOT EXISTS review_settings (
          company TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT false, google_url TEXT NOT NULL DEFAULT '',
          delay_days INTEGER NOT NULL DEFAULT 3, enabled_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS review_requests (
          project_id TEXT PRIMARY KEY, company TEXT NOT NULL, client_id TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
          token_hash TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'Envoyée', manual BOOLEAN NOT NULL DEFAULT false,
          sent_at TIMESTAMPTZ, opened_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ, feedback TEXT NOT NULL DEFAULT '',
          feedback_at TIMESTAMPTZ, error TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS review_optout (email TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      })().catch((e) => {
        schemas.delete(db);
        throw e;
      }),
    );
  return schemas.get(db);
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const mailCompany = (data, id) => {
  const c = data.companies.find((x) => x.id === id);
  return c ? { id: String(c.id), name: c.name || "", code: c.code || "" } : { id: String(id) };
};
// A Google link: the review link of the company's Google profile (or its Maps page).
function googleUrl(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  let u;
  try {
    u = new URL(s);
  } catch {
    D.fail("Lien Google invalide.");
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !/(^|\.)(google\.[a-z.]+|g\.page|goo\.gl|g\.co)$/.test(host)) D.fail("Collez le lien de votre fiche Google (il commence par https://g.page, https://maps.app.goo.gl ou https://www.google.…).");
  return u.href;
}
async function settingsFor(db, company) {
  const r = (await db.query("SELECT * FROM review_settings WHERE company=$1", [company])).rows[0];
  return { enabled: !!r?.enabled, googleUrl: r?.google_url || "", delayDays: r?.delay_days ?? 3, enabledAt: r?.enabled_at || null };
}
const base = () => require("./mail-routes").publicUrl(null);
const day = (v) => String(v || "").slice(0, 10);

// Finished and fully paid: the day it became so, or "" while it is not.
function paidOn(data, p) {
  if (p.deletedAt || p.status !== "Terminé") return "";
  const invoices = data.invoices.filter((i) => !i.deletedAt && D.same(i.project, p.id) && i.status !== "Brouillon" && i.status !== "Annulée");
  if (!invoices.length || invoices.some((i) => i.status !== "Payée")) return "";
  const ids = new Set(invoices.map((i) => String(i.id)));
  const last = data.payments.filter((x) => ids.has(String(x.invoice))).reduce((m, x) => (day(x.date) > m ? day(x.date) : m), "");
  return [day(p.completedAt), last].sort().pop() || "";
}

async function send(db, data, p, { manual = false } = {}) {
  const settings = await settingsFor(db, p.company);
  if (!settings.googleUrl) D.fail("Indiquez d’abord le lien de votre fiche Google (Réglages des avis).");
  const company = data.companies.find((c) => c.id === p.company);
  if (!mailer.configured(mailCompany(data, p.company))) D.fail(`L’envoi d’e-mails n’est pas configuré pour ${company?.name || "cette entreprise"}.`);
  const client = data.clients.find((c) => D.same(c.id, p.clientId));
  const email = String(client?.email || "").trim().toLowerCase();
  if (!mailer.validEmail(email)) D.fail("Le client n’a pas d’adresse e-mail valide.");
  if ((await db.query("SELECT 1 FROM review_optout WHERE email=$1", [email])).rowCount) D.fail("Ce client a demandé à ne plus recevoir ces messages.");
  const url = base();
  if (!url) D.fail("Indiquez l’adresse de l’application (APP_URL) sur le serveur pour envoyer des liens.", 503);
  const token = randomBytes(24).toString("base64url");
  const claimed = await db.query(
    `INSERT INTO review_requests(project_id,company,client_id,email,token_hash,status,manual,sent_at) VALUES($1,$2,$3,$4,$5,'Envoi…',$6,NOW())
     ON CONFLICT (project_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,email=EXCLUDED.email,status='Envoi…',manual=EXCLUDED.manual,sent_at=NOW(),error=''
       WHERE review_requests.status IN ('Échec','Lien créé')
     RETURNING project_id`,
    [p.id, p.company, String(p.clientId || ""), email, hash(token), manual],
  );
  if (!claimed.rowCount) D.fail("L’avis a déjà été demandé pour ce chantier.");
  const { compose } = require("./mail-render");
  const ms = await require("./mail-settings").getSettings(db, p.company);
  const first = String(client.name || "").trim();
  const composed = compose({
    company,
    settings: ms,
    subject: "Votre avis sur notre travail",
    body: `Bonjour ${first},\n\nMerci de nous avoir fait confiance pour « ${p.title} ». Votre avis aide d’autres clients à nous choisir : il ne vous faudra qu’une minute.\n\nSi quelque chose ne vous a pas convenu, vous pouvez aussi nous l’écrire directement depuis la même page.`,
    button: { label: "Donner mon avis", url: `${url}/avis?t=${token}` },
  });
  try {
    await require("./mail-routes").sendLogged(
      db,
      { company: p.company, kind: "review", entityType: "projects", entityId: p.id },
      { to: email, subject: composed.subject, text: composed.text, html: composed.html, attachments: composed.attachments, company: mailCompany(data, p.company), fromName: company?.name || "", replyTo: mailer.validEmail(company?.billing?.email || "") ? company.billing.email : "" },
    );
    await db.query("UPDATE review_requests SET status='Envoyée' WHERE project_id=$1", [p.id]);
  } catch (e) {
    await db.query("UPDATE review_requests SET status='Échec', error=$2 WHERE project_id=$1", [p.id, mailer.friendlyError(e, "")]);
    D.fail(mailer.friendlyError(e, ""));
  }
  return { ok: true };
}

// Runs every hour: the jobs finished and paid since the requests were switched on, after the delay.
async function processReviewRequests(db, { now = new Date(), anyTime = false } = {}) {
  await ensureSchema(db);
  // Office hours on weekdays only, Swiss time.
  const zurich = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
  if (!anyTime && ([0, 6].includes(zurich.getDay()) || zurich.getHours() < 9 || zurich.getHours() >= 19)) return { sent: 0 };
  const companies = (await db.query("SELECT * FROM review_settings WHERE enabled=true AND google_url<>''")).rows;
  if (!companies.length) return { sent: 0 };
  const { data } = await loadState(db);
  const done = new Set((await db.query("SELECT project_id FROM review_requests")).rows.map((x) => x.project_id));
  const today = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const s of companies) {
    if (!mailer.configured(mailCompany(data, s.company))) continue;
    const since = s.enabled_at ? new Date(s.enabled_at).toISOString() : now.toISOString();
    let count = 0;
    for (const p of data.projects) {
      if (count >= 20) break;
      if (p.company !== s.company || done.has(p.id) || !p.completedAt || p.completedAt < since) continue;
      const ref = paidOn(data, p);
      if (!ref) continue;
      const due = new Date(ref + "T12:00:00Z");
      due.setUTCDate(due.getUTCDate() + Number(s.delay_days || 0));
      if (due.toISOString().slice(0, 10) > today) continue;
      try {
        await send(db, data, p);
        sent++;
        count++;
      } catch (e) {
        if (!e.expose) console.error("review.send", e?.code || "unknown");
      }
    }
  }
  return { sent };
}

function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  r.use((req, res, next) => {
    if (!D.privileged(req.user, [...D.OPS, ...D.FIN])) return next(new D.AppError("Accès refusé.", 403));
    res.set("Cache-Control", "no-store");
    ensureSchema(db).then(() => next(), next);
  });
  async function context(req) {
    const { data } = await loadState(db);
    return { data, user: D.effectiveUser(data, req.user) };
  }
  r.get(
    "/settings",
    wrap(async (req, res) => {
      const { data, user } = await context(req);
      const companies = data.companies.filter((c) => c.id !== "group" && D.inCompany(user, c.id));
      const out = [];
      for (const c of companies) out.push({ id: c.id, name: c.name, ...(await settingsFor(db, c.id)), mailReady: mailer.configured(mailCompany(data, c.id)) });
      const ids = companies.map((c) => c.id);
      const recent = ids.length
        ? (await db.query("SELECT project_id,company,status,sent_at,clicked_at,feedback,feedback_at FROM review_requests WHERE company = ANY($1::text[]) ORDER BY COALESCE(feedback_at,sent_at,created_at) DESC LIMIT 30", [ids])).rows
        : [];
      const title = (id) => data.projects.find((p) => p.id === id)?.title || id;
      res.json({
        companies: out,
        canEdit: D.privileged(user, D.STAFF),
        appUrl: !!base(),
        recent: recent.map((x) => ({ projectId: x.project_id, title: title(x.project_id), company: x.company, status: x.status, sentAt: x.sent_at, clicked: !!x.clicked_at, feedback: x.feedback, feedbackAt: x.feedback_at })),
      });
    }),
  );
  r.post(
    "/settings",
    wrap(async (req, res) => {
      const { data, user } = await context(req);
      if (!D.privileged(user, D.STAFF)) D.fail("Réservé à la direction.", 403);
      const company = String(req.body.company || "");
      if (!data.companies.some((c) => c.id === company && c.id !== "group") || !D.inCompany(user, company)) D.fail("Entreprise invalide.", 403);
      const url = googleUrl(req.body.googleUrl);
      const enabled = req.body.enabled === true && !!url;
      const delay = Math.round(D.num(req.body.delayDays ?? 3, "Délai", 0, 60));
      await db.query(
        `INSERT INTO review_settings(company,enabled,google_url,delay_days,enabled_at,updated_at) VALUES($1,$2,$3,$4,CASE WHEN $2 THEN NOW() END,NOW())
         ON CONFLICT (company) DO UPDATE SET enabled=EXCLUDED.enabled, google_url=EXCLUDED.google_url, delay_days=EXCLUDED.delay_days,
           enabled_at=CASE WHEN EXCLUDED.enabled AND NOT review_settings.enabled THEN NOW() WHEN EXCLUDED.enabled THEN review_settings.enabled_at ELSE NULL END, updated_at=NOW()`,
        [company, enabled, url, delay],
      );
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [user.email, "Réglages des avis Google", JSON.stringify({ company, enabled })]);
      res.json({ ok: true, settings: await settingsFor(db, company) });
    }),
  );
  async function project(req) {
    const { data, user } = await context(req);
    const p = data.projects.find((x) => D.same(x.id, req.params.id) && !x.deletedAt);
    if (!p || !D.canProject(data, user, p)) D.fail("Chantier introuvable.", 404);
    return { data, user, p };
  }
  r.get(
    "/project/:id",
    wrap(async (req, res) => {
      const { data, p } = await project(req);
      const row = (await db.query("SELECT status,sent_at,clicked_at,feedback,feedback_at,error,manual FROM review_requests WHERE project_id=$1", [p.id])).rows[0];
      const settings = await settingsFor(db, p.company);
      const client = data.clients.find((c) => D.same(c.id, p.clientId));
      res.json({
        request: row ? { status: row.status, sentAt: row.sent_at, clicked: !!row.clicked_at, feedback: row.feedback, feedbackAt: row.feedback_at, error: row.error, manual: row.manual } : null,
        finished: p.status === "Terminé",
        paidOn: paidOn(data, p),
        configured: !!settings.googleUrl,
        enabled: settings.enabled,
        delayDays: settings.delayDays,
        clientEmail: !!mailer.validEmail(String(client?.email || "")),
        mailReady: mailer.configured(mailCompany(data, p.company)),
      });
    }),
  );
  r.post(
    "/project/:id/send",
    wrap(async (req, res) => {
      const { data, p } = await project(req);
      if (p.status !== "Terminé") D.fail("Le chantier n’est pas terminé.");
      res.json(await send(db, data, p, { manual: true }));
    }),
  );
  // A link to send yourself (WhatsApp, SMS) instead of the e-mail.
  r.post(
    "/project/:id/link",
    wrap(async (req, res) => {
      const { data, p } = await project(req);
      if (p.status !== "Terminé") D.fail("Le chantier n’est pas terminé.");
      if (!(await settingsFor(db, p.company)).googleUrl) D.fail("Indiquez d’abord le lien de votre fiche Google (Réglages des avis).");
      const url = base() || `${req.protocol}://${req.get("host")}`;
      const token = randomBytes(24).toString("base64url");
      const client = data.clients.find((c) => D.same(c.id, p.clientId));
      const done = await db.query(
        `INSERT INTO review_requests(project_id,company,client_id,email,token_hash,status,manual,sent_at) VALUES($1,$2,$3,$4,$5,'Lien créé',true,NOW())
         ON CONFLICT (project_id) DO UPDATE SET token_hash=EXCLUDED.token_hash, sent_at=NOW() WHERE review_requests.status IN ('Lien créé','Échec')
         RETURNING project_id`,
        [p.id, p.company, String(p.clientId || ""), String(client?.email || "").toLowerCase(), hash(token)],
      );
      if (!done.rowCount) D.fail("L’avis a déjà été demandé par e-mail pour ce chantier.");
      res.json({ ok: true, url: `${url}/avis?t=${token}`, phone: client?.phone || "", name: client?.name || "" });
    }),
  );
  return r;
}

function publicRoutes(db) {
  const r = express.Router();
  const attempts = new Map();
  const limited = (key, max) => {
    const now = Date.now();
    if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
    let a = attempts.get(key);
    if (!a || a.until < now) attempts.set(key, (a = { count: 0, until: now + 15 * 60000 }));
    return ++a.count > max;
  };
  r.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (limited("ip:" + req.ip, 120)) return next(new D.AppError("Trop de requêtes. Réessayez dans quelques minutes.", 429));
    ensureSchema(db).then(() => next(), next);
  });
  async function find(token) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ""))) D.fail("Lien invalide.", 404);
    const row = (await db.query("SELECT * FROM review_requests WHERE token_hash=$1", [hash(token)])).rows[0];
    if (!row) D.fail("Ce lien n’est plus valable.", 404);
    return row;
  }
  r.get(
    "/:token",
    wrap(async (req, res) => {
      const row = await find(req.params.token);
      const { data } = await loadState(db);
      const company = data.companies.find((c) => c.id === row.company);
      const s = await settingsFor(db, row.company);
      if (!row.opened_at) await db.query("UPDATE review_requests SET opened_at=NOW() WHERE project_id=$1", [row.project_id]);
      res.json({ company: company?.name || "", companyId: company?.id || "", googleUrl: s.googleUrl, feedbackSent: !!row.feedback, optedOut: !!(row.email && (await db.query("SELECT 1 FROM review_optout WHERE email=$1", [row.email])).rowCount) });
    }),
  );
  r.post(
    "/:token/google",
    wrap(async (req, res) => {
      const row = await find(req.params.token);
      await db.query("UPDATE review_requests SET clicked_at=COALESCE(clicked_at,NOW()), status=CASE WHEN status IN ('Envoyée','Lien créé') THEN 'Avis Google ouvert' ELSE status END WHERE project_id=$1", [row.project_id]);
      res.json({ url: (await settingsFor(db, row.company)).googleUrl });
    }),
  );
  r.post(
    "/:token/feedback",
    wrap(async (req, res) => {
      const row = await find(req.params.token);
      if (limited("fb:" + row.project_id, 5)) D.fail("Message déjà envoyé.", 429);
      const text = D.text(String(req.body?.text || ""), "Message", 3000);
      await db.query("UPDATE review_requests SET feedback=$2, feedback_at=NOW(), status='Remarque reçue' WHERE project_id=$1", [row.project_id, text]);
      const { data } = await loadState(db);
      const p = data.projects.find((x) => x.id === row.project_id);
      const users = (await db.query("SELECT id,company FROM users WHERE role IN ('admin','direction','manager') AND disabled=false AND deleted_at IS NULL")).rows.filter((u) => u.company === "group" || u.company === row.company);
      await require("./messaging-routes")
        .notifyUsers(db, users.map((u) => u.id), { category: "messages", title: "Remarque d’un client", body: `${p?.title || "Chantier"} : ${text.slice(0, 140)}`, url: "/?open=projects" })
        .catch(() => {});
      res.json({ ok: true });
    }),
  );
  r.post(
    "/:token/optout",
    wrap(async (req, res) => {
      const row = await find(req.params.token);
      if (row.email) await db.query("INSERT INTO review_optout(email) VALUES($1) ON CONFLICT DO NOTHING", [row.email]);
      res.json({ ok: true });
    }),
  );
  return r;
}
module.exports = { routes, publicRoutes, processReviewRequests, paidOn, ensureSchema, googleUrl };
