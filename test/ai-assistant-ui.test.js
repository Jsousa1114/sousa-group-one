"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const D = require("../domain");

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));

// Loads the real application shell with the AI module and a fake API.
async function setup(role = "admin", options = {}) {
  const dom = new JSDOM(html, { url: "http://localhost", runScripts: "outside-only" });
  const w = dom.window;
  const d = D.emptyState();
  d.clients = [{ id: "c1", name: "Client", company: "home" }];
  d.projects = [{ id: "p1", title: "Chantier", clientId: "c1", company: "home", team: [], status: "En cours" }];
  d.documents = [{ id: "doc1", company: "home", project: "p1", name: "Contrat.txt", category: "Contrat", visibility: "team", size: 40, createdAt: "2026-11-20" }];
  const profile = { id: 7, name: "Marc Dupont", role, company: role === "client" ? "home" : "group", client_id: role === "client" ? "c1" : null };
  const calls = [];
  w.sessionStorage.setItem("sgo_session", "unit-test-session");
  w.setInterval = () => 0;
  if (options.voice) {
    // A minimal speech synthesis, recording what is read aloud.
    w.spoken = [];
    w.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    w.speechSynthesis = { getVoices: () => [], cancel() {}, speak: (u) => (w.spoken.push(u.text), u.onend && setTimeout(u.onend, 0)) };
    w.localStorage.setItem("sgo_ai_voice", "1");
  }
  w.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    const json = (payload) => ({ ok: true, status: 200, json: async () => payload });
    if (String(url).includes("/operations/p3/status")) return json({ providerConfigured: true, provider: "Google Gemini", usage: { today: 0, limit: 150 }, transcriptionConfigured: false, features: {} });
    if (String(url).includes("/operations/p3/assistant"))
      return json({ mode: "ai", answer: options.answer || (calls.filter((c) => c.url.includes("/assistant")).length > 1 ? "**Deux chantiers** sont en retard :\n- [[p1]] (35 %)\n- [[X-404]]" : "Deux chantiers sont en retard.") });
    if (String(url).includes("/operations/p3/briefing")) return json({ day: "2026-11-24", text: "- Le chantier [[p1]] est en retard.", mode: "ai", createdAt: "2026-11-24T05:45:00Z" });
    if (String(url).includes("/operations/p3/document")) return json({ answer: "- **Délai** : 30 jours." });
    if (String(url).includes("/operations/tasks")) return json({ ok: true, id: "t1" });
    if (String(url).includes("/api/state/documents/doc1")) return { ok: true, status: 200, blob: async () => new w.Blob(["Contrat. Délai d'exécution : 30 jours."]) };
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
// The menu shows seven sections; the pages of the open section are its tabs.
const SECTION_OF = {
  dashboard: "home", messages: "communication", projects: "work", clients: "work", documents: "work", maintenance: "work",
  planning: "team", time: "team", absences: "team", employees: "team",
  quotes: "money", invoices: "money", payments: "money", expenses: "money",
  inventory: "stock", tools: "stock", vehicles: "stock", suppliers: "stock",
  pro: "manage", pilotage: "manage", reports: "manage", companies: "manage", advanced: "manage", audit: "manage", settings: "manage",
};
const click = (h, selector) => {
  let el = h.d.querySelector(selector);
  const m = !el && selector.match(/^\[data-page="([^"]+)"\]$/);
  if (m) {
    h.d.querySelector(`#nav [data-section="${SECTION_OF[m[1]]}"]`)?.click();
    el = h.d.querySelector(selector);
    if (!el && h.d.body.dataset.view === m[1]) return;
  }
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

test("answers are formatted, cite records as links, remember the conversation and can be copied", async () => {
  const h = await setup("admin");
  try {
    click(h, ".top-actions [data-p3-panel='toggle']");
    assert.match(h.d.getElementById("aiFootnote").textContent, /Google Gemini/, "users are told where questions go");
    for (const question of ["Quels chantiers sont en retard ?", "Lesquels exactement ?"]) {
      h.d.getElementById("aiQuestion").value = question;
      h.d.getElementById("aiComposer").dispatchEvent(new h.w.Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 5; i++) await flush();
    }
    const second = h.calls.filter((c) => c.url.includes("/operations/p3/assistant"))[1].body;
    assert.equal(second.question, "Lesquels exactement ?");
    assert.deepEqual(second.history, [
      { role: "user", content: "Quels chantiers sont en retard ?" },
      { role: "assistant", content: "Deux chantiers sont en retard." },
    ]);
    const answer = [...h.d.querySelectorAll(".ai-msg.ai-answer .ai-rich")].at(-1);
    assert.equal(answer.querySelector("b").textContent, "Deux chantiers");
    assert.equal(answer.querySelectorAll("li").length, 2);
    const ref = answer.querySelector(".ai-ref[data-p3-ref='project']");
    assert.equal(ref.textContent, "Chantier", "a known project is shown by its title");
    assert.match(answer.textContent, /X-404/, "an unknown reference stays plain text");
    assert.equal(answer.querySelectorAll(".ai-ref").length, 1);
    assert.ok(h.d.querySelector(".ai-msg.ai-answer [data-p3-copy]"));
    ref.click();
    assert.equal(h.d.getElementById("aiPanel").hidden, true, "the panel closes to show the record");
    assert.equal(h.d.getElementById("modalWrap").classList.contains("hidden"), false, "the project opens");
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
    h.w.SGOChatCore.closeModal(true);

    click(h, '[data-page="invoices"]');
    for (let i = 0; i < 3; i++) await flush();
    click(h, "#content .section-head [data-p3-open='email']");
    assert.equal(h.d.getElementById("p3MailKind").value, "invoice_reminder");
    h.d.getElementById("p3MailKind").value = "project_update";
    h.d.getElementById("p3MailKind").dispatchEvent(new h.w.Event("change", { bubbles: true }));
    assert.equal(h.d.getElementById("p3MailTarget").value, "p1", "the list follows the kind of message");
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

test("actions proposed by the assistant are recorded only once confirmed", async () => {
  const action = '```action\n{"type":"task.create","projectId":"p1","title":"Commander 2 disjoncteurs","dueDate":"2026-11-28","priority":"high"}\n```';
  const h = await setup("admin", { answer: "Je propose cette tâche :\n" + action });
  try {
    click(h, ".top-actions [data-p3-panel='toggle']");
    h.d.getElementById("aiQuestion").value = "Ajoute une tâche commander 2 disjoncteurs pour vendredi";
    h.d.getElementById("aiComposer").dispatchEvent(new h.w.Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 5; i++) await flush();
    const card = h.d.querySelector(".ai-action-card");
    assert.ok(card, "a confirmation card is shown");
    assert.doesNotMatch(h.d.querySelector(".ai-msg.ai-answer .ai-rich").textContent, /```|task\.create/, "the raw block is hidden");
    assert.match(card.textContent, /Nouvelle tâche/);
    assert.match(card.textContent, /Chantier/);
    assert.match(card.textContent, /28\.11\.2026/);
    assert.match(card.textContent, /Haute/);
    assert.equal(h.calls.filter((c) => c.url.includes("/operations/tasks")).length, 0, "nothing is recorded before confirmation");
    click(h, "[data-p3-act='confirm']");
    for (let i = 0; i < 5; i++) await flush();
    const sent = h.calls.find((c) => c.url.includes("/operations/tasks"));
    assert.deepEqual(sent.body, { projectId: "p1", title: "Commander 2 disjoncteurs", priority: "high", dueDate: "2026-11-28", assignedEmployeeId: null, status: "todo" });
    assert.match(h.d.querySelector(".ai-action-card").textContent, /Enregistré/);
    // The next question tells the AI the action was confirmed.
    h.d.getElementById("aiQuestion").value = "Merci";
    h.d.getElementById("aiComposer").dispatchEvent(new h.w.Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 5; i++) await flush();
    const history = h.calls.filter((c) => c.url.includes("/operations/p3/assistant")).at(-1).body.history;
    assert.match(history.at(-1).content, /task\.create proposée : confirmée/);
  } finally {
    h.close();
  }
});

test("the dashboard shows the point du jour, and documents can be summarised", async () => {
  const h = await setup("admin");
  try {
    for (let i = 0; i < 5; i++) await flush();
    const card = h.d.getElementById("aiBriefing");
    assert.ok(card, "the briefing card is on the dashboard");
    assert.match(card.textContent, /Point du jour/);
    assert.equal(card.querySelector(".ai-ref").textContent, "Chantier");
    click(h, '[data-page="documents"]');
    for (let i = 0; i < 5; i++) await flush();
    click(h, "#content [data-p3-doc='doc1']");
    for (let i = 0; i < 8; i++) await flush();
    const request = h.calls.find((c) => c.url.includes("/operations/p3/document"));
    assert.equal(request.body.documentId, "doc1");
    assert.match(request.body.text, /Délai d'exécution/);
    assert.match(h.d.getElementById("p3DocThread").textContent, /Délai : 30 jours/);
  } finally {
    h.close();
  }
});

test("in conversation mode, answers are read aloud", async () => {
  const h = await setup("admin", { voice: true, answer: "**Deux chantiers** sont en retard. Le premier est [[p1]]." });
  try {
    click(h, ".top-actions [data-p3-panel='toggle']");
    assert.equal(h.d.querySelector("[data-p3-panel='voice-mode']").getAttribute("aria-pressed"), "true");
    h.d.getElementById("aiQuestion").value = "Quels chantiers sont en retard ?";
    h.d.getElementById("aiComposer").dispatchEvent(new h.w.Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await flush();
    assert.deepEqual(h.w.spoken, ["Deux chantiers sont en retard.", "Le premier est Chantier."]);
  } finally {
    h.close();
  }
});
