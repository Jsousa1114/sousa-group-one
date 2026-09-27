"use strict";
process.env.JWT_SECRET = "account-browser-test-secret-2026-long-enough-value";
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const { emptyState } = require("../domain");

const PASSWORD = "Account-Browser-Test-Password-2026";
let db, server, browser, base;

async function seed() {
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash(PASSWORD, 4);
  await db.query(
    "INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
    ["account-browser@test.invalid", hash, "employee", "Compte Mobile", "", "home", "e1"],
  );
  const d = emptyState();
  d.employees = [{
    id: "e1", name: "Compte Mobile", job: "Technicien", email: "account-browser@test.invalid",
    phone: "+41 76 000 00 00", salary: 5000, salaryPeriod: "monthly",
    activity: 80, vacation: 18, entry: "2026-01-15", company: "home",
    companies: ["home","tech"], nationality: "Portugaise", residencePermit: "C",
    residencePermitExpiry: "2027-12-31", emergencyName: "Contact urgence",
    emergencyPhone: "+41 79 111 11 11", city: "Lausanne", country: "CH"
  }];
  d.clients = [{ id:"c1", name:"Client", company:"home" }];
  d.projects = [{ id:"p1", title:"Chantier compte", company:"home", clientId:"c1", team:["e1"], status:"En cours", progress:60 }];
  d.time = [{ id:"t1", employeeId:"e1", project:"p1", date:new Date().toISOString().slice(0,7)+"-05", hours:8 }];
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true });
}
async function login(page) {
  await page.goto(base, { waitUntil:"networkidle" });
  await page.locator("#email").fill("account-browser@test.invalid");
  await page.locator("#password").fill(PASSWORD);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.locator("#app").waitFor({ state:"visible" });
}
async function openAccount(page, mobile=false) {
  if (mobile) {
    await page.locator('[data-action="open-side"]').click();
  }
  await page.locator('[data-page="settings"]').click();
  await page.locator(".account-profile-card").waitFor({ timeout:10000 });
}
async function noOverflow(page,label) {
  const d = await page.evaluate(() => {
    const width = innerWidth,
      offenders = [...document.querySelectorAll("body *")]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            id: el.id,
            cls: String(el.className || "").slice(0, 100),
            left: Math.round(r.left),
            right: Math.round(r.right),
            width: Math.round(r.width),
            scrollWidth: el.scrollWidth,
          };
        })
        .filter((x) => x.right > width + 2 || x.left < -2 || x.scrollWidth > Math.max(x.width + 2, width + 2))
        .sort((a, b) => Math.max(b.right - width, b.scrollWidth - b.width) - Math.max(a.right - width, a.scrollWidth - a.width))
        .slice(0, 12);
    return {
      width,
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      offenders,
    };
  });
  assert.ok(d.doc <= d.width + 2, label + " document overflow " + JSON.stringify(d));
  assert.ok(d.body <= d.width + 2, label + " body overflow " + JSON.stringify(d));
}
(async()=>{
  try {
    await seed();
    const desktop = await browser.newContext({ viewport:{width:1440,height:900} });
    const dp = await desktop.newPage();
    const errors=[];
    dp.on("pageerror",e=>errors.push(e.message));
    await login(dp);
    await openAccount(dp);
    assert.match(await dp.locator("#accountCenter").innerText(), /Informations personnelles/);
    assert.match(await dp.locator("#accountCenter").innerText(), /Sécurité du compte/);
    assert.match(await dp.locator("#accountCenter").innerText(), /Notifications/);
    assert.match(await dp.locator("#accountCenter").innerText(), /Messagerie et confidentialité/);
    assert.match(await dp.locator("#accountCenter").innerText(), /Mes documents/);
    assert.match(await dp.locator("#accountCenter").innerText(), /Zone sensible/);
    await noOverflow(dp,"desktop account");

    await dp.locator('[data-account-action="edit-profile"]').click();
    await dp.locator('#accountProfileForm [name="phone"]').fill("+41 79 555 44 33");
    await dp.locator('#accountProfileForm [name="city"]').fill("Nyon");
    await dp.locator('#accountProfileForm button[type="submit"]').click();
    await dp.locator(".account-profile-card").waitFor();
    await dp.waitForFunction(() => document.querySelector("#accountCenter")?.textContent.includes("+41 79 555 44 33"));
    assert.match(await dp.locator("#accountCenter").innerText(), /Nyon/);

    const privacy = dp.locator("#accountPrivacyForm");
    const onlineToggle = privacy.locator('label.account-switch:has(input[name="online"])');
    const readToggle = privacy.locator('label.account-switch:has(input[name="readReceipts"])');
    if (await privacy.locator('[name="online"]').isChecked()) await onlineToggle.click();
    if (await privacy.locator('[name="readReceipts"]').isChecked()) await readToggle.click();
    assert.equal(await privacy.locator('[name="online"]').isChecked(), false);
    assert.equal(await privacy.locator('[name="readReceipts"]').isChecked(), false);
    await privacy.locator('button[type="submit"]').click();
    await dp.waitForTimeout(250);
    const pref = await dp.evaluate(async () =>
      fetch("/api/account/preferences", { credentials: "same-origin" }).then((r) => r.json())
    );
    assert.equal(pref.preferences.privacy.online,false);
    assert.equal(pref.preferences.privacy.readReceipts,false);

    const mobile = await browser.newContext({ viewport:{width:390,height:844} });
    const mp = await mobile.newPage();
    const mobileErrors=[];
    mp.on("pageerror",e=>mobileErrors.push(e.message));
    await login(mp);
    await openAccount(mp,true);
    await noOverflow(mp,"390px account");
    await mp.setViewportSize({width:320,height:700});
    await noOverflow(mp,"320px account");
    assert.equal(await mp.locator(".account-grid").count(),1);

    assert.deepEqual(errors,[]);
    assert.deepEqual(mobileErrors,[]);
    console.log("ACCOUNT CENTER BROWSER PASS: desktop + 390/320 mobile, profile edit, privacy preferences, sessions and responsive sections");
    await desktop.close();
    await mobile.close();
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((r)=>server.close(r));
    if (db) await db.end();
  }
})().catch(e=>{console.error("ACCOUNT CENTER BROWSER FAILED",e);process.exitCode=1;});
