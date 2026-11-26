"use strict";
// « Importer le relevé bancaire »: camt.053 / camt.054 (XML or ZIP) → the invoices each credit
// pays, checked by a person, recorded once.
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const D = require("../domain");
const { readStatement, matchCredits } = require("../bank-import");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";
const IBAN = "CH9300762011623852957";
const QRR = "210000000003139471430009017";

function tx({ amount, ref = "", ustrd = "", debtor = "", bankRef = "", v8 = false }) {
  return `<TxDtls><Refs>${bankRef ? `<AcctSvcrRef>${bankRef}</AcctSvcrRef>` : ""}<EndToEndId>NOTPROVIDED</EndToEndId></Refs>
    <Amt Ccy="CHF">${amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd>
    <RltdPties><Dbtr>${v8 ? `<Pty><Nm>${debtor}</Nm></Pty>` : `<Nm>${debtor}</Nm>`}</Dbtr><DbtrAcct><Id><IBAN>CH5604835012345678009</IBAN></Id></DbtrAcct></RltdPties>
    <RmtInf>${ustrd ? `<Ustrd>${ustrd}</Ustrd>` : ""}${ref ? `<Strd><CdtrRefInf><Tp><CdOrPrtry><Prtry>QRR</Prtry></CdOrPrtry></Tp><Ref>${ref}</Ref></CdtrRefInf></Strd>` : ""}</RmtInf></TxDtls>`;
}
function camt054(entries, version = "001.08") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.${version}"><BkToCstmrDbtCdtNtfctn><GrpHdr><MsgId>M1</MsgId></GrpHdr>
<Ntfctn><Id>N1</Id><Acct><Id><IBAN>${IBAN}</IBAN></Id></Acct>${entries.join("")}</Ntfctn></BkToCstmrDbtCdtNtfctn></Document>`;
}
const entry = ({ amount, cdi = "CRDT", txs = [], date = "2026-11-20", status = "BOOK", reversal = false, ref = "E1" }) =>
  `<Ntry><NtryRef>${ref}</NtryRef><Amt Ccy="CHF">${amount}</Amt><CdtDbtInd>${cdi}</CdtDbtInd>${reversal ? "<RvslInd>true</RvslInd>" : ""}<Sts><Cd>${status}</Cd></Sts>
   <BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt><AcctSvcrRef>${ref}</AcctSvcrRef>
   <NtryDtls>${txs.join("")}</NtryDtls></Ntry>`;

// A ZIP of stored or deflated files, as an e-banking export.
function zip(files) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [name, text, deflate] of files) {
    const raw = Buffer.from(text),
      data = deflate ? zlib.deflateRawSync(raw) : raw,
      n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

test("camt.054 credits: batch entries, references, names; debits, reversals and pending lines are left out", () => {
  const xml = camt054([
    entry({
      amount: "2000.00",
      ref: "B1",
      txs: [
        tx({ amount: "1200.00", ustrd: "F-2026-0002 Situation 2", debtor: "Sophie Bernard", bankRef: "T1" }),
        tx({ amount: "800.00", ref: "21 00000 00003 13947 14300 09017", debtor: "Garage Dubois SA", bankRef: "T2", v8: true }),
      ],
    }),
    entry({ amount: "99.00", cdi: "DBIT", ref: "D1", txs: [tx({ amount: "99.00", debtor: "Swisscom" })] }),
    entry({ amount: "50.00", ref: "R1", reversal: true, txs: [tx({ amount: "50.00", debtor: "X" })] }),
    entry({ amount: "70.00", ref: "P1", status: "PDNG", txs: [tx({ amount: "70.00", debtor: "Y" })] }),
    entry({ amount: "2150.00", ref: "S1", txs: [tx({ amount: "2150.00", debtor: "KELLER PIERRE", bankRef: "T3" })] }),
  ]);
  const st = readStatement(Buffer.from(xml));
  assert.deepEqual(st.accounts, [IBAN]);
  assert.equal(st.credits.length, 3);
  const byDebtor = Object.fromEntries(st.credits.map((c) => [c.debtor, c]));
  assert.equal(byDebtor["Sophie Bernard"].amount, 1200);
  assert.match(byDebtor["Sophie Bernard"].text, /F-2026-0002/);
  assert.equal(byDebtor["Garage Dubois SA"].reference, QRR);
  assert.equal(byDebtor["Garage Dubois SA"].date, "2026-11-20");
  // The same file twice gives the same keys: a line is never recorded twice.
  assert.deepEqual(readStatement(Buffer.from(xml)).credits.map((c) => c.key), st.credits.map((c) => c.key));
});

test("ZIP of several statements (stored and deflated) is read, a line present in two files counts once", () => {
  const a = camt054([entry({ amount: "10.00", ref: "Z1", txs: [tx({ amount: "10.00", debtor: "A", bankRef: "ZA" })] })]);
  const b = camt054([entry({ amount: "20.00", ref: "Z2", txs: [tx({ amount: "20.00", debtor: "B", bankRef: "ZB" })] }), entry({ amount: "10.00", ref: "Z1", txs: [tx({ amount: "10.00", debtor: "A", bankRef: "ZA" })] })], "001.04");
  const st = readStatement(zip([["camt054_1.xml", a, false], ["sub/camt054_2.xml", b, true], ["readme.txt", "x", false]]));
  assert.deepEqual(st.credits.map((c) => c.amount).sort(), [10, 20]);
  assert.throws(() => readStatement(Buffer.from("<html>pas un relevé</html>")), /camt/);
  assert.throws(() => readStatement(zip([["notes.txt", "x", false]])), /Aucun relevé/);
});

test("matching: QR reference and invoice number are sure, amount + name must be checked, the rest is left to choose", () => {
  const invoices = [
    { id: "F-2026-0002", clientId: "c1", amount: 7200, paid: 0, status: "Émise" },
    { id: "F-2026-0003", clientId: "c2", amount: 800, paid: 0, status: "Émise", paymentReference: QRR },
    { id: "F-2026-0004", clientId: "c3", amount: 2150, paid: 0, status: "Émise" },
    { id: "F-2026-0005", clientId: "c4", amount: 500, paid: 0, status: "Émise" },
    { id: "F-2026-0006", clientId: "c4", amount: 500, paid: 0, status: "Émise" },
    { id: "F-2026-0007", clientId: "c1", amount: 300, paid: 300, status: "Payée" },
    { id: "F-2026-0008", clientId: "c1", amount: 300, paid: 0, status: "Brouillon" },
  ];
  const clients = [
    { id: "c1", name: "Sophie Bernard" },
    { id: "c2", name: "Garage Dubois SA" },
    { id: "c3", name: "Famille Keller" },
    { id: "c4", name: "Immo Léman" },
  ];
  const c = (amount, extra = {}) => ({ key: "k" + amount + (extra.text || "") + (extra.reference || ""), amount, currency: "CHF", reference: "", text: "", debtor: "", date: "2026-11-20", ...extra });
  const lines = matchCredits(
    [
      c(1200, { text: "Facture F 2026 0002", debtor: "S. Bernard" }),
      c(800, { reference: QRR }),
      c(2150, { debtor: "KELLER PIERRE" }),
      c(500, { debtor: "Immo Leman SA" }),
      c(9000, { text: "F-2026-0002" }),
      c(300, { text: "F-2026-0007" }),
      c(42, { debtor: "Inconnu" }),
      c(10, { key: "old" }),
    ],
    invoices,
    clients,
    { imported: new Set(["old"]) },
  );
  const [byNumber, byRef, byName, twoSame, tooMuch, alreadyPaid, unknown, done] = lines;
  assert.equal(byNumber.status, "sure");
  assert.equal(byNumber.invoice, "F-2026-0002");
  assert.match(byNumber.note, /partiel/);
  assert.equal(byRef.status, "sure");
  assert.equal(byRef.invoice, "F-2026-0003");
  assert.equal(byName.status, "check");
  assert.deepEqual(byName.suggestions, ["F-2026-0004"]);
  assert.equal(byName.invoice, "", "a guess is never pre-selected");
  assert.equal(twoSame.status, "unknown");
  assert.deepEqual(twoSame.suggestions.sort(), ["F-2026-0005", "F-2026-0006"]);
  assert.equal(tooMuch.status, "check");
  assert.match(tooMuch.note, /dépasse/);
  assert.equal(alreadyPaid.status, "unknown", "a paid invoice is not proposed again");
  assert.equal(unknown.status, "unknown");
  assert.equal(done.status, "done");
});

let db, server, url;
const tokens = {};
async function call(path, who, body) {
  const r = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + tokens[who], ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}

test.before(async () => {
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, company] of [
    ["bank-admin@test.invalid", "admin", "group"],
    ["bank-accounting@test.invalid", "accounting", "home"],
    ["bank-manager@test.invalid", "manager", "home"],
    ["bank-other@test.invalid", "accounting", "solar"],
  ])
    await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES($1,$2,$3,$4,'',$5)", [email, hash, role, "Test " + role, company]);
  const d = D.emptyState();
  const admin = { id: 1, role: "admin", company: "group" };
  d.companies.find((c) => c.id === "home").billing = { iban: IBAN, street: "Rue Test", buildingNumber: "2", zip: "1000", city: "Lausanne", country: "CH" };
  d.clients = [
    { id: "c1", company: "home", name: "Sophie Bernard", street: "Rue du Lac", buildingNumber: "4", zip: "1000", city: "Lausanne", country: "CH", email: "s@example.invalid" },
    { id: "c2", company: "home", name: "Garage Dubois SA", street: "Rue B", buildingNumber: "1", zip: "1110", city: "Morges", country: "CH", email: "g@example.invalid" },
  ];
  const line = (price) => [{ description: "Travaux", quantity: 1, unit: "forfait", unitPrice: price, vatRate: 0, discount: 0 }];
  const issue = (clientId, price) => {
    const inv = D.applyCommand(d, admin, { action: "create", collection: "invoices", payload: { company: "home", clientId, title: "Travaux", date: "2026-11-01", due: "2026-11-30", lines: line(price) } }).result;
    D.applyCommand(d, admin, { action: "invoice.issue", payload: { id: inv.id } });
    return inv;
  };
  issue("c1", 7200);
  issue("c2", 800);
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  for (const who of ["admin", "accounting", "manager", "other"]) {
    const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `bank-${who}@test.invalid`, password: "A-Strong-Test-Password" }) });
    tokens[who] = (await r.json()).token;
  }
});
test.after(async () => {
  server?.close();
  await db?.end?.();
});

test("import: preview, confirm, payments recorded once; finance roles only; company of the account", async () => {
  const { data: st } = await call("state", "admin");
  const [first, second] = st.data.invoices.sort((a, b) => a.id.localeCompare(b.id));
  const xml = camt054([
    entry({
      amount: "2000.00",
      ref: "B1",
      txs: [
        tx({ amount: "1200.00", ustrd: first.id + " acompte", debtor: "Sophie Bernard", bankRef: "T1" }),
        tx({ amount: "800.00", debtor: "Garage Dubois SA", bankRef: "T2" }),
      ],
    }),
    entry({ amount: "33.30", ref: "U1", txs: [tx({ amount: "33.30", debtor: "Inconnu", bankRef: "T3" })] }),
  ]);
  const file = Buffer.from(xml).toString("base64");
  assert.equal((await call("bank/preview", "manager", { file })).status, 403);
  const preview = await call("bank/preview", "accounting", { file });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.companies.map((c) => c.id), ["home"]);
  assert.deepEqual(preview.data.counts, { sure: 1, check: 1, unknown: 1, done: 0 });
  const sure = preview.data.lines.find((l) => l.status === "sure");
  const check = preview.data.lines.find((l) => l.status === "check");
  assert.equal(sure.invoice, first.id);
  assert.deepEqual(check.suggestions, [second.id]);
  // Another company's accountant sees none of these invoices.
  const other = await call("bank/preview", "other", { file });
  assert.equal(other.data.lines.filter((l) => l.status === "sure").length, 0);
  // A tampered amount is ignored: the server reads the amounts from the file again.
  const confirm = await call("bank/confirm", "accounting", {
    file,
    items: [
      { key: sure.key, invoice: sure.invoice, amount: 99999 },
      { key: check.key, invoice: second.id },
      { key: "made-up", invoice: first.id },
    ],
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
  assert.equal(confirm.data.created.length, 2);
  assert.equal(confirm.data.skipped.length, 1);
  const { data: after } = await call("state", "admin");
  const inv1 = after.data.invoices.find((i) => i.id === first.id),
    inv2 = after.data.invoices.find((i) => i.id === second.id);
  assert.equal(inv1.paid, 1200);
  assert.equal(inv1.status, "Partiellement payée");
  assert.equal(inv2.paid, 800);
  assert.equal(inv2.status, "Payée");
  const pays = after.data.payments.filter((p) => p.bankKey);
  assert.equal(pays.length, 2);
  assert.equal(pays.find((p) => p.invoice === first.id).method, "Virement bancaire (relevé)");
  // The same statement again: everything is already recorded.
  const again = await call("bank/preview", "accounting", { file });
  assert.equal(again.data.counts.done, 2);
  const twice = await call("bank/confirm", "accounting", { file, items: [{ key: sure.key, invoice: first.id }] });
  assert.equal(twice.data.created.length, 0);
  assert.equal((await call("state", "admin")).data.data.invoices.find((i) => i.id === first.id).paid, 1200);
  const history = await call("bank/history", "accounting");
  assert.equal(history.data.rows.length, 2);
  assert.equal((await call("bank/preview", "accounting", { file: "pas du base64 !" })).status, 400);
});
