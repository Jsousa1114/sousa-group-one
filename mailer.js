"use strict";
// Outgoing e-mail over SMTP (Gmail with an app password by default), one account per company.
//   SMTP_USER_<COMPANY> / SMTP_PASS_<COMPANY>  the Gmail address and its 16-character "app
//       password" for one company, saved under its name without "Sousa", in capitals
//       (ELECTRICITE, HOME, TECH, MOVING, SOLAR, EVENTS, GROUP) or under its id.
//   SMTP_USER / SMTP_PASS  optional default account, used by companies without their own.
//   SMTP_HOST default smtp.gmail.com, SMTP_PORT default 465 (TLS)
//   MAIL_FROM_NAME  name shown when no company name is given (default "Sousa Group One")
//   MAIL_REPLY_TO   optional address for replies
const nodemailer = require("nodemailer");

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const validEmail = (value) => typeof value === "string" && value.length <= 254 && EMAIL.test(value.trim());
const envKey = (company) => String(company || "").toUpperCase().replace(/[^A-Z0-9]/g, "_");

// The names a company's account can be saved under: its id, its name without "Sousa"
// ("Sousa Moving" → MOVING, "Sousa Home Service" → HOME_SERVICE, then HOME), and its code.
// Companies created in the application have a generated id, so the name is what people use.
function accountKeys(company) {
  if (!company) return [];
  const c = typeof company === "object" ? company : { id: company };
  const keys = [envKey(c.id)];
  if (c.name) {
    const slug = String(c.name)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/^SOUSA[\s-]+/, "")
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    keys.push(slug);
    if (c.code) keys.push(envKey(c.code));
    keys.push(slug.split("_")[0]);
  } else if (c.code) keys.push(envKey(c.code));
  return [...new Set(keys.filter(Boolean))];
}

function account(company) {
  for (const key of accountKeys(company))
    if (validEmail(process.env["SMTP_USER_" + key] || "") && String(process.env["SMTP_PASS_" + key] || "").trim())
      return { user: process.env["SMTP_USER_" + key].trim(), pass: process.env["SMTP_PASS_" + key], source: "company", key };
  if (validEmail(process.env.SMTP_USER || "") && String(process.env.SMTP_PASS || "").trim())
    return { user: process.env.SMTP_USER.trim(), pass: process.env.SMTP_PASS, source: "default" };
  return null;
}

function settings(company) {
  const port = Number(process.env.SMTP_PORT || 465);
  const found = account(company);
  return {
    host: String(process.env.SMTP_HOST || "smtp.gmail.com").trim(),
    port,
    secure: String(process.env.SMTP_SECURE || (port === 465 ? "true" : "false")) === "true",
    user: found?.user || "",
    pass: String(found?.pass || "").replace(/\s+/g, ""),
    source: found?.source || "",
    fromName: String(process.env.MAIL_FROM_NAME || "Sousa Group One").replace(/["<>\r\n]/g, "").trim() || "Sousa Group One",
    replyTo: validEmail(process.env.MAIL_REPLY_TO || "") ? process.env.MAIL_REPLY_TO.trim() : "",
  };
}

// With a company (id or { id, name, code }): is there an account for it (its own or the default)?
// Without: is there at least one account?
function configured(company) {
  if (company !== undefined) return !!(settings(company).host && settings(company).user && settings(company).pass);
  return !!account("") || Object.keys(process.env).some((k) => /^SMTP_USER_[A-Z0-9_]+$/.test(k) && account(k.slice(10).toLowerCase()));
}

function sender(company) {
  const s = settings(company);
  return s.user && s.pass ? { address: s.user, name: s.fromName, replyTo: s.replyTo, source: s.source } : null;
}

const transports = new Map();
function getTransport(s) {
  const key = [s.host, s.port, s.secure, s.user, s.pass].join("|");
  if (!transports.has(key))
    transports.set(
      key,
      nodemailer.createTransport({
        host: s.host,
        port: s.port,
        secure: s.secure,
        auth: { user: s.user, pass: s.pass },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
      }),
    );
  return transports.get(key);
}

// IMAP settings of an account (same address and app password), to read the clients' replies.
function imapSettings(company) {
  const s = settings(company);
  if (!s.user || !s.pass) return null;
  return {
    host: String(process.env.IMAP_HOST || (s.host === "smtp.gmail.com" ? "imap.gmail.com" : "")).trim(),
    port: Number(process.env.IMAP_PORT || 993),
    secure: String(process.env.IMAP_SECURE || "true") === "true",
    user: s.user,
    pass: s.pass,
    source: s.source,
  };
}

// Errors are turned into plain French, without passwords or server messages.
function friendlyError(error, address = "") {
  const code = String(error?.code || "");
  const response = Number(error?.responseCode || 0);
  if (code === "EAUTH" || response === 535 || response === 534)
    return `Gmail a refusé la connexion${address ? " de " + address : ""} : vérifiez l’adresse d’envoi et le mot de passe d’application.`;
  if (response === 550 || response === 553 || code === "EENVELOPE") return "Adresse du destinataire refusée.";
  if (response === 552 || response === 554) return "Message refusé par le serveur d’envoi (pièce jointe trop lourde ou contenu bloqué).";
  if (response === 421 || response === 450 || response === 451 || response === 452)
    return "Le serveur d’envoi est momentanément saturé ou la limite quotidienne Gmail est atteinte. Réessayez plus tard.";
  if (["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNREFUSED", "EDNS", "ENOTFOUND"].includes(code))
    return "Le serveur d’envoi ne répond pas. Réessayez dans quelques minutes.";
  return "L’e-mail n’a pas pu être envoyé.";
}

const userError = (message, status) => Object.assign(new Error(message), { status, expose: true });

// Addresses given as an array or as a text separated by commas or semicolons.
const addressList = (value) =>
  (Array.isArray(value) ? value : String(value || "").split(/[,;]/))
    .map((a) => String(a || "").trim())
    .filter(Boolean);
const messageIds = (value) =>
  (Array.isArray(value) ? value : String(value || "").split(/\s+/))
    .map((id) => String(id || "").replace(/[\r\n\s]+/g, "").trim())
    .filter((id) => /^<[^<>]{3,490}>$/.test(id))
    .slice(-20);

// company: whose Gmail account sends; fromName: the name shown (usually the company name).
// to / cc / bcc: one address or several (array, or text separated by commas).
// attachments: [{ filename, content: Buffer, contentType }]
// html: the laid-out version (the text stays the fallback); bcc: hidden copy.
// inReplyTo / references: Message-IDs of the message answered, so the reply joins its conversation.
async function sendMail({ to, cc = "", subject, text, html = "", attachments = [], replyTo = "", company = "", fromName = "", bcc = "", inReplyTo = "", references = "" }) {
  const s = settings(company);
  if (!s.user || !s.pass) throw userError("L’envoi d’e-mails n’est pas configuré sur le serveur pour cette entreprise.", 503);
  const toList = addressList(to);
  if (!toList.length || !toList.every(validEmail)) throw userError("Adresse e-mail du destinataire invalide.", 400);
  const ccList = addressList(cc);
  if (!ccList.every(validEmail)) throw userError("Adresse en copie invalide.", 400);
  const visible = new Set([...toList, ...ccList].map((a) => a.toLowerCase()));
  const bccList = addressList(bcc).filter((a) => validEmail(a) && !visible.has(a.toLowerCase()));
  const name = String(fromName || s.fromName).replace(/["<>\r\n]/g, "").trim() || s.fromName;
  const answered = messageIds(inReplyTo)[0];
  const thread = messageIds(references);
  try {
    const info = await getTransport(s).sendMail({
      from: { name, address: s.user },
      to: toList.join(", "),
      cc: ccList.length ? ccList.join(", ") : undefined,
      replyTo: validEmail(replyTo) ? replyTo.trim() : s.replyTo || undefined,
      bcc: bccList.length ? bccList.join(", ") : undefined,
      subject: String(subject || "").replace(/[\r\n]+/g, " ").slice(0, 250),
      text: String(text || ""),
      html: html || undefined,
      attachments,
      inReplyTo: answered || undefined,
      references: thread.length ? thread : undefined,
    });
    return { messageId: String(info?.messageId || ""), from: s.user };
  } catch (error) {
    console.warn("mail.send.failed", error?.code || "unknown", error?.responseCode || "");
    throw userError(friendlyError(error, s.user), 502);
  }
}

module.exports = { configured, sender, sendMail, imapSettings, validEmail, friendlyError, envKey, accountKeys, addressList, _reset: () => transports.clear() };
