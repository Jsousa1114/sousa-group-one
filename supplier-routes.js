"use strict";
const express = require("express");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { loadState, persistedState, syncEntityMirror } = require("./db");
const {
  VENDORS,
  HEADERS,
  OPTIONAL_HEADERS,
  validateRows,
  compare,
} = require("./supplier-catalog");
const { rankRows, interpret } = require("./supplier-search");
const schemas = new WeakMap();
function ensureSchema(db) {
  if (!schemas.has(db))
    schemas.set(
      db,
      db
        .query(
          `CREATE TABLE IF NOT EXISTS supplier_catalogs (
    company TEXT NOT NULL, vendor TEXT NOT NULL, articles JSONB NOT NULL,
    source TEXT NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    imported_by INTEGER NOT NULL, PRIMARY KEY(company,vendor)
  )`,
        )
        .catch((e) => {
          schemas.delete(db);
          throw e;
        }),
    );
  return schemas.get(db);
}
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  r.use((req, res, next) => {
    if (!D.privileged(req.user, [...D.OPS, "accounting"]))
      return next(new D.AppError("Accès fournisseurs requis.", 403));
    res.set("Cache-Control", "no-store");
    ensureSchema(db).then(() => next(), next);
  });
  async function company(req) {
    const id = String(req.body?.company || req.query.company || "");
    const state = await loadState(db);
    if (
      !id ||
      id === "group" ||
      !D.inCompany(req.user, id) ||
      !state.data.companies.some((x) => x.id === id)
    )
      D.fail("Sélectionnez une entreprise autorisée.", 403);
    return id;
  }
  function input(req) {
    if (!D.privileged(req.user, D.OPS))
      D.fail("Modification fournisseurs non autorisée.", 403);
    if (!VENDORS.some((x) => x.id === req.body?.vendor))
      D.fail("Fournisseur inconnu.");
    const source = String(req.body.source || "").trim();
    if (!source || source.length > 200)
      D.fail("Source du tarif requise (200 caractères maximum).");
    return {
      vendor: req.body.vendor,
      source,
      articles: validateRows(req.body.csv),
    };
  }
  r.get("/directory", (req, res) =>
    res.json({ vendors: VENDORS, headers: [...HEADERS, ...OPTIONAL_HEADERS] }),
  );
  r.get(
    "/catalog",
    wrap(async (req, res) => {
      const c = await company(req),
        quantity = Number(req.query.quantity || 1);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e7)
        D.fail("Quantité invalide.");
      const q = String(req.query.q || "")
        .trim()
        .toLowerCase();
      if (q.length > 200) D.fail("Recherche trop longue.");
      const vendor = String(req.query.vendor || "");
      if (vendor && !VENDORS.some((x) => x.id === vendor))
        D.fail("Fournisseur inconnu.");
      const offset = Number(req.query.offset || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) D.fail("Page invalide.");
      const catalogs = (
        await db.query(
          "SELECT * FROM supplier_catalogs WHERE company=$1 ORDER BY vendor",
          [c],
        )
      ).rows;
      const rows = catalogs
        .filter((x) => !vendor || x.vendor === vendor)
        .flatMap((catalog) =>
          catalog.articles.map((article) => ({
            ...catalog,
            articles: undefined,
            article,
          })),
        );
      const search = await interpret(q, `${req.user.id}:${c}`);
      const ranked = rankRows(rows, q, search.alternatives);
      const matching = ranked.map((x) => x.row);
      // Compare whole matching identities, so a supplier-specific reference still finds competing offers.
      const identity = (x) =>
        x.ean ? "g:" + x.ean : x.numero_e ? "e:" + x.numero_e : "";
      const identities = new Set(
        matching.map((r) => identity(r.article)).filter(Boolean),
      );
      const selected = new Set(matching);
      const groups = compare(
        rows.filter(
          (r) => selected.has(r) || identities.has(identity(r.article)),
        ),
        quantity,
      );
      const rankByReference = new Map(
        ranked.map((x) => [
          x.row.vendor + "|" + x.row.article.reference,
          x.score,
        ]),
      );
      const groupRank = (g) =>
        Math.max(
          0,
          ...g.offers.map(
            (o) => rankByReference.get(o.vendor + "|" + o.reference) || 0,
          ),
        );
      groups.sort((a, b) => groupRank(b) - groupRank(a));
      res.json({
        search,

        vendors: VENDORS,
        catalogs: catalogs.map((x) => ({
          vendor: x.vendor,
          count: x.articles.length,
          source: x.source,
          importedAt: x.imported_at,
        })),
        quantity,
        totalGroups: groups.length,
        offset,
        nextOffset: offset + 200 < groups.length ? offset + 200 : null,
        groups: groups.slice(offset, offset + 200),
      });
    }),
  );
  r.post(
    "/preview",
    wrap(async (req, res) => {
      await company(req);
      const data = input(req);
      res.json({
        count: data.articles.length,
        unmatched: data.articles.filter((x) => !x.ean && !x.numero_e).length,
        sample: data.articles.slice(0, 5),
      });
    }),
  );
  r.post(
    "/import",
    wrap(async (req, res) => {
      const c = await company(req),
        data = input(req),
        client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO supplier_catalogs(company,vendor,articles,source,imported_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(company,vendor) DO UPDATE SET articles=EXCLUDED.articles,source=EXCLUDED.source,imported_by=EXCLUDED.imported_by,imported_at=NOW()`,
          [
            c,
            data.vendor,
            JSON.stringify(data.articles),
            data.source,
            req.user.id,
          ],
        );
        await client.query(
          "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
          [
            req.user.email,
            "supplier.catalog.import",
            JSON.stringify({
              company: c,
              vendor: data.vendor,
              count: data.articles.length,
              source: data.source,
            }),
          ],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      res.json({ ok: true, count: data.articles.length });
    }),
  );
  r.post(
    "/enable",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, D.OPS))
        D.fail("Modification fournisseurs non autorisée.", 403);
      const c = await company(req),
        client = await db.connect();
      const vendorId = String(req.body.vendor || "");
      if (vendorId && !VENDORS.some((x) => x.id === vendorId)) {
        client.release();
        D.fail("Fournisseur inconnu.");
      }
      let added = 0;
      try {
        await client.query("BEGIN");
        let { data } = await loadState(client, { forUpdate: true });
        for (const vendor of VENDORS.filter(
          (x) => !vendorId || x.id === vendorId,
        )) {
          const norm = (s) =>
            String(s)
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toLowerCase()
              .replace(/[^a-z0-9]/g, "");
          if (
            data.suppliers.some(
              (x) =>
                !x.deletedAt &&
                x.company === c &&
                (x.catalogVendor === vendor.id ||
                  norm(x.name).includes(
                    norm(vendor.name.replace(" Suisse", "")),
                  )),
            )
          )
            continue;
          const out = D.applyCommand(data, req.user, {
            action: "create",
            collection: "suppliers",
            payload: {
              company: c,
              name: vendor.name,
              email: "",
              contact: "",
              phone: "",
            },
          });
          data = out.data;
          Object.assign(
            data.suppliers.find((x) => x.id === out.result.id),
            { catalogVendor: vendor.id, website: vendor.url },
          );
          added++;
        }
        if (added) {
          await client.query(
            "UPDATE app_state SET data=$1,revision=revision+1,updated_at=NOW(),updated_by=$2 WHERE id=1",
            [JSON.stringify(persistedState(data)), req.user.email],
          );
          await syncEntityMirror(client, data, ["suppliers"]);
          await client.query(
            "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
            [
              req.user.email,
              "supplier.directory.enable",
              JSON.stringify({ company: c, added }),
            ],
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      res.json({ ok: true, added });
    }),
  );
  return r;
}
module.exports = { routes, ensureSchema };
