"use strict";
// « Devis déménagement »: volume, truck, team and hours from an inventory; the client's link; the quote.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const D = require("../domain");
const M = require("../moving");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";

test("estimate: volume, smallest truck that fits, team, stairs, hours, quote lines", () => {
  const small = M.estimate({ items: { canape3: 1, litdouble: 1, armoire2: 1, carton: 20, inconnu: 3 }, details: { fromFloor: 0, toFloor: 0, distanceKm: 10 } }, M.DEFAULT_SETTINGS);
  assert.equal(small.volume, 7.5);
  assert.equal(small.truck.label, "Fourgon 12 m³");
  assert.equal(small.movers, 2);
  assert.equal(small.trips, 1);
  assert.equal(small.hours, 4, "7.5 m³ / (2 × 1.2) = 3.1 h + 0.75 h of driving → 4 h");
  assert.equal(small.lines[0].unitPrice, 2 * 55 + 30);
  assert.match(small.lines[0].description, /2 déménageurs avec Fourgon 12 m³/);
  assert.equal(small.lines[1].quantity, 10);
  assert.match(small.scope, /Volume estimé : 7.5 m³ \(23 objets\)/);
  assert.match(small.scope, /Chambres : 1 × Lit double avec matelas, 1 × Armoire 2 portes/);
  // A 4th floor without a lift takes longer than with one.
  const stairs = M.estimate({ items: { canape3: 1, litdouble: 1, armoire2: 1, carton: 20 }, details: { fromFloor: 4, fromLift: false, distanceKm: 10 } }, M.DEFAULT_SETTINGS);
  const lift = M.estimate({ items: { canape3: 1, litdouble: 1, armoire2: 1, carton: 20 }, details: { fromFloor: 4, fromLift: true, distanceKm: 10 } }, M.DEFAULT_SETTINGS);
  assert.ok(stairs.hours > lift.hours);
  // A big move: biggest truck, several trips, more people, extras.
  const big = M.estimate(
    { items: { canape3: 4, armoire4: 8, litdouble: 6, carton: 200, piano: 1 }, custom: [{ label: "Aquarium", m3: 1, qty: 1, assembly: true }], details: { distanceKm: 30, cartonsSupplied: 50, packing: true, assembly: 3 } },
    M.DEFAULT_SETTINGS,
  );
  assert.equal(big.volume, 63);
  assert.equal(big.truck.m3, 40);
  assert.equal(big.trips, 2);
  assert.equal(big.movers, 4);
  assert.equal(big.km, 90);
  const labels = big.lines.map((l) => l.description).join(" | ");
  assert.match(labels, /Cartons de déménagement fournis/);
  assert.match(labels, /Emballage et déballage/);
  assert.match(labels, /Démontage et remontage/);
  assert.equal(big.lines.find((l) => /Démontage/.test(l.description)).quantity, 4);
  assert.match(labels, /piano/);
  // The person's choices win.
  const forced = M.estimate({ items: { canape3: 1 } }, M.DEFAULT_SETTINGS, { movers: 3, hours: 6, truck: 1 });
  assert.deepEqual([forced.movers, forced.hours, forced.truck.m3], [3, 6, 20]);
  assert.equal(M.estimate({ items: { canape3: 1 } }, M.DEFAULT_SETTINGS).hours, M.DEFAULT_SETTINGS.minHours, "minimum hours");
  assert.throws(() => M.cleanSettings({ trucks: [] }), /véhicules/);
  assert.throws(() => M.cleanSettings({ moverRate: -1 }), /Tarif/);
});

let db, server, url;
const tokens = {};
async function call(path, who, body) {
  const r = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { ...(who ? { Authorization: "Bearer " + tokens[who] } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
test.before(async () => {
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, company] of [
    ["m-admin@test.invalid", "admin", "group"],
    ["m-manager@test.invalid", "manager", "moving"],
    ["m-accounting@test.invalid", "accounting", "moving"],
    ["m-elec@test.invalid", "accounting", "electricite"],
  ])
    await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES($1,$2,$3,$4,'',$5)", [email, hash, role, "M " + role, company]);
  const d = D.emptyState();
  d.clients = [{ id: "c1", company: "moving", name: "Famille Keller", email: "keller@example.invalid", phone: "078 123 45 67", city: "Vevey" }];
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  for (const who of ["admin", "manager", "accounting", "elec"]) {
    const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `m-${who}@test.invalid`, password: "A-Strong-Test-Password" }) });
    tokens[who] = (await r.json()).token;
  }
});
test.after(async () => {
  server?.close();
  await db?.end?.();
});

test("inventory → client link → client fills it in → quote (draft) with the company's prices", async () => {
  const cfg = (await call("moving/config", "manager")).data;
  assert.deepEqual(cfg.companies.map((c) => c.id), ["moving"]);
  assert.equal(cfg.canQuote, false);
  assert.equal(cfg.canSettings, false);
  assert.deepEqual((await call("moving/config", "elec")).data.companies, []);
  assert.equal((await call("moving/settings", "manager", { company: "moving", settings: M.DEFAULT_SETTINGS })).status, 403);
  const prices = await call("moving/settings", "admin", { company: "moving", settings: { ...M.DEFAULT_SETTINGS, moverRate: 60, trucks: [{ label: "Camion 25 m³", m3: 25, rate: 50 }] } });
  assert.equal(prices.status, 200, JSON.stringify(prices.data));
  // The team starts the inventory and sends a link to the client.
  const saved = await call("moving/inventories/save", "manager", { company: "moving", clientId: "c1", title: "Déménagement Keller", inventory: { items: { canape3: 1 }, details: { fromAddress: "Rue A 1, Vevey", toAddress: "Rue B 2, Montreux", distanceKm: 8 } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await call("moving/inventories/save", "elec", { company: "moving", inventory: {} })).status, 403);
  const link = await call(`moving/inventories/${saved.data.id}/link`, "manager", {});
  const token = new URL(link.data.url).searchParams.get("t");
  assert.ok(token && link.data.url.includes("/inventaire?t="));
  // The client's page: no account.
  const page = await call("moving-public/" + token);
  assert.equal(page.status, 200);
  assert.equal(page.data.inventory.items.canape3, 1);
  assert.ok(page.data.catalog.length >= 5);
  assert.equal((await call("moving-public/" + "x".repeat(30))).status, 404);
  const sent = await call("moving-public/" + token, null, { inventory: { items: { canape3: 1, litdouble: 2, carton: 30, nimportequoi: 5 }, details: { fromAddress: "Rue A 1, Vevey", fromFloor: 3, fromLift: false, toAddress: "Rue B 2, Montreux", distanceKm: 8 }, notes: "Piano à l’étage ? non." }, submit: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const list = (await call("moving/inventories", "manager")).data.inventories;
  assert.equal(list[0].status, "Reçu du client");
  assert.equal(list[0].inventory.items.nimportequoi, undefined, "unknown items are dropped");
  // Estimate with the company's prices.
  const est = (await call("moving/estimate", "accounting", { company: "moving", inventory: list[0].inventory })).data;
  assert.equal(est.volume, 9);
  assert.equal(est.truck.label, "Camion 25 m³");
  assert.equal(est.lines[0].unitPrice, 2 * 60 + 50);
  assert.ok(est.total > est.net);
  // The manager cannot create quotes; accounting can, once.
  assert.equal((await call(`moving/inventories/${saved.data.id}/quote`, "manager", {})).status, 403);
  const quote = await call(`moving/inventories/${saved.data.id}/quote`, "accounting", { overrides: { hours: 5 } });
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  const st = (await call("state", "admin")).data.data;
  const q = st.quotes.find((x) => x.id === quote.data.quoteId);
  assert.equal(q.status, "Brouillon");
  assert.equal(q.clientId, "c1");
  assert.equal(q.lines[0].quantity, 5);
  assert.match(q.scope, /Départ : Rue A 1, Vevey, 3e étage \(sans ascenseur\)/);
  assert.equal((await call(`moving/inventories/${saved.data.id}/quote`, "accounting", {})).status, 400, "only one quote per inventory");
  // The client can no longer change it.
  assert.equal((await call("moving-public/" + token, null, { inventory: { items: { canape3: 9 } } })).status, 400);
  assert.equal((await call("moving-public/" + token)).data.locked, true);
});

test("an inventory without client creates the client with the quote; links expire", async () => {
  const saved = await call("moving/inventories/save", "admin", { company: "moving", title: "Déménagement Rochat", inventory: { items: { litsimple: 2, carton: 10 } } });
  const bad = await call(`moving/inventories/${saved.data.id}/quote`, "admin", { newClient: { name: "Paul Rochat" } });
  assert.equal(bad.status, 400, "e-mail and town are required for a new client");
  const ok = await call(`moving/inventories/${saved.data.id}/quote`, "admin", { newClient: { name: "Paul Rochat", email: "paul@example.invalid", city: "Nyon", phone: "079 000 00 00" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const st = (await call("state", "admin")).data.data;
  const client = st.clients.find((c) => c.name === "Paul Rochat");
  assert.equal(client.company, "moving");
  assert.equal(st.quotes.find((x) => x.id === ok.data.quoteId).clientId, client.id);
  const link = await call(`moving/inventories/${saved.data.id}/link`, "admin", {});
  const token = new URL(link.data.url).searchParams.get("t");
  await db.query("UPDATE moving_inventories SET token_expires=NOW() - interval '1 day' WHERE id=$1", [saved.data.id]);
  const expired = await call("moving-public/" + token);
  assert.equal(expired.status, 404);
  assert.match(expired.data.error, /expiré/);
  // Photos need the AI provider; without it the answer says so.
  const photo = await call("moving/photos", "admin", { company: "moving", images: ["data:image/png;base64,iVBORw0KGgo="] });
  assert.equal(photo.status, 424);
  assert.equal((await call(`moving/inventories/${saved.data.id}/delete`, "admin", {})).status, 200);
});
