"use strict";

const express = require("express");
const D = require("./domain");

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const clean = (value, max = 5000, optional = false) => {
  if (optional && (value == null || String(value).trim() === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    D.fail("Texte invalide.");
  return value.trim();
};

const isoDate = (value) => {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text + "T12:00:00Z")))
    D.fail("Date invalide.");
  return text;
};

const hhmm = (value) => {
  const text = String(value || "");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) D.fail("Heure invalide.");
  return text;
};

const roleAllowed = (user, roles) => {
  if (!roles.includes(user.role)) D.fail("Accès non autorisé.", 403);
};

async function stateContext(db, user) {
  const row = (await db.query("SELECT data,revision FROM app_state WHERE id=1")).rows[0];
  const data = D.normalize(row?.data);
  return {
    data,
    view: D.viewState(data, user),
    revision: Number(row?.revision || 0),
  };
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function addDays(date, days) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayOf(date) {
  const d = new Date(date + "T12:00:00Z");
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function durationHours(start, end) {
  const [sh, sm] = String(start || "00:00").split(":").map(Number);
  const [eh, em] = String(end || "00:00").split(":").map(Number);
  const value = eh + em / 60 - sh - sm / 60;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function employeeCapacity(employee) {
  const weekly = Number(employee.weeklyHours);
  if (Number.isFinite(weekly) && weekly > 0) return Math.min(80, weekly);
  const activity = Number(employee.activity);
  const ratio = Number.isFinite(activity) && activity > 0 ? Math.min(activity, 100) / 100 : 1;
  return Math.round(42 * ratio * 100) / 100;
}

function workloadStatus(utilization) {
  if (utilization > 110) return "overloaded";
  if (utilization >= 85) return "high";
  if (utilization < 50) return "available";
  return "balanced";
}

function visibleEmployees(ctx, user) {
  let rows = (ctx.view.employees || []).filter((e) => !e.deletedAt);
  if (user.role === "employee")
    rows = rows.filter((e) => D.same(e.id, user.employee_id));
  return rows;
}

function buildWorkload(ctx, user, weeks = 4, startDate = todayIso()) {
  const count = Math.min(8, Math.max(1, Number.parseInt(String(weeks || 4), 10) || 4));
  const windowStart = mondayOf(startDate);
  const weekRanges = Array.from({ length: count }, (_, index) => ({
    index,
    start: addDays(windowStart, index * 7),
    end: addDays(windowStart, index * 7 + 6),
  }));
  const employees = visibleEmployees(ctx, user).map((employee) => {
    const capacity = employeeCapacity(employee);
    const row = {
      employeeId: String(employee.id),
      name: employee.name || String(employee.id),
      job: employee.job || "",
      company: employee.company || "",
      weeks: [],
      totalPlanned: 0,
      totalCapacity: 0,
    };
    for (const week of weekRanges) {
      const planned = (ctx.view.planning || [])
        .filter(
          (p) =>
            D.same(p.employeeId, employee.id) &&
            p.date >= week.start &&
            p.date <= week.end,
        )
        .reduce((sum, p) => sum + durationHours(p.start, p.end), 0);
      const rounded = Math.round(planned * 100) / 100;
      const utilization = capacity > 0 ? Math.round((rounded / capacity) * 1000) / 10 : 0;
      row.weeks.push({
        start: week.start,
        end: week.end,
        planned: rounded,
        capacity,
        available: Math.max(0, Math.round((capacity - rounded) * 100) / 100),
        utilization,
        status: workloadStatus(utilization),
      });
      row.totalPlanned += rounded;
      row.totalCapacity += capacity;
    }
    row.totalPlanned = Math.round(row.totalPlanned * 100) / 100;
    row.totalCapacity = Math.round(row.totalCapacity * 100) / 100;
    return row;
  });
  return {
    generatedAt: new Date().toISOString(),
    windowStart,
    windowEnd: weekRanges[weekRanges.length - 1].end,
    weeks: weekRanges,
    employees,
  };
}

function aiConfigured() {
  return !!(process.env.AI_API_URL && process.env.AI_API_KEY);
}

function transcriptionConfigured() {
  return !!(process.env.AI_TRANSCRIBE_API_URL && process.env.AI_API_KEY);
}

function providerText(payload) {
  const direct = payload?.choices?.[0]?.message?.content;
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct))
    return direct.map((part) => part?.text || part?.content || "").filter(Boolean).join("\n");
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (Array.isArray(payload?.output)) {
    const text = payload.output
      .flatMap((entry) => (Array.isArray(entry?.content) ? entry.content : []))
      .map((part) => part?.text || part?.content || "")
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return "";
}

function parseJsonText(value) {
  let text = String(value || "").trim();
  text = text.replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  try {
    return JSON.parse(text);
  } catch {
    D.fail("La réponse IA n'est pas exploitable.", 502);
  }
}

async function callAi({ system, user, imageDataUrl = "", json = false }) {
  if (!aiConfigured()) D.fail("Le fournisseur IA n'est pas configuré.", 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const userContent = imageDataUrl
      ? [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ]
      : user;
    const body = {
      model: process.env.AI_MODEL || "default",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    };
    if (json) body.response_format = { type: "json_object" };
    const response = await fetch(process.env.AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.AI_API_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) D.fail("Le service IA est indisponible.", 502);
    const text = providerText(payload);
    if (!text) D.fail("Le service IA n'a renvoyé aucun contenu.", 502);
    return json ? parseJsonText(text) : text.slice(0, 30000);
  } catch (error) {
    if (error?.status) throw error;
    D.fail("Le service IA est indisponible.", 502);
  } finally {
    clearTimeout(timer);
  }
}

function operationalContext(ctx) {
  const today = todayIso();
  const projects = (ctx.view.projects || []).map((p) => ({
    id: String(p.id),
    title: p.title || "",
    company: p.company || "",
    status: p.status || "",
    progress: Number(p.progress) || 0,
    budget: Number(p.budget) || 0,
    cost: Number(p.cost) || 0,
    start: p.start || "",
    end: p.end || "",
    team: Array.isArray(p.team) ? p.team.map(String) : [],
  }));
  const invoices = (ctx.view.invoices || []).map((i) => ({
    id: String(i.id),
    clientId: i.clientId || "",
    project: i.project || "",
    status: i.status || "",
    amount: Number(i.amount) || 0,
    paid: Number(i.paid) || 0,
    due: i.due || "",
  }));
  const quotes = (ctx.view.quotes || []).map((q) => ({
    id: String(q.id),
    clientId: q.clientId || "",
    project: q.project || "",
    status: q.status || "",
    amount: Number(q.amount) || 0,
    valid: q.valid || "",
  }));
  const inventory = (ctx.view.inventory || []).map((x) => ({
    id: String(x.id),
    name: x.name || "",
    sku: x.sku || "",
    stock: Number(x.stock) || 0,
    min: Number(x.min) || 0,
  }));
  const employees = (ctx.view.employees || []).map((e) => ({
    id: String(e.id),
    name: e.name || "",
    job: e.job || "",
    company: e.company || "",
    weeklyHours: Number(e.weeklyHours) || 0,
    activity: Number(e.activity) || 0,
  }));
  const planning = (ctx.view.planning || [])
    .filter((p) => p.date >= today && p.date <= addDays(today, 35))
    .map((p) => ({
      employeeId: String(p.employeeId),
      project: String(p.project || ""),
      date: p.date,
      start: p.start,
      end: p.end,
    }));
  return {
    today,
    projects,
    invoices,
    quotes,
    inventory,
    employees,
    planning,
  };
}

function localAssistant(question, ctx, user) {
  const q = question.toLowerCase();
  const today = todayIso();
  const openProjects = (ctx.view.projects || []).filter((p) => !["Terminé", "Archivé"].includes(p.status));
  const overdueInvoices = (ctx.view.invoices || []).filter((i) => {
    const due = i.due || "";
    return due && due < today && (Number(i.amount) || 0) > (Number(i.paid) || 0);
  });
  const openQuotes = (ctx.view.quotes || []).filter((x) => !["Accepté", "Refusé"].includes(x.status));
  const lowStock = (ctx.view.inventory || []).filter((x) => Number(x.min) > 0 && Number(x.stock) <= Number(x.min));
  const workload = buildWorkload(ctx, user, 4, today);
  if (/factur|paiement|encaisse/.test(q)) {
    const outstanding = overdueInvoices.reduce(
      (sum, i) => sum + Math.max(0, (Number(i.amount) || 0) - (Number(i.paid) || 0)),
      0,
    );
    return overdueInvoices.length
      ? `${overdueInvoices.length} facture(s) en retard pour ${outstanding.toFixed(2)} CHF restant à encaisser. Les plus urgentes sont : ${overdueInvoices.slice(0, 5).map((i) => i.id).join(", ")}.`
      : "Aucune facture en retard n'est visible dans votre périmètre.";
  }
  if (/stock|mat[eé]riel|article/.test(q))
    return lowStock.length
      ? `${lowStock.length} article(s) sont au minimum de stock ou en dessous : ${lowStock.slice(0, 8).map((x) => x.name || x.id).join(", ")}.`
      : "Aucune alerte de stock minimum n'est visible.";
  if (/charge|disponib|planning|[eé]quipe/.test(q)) {
    const ordered = workload.employees
      .map((e) => ({
        ...e,
        utilization: e.totalCapacity ? Math.round((e.totalPlanned / e.totalCapacity) * 100) : 0,
      }))
      .sort((a, b) => b.utilization - a.utilization);
    return ordered.length
      ? "Charge prévue sur 4 semaines : " +
          ordered
            .slice(0, 8)
            .map((e) => `${e.name} ${e.utilization}% (${e.totalPlanned.toFixed(1)} h planifiées)`)
            .join(" · ")
      : "Aucune donnée de planning exploitable n'est visible.";
  }
  if (/devis|offre/.test(q))
    return `${openQuotes.length} devis non clôturé(s) sont visibles dans votre périmètre.`;
  if (/chantier|projet|travaux/.test(q))
    return openProjects.length
      ? `${openProjects.length} chantier(s) ouverts : ${openProjects.slice(0, 8).map((p) => `${p.title || p.id} (${p.status || "sans statut"}, ${Number(p.progress) || 0}%)`).join(" · ")}`
      : "Aucun chantier ouvert n'est visible.";
  return `Vue rapide : ${openProjects.length} chantier(s) ouverts, ${openQuotes.length} devis non clôturé(s), ${overdueInvoices.length} facture(s) en retard et ${lowStock.length} alerte(s) de stock. Posez une question sur les chantiers, factures, devis, stock ou la charge équipe pour un détail ciblé.`;
}

function validImageDataUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 7_000_000 ||
    !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    D.fail("Image invalide ou trop volumineuse.");
  return value;
}

function validAudioDataUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 7_000_000 ||
    !/^data:audio\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    D.fail("Audio invalide ou trop volumineux.");
  return value;
}

function normalizeQuoteDraft(raw, fallbackTitle, brief, vatRate) {
  const rows = Array.isArray(raw?.lines) ? raw.lines.slice(0, 30) : [];
  const lines = rows
    .map((line) => ({
      description: String(line?.description || "").trim().slice(0, 500),
      details: String(line?.details || "").trim().slice(0, 5000),
      quantity: Math.min(100000, Math.max(0.001, Number(line?.quantity) || 1)),
      unit: String(line?.unit || "forfait").trim().slice(0, 30) || "forfait",
      unitPrice: Math.min(1_000_000, Math.max(0, Number(line?.unitPrice) || 0)),
      vatRate: Math.min(100, Math.max(0, Number(line?.vatRate ?? vatRate) || 0)),
      discount: Math.min(100, Math.max(0, Number(line?.discount) || 0)),
    }))
    .filter((line) => line.description);
  if (!lines.length) {
    const chunks = brief
      .split(/\n+|(?<=[.!?;])\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 8);
    for (const chunk of chunks.length ? chunks : [brief])
      lines.push({
        description: chunk.slice(0, 500),
        details: "",
        quantity: 1,
        unit: "forfait",
        unitPrice: 0,
        vatRate,
        discount: 0,
      });
  }
  return {
    title: String(raw?.title || fallbackTitle || "Devis assisté").trim().slice(0, 200),
    scope: String(raw?.scope || brief).trim().slice(0, 5000),
    message: String(raw?.message || "").trim().slice(0, 5000),
    terms: String(raw?.terms || "").trim().slice(0, 5000),
    exclusions: String(raw?.exclusions || "").trim().slice(0, 5000),
    depositPercent: Math.min(100, Math.max(0, Number(raw?.depositPercent) || 0)),
    lines,
    pricingRequired: lines.some((line) => !(Number(line.unitPrice) > 0)),
  };
}

async function buildAnomalies(db, ctx) {
  const today = todayIso();
  const anomalies = [];
  const push = (severity, type, title, body, page, entityId) =>
    anomalies.push({ severity, type, title, body, page, entityId: String(entityId || "") });

  for (const invoice of ctx.view.invoices || []) {
    const remaining = Math.max(0, (Number(invoice.amount) || 0) - (Number(invoice.paid) || 0));
    if (remaining > 0 && invoice.due && invoice.due < today)
      push("high", "invoice.overdue", "Facture en retard", `${invoice.id} · ${remaining.toFixed(2)} CHF restant`, "invoices", invoice.id);
  }

  for (const project of ctx.view.projects || []) {
    const budget = Number(project.budget) || 0;
    const cost = Number(project.cost) || 0;
    const progress = Number(project.progress) || 0;
    if (budget > 0 && cost > budget)
      push("critical", "project.over_budget", "Budget chantier dépassé", `${project.title || project.id} · ${(cost - budget).toFixed(2)} CHF au-dessus du budget`, "projects", project.id);
    if (project.end && project.end < today && !["Terminé", "Archivé"].includes(project.status))
      push("critical", "project.overdue", "Chantier en retard", `${project.title || project.id} · échéance ${project.end}`, "projects", project.id);
    if (project.end && project.end >= today && project.end <= addDays(today, 14) && progress < 70 && !["Terminé", "Archivé"].includes(project.status))
      push("high", "project.deadline_risk", "Échéance chantier à risque", `${project.title || project.id} · ${progress}% pour une échéance au ${project.end}`, "projects", project.id);
  }

  for (const item of ctx.view.inventory || [])
    if (Number(item.min) > 0 && Number(item.stock) <= Number(item.min))
      push(Number(item.stock) <= 0 ? "critical" : "high", "inventory.low", "Stock faible", `${item.name || item.id} · ${Number(item.stock) || 0} restant(s)`, "inventory", item.id);

  const visibleProjectIds = new Set((ctx.view.projects || []).map((p) => String(p.id)));
  if (visibleProjectIds.size) {
    const tasks = (await db.query(
      `SELECT id,project_id,title,status,priority,due_date,created_at
       FROM project_tasks
       WHERE project_id=ANY($1::text[])
       ORDER BY created_at DESC`,
      [[...visibleProjectIds]],
    )).rows;
    for (const task of tasks) {
      if (task.status === "done") continue;
      const created = new Date(task.created_at);
      const stale = Number.isFinite(created.getTime()) && Date.now() - created.getTime() > 7 * 86400000;
      if (task.due_date && String(task.due_date).slice(0, 10) < today)
        push("high", "task.overdue", "Tâche en retard", `${task.title} · chantier ${task.project_id}`, "pilotage", task.id);
      else if (task.status === "blocked" && stale)
        push("high", "task.blocked_stale", "Tâche bloquée depuis plusieurs jours", `${task.title} · chantier ${task.project_id}`, "pilotage", task.id);
    }
  }

  const byEmployeeDay = new Map();
  const byEmployeeWeek = new Map();
  for (const row of ctx.view.time || []) {
    const hours = Number(row.hours) || 0;
    const employeeId = String(row.employeeId || "");
    if (!employeeId || !row.date || hours <= 0) continue;
    const dayKey = employeeId + "|" + row.date;
    byEmployeeDay.set(dayKey, (byEmployeeDay.get(dayKey) || 0) + hours);
    const weekKey = employeeId + "|" + mondayOf(row.date);
    byEmployeeWeek.set(weekKey, (byEmployeeWeek.get(weekKey) || 0) + hours);
  }
  const employeeName = (id) => (ctx.view.employees || []).find((e) => D.same(e.id, id))?.name || id;
  for (const [key, hours] of byEmployeeDay) {
    if (hours <= 11) continue;
    const [employeeId, date] = key.split("|");
    push(hours > 13 ? "critical" : "high", "time.long_day", "Journée exceptionnellement longue", `${employeeName(employeeId)} · ${hours.toFixed(1)} h le ${date}`, "time", employeeId);
  }
  for (const [key, hours] of byEmployeeWeek) {
    if (hours <= 55) continue;
    const [employeeId, week] = key.split("|");
    push(hours > 65 ? "critical" : "high", "time.long_week", "Volume hebdomadaire inhabituel", `${employeeName(employeeId)} · ${hours.toFixed(1)} h semaine du ${week}`, "time", employeeId);
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  anomalies.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return anomalies.slice(0, 150);
}

function routes(db) {
  const r = express.Router();

  r.get(
    "/status",
    wrap(async (req, res) => {
      if (req.user.role === "client") D.fail("Accès non autorisé.", 403);
      res.json({
        providerConfigured: aiConfigured(),
        transcriptionConfigured: transcriptionConfigured(),
        browserDictation: true,
        features: {
          assistant: true,
          quoteDraft: true,
          supplierInvoiceOcr: true,
          materialOcr: true,
          voiceToText: true,
          dailySummary: true,
          anomalyDetection: true,
          workloadForecast: true,
          assistedPlanning: true,
        },
      });
    }),
  );

  r.post(
    "/assistant",
    wrap(async (req, res) => {
      if (req.user.role === "client") D.fail("Accès non autorisé.", 403);
      const question = clean(req.body?.question, 3000);
      const ctx = await stateContext(db, req.user);
      if (!aiConfigured())
        return res.json({ mode: "local", answer: localAssistant(question, ctx, req.user) });
      const context = operationalContext(ctx);
      const answer = await callAi({
        system:
          "Tu es l'assistant interne de Sousa Group One. Réponds en français, de façon concise et opérationnelle. Utilise uniquement le contexte fourni. N'invente jamais un chiffre, une personne, un prix ou un statut. Si l'information n'est pas dans le contexte, dis-le explicitement. Ne révèle pas de données qui ne figurent pas dans le contexte.",
        user: "QUESTION:\n" + question + "\n\nCONTEXTE AUTORISÉ:\n" + JSON.stringify(context),
      });
      res.json({ mode: "ai", answer });
    }),
  );

  r.post(
    "/quote-draft",
    wrap(async (req, res) => {
      roleAllowed(req.user, D.FIN);
      const ctx = await stateContext(db, req.user);
      const brief = clean(req.body?.brief, 6000);
      const company = clean(req.body?.company, 80);
      if (!D.inCompany(req.user, company) || company === "group")
        D.fail("Entreprise non autorisée.", 403);
      const clientId = clean(req.body?.clientId, 200);
      const client = ctx.view.clients.find((x) => D.same(x.id, clientId));
      if (!client || (client.company && client.company !== company))
        D.fail("Client non autorisé.", 403);
      const projectId = req.body?.projectId ? clean(req.body.projectId, 200) : "";
      if (projectId) {
        const project = ctx.view.projects.find((x) => D.same(x.id, projectId));
        if (!project || project.company !== company || !D.same(project.clientId, clientId))
          D.fail("Chantier incompatible.", 403);
      }
      const title = req.body?.title ? clean(req.body.title, 200) : "";
      const vatRateRaw = Number(req.body?.vatRate ?? 8.1);
      const vatRate = Number.isFinite(vatRateRaw) ? Math.min(100, Math.max(0, vatRateRaw)) : 8.1;
      let raw = {};
      let mode = "local";
      if (aiConfigured()) {
        mode = "ai";
        raw = await callAi({
          json: true,
          system:
            "Tu aides à préparer un brouillon de devis professionnel. Retourne uniquement un objet JSON avec les clés title, scope, message, terms, exclusions, depositPercent, lines. lines est un tableau d'objets description, details, quantity, unit, unitPrice, vatRate, discount. N'invente jamais un prix : si aucun prix fiable n'est fourni dans le brief, mets unitPrice à 0. Ne crée pas de prestations qui ne sont pas demandées.",
          user:
            "Entreprise: " +
            company +
            "\nClient: " +
            (client.name || clientId) +
            "\nObjet souhaité: " +
            (title || "à déterminer") +
            "\nTVA proposée: " +
            vatRate +
            "%\nBrief:\n" +
            brief,
        });
      }
      const draft = normalizeQuoteDraft(raw, title, brief, vatRate);
      res.json({
        mode,
        company,
        clientId,
        projectId,
        draft,
        warning: draft.pricingRequired
          ? "Un ou plusieurs prix restent à compléter avant la création du brouillon."
          : "",
      });
    }),
  );

  r.post(
    "/ocr",
    wrap(async (req, res) => {
      if (req.user.role === "client") D.fail("Accès non autorisé.", 403);
      const mode = String(req.body?.mode || "");
      if (!["supplier_invoice", "material"].includes(mode)) D.fail("Mode OCR invalide.");
      const imageDataUrl = validImageDataUrl(req.body?.imageDataUrl);
      const system =
        mode === "supplier_invoice"
          ? "Analyse une facture fournisseur. Retourne uniquement du JSON avec supplier, invoiceNumber, date, dueDate, currency, subtotal, tax, total, items (description, reference, quantity, unit, unitPrice, amount), confidence (0-1) et warnings. Utilise null lorsqu'une valeur est inconnue. N'invente rien."
          : "Analyse l'image ou le document de matériel. Retourne uniquement du JSON avec supplier, items (description, reference, sku, ean, quantity, unit, unitPrice), confidence (0-1) et warnings. Utilise null lorsqu'une valeur est inconnue. N'invente rien.";
      const data = await callAi({
        system,
        user: "Extrais uniquement les informations visibles et structurées.",
        imageDataUrl,
        json: true,
      });
      res.json({ mode, data });
    }),
  );

  r.post(
    "/transcribe",
    wrap(async (req, res) => {
      if (req.user.role === "client") D.fail("Accès non autorisé.", 403);
      if (!transcriptionConfigured())
        D.fail("La transcription serveur n'est pas configurée. Utilisez la dictée du navigateur ou configurez AI_TRANSCRIBE_API_URL.", 503);
      const dataUrl = validAudioDataUrl(req.body?.audioDataUrl);
      const match = dataUrl.match(/^data:(audio\/[A-Za-z0-9.+-]+);base64,(.+)$/);
      const mime = match[1];
      const buffer = Buffer.from(match[2], "base64");
      const extension = mime.includes("webm")
        ? "webm"
        : mime.includes("wav")
          ? "wav"
          : mime.includes("mpeg") || mime.includes("mp3")
            ? "mp3"
            : "audio";
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: mime }), "compte-rendu." + extension);
      form.append("model", process.env.AI_TRANSCRIBE_MODEL || "whisper-1");
      if (process.env.AI_TRANSCRIBE_LANGUAGE)
        form.append("language", process.env.AI_TRANSCRIBE_LANGUAGE);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await fetch(process.env.AI_TRANSCRIBE_API_URL, {
          method: "POST",
          headers: { Authorization: "Bearer " + process.env.AI_API_KEY },
          body: form,
          signal: controller.signal,
          redirect: "error",
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) D.fail("Le service de transcription est indisponible.", 502);
        const text = String(payload?.text || payload?.transcript || providerText(payload) || "").trim();
        if (!text) D.fail("Aucune transcription reçue.", 502);
        res.json({ text: text.slice(0, 20000) });
      } catch (error) {
        if (error?.status) throw error;
        D.fail("Le service de transcription est indisponible.", 502);
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  r.get(
    "/workload",
    wrap(async (req, res) => {
      if (req.user.role === "client") D.fail("Accès non autorisé.", 403);
      const ctx = await stateContext(db, req.user);
      res.json(buildWorkload(ctx, req.user, req.query.weeks || 4, req.query.start || todayIso()));
    }),
  );

  r.post(
    "/planning-suggestions",
    wrap(async (req, res) => {
      roleAllowed(req.user, [...new Set([...D.HR, "manager"])]);
      const ctx = await stateContext(db, req.user);
      const projectId = clean(req.body?.projectId, 200);
      const project = ctx.view.projects.find((p) => D.same(p.id, projectId));
      if (!project) D.fail("Chantier inaccessible.", 403);
      const date = isoDate(req.body?.date);
      const start = hhmm(req.body?.start);
      const end = hhmm(req.body?.end);
      if (durationHours(start, end) <= 0) D.fail("Créneau invalide.");
      const limit = Math.min(10, Math.max(1, Number.parseInt(String(req.body?.limit || 5), 10) || 5));
      const weekStart = mondayOf(date);
      const weekEnd = addDays(weekStart, 6);
      const words = new Set(
        String((project.title || "") + " " + (project.description || ""))
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .split(/[^a-z0-9]+/)
          .filter((x) => x.length >= 4),
      );
      const employees = (ctx.view.employees || []).filter(
        (e) =>
          !e.deletedAt &&
          D.employeeInCompany(e, project.company),
      );
      const suggestions = [];
      for (const employee of employees) {
        const absent = (ctx.data.absences || []).some(
          (a) =>
            D.same(a.employeeId, employee.id) &&
            a.status === "Approuvée" &&
            a.from <= date &&
            a.to >= date,
        );
        if (absent) continue;
        const conflict = (ctx.data.planning || []).some(
          (p) =>
            D.same(p.employeeId, employee.id) &&
            p.date === date &&
            p.start < end &&
            p.end > start,
        );
        if (conflict) continue;
        const weeklyPlanned = (ctx.data.planning || [])
          .filter(
            (p) =>
              D.same(p.employeeId, employee.id) &&
              p.date >= weekStart &&
              p.date <= weekEnd,
          )
          .reduce((sum, p) => sum + durationHours(p.start, p.end), 0);
        const capacity = employeeCapacity(employee);
        const available = Math.max(0, capacity - weeklyPlanned);
        let score = Math.max(0, Math.min(45, (available / Math.max(capacity, 1)) * 45));
        const reasons = [`${available.toFixed(1)} h disponibles sur la semaine`];
        if ((project.team || []).some((id) => D.same(id, employee.id))) {
          score += 30;
          reasons.push("déjà dans l'équipe du chantier");
        }
        const jobWords = String(employee.job || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .split(/[^a-z0-9]+/)
          .filter((x) => x.length >= 4);
        const matches = jobWords.filter((word) => words.has(word));
        if (matches.length) {
          score += Math.min(20, matches.length * 8);
          reasons.push("fonction cohérente avec le chantier");
        }
        if (!(ctx.data.planning || []).some((p) => D.same(p.employeeId, employee.id) && p.date === date)) {
          score += 10;
          reasons.push("aucune autre affectation ce jour");
        }
        suggestions.push({
          employeeId: String(employee.id),
          name: employee.name || String(employee.id),
          job: employee.job || "",
          score: Math.round(score * 10) / 10,
          weeklyPlanned: Math.round(weeklyPlanned * 100) / 100,
          weeklyCapacity: capacity,
          reasons,
        });
      }
      suggestions.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "fr"));
      res.json({
        project: { id: String(project.id), title: project.title || String(project.id), company: project.company },
        slot: { date, start, end },
        suggestions: suggestions.slice(0, limit),
      });
    }),
  );

  r.get(
    "/anomalies",
    wrap(async (req, res) => {
      if (req.user.role === "client") D.fail("Accès non autorisé.", 403);
      const ctx = await stateContext(db, req.user);
      res.json({ anomalies: await buildAnomalies(db, ctx) });
    }),
  );

  return r;
}

module.exports = {
  routes,
  buildWorkload,
  normalizeQuoteDraft,
  providerText,
  parseJsonText,
};
