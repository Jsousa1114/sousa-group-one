"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { HEADERS, validateRows, compare } = require("../supplier-catalog");
const csv = (changes = {}) =>
  HEADERS.join(";") +
  "\n" +
  HEADERS.map(
    (k) =>
      ({
        reference: "R1",
        designation: "Interrupteur",
        ean: "7612345678900",
        numero_e: "",
        unite: "pcs",
        prix_chf_ht: "10.50",
        prix_pour: "1",
        conditionnement: "1",
        type_prix: "net",
        date_prix: "2026-10-03",
        valable_jusquau: "",
        ...changes,
      })[k],
  ).join(";");
const now = new Date("2026-10-04T10:00:00Z");
// Valid GTIN generated using its public check-digit algorithm, no real supplier price.
const valid = (changes) =>
  validateRows(csv({ ean: "4006381333931", ...changes }), now)[0];
test("supplier CSV preserves references and validates identifiers, amounts and dates", () => {
  const row = valid({
    reference: "000123",
    prix_chf_ht: "10,50",
    designation: '"Interrupteur; blanc"',
  });
  assert.equal(row.reference, "000123");
  assert.equal(row.designation, "Interrupteur; blanc");
  assert.equal(row.prix_chf_ht, 10.5);
  assert.equal(row.ean, "04006381333931");
  for (const change of [
    { prix_chf_ht: "" },
    { prix_chf_ht: "0" },
    { prix_pour: "0" },
    { conditionnement: "-1" },
    { ean: "12345678" },
    { numero_e: "abc123" },
    { date_prix: "2026-02-30" },
    { date_prix: "2027-01-01" },
    { type_prix: "ttc" },
    { unite: "boite" },
    { conditionnement: "0.5" },
  ])
    assert.throws(() => valid(change));
  assert.throws(
    () =>
      validateRows(
        csv({ ean: "4006381333931" }) +
          "\n" +
          csv({ ean: "4006381333931" }).split("\n")[1],
        now,
      ),
    /double/,
  );
});
test("comparison includes packs, keeps net/public and units apart, excludes stale or expired best offers", () => {
  const rows = [
    {
      vendor: "em",
      article: valid({ prix_chf_ht: "8", conditionnement: "10" }),
    },
    { vendor: "sonepar", article: valid({ prix_chf_ht: "9" }) },
    {
      vendor: "otto-fischer",
      article: valid({ prix_chf_ht: "1", date_prix: "2026-08-01" }),
    },
    {
      vendor: "otto-fischer",
      article: valid({ prix_chf_ht: "2", valable_jusquau: "2026-10-03" }),
    },
    { vendor: "em", article: valid({ prix_chf_ht: "1", type_prix: "public" }) },
    { vendor: "sonepar", article: valid({ prix_chf_ht: "1", unite: "m" }) },
  ];
  const groups = compare(rows, 3, now);
  assert.equal(groups.length, 3);
  const group = groups.find((x) => x.unit === "pcs" && x.priceType === "net");
  assert.equal(group.bestTotal, 27);
  assert.equal(group.comparable, true);
  assert.equal(group.offers.find((x) => x.vendor === "em").ordered, 10);
  assert.equal(groups.find((x) => x.priceType === "public").comparable, false);
  const normalized = compare(
    [
      {
        vendor: "em",
        article: valid({ prix_chf_ht: "100", prix_pour: "100" }),
      },
    ],
    4,
    now,
  )[0];
  assert.equal(normalized.offers[0].unitPrice, 1);
  assert.equal(normalized.offers[0].total, 4);
});
test("comparison never merges unrelated articles, and supports Swiss E numbers without EAN", () => {
  let groups = compare(
    ["em", "sonepar"].map((vendor) => ({
      vendor,
      article: valid({ ean: "", numero_e: "123 456 789" }),
    })),
    1,
    now,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].comparable, true);
  groups = compare(
    ["em", "sonepar"].map((vendor) => ({
      vendor,
      article: valid({ ean: "", numero_e: "" }),
    })),
    1,
    now,
  );
  assert.equal(groups.length, 2);
  assert.ok(groups.every((x) => !x.comparable));
});

test("supplier endpoints enforce scope, preview before import, atomic invalid rejection and idempotent directory", async () => {
  const { database } = require("./database"),
    { migrate, loadState } = require("../db"),
    { emptyState } = require("../domain");
  const express = require("express"),
    jwt = require("jsonwebtoken");
  process.env.JWT_SECRET = "supplier-tests-only-secret-at-least-32-characters";
  const db = await database();
  let server;
  try {
    await migrate(db);
    const state = emptyState();
    await db.query("UPDATE app_state SET data=$1 WHERE id=1", [
      JSON.stringify(state),
    ]);
    const tokens = {};
    for (const [key, role, company] of [
      ["admin", "admin", "group"],
      ["manager", "manager", "home"],
      ["client", "client", "home"],
      ["accounting", "accounting", "home"],
    ]) {
      const user = (
        await db.query(
          "INSERT INTO users(email,password_hash,role,name,company,avatar) VALUES($1,'test',$2,$3,$4,'') RETURNING id,session_version",
          [key + "@test.invalid", role, key, company],
        )
      ).rows[0];
      tokens[key] = jwt.sign(
        { sub: String(user.id), sv: user.session_version },
        process.env.JWT_SECRET,
        { issuer: "sousa-group-one", audience: "sgo-web" },
      );
    }
    const app = express();
    app.use(express.json());
    app.use("/", require("../supplier-routes").routes(db));
    app.use((e, req, res, next) =>
      res.status(e.status || 500).json({ error: e.message }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const call = async (path, key = "admin", body) => {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}${path}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: "Bearer " + tokens[key],
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      return { status: res.status, data: await res.json() };
    };
    const data = {
      company: "home",
      vendor: "em",
      source: "Test export",
      csv: csv({
        ean: "4006381333931",
        date_prix: new Date().toISOString().slice(0, 10),
      }),
    };
    assert.equal((await call("/directory", "client")).status, 403);
    assert.equal(
      (await call("/catalog?company=electricite", "manager")).status,
      403,
    );
    assert.equal((await call("/catalog?company=group")).status, 403);
    assert.equal((await call("/preview", "accounting", data)).status, 403);
    assert.equal((await call("/preview", "admin", data)).data.count, 1);
    assert.equal((await call("/catalog?company=home")).data.groups.length, 0);
    assert.equal((await call("/import", "manager", data)).status, 200);
    assert.equal(
      (await call("/import", "admin", { ...data, vendor: "sonepar" })).status,
      200,
    );
    assert.equal(
      (
        await call("/import", "admin", {
          ...data,
          csv: data.csv.replace("10.50", "0"),
        })
      ).status,
      400,
    );
    const catalog = await call(
      "/catalog?company=home&q=R1&quantity=2",
      "accounting",
    );
    assert.equal(catalog.status, 200);
    assert.equal(catalog.data.groups[0].offers.length, 2);
    assert.equal(catalog.data.groups[0].comparable, true);
    assert.equal(
      (await call("/catalog?company=electricite")).data.catalogs.length,
      0,
    );
    assert.equal(
      (await call("/enable", "admin", { company: "home" })).data.added,
      3,
    );
    assert.equal(
      (await call("/enable", "admin", { company: "home" })).data.added,
      0,
    );
    assert.equal((await loadState(db)).data.suppliers.length, 3);
    assert.equal(
      (await call("/enable", "manager", { company: "electricite" })).status,
      403,
    );
    assert.equal(
      (
        await db.query(
          "SELECT COUNT(*)::int AS n FROM audit_logs WHERE action='supplier.catalog.import'",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await db.end();
  }
});

test("supplier UI renders three catalogs, escapes imported text and supports search", async () => {
  const { JSDOM } = require("jsdom"),
    fs = require("node:fs");
  const dom = new JSDOM('<div id="host"></div><div id="modal"></div>', {
    url: "https://test.invalid",
    runScripts: "outside-only",
  });
  const { window } = dom,
    calls = [];
  const { VENDORS } = require("../supplier-catalog");
  window.SGOChatCore = {
    esc: (v) =>
      String(v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    getState: () => ({ companies: [{ id: "home", name: "Home" }] }),
    getCompany: () => "home",
    api: async (path) => {
      calls.push(path);
      return path.endsWith("directory")
        ? { vendors: VENDORS, headers: HEADERS }
        : {
            catalogs: [],
            groups: compare(
              [
                {
                  vendor: "em",
                  source: "<img src=x onerror=alert(1)>",
                  article: valid({ designation: "<script>alert(1)</script>" }),
                },
              ],
              1,
              now,
            ),
            totalGroups: 1,
          };
    },
    modal: (title, html) => {
      window.document.querySelector("#modal").innerHTML = html;
    },
  };
  window.eval(fs.readFileSync("supplier-suite.js", "utf8"));
  await window.SGOSuppliers.render(window.document.querySelector("#host"));
  assert.equal(window.document.querySelectorAll(".supplier-vendor").length, 3);
  assert.equal(
    window.document.querySelectorAll(
      "#supplierResults script,#supplierResults img",
    ).length,
    0,
  );
  assert.match(
    window.document.querySelector("#supplierResults").textContent,
    /<script>alert/,
  );
  const form = window.document.querySelector("#supplierSearch");
  form.elements.q.value = "prise";
  form.elements.quantity.value = "12";
  await form.onsubmit({ preventDefault() {}, target: form });
  assert.ok(
    calls.some((x) => x.includes("q=prise") && x.includes("quantity=12")),
  );
  window.document.querySelector('[data-import="em"]').click();
  assert.ok(window.document.querySelector("#supplierConfirm").disabled);
  assert.match(
    window.document.querySelector("#supplierImportForm").textContent,
    /remplace tous les articles/,
  );
  dom.window.close();
});
