"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("playwright");

const url = "https://sousa-group-one.onrender.com";
const wait = (n) => new Promise((resolve) => setTimeout(resolve, n));

async function check(browser, device, viewport, isMobile) {
  const context = await browser.newContext({ viewport, isMobile, hasTouch: isMobile, deviceScaleFactor: isMobile ? 2 : 1 });
  const page = await context.newPage();
  const errors = [];
  const failed = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().startsWith(url) && response.status() >= 400) {
      failed.push(response.status() + " " + response.url());
    }
  });
  const response = await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
  assert.equal(response.status(), 200, device + ": public page HTTP status");
  assert.match(await page.title(), /Sousa Group One/i);
  await page.locator("#loginForm").waitFor({ state: "visible" });
  await page.locator("#email").waitFor({ state: "visible" });
  await page.locator("#password").waitFor({ state: "visible" });
  await page.locator('#loginForm button[type="submit"]').waitFor({ state: "visible" });
  assert.equal(await page.locator("#app").isVisible(), false, device + ": private app hidden without login");
  const loginLogo = page.locator(".login-logo");
  assert.equal(await loginLogo.evaluate((img) => img.complete && img.naturalWidth > 0), true, device + ": logo loaded");
  assert.equal(await page.locator("#email").getAttribute("type"), "email");
  assert.equal(await page.locator("#password").getAttribute("type"), "password");

  // HTML5 validation: blank credentials must not submit or navigate.
  await page.locator('#loginForm button[type="submit"]').click();
  assert.equal(await page.locator("#email").evaluate((e) => e.validity.valueMissing), true);
  assert.equal(new URL(page.url()).origin, new URL(url).origin);

  // The public app must reject private state requests without a token.
  const unauthorized = await page.request.get(url + "/api/state");
  assert.equal(unauthorized.status(), 401, device + ": private state access is denied");

  // Verify server + real DB through the production health endpoint, read-only.
  const healthy = await page.request.get(url + "/healthz");
  assert.equal(healthy.status(), 200, device + ": health status");
  assert.equal((await healthy.json()).ok, true, device + ": DB health");
  assert.deepEqual(errors, [], device + ": no uncaught JavaScript exceptions");
  assert.deepEqual(failed, [], device + ": no broken public resources");
  const bounds = await page.evaluate(() => ({
    htmlWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  assert.ok(bounds.htmlWidth <= bounds.viewport + 2, device + ": unexpected horizontal scrolling " + JSON.stringify(bounds));
  fs.mkdirSync("browser-test-results", { recursive: true });
  await page.screenshot({ path: "browser-test-results/login-" + device + ".png", fullPage: true });
  console.log(device + ": PASS; login rendered, logo and assets loaded, no page errors, private API rejected, DB OK, width " + bounds.viewport);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await check(browser, "desktop", { width: 1440, height: 900 }, false);
    await check(browser, "mobile", { width: 390, height: 844 }, true);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
