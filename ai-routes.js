"use strict";
const express = require("express");
const D = require("./domain");
const { auth } = require("./auth-middleware");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ALLOWED = new Set(["admin", "direction", "hr", "manager", "accounting", "employee"]);

function clean(value, max = 12000) {
  return String(value ?? "").trim().slice(0, max);
}
function configured() {
  return !!process.env.OPENAI_API_KEY;
}
function model() {
  return process.env.OPENAI_MODEL || "gpt-5.6-luna";
}
function transcriptionModel() {
  return process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-transcribe";
}
function extractText(response) {
  if (typeof response?.output_text === "string") return response.output_text.trim();
  const parts = [];
  for (const item of response?.output || [])
    for (const content of item?.content || [])
      if (typeof content?.text === "string") parts.push(content.text);
  return parts.join("\n").trim();
}
async function responseApi(input, instructions) {
  if (!configured()) D.fail("Assistant IA non configuré sur le serveur.", 503);
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model(),
      store: false,
      instructions:
        instructions ||
        "Tu es l’assistant interne de Sousa Group One. Réponds en français, factuellement, à partir des données fournies. N’invente aucune donnée manquante.",
      input,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok)
    D.fail(
      "Service IA indisponible : " +
        clean(body?.error?.message || ("HTTP " + r.status), 400),
      502,
    );
  return extractText(body);
}
async function context(db, user) {
  const row = (await db.query("SELECT data FROM app_state WHERE id=1")).rows[0];
  const data = D.normalize(row?.data);
  return { data, view: D.viewState(data, user) };
}
function compactContext(view) {
  return {
    companies: view.companies?.map((x) => ({ id: x.id, name: x.name })) || [],
    employees:
      view.employees?.map((x) => ({
        id: x.id,
        name: x.name,
        job: x.job,
        company: x.company,
        vacation: x.vacation,
      })) || [],
    clients:
      view.clients?.map((x) => ({ id: x.id, name: x.name, city: x.city })) || [],
    projects:
      view.projects?.map((x) => ({
        id: x.id,
        title: x.title,
        clientId: x.clientId,
        company: x.company,
        status: x.status,
        progress: x.progress,
        budget: x.budget,
        cost: x.cost,
        team: x.team,
      })) || [],
    planning:
      view.planning?.slice(-200).map((x) => ({
        employeeId: x.employeeId,
        project: x.project,
        date: x.date,
        start: x.start,
        end: x.end,
      })) || [],
    time:
      view.time?.slice(-200).map((x) => ({
        employeeId: x.employeeId,
        project: x.project,
        date: x.date,
        hours: x.hours,
        status: x.status,
      })) || [],
    invoices:
      view.invoices?.slice(-100).map((x) => ({
        id: x.id,
        clientId: x.clientId,
        project: x.project,
        amount: x.amount,
        paid: x.paid,
        due: x.due,
        status: x.status,
      })) || [],
    quotes:
      view.quotes?.slice(-100).map((x) => ({
        id: x.id,
        clientId: x.clientId,
        project: x.project,
        amount: x.amount,
        status: x.status,
      })) || [],
    inventory:
      view.inventory?.slice(0, 200).map((x) => ({
        id: x.id,
        sku: x.sku,
        name: x.name,
        stock: x.stock,
        min: x.min,
      })) || [],
  };
}
function deterministicInsights(view) {
  const today = new Date().toISOString().slice(0, 10),
    out = [];
  for (const i of view.invoices || []) {
    const due = Math.max(0, (Number(i.amount) || 0) - (Number(i.paid) || 0));
    if (due > 0 && i.due && i.due < today)
      out.push({ type: "invoice_overdue", id: i.id, amount: due, due: i.due });
  }
  for (const p of view.projects || []) {
    const budget = Number(p.budget) || 0,
      cost = Number(p.cost) || 0;
    if (budget > 0 && cost >= budget * 0.85)
      out.push({
        type: cost > budget ? "project_over_budget" : "project_budget_warning",
        id: p.id,
        title: p.title,
        budget,
        cost,
      });
  }
  for (const x of view.inventory || [])
    if ((Number(x.min) || 0) > 0 && (Number(x.stock) || 0) <= Number(x.min))
      out.push({ type: "low_stock", id: x.id, name: x.name, stock: x.stock, min: x.min });
  return out.slice(0, 100);
}

function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  r.use((req, res, next) => {
    if (!ALLOWED.has(req.user.role)) return res.status(403).json({ error: "Accès IA refusé." });
    next();
  });

  r.get("/status", (req, res) =>
    res.json({
      configured: configured(),
      model: model(),
      transcriptionModel: transcriptionModel(),
      provider: "OpenAI",
    }),
  );

  r.post(
    "/assistant",
    wrap(async (req, res) => {
      const { view } = await context(db, req.user),
        prompt = clean(req.body?.prompt, 6000);
      if (!prompt) D.fail("Question requise.");
      const text = await responseApi(
        [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  prompt +
                  "\n\nDonnées autorisées de Sousa Group One :\n" +
                  JSON.stringify(compactContext(view)),
              },
            ],
          },
        ],
        "Tu es l’assistant interne opérationnel de Sousa Group One. Réponds en français. Utilise uniquement les données autorisées fournies. Signale clairement toute information manquante.",
      );
      res.json({ text });
    }),
  );

  r.post(
    "/quote-draft",
    wrap(async (req, res) => {
      const { view } = await context(db, req.user),
        description = clean(req.body?.description, 6000),
        projectId = clean(req.body?.projectId, 120),
        project = projectId ? view.projects.find((x) => D.same(x.id, projectId)) : null;
      if (!description) D.fail("Description des travaux requise.");
      const text = await responseApi(
        [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Prépare un brouillon de devis professionnel. Donne : titre, hypothèses, prestations détaillées, quantités/unités lorsque déductibles, exclusions, puis une liste JSON de lignes à la fin. Ne crée aucun prix non fourni ; indique PRIX À COMPLÉTER.\n\nTravaux : " +
                  description +
                  "\nChantier : " +
                  JSON.stringify(project || null),
              },
            ],
          },
        ],
      );
      res.json({ text });
    }),
  );

  r.post(
    "/daily-summary",
    wrap(async (req, res) => {
      const { view } = await context(db, req.user),
        date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date || ""))
          ? String(req.body.date)
          : new Date().toISOString().slice(0, 10),
        data = {
          date,
          planning: (view.planning || []).filter((x) => x.date === date),
          time: (view.time || []).filter((x) => x.date === date),
          messages: (view.messages || [])
            .filter((x) => String(x.createdAt || "").startsWith(date))
            .slice(-80)
            .map((x) => ({ sender: x.sender, text: x.text, createdAt: x.createdAt })),
          projects: view.projects || [],
        };
      const text = await responseApi([
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Rédige le résumé opérationnel journalier Sousa Group One : travail réalisé, chantiers concernés, heures, points bloquants, actions demain et éléments à facturer/surveiller.\n" +
                JSON.stringify(data),
            },
          ],
        },
      ]);
      res.json({ text, date });
    }),
  );

  r.post(
    "/planning-assist",
    wrap(async (req, res) => {
      const { view } = await context(db, req.user),
        objective = clean(req.body?.objective, 3000);
      const text = await responseApi([
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Propose une planification. Ne modifie rien automatiquement. Respecte les affectations existantes, les rôles et évite les chevauchements. Objectif : " +
                (objective || "équilibrer la charge des équipes") +
                "\nDonnées : " +
                JSON.stringify(compactContext(view)),
            },
          ],
        },
      ]);
      res.json({ text });
    }),
  );

  r.post(
    "/anomaly-review",
    wrap(async (req, res) => {
      const { view } = await context(db, req.user),
        insights = deterministicInsights(view);
      const text = await responseApi([
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Analyse ces alertes déterministes. Priorise les actions sans inventer de causes.\n" +
                JSON.stringify(insights),
            },
          ],
        },
      ]);
      res.json({ text, insights });
    }),
  );

  r.post(
    "/image",
    wrap(async (req, res) => {
      const kind = ["invoice", "material", "general"].includes(req.body?.kind)
          ? req.body.kind
          : "general",
        mime = clean(req.body?.mime, 80),
        content = clean(req.body?.content, 8 * 1024 * 1024);
      if (!/^image\/(jpeg|png|webp)$/.test(mime) || !content)
        D.fail("Image JPEG, PNG ou WebP requise.");
      if (Buffer.from(content, "base64").length > 5 * 1024 * 1024)
        D.fail("Image de 5 Mo maximum.");
      const instructions =
        kind === "invoice"
          ? "Extrais les données de cette facture fournisseur : fournisseur, date, référence, lignes, quantités, montants, TVA et total. Signale les champs incertains. Ne devine rien."
          : kind === "material"
            ? "Identifie le matériel visible : marque, modèle/référence, caractéristiques lisibles, quantité visible et remarques. Ne devine pas les références illisibles."
            : "Analyse cette image dans le contexte d’un chantier et décris uniquement ce qui est visible.";
      const text = await responseApi([
        {
          role: "user",
          content: [
            { type: "input_text", text: instructions },
            { type: "input_image", image_url: "data:" + mime + ";base64," + content },
          ],
        },
      ]);
      res.json({ text, kind });
    }),
  );

  r.post(
    "/transcribe",
    wrap(async (req, res) => {
      if (!configured()) D.fail("Assistant IA non configuré sur le serveur.", 503);
      const mime = clean(req.body?.mime, 80),
        content = clean(req.body?.content, 12 * 1024 * 1024);
      if (!/^audio\/(webm|ogg|mpeg|mp4|wav|x-m4a|m4a)$/.test(mime) || !content)
        D.fail("Fichier audio non reconnu.");
      const buf = Buffer.from(content, "base64");
      if (!buf.length || buf.length > 8 * 1024 * 1024) D.fail("Audio de 8 Mo maximum.");
      const ext = mime.includes("wav")
          ? "wav"
          : mime.includes("ogg")
            ? "ogg"
            : mime.includes("mpeg")
              ? "mp3"
              : mime.includes("m4a") || mime.includes("mp4")
                ? "m4a"
                : "webm",
        form = new FormData();
      form.append("file", new Blob([buf], { type: mime }), "audio." + ext);
      form.append("model", transcriptionModel());
      form.append("response_format", "json");
      const r2 = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY },
        body: form,
      });
      const body = await r2.json().catch(() => ({}));
      if (!r2.ok)
        D.fail(
          "Transcription indisponible : " +
            clean(body?.error?.message || ("HTTP " + r2.status), 400),
          502,
        );
      res.json({ text: clean(body.text, 20000) });
    }),
  );

  return r;
}
module.exports = { routes, deterministicInsights, extractText };
