"use strict";
process.env.JWT_SECRET = "suite-browser-secret-2026-with-very-long-value";
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const { emptyState } = require("../domain");

const PASSWORD = "Suite-Browser-Password-2026";
let db, server, browser, base, adminId, clientId;

async function seed() {
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash(PASSWORD, 4);
  const adminInsert = await db.query(
    "INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES($1,$2,'admin','Admin Suite','AS','group') RETURNING id",
    ["suite-admin@e2e.invalid", hash],
  );
  adminId = adminInsert.rows[0].id;
  const clientInsert = await db.query(
    "INSERT INTO users(email,password_hash,role,name,avatar,company,client_id) VALUES($1,$2,'client','Client Suite','CS','home','c-suite') RETURNING id",
    ["suite-client@e2e.invalid", hash],
  );
  clientId = clientInsert.rows[0].id;
  const state = emptyState();
  state.clients = [
    {
      id: "c-suite",
      name: "Client Suite",
      company: "home",
      email: "suite-client@e2e.invalid",
      city: "Lausanne",
    },
  ];
  state.projects = [
    {
      id: "p-suite",
      company: "home",
      clientId: "c-suite",
      team: [],
      title: "Projet Suite",
      progress: 10,
      status: "En cours",
    },
  ];
  state.messageThreads = [
    {
      id: "thread-suite",
      type: "group",
      name: "Equipe Suite",
      participants: [String(adminId), String(clientId)],
      projectId: "",
      createdBy: adminId,
      createdAt: new Date().toISOString(),
    },
  ];
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
async function make(viewport) {
  const context = await browser.newContext({
    viewport,
    permissions: ["microphone", "camera"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console:" + m.text());
  });
  return { context, page, errors };
}
async function login(page, email) {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.locator("#app").waitFor({ state: "visible" });
}
async function openMessages(page, mobile = false) {
  if (mobile) {
    await page.locator('[data-action="open-side"]').click();
    await page.locator('[data-page="messages"]').click();
  } else await page.locator('[data-page="messages"]').click();
  await page.locator(".whatsapp-chat").waitFor();
}
async function waitKeys() {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const count = Number(
      (
        await db.query(
          "SELECT COUNT(*)::int n FROM user_crypto_keys WHERE user_id=ANY($1::int[])",
          [[adminId, clientId]],
        )
      ).rows[0].n,
    );
    if (count === 2) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("E2EE keys were not registered for both browser users");
}
async function noOverflow(page, label) {
  const dims = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(dims.scroll <= dims.client + 2, label + " html overflow " + JSON.stringify(dims));
  assert.ok(dims.body <= dims.client + 2, label + " body overflow " + JSON.stringify(dims));
}

(async () => {
  let admin, client;
  try {
    await seed();
    admin = await make({ width: 1280, height: 820 });
    client = await make({ width: 390, height: 844 });
    await login(admin.page, "suite-admin@e2e.invalid");
    await login(client.page, "suite-client@e2e.invalid");
    await openMessages(admin.page, false);
    await openMessages(client.page, true);
    await waitKeys();

    // Direct E2EE message: auto mode must encrypt once both keys exist.
    const adminClient = admin.page.locator(".chat-contact").filter({ hasText: "Client Suite" });
    await adminClient.click();
    await admin.page.locator("#suiteEncryptionBadge").waitFor();
    await admin.page.waitForFunction(() =>
      document.querySelector("#suiteEncryptionBadge")?.textContent.includes("E2EE actif"),
    );
    const secret = "Texte E2EE navigateur " + Date.now();
    await admin.page.locator("#messageText").fill(secret);
    await admin.page.locator("#messageForm .chat-send").click();
    await admin.page.waitForTimeout(600);
    const stored = (
      await db.query(
        "SELECT data FROM app_state WHERE id=1",
      )
    ).rows[0].data.messages.find((m) => m.encryption);
    assert.ok(stored, "encrypted message should exist");
    assert.equal(stored.text, "");
    assert.ok(stored.encryption.ciphertext);
    assert.equal(JSON.stringify(stored).includes(secret), false, "plaintext must not be stored on server");

    // Client opens direct conversation and decrypts the browser-only plaintext.
    const mobileDirect = client.page.locator(".chat-contact").filter({ hasText: "Admin Suite" });
    await mobileDirect.click();
    await client.page.locator(".encrypted-text").filter({ hasText: secret }).waitFor({ timeout: 10000 });
    await noOverflow(client.page, "mobile E2EE direct chat");

    // Reaction and favorite from UI.
    const received = client.page.locator('[data-message-id="' + stored.id + '"]');
    await received.locator('[data-suite-action="react"]').click();
    await client.page.locator('[data-suite-action="react-direct"][data-suite-emoji="✅"]').click();
    await received.locator('[data-suite-action="favorite"]').click();
    const metaDeadline = Date.now() + 5000;
    let metaOk = false;
    while (Date.now() < metaDeadline) {
      const reaction = (
        await db.query(
          "SELECT 1 FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji='✅'",
          [stored.id, clientId],
        )
      ).rows.length;
      const favorite = (
        await db.query(
          "SELECT 1 FROM message_favorites WHERE message_id=$1 AND user_id=$2",
          [stored.id, clientId],
        )
      ).rows.length;
      if (reaction && favorite) {
        metaOk = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(metaOk, true, "reaction and favorite should persist");

    // Direct video call with fake camera/micro.
    await admin.page.locator('[data-action="call-video"]').click();
    await admin.page.locator("#callOverlay:not(.hidden)").waitFor();
    await client.page.locator("#callAccept:not(.hidden)").waitFor({ timeout: 10000 });
    assert.match(await client.page.locator("#callState").innerText(), /vidéo/i);
    await client.page.locator("#callAccept").click();
    await admin.page.waitForFunction(async () => {
      const token = sessionStorage.getItem("sgo_session");
      const r = await fetch("/api/state/calls/pending", {
        headers: { Authorization: "Bearer " + token },
      });
      const j = await r.json();
      return j.call?.status === "accepted" && j.call?.callType === "video";
    }, null, { timeout: 10000 });
    await client.page.locator("#callCamera").waitFor({ state: "visible" });
    await client.page.locator("#callCamera").click();
    assert.equal(
      await client.page.locator("#callCamera").evaluate((el) => el.classList.contains("muted")),
      true,
    );
    await client.page.locator("#callCamera").click();
    await admin.page.locator("#callHangup").click();
    await client.page.locator("#callState").filter({ hasText: /terminé/i }).waitFor({ timeout: 8000 });

    // Group audio call via visible thread.
    await admin.page.locator(".chat-back").click().catch(() => {});
    const adminGroup = admin.page.locator(".chat-contact").filter({ hasText: "Equipe Suite" });
    await adminGroup.click();
    await admin.page.locator('[data-suite-action="group-audio"]').click();
    await admin.page.locator("#groupCallOverlay:not(.hidden)").waitFor();
    await client.page.locator("#groupCallInvite").waitFor({ timeout: 12000 });
    await client.page.locator('[data-suite-action="group-accept"]').click();
    await client.page.locator("#groupCallOverlay:not(.hidden)").waitFor({ timeout: 10000 });
    await admin.page.waitForFunction(async () => {
      const token = sessionStorage.getItem("sgo_session");
      const r = await fetch("/api/messaging/group-calls/pending", {
        headers: { Authorization: "Bearer " + token },
      });
      const j = await r.json();
      return j.rooms?.[0]?.status === "active";
    }, null, { timeout: 10000 });
    await client.page.locator('[data-suite-action="group-mute"]').click();
    assert.equal(
      await client.page.locator('[data-suite-action="group-mute"]').evaluate((el) => el.classList.contains("muted")),
      true,
    );
    await admin.page.locator('[data-suite-action="group-hangup"]').click();
    await admin.page.locator("#groupCallOverlay").waitFor({ state: "hidden" });

    // Mobile tools still fit at 390 and 320 with the expanded suite.
    await noOverflow(client.page, "390px expanded suite");
    await client.page.setViewportSize({ width: 320, height: 700 });
    await noOverflow(client.page, "320px expanded suite");

    // Search modal and archive/settings tools exist.
    await client.page.locator('[data-suite-action="search"]').first().click().catch(async () => {
      await client.page.locator(".chat-back").click();
      await client.page.locator('[data-suite-action="search"]').first().click();
    });
    await client.page.locator("#suiteGlobalSearch").fill(secret.slice(0, 12));
    await client.page.locator("#suiteSearchResults button").first().waitFor({ timeout: 8000 });

    assert.deepEqual(admin.errors, [], "admin page errors: " + admin.errors.join("\n"));
    assert.deepEqual(client.errors, [], "client page errors: " + client.errors.join("\n"));
    console.log("COMPLETE MESSAGING BROWSER PASS: E2EE plaintext absent from server, decrypt UI, reaction/favorite, direct video camera, group call, 390/320 layout, search");
  } finally {
    await admin?.context.close().catch(() => {});
    await client?.context.close().catch(() => {});
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.end();
  }
})().catch((e) => {
  console.error("COMPLETE MESSAGING BROWSER FAILED", e);
  process.exitCode = 1;
});
