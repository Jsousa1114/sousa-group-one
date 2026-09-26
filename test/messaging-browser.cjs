"use strict";
process.env.JWT_SECRET = "browser-call-test-secret-2026-very-long-value";
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const { emptyState } = require("../domain");

const PASSWORD = "Messaging-Call-Test-Password-2026";
let db, server, browser, base;

async function seed() {
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const [email, role, name, clientId] of [
    ["admin-call@e2e.invalid", "admin", "Admin Appel", null],
    ["client-call@e2e.invalid", "client", "Client Mobile", "c1"],
  ])
    await db.query(
      "INSERT INTO users(email,password_hash,role,name,avatar,company,client_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [email, hash, role, name, "", role === "admin" ? "group" : "home", clientId],
    );
  const state = emptyState();
  state.clients = [{ id: "c1", name: "Client Mobile", company: "home", email: "client-call@e2e.invalid" }];
  state.projects = [{ id: "p1", title: "Chantier mobile", company: "home", clientId: "c1", team: [], progress: 0, status: "Planifié" }];
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(state)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ],
  });
}
async function context(viewport) {
  const c = await browser.newContext({
    viewport,
    permissions: ["microphone"],
  });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  return { c, p };
}
async function login(page, email) {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.locator("#app").waitFor({ state: "visible" });
}
async function openMessages(page, mobile) {
  if (mobile) {
    await page.locator('[data-action="open-side"]').click();
    await page.locator('[data-page="messages"]').click();
  } else {
    await page.locator('[data-page="messages"]').click();
  }
  await page.locator(".whatsapp-chat").waitFor();
}
async function noOverflow(page, label) {
  const dims = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(dims.scroll <= dims.client + 2, label + " horizontal overflow " + JSON.stringify(dims));
  assert.ok(dims.body <= dims.client + 2, label + " body overflow " + JSON.stringify(dims));
}
async function controlWithinViewport(page, selector, label) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, label + " missing");
  const width = await page.evaluate(() => innerWidth);
  assert.ok(box.x >= -1 && box.x + box.width <= width + 1, label + " outside viewport: " + JSON.stringify({ box, width }));
}

(async () => {
  try {
    await seed();
    const admin = await context({ width: 1440, height: 900 });
    const client = await context({ width: 390, height: 844 });
    await login(admin.p, "admin-call@e2e.invalid");
    await login(client.p, "client-call@e2e.invalid");
    await openMessages(admin.p, false);
    await openMessages(client.p, true);

    await noOverflow(client.p, "390px conversation list");
    await client.p.locator(".chat-contact").first().click();
    await client.p.locator(".chat-main-panel").waitFor({ state: "visible" });
    await noOverflow(client.p, "390px open conversation");
    for (const selector of ['[data-action="chat-file"]','[data-action="chat-voice"]',"#messageText",".chat-send"])
      await controlWithinViewport(client.p, selector, "390px " + selector);

    // Voice recording with a fake microphone must start and stop without leaving the mic captured.
    await client.p.locator('[data-action="chat-voice"]').click();
    await client.p.locator('[data-action="chat-voice"].recording').waitFor();
    await client.p.waitForTimeout(700);
    await client.p.locator('[data-action="chat-voice"]').click();
    await client.p.locator("#chatAttachmentBar:not(.hidden)").waitFor({ timeout: 10000 });
    assert.match(await client.p.locator("#chatAttachmentBar").innerText(), /message-vocal/i);

    // Admin opens direct client chat and calls.
    const adminClient = admin.p.locator(".chat-contact").filter({ hasText: "Client Mobile" });
    await adminClient.click();
    await admin.p.locator('[data-action="call-start"]').click();
    await admin.p.locator("#callOverlay:not(.hidden)").waitFor();
    await client.p.locator("#callAccept:not(.hidden)").waitFor({ timeout: 10000 });
    assert.match(await client.p.locator("#callState").innerText(), /entrant/i);
    await client.p.locator("#callAccept").click();

    // Signaling must reach accepted state and peer should normally connect on localhost fake media.
    await admin.p.waitForFunction(async () => {
      const token = sessionStorage.getItem("sgo_session");
      const r = await fetch("/api/state/calls/pending", { headers: { Authorization: "Bearer " + token } });
      const j = await r.json();
      return j.call?.status === "accepted";
    }, null, { timeout: 10000 });
    await admin.p.locator("#callState").filter({ hasText: /En appel|Connexion/ }).waitFor({ timeout: 12000 });

    // Mute/unmute must work and not close the call.
    await client.p.locator("#callMute").waitFor({ state: "visible" });
    await client.p.locator("#callMute").click();
    assert.equal(await client.p.locator("#callMute").evaluate((el) => el.classList.contains("muted")), true);
    await client.p.locator("#callMute").click();
    assert.equal(await client.p.locator("#callMute").evaluate((el) => el.classList.contains("muted")), false);

    await admin.p.locator("#callHangup").click();
    await client.p.locator("#callState").filter({ hasText: /terminé/i }).waitFor({ timeout: 8000 });
    await noOverflow(client.p, "390px after call");

    // Narrow-phone regression check.
    await client.p.setViewportSize({ width: 320, height: 700 });
    await noOverflow(client.p, "320px open conversation");
    for (const selector of ['[data-action="chat-file"]','[data-action="chat-voice"]',"#messageText",".chat-send"])
      await controlWithinViewport(client.p, selector, "320px " + selector);

    console.log("MESSAGING E2E PASS: 390/320 mobile layout, fake microphone voice recording, incoming/outgoing audio call, accept, mute/unmute, hangup");
    await admin.c.close();
    await client.c.close();
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.end();
  }
})().catch((e) => {
  console.error("MESSAGING E2E FAILED", e);
  process.exitCode = 1;
});
