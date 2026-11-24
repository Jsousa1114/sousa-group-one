"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const D = require("../domain");

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));

// Loads the real application shell with the AI module and a fake API.
async function setup(role = "admin") {
  const dom = new JSDOM(html, { url: "http://localhost", runScripts: "outside-only" });
  const w = dom.window;
  const d = D.emptyState();
  d.clients = [{ id: "c1", name: "Client", company: "home" }];
  d.projects = [{ id: "p1", title: "Chantier", clientId: "c1", company: "home", team: [], status: "En cours" }];
  const profile = { id: 7, name: "Marc Dupont", role, company: role === "client" ? "home" : "group", client_id: role === "client" ? "c1" : null };
  const calls = [];
  w.sessionStorage.setItem("sgo_session", "unit-test-session");
  w.setInterval = () => 0;
  w.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    const json = (payload) => ({ ok: true, status: 200, json: async () => payload });
    if (String(url).includes("/operations/p3/status")) return json({ providerConfigured: true, transcriptionConfigured: false, features: {} });
    if (String(url).includes("/operations/p3/assistant")) return json({ mode: "ai", answer: "Deux chantiers sont en retard." });
    if (String(url).endsWith("/api/state")) return json({ data: D.viewState(d, profile), revision: 1, profile, contacts: [] });
    return json({});
  };
  w.eval(fs.readFileSync(require.resolve("../finance.js"), "utf8"));
  w.eval(fs.readFileSync(require.resolve("../app.js"), "utf8"));
  w.eval(fs.readFileSync(require.resolve("../p3-center.js"), "utf8"));
  await flush();
  w.SGOChatCore.render();
  for (let i = 0; i < 5; i++) await flush();
  return { w, d: w.document, calls, close: () => w.close() };
}
const click = (h, selector) => {
  const el = h.d.querySelector(selector);
  assert.ok(el, "missing " + selector);
  el.click();
};

test("the AI assistant is reachable from every page and answers in a side panel", async () => {
  const h = await setup("admin");
  try {
    const launcher = h.d.querySelector(".top-actions [data-p3-panel='toggle']");
    assert.ok(launcher, "the Assistant button is in the top bar");
    click(h, ".top-actions [data-p3-panel='toggle']");
    const panel = h.d.getElementById("aiPanel");
    assert.equal(panel.hidden, false);
    assert.equal(launcher.getAttribute("aria-expanded"), "true");
    assert.ok(h.d.querySelectorAll("#aiSuggestions .ai-chip").length >= 1, "page suggestions are offered");
    assert.ok(h.d.querySelector("#aiTools [data-p3-open='ocr-invoice']"), "tool shortcuts are offered");

    h.d.getElementById("aiQuestion").value = "Quels chantiers sont en retard ?";
    h.d.getElementById("aiComposer").dispatchEvent(new h.w.Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 5; i++) await flush();
    const ask = h.calls.find((c) => c.url.includes("/operations/p3/assistant"));
    assert.match(ask.body.question, /Quels chantiers sont en retard/);
    assert.match(h.d.querySelector(".ai-msg.ai-answer").textContent, /Deux chantiers sont en retard/);

    // The conversation survives a page change.
    click(h, ".ai-panel-head [data-p3-panel='close']");
    assert.equal(panel.hidden, true);
    click(h, '[data-page="invoices"]');
    for (let i = 0; i < 3; i++) await flush();
    click(h, ".top-actions [data-p3-panel='toggle']");
    assert.equal(h.d.querySelectorAll(".ai-msg").length, 2);
  } finally {
    h.close();
  }
});

test("AI tools appear on the pages where they are needed and open in a dialog", async () => {
  const h = await setup("admin");
  try {
    click(h, '[data-page="expenses"]');
    for (let i = 0; i < 3; i++) await flush();
    click(h, "#content .section-head [data-p3-open='ocr-invoice']");
    assert.equal(h.d.getElementById("modalWrap").classList.contains("hidden"), false);
    assert.ok(h.d.querySelector("#modalBody #p3OcrFile"), "the invoice reader opens in a dialog");
    assert.equal(h.d.getElementById("p3OcrMode").value, "supplier_invoice");
    h.w.SGOChatCore.closeModal(true);

    click(h, '[data-page="quotes"]');
    for (let i = 0; i < 3; i++) await flush();
    click(h, "#content .section-head [data-p3-open='quote']");
    // The default client belongs to the default company (the server requires it).
    const company = h.d.getElementById("p3QuoteCompany").value;
    const client = h.d.getElementById("p3QuoteClient").selectedOptions[0];
    assert.equal(client.dataset.company, company);
  } finally {
    h.close();
  }
});

test("clients get no AI assistant", async () => {
  const h = await setup("client");
  try {
    assert.equal(h.d.querySelector("[data-p3-panel='toggle']"), null);
  } finally {
    h.close();
  }
});
