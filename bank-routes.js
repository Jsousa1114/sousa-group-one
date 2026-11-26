"use strict";
// « Importer le relevé bancaire »: the credits of an e-banking statement become payments of the
// invoices they pay, after the person has checked the proposal. Each bank line is recorded once.
const express = require("express");
const D = require("./domain");
const Finance = require("./finance");
const { auth } = require("./auth-middleware");
const { loadState } = require("./db");
const { readStatement, matchCredits } = require("./bank-import");

const schemas = new WeakMap();
function ensureSchema(db) {
  if (!schemas.has(db))
    schemas.set(
      db,
      db
        .query(
          `CREATE TABLE IF NOT EXISTS bank_transactions (
            key TEXT PRIMARY KEY, account TEXT NOT NULL DEFAULT '', booked_on TEXT,
            amount NUMERIC(14,2) NOT NULL, debtor TEXT NOT NULL DEFAULT '',
            invoice_id TEXT NOT NULL, payment_id TEXT NOT NULL,
            imported_by INTEGER, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`,
        )
        .catch((e) => {
          schemas.delete(db);
          throw e;
        }),
    );
  return schemas.get(db);
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function statement(body) {
  const raw = String(body?.file || "");
  if (!raw || raw.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) D.fail("Choisissez le fichier du relevé (XML ou ZIP).");
  try {
    return readStatement(Buffer.from(raw, "base64"));
  } catch (e) {
    D.fail(e.message || "Relevé illisible.");
  }
}
const requested = (i) => {
  try {
    return Finance.paymentSummary(i).requested;
  } catch {
    return i.amount - (i.paid || 0);
  }
};
// The invoices this person may pay, limited to the company whose account the statement is for.
function scope(data, user, accounts) {
  const view = D.viewState(data, user);
  const owners = data.companies.filter((c) => c.billing?.iban && accounts.includes(String(c.billing.iban).replace(/\s/g, "").toUpperCase()));
  const companies = owners.map((c) => c.id);
  return {
    companies: owners.map((c) => ({ id: c.id, name: c.name })),
    invoices: view.invoices.filter((i) => !companies.length || companies.includes(i.company)),
    clients: view.clients,
  };
}

function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  r.use((req, res, next) => {
    if (!D.privileged(req.user, D.FIN)) return next(new D.AppError("Accès finances requis.", 403));
    res.set("Cache-Control", "no-store");
    ensureSchema(db).then(() => next(), next);
  });

  r.post(
    "/preview",
    wrap(async (req, res) => {
      const st = statement(req.body);
      const { data } = await loadState(db);
      const user = D.effectiveUser(data, req.user);
      const sc = scope(data, user, st.accounts);
      const keys = st.credits.map((c) => c.key);
      const imported = new Set(
        keys.length ? (await db.query("SELECT key FROM bank_transactions WHERE key = ANY($1::text[])", [keys])).rows.map((x) => x.key) : [],
      );
      const lines = matchCredits(st.credits, sc.invoices, sc.clients, { imported, requested });
      res.json({
        accounts: st.accounts,
        companies: sc.companies,
        lines: lines.map(({ debtorIban, ...l }) => l),
        counts: ["sure", "check", "unknown", "done"].reduce((o, k) => ({ ...o, [k]: lines.filter((l) => l.status === k).length }), {}),
      });
    }),
  );

  r.post(
    "/confirm",
    wrap(async (req, res) => {
      const st = statement(req.body);
      const wanted = Array.isArray(req.body.items) ? req.body.items.slice(0, 2000) : [];
      if (!wanted.length) D.fail("Aucun paiement sélectionné.");
      const byKey = new Map(st.credits.map((c) => [c.key, c]));
      const client = await db.connect();
      const created = [],
        skipped = [];
      try {
        await client.query("BEGIN");
        const row = await loadState(client, { forUpdate: true });
        const user = D.effectiveUser(row.data, req.user);
        const sc = scope(row.data, user, st.accounts);
        const allowed = new Set(sc.invoices.map((i) => i.id));
        const now = new Date().toISOString();
        for (const item of wanted) {
          const credit = byKey.get(String(item?.key || ""));
          const invoiceId = String(item?.invoice || "");
          if (!credit || !invoiceId || !allowed.has(invoiceId)) {
            skipped.push({ key: item?.key, reason: "Ligne ou facture introuvable." });
            continue;
          }
          const done = await client.query("SELECT 1 FROM bank_transactions WHERE key=$1", [credit.key]);
          if (done.rowCount) {
            skipped.push({ key: credit.key, reason: "Déjà enregistré." });
            continue;
          }
          await client.query("SAVEPOINT pay");
          const invoice = row.data.invoices.find((i) => i.id === invoiceId);
          const before = invoice ? { paid: invoice.paid, status: invoice.status } : null,
            count = row.data.payments.length;
          try {
            const payment = D.applyCommand(
              row.data,
              user,
              {
                action: "create",
                collection: "payments",
                payload: {
                  invoice: invoiceId,
                  amount: credit.amount,
                  date: credit.date || now.slice(0, 10),
                  method: "Virement bancaire (relevé)",
                },
              },
              now,
            ).result;
            payment.bankKey = credit.key;
            if (credit.debtor) payment.payer = credit.debtor;
            await client.query(
              "INSERT INTO bank_transactions(key,account,booked_on,amount,debtor,invoice_id,payment_id,imported_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
              [credit.key, credit.account, credit.date || null, credit.amount, credit.debtor, invoiceId, payment.id, req.user.id],
            );
            await client.query("RELEASE SAVEPOINT pay");
            created.push({ key: credit.key, invoice: invoiceId, payment: payment.id, amount: credit.amount });
          } catch (e) {
            await client.query("ROLLBACK TO SAVEPOINT pay");
            row.data.payments.length = count;
            if (invoice && before) Object.assign(invoice, before);
            if (!e.expose) throw e;
            skipped.push({ key: credit.key, reason: e.message });
          }
        }
        if (created.length) {
          const { persistedState, syncEntityMirror } = require("./db");
          await client.query("UPDATE app_state SET data=$1,revision=revision+1,updated_at=NOW(),updated_by=$2 WHERE id=1", [
            JSON.stringify(persistedState(row.data)),
            user.email,
          ]);
          await syncEntityMirror(client, row.data, ["payments", "invoices"]);
          await client.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [
            user.email,
            "Import du relevé bancaire",
            JSON.stringify({ payments: created.length, total: created.reduce((t, c) => t + c.amount, 0), accounts: st.accounts }),
          ]);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      res.json({ ok: true, created, skipped });
    }),
  );

  r.get(
    "/history",
    wrap(async (req, res) => {
      const { data } = await loadState(db);
      const user = D.effectiveUser(data, req.user);
      const visible = new Set(D.viewState(data, user).invoices.map((i) => i.id));
      const rows = (
        await db.query("SELECT booked_on,amount,debtor,invoice_id,imported_at FROM bank_transactions ORDER BY imported_at DESC, booked_on DESC LIMIT 300")
      ).rows.filter((x) => visible.has(x.invoice_id));
      res.json({ rows: rows.slice(0, 100) });
    }),
  );
  return r;
}
module.exports = { routes, ensureSchema };
