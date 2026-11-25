"use strict";
// E-mail settings of each company: texts with fields such as {client} or {montant}, the
// signature, the delays of the automatic sendings, a hidden copy, and which automatic
// sendings are switched on (with the date they were switched on, so nothing is retroactive).

const TEMPLATES = {
  invoice: {
    label: "Facture",
    subject: "Facture {document} — {entreprise}",
    body: "Bonjour {client},\n\nVous trouverez en pièce jointe notre facture {document}{objet} d’un montant de {montant}, payable jusqu’au {echeance}.\n\nLe bulletin de versement QR figure sur la dernière page.",
  },
  quote: {
    label: "Devis",
    subject: "Devis {document} — {entreprise}",
    body: "Bonjour {client},\n\nVous trouverez en pièce jointe notre devis {document}{objet} d’un montant de {montant}, valable jusqu’au {validite}.\n\nNous restons à votre disposition pour toute question.",
  },
  reminder1: {
    label: "1er rappel de facture",
    subject: "Rappel : facture {document}",
    body: "Bonjour {client},\n\nSauf erreur de notre part, la facture {document}{objet} du {date_document}, échue le {echeance}, présente un solde de {reste}.\n\nVous trouverez la facture avec le bulletin de versement QR en pièce jointe. Si le paiement a été effectué entre-temps, merci de ne pas tenir compte de ce message.",
  },
  reminder2: {
    label: "2e rappel de facture",
    subject: "Deuxième rappel : facture {document}",
    body: "Bonjour {client},\n\nMalgré notre précédent rappel, la facture {document}{objet} du {date_document}, échue le {echeance}, présente un solde de {reste}.\n\nNous vous remercions de bien vouloir procéder au règlement dans les 10 jours. Vous trouverez la facture avec le bulletin de versement QR en pièce jointe.\n\nSi vous rencontrez une difficulté, n’hésitez pas à nous contacter en répondant à ce message.",
  },
  reminder3: {
    label: "Dernier rappel de facture",
    subject: "Dernier rappel : facture {document}",
    body: "Bonjour {client},\n\nMalgré nos rappels, la facture {document}{objet} du {date_document}, échue le {echeance}, présente un solde de {reste}.\n\nNous vous prions de régler ce montant dans les 10 jours. Sans paiement ni nouvelles de votre part dans ce délai, nous devrons engager la procédure de recouvrement.\n\nVous trouverez la facture avec le bulletin de versement QR en pièce jointe.",
  },
  quoteFollowup: {
    label: "Relance de devis",
    subject: "Votre devis {document}",
    body: "Bonjour {client},\n\nNous revenons vers vous au sujet de notre devis {document}{objet} d’un montant de {montant}, valable jusqu’au {validite}.\n\nAvez-vous des questions, ou souhaitez-vous que nous l’adaptions ? Nous restons volontiers à votre disposition. Vous trouverez le devis en pièce jointe.",
  },
  appointment: {
    label: "Confirmation de rendez-vous",
    subject: "Confirmation de notre intervention du {date}",
    body: "Bonjour {client},\n\nNous vous confirmons notre intervention pour « {chantier} » le {jour} {date}, de {heure_debut} à {heure_fin}, à l’adresse suivante : {adresse}.\n\nIntervenants : {equipe}.\n\nEn cas d’empêchement, merci de nous prévenir en répondant à ce message.",
  },
  appointmentReminder: {
    label: "Rappel de rendez-vous (la veille)",
    subject: "Rappel : notre intervention demain, {date}",
    body: "Bonjour {client},\n\nPour rappel, nous intervenons demain, {jour} {date}, de {heure_debut} à {heure_fin}, à l’adresse suivante : {adresse}, pour « {chantier} ».\n\nÀ demain !",
  },
  invite: {
    label: "Invitation à l’espace client",
    subject: "Votre espace client {entreprise}",
    body: "Bonjour {client},\n\nNous vous avons ouvert un espace client en ligne : vous y retrouverez vos devis, factures, documents et l’avancement de vos chantiers.\n\nPour l’activer, choisissez votre mot de passe avec le bouton ci-dessous (lien valable 7 jours).",
  },
};

const FIELDS = {
  client: "nom du client",
  entreprise: "nom de l’entreprise",
  document: "numéro du devis ou de la facture",
  objet: "objet du document, entre parenthèses",
  montant: "montant total",
  reste: "reste à payer",
  echeance: "date d’échéance",
  validite: "fin de validité du devis",
  date_document: "date du document",
  chantier: "nom du chantier",
  jour: "jour de la semaine",
  date: "date du rendez-vous",
  heure_debut: "heure de début",
  heure_fin: "heure de fin",
  adresse: "adresse du chantier",
  equipe: "intervenants",
};

const DEFAULTS = {
  signature: { phone: "", website: "", extra: "" },
  bcc: "",
  templates: {},
  reminderStages: [7, 14, 30],
  automations: {
    invoiceReminders: { enabled: false, enabledAt: null },
    quoteFollowup: { enabled: false, enabledAt: null, days: 7 },
    appointments: { enabled: false, enabledAt: null, dayBefore: true },
    autoSendInvoices: { enabled: false, enabledAt: null },
    autoSendQuotes: { enabled: false, enabledAt: null },
  },
};
const AUTOMATIONS = Object.keys(DEFAULTS.automations);

const clean = (value, max) => String(value ?? "").replace(/\r/g, "").slice(0, max);
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

function merge(config = {}) {
  const c = config && typeof config === "object" ? config : {};
  const automations = {};
  for (const key of AUTOMATIONS) automations[key] = { ...DEFAULTS.automations[key], ...(c.automations?.[key] || {}) };
  const stages = Array.isArray(c.reminderStages) ? c.reminderStages.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 365) : [];
  return {
    signature: { ...DEFAULTS.signature, ...(c.signature || {}) },
    bcc: typeof c.bcc === "string" ? c.bcc : "",
    templates: Object.fromEntries(
      Object.keys(TEMPLATES).map((key) => [
        key,
        {
          subject: c.templates?.[key]?.subject || TEMPLATES[key].subject,
          body: c.templates?.[key]?.body || TEMPLATES[key].body,
          custom: !!(c.templates?.[key]?.subject || c.templates?.[key]?.body),
        },
      ]),
    ),
    reminderStages: stages.length === 3 && stages[0] < stages[1] && stages[1] < stages[2] ? stages : DEFAULTS.reminderStages,
    automations,
  };
}

async function getSettings(db, company) {
  const row = (await db.query("SELECT config FROM mail_settings WHERE company=$1", [String(company || "")])).rows[0];
  const settings = merge(row?.config);
  // Payment reminders switched on before the per-company settings existed stay on.
  if (!row?.config?.automations?.invoiceReminders) {
    const legacy = (await db.query("SELECT enabled,config FROM integration_settings WHERE provider='invoice_email_reminders'")).rows[0];
    if (legacy?.enabled) settings.automations.invoiceReminders = { enabled: true, enabledAt: legacy.config?.enabledAt || null };
  }
  return settings;
}

// Saves what the person changed; switching an automatic sending on records when (non retroactive).
async function saveSettings(db, company, input, userId) {
  const current = await getSettings(db, company);
  const next = { ...current, templates: {} };
  const errors = [];
  if (input.signature)
    next.signature = {
      phone: clean(input.signature.phone, 40).trim(),
      website: clean(input.signature.website, 120).trim(),
      extra: clean(input.signature.extra, 300).trim(),
    };
  if (input.bcc !== undefined) {
    const bcc = clean(input.bcc, 254).trim();
    if (bcc && !EMAIL.test(bcc)) errors.push("Adresse de copie cachée invalide.");
    next.bcc = bcc;
  }
  for (const key of Object.keys(TEMPLATES)) {
    const t = input.templates?.[key];
    const subject = t ? clean(t.subject, 200).trim() : current.templates[key].custom ? current.templates[key].subject : "";
    const body = t ? clean(t.body, 6000).trim() : current.templates[key].custom ? current.templates[key].body : "";
    // A text equal to the default is not stored, so later improvements of the default apply.
    if ((subject && subject !== TEMPLATES[key].subject) || (body && body !== TEMPLATES[key].body))
      next.templates[key] = { subject: subject || TEMPLATES[key].subject, body: body || TEMPLATES[key].body };
  }
  if (Array.isArray(input.reminderStages)) {
    const stages = input.reminderStages.map(Number);
    if (stages.length !== 3 || stages.some((n) => !Number.isInteger(n) || n < 1 || n > 365) || !(stages[0] < stages[1] && stages[1] < stages[2]))
      errors.push("Délais des rappels : trois nombres de jours croissants (par exemple 7, 14 et 30).");
    else next.reminderStages = stages;
  }
  for (const key of AUTOMATIONS) {
    const wanted = input.automations?.[key];
    if (!wanted) continue;
    const was = current.automations[key];
    const enabled = wanted.enabled === true;
    next.automations[key] = {
      ...was,
      enabled,
      enabledAt: enabled ? (was.enabled && was.enabledAt ? was.enabledAt : new Date().toISOString()) : null,
    };
    if (key === "quoteFollowup" && wanted.days !== undefined) {
      const days = Number(wanted.days);
      if (!Number.isInteger(days) || days < 1 || days > 90) errors.push("Relance des devis : entre 1 et 90 jours.");
      else next.automations.quoteFollowup.days = days;
    }
    if (key === "appointments" && wanted.dayBefore !== undefined) next.automations.appointments.dayBefore = wanted.dayBefore === true;
  }
  if (errors.length) {
    const error = new Error(errors.join(" "));
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const stored = {
    signature: next.signature,
    bcc: next.bcc,
    templates: next.templates,
    reminderStages: next.reminderStages,
    automations: next.automations,
  };
  await db.query(
    `INSERT INTO mail_settings(company,config,updated_by,updated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT(company) DO UPDATE SET config=EXCLUDED.config,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
    [String(company), JSON.stringify(stored), userId || null],
  );
  return getSettings(db, company);
}

// {client}, {montant}… are replaced; anything unknown is left as written.
function fill(text, values) {
  return String(text || "").replace(/\{([a-z_]+)\}/g, (all, key) => (values[key] != null ? String(values[key]) : all));
}

module.exports = { TEMPLATES, FIELDS, DEFAULTS, AUTOMATIONS, merge, getSettings, saveSettings, fill };
