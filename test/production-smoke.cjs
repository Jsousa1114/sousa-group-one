"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const base = String(process.env.PROD_BASE_URL || "https://sousa-group-one.onrender.com").replace(/\/$/, "");
const email = process.env.E2E_ADMIN_EMAIL || "";
const password = process.env.E2E_ADMIN_PASSWORD || "";

(async () => {
  const health = await fetch(base + "/healthz");
  assert.equal(health.status, 200, "healthz must return 200");
  const ready = await fetch(base + "/readyz");
  assert.equal(ready.status, 200, "readyz must return 200");
  const readiness = await ready.json();
  assert.equal(readiness.ok, true, "critical production readiness checks must pass");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 500) errors.push(r.status() + " " + r.url());
    });
    await page.goto(base, { waitUntil: "networkidle" });
    await page.locator("#loginForm").waitFor();
    if (email && password) {
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(password);
      await page.locator('#loginForm button[type="submit"]').click();
      await page.locator("#app").waitFor({ state: "visible", timeout: 15000 });
      for (const key of ["dashboard", "projects", "clients", "messages", "settings"]) {
        const nav = page.locator('[data-page="' + key + '"]');
        if (await nav.count()) {
          await nav.click();
          await page.waitForTimeout(120);
          assert.ok((await page.locator("#content").innerText()).trim().length > 0);
        }
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      email && password
        ? "PRODUCTION E2E PASS: public health + authenticated admin smoke"
        : "PRODUCTION SMOKE PASS: public health/readiness/login page; authenticated secrets not configured",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("PRODUCTION SMOKE FAILED", error);
  process.exitCode = 1;
});
