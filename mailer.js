"use strict";
// Outgoing e-mail over SMTP (Gmail with an app password by default).
//   SMTP_USER   the sending address, e.g. sousagroup.xxx@gmail.com
//   SMTP_PASS   the 16-character Google "app password" (never the account password)
//   SMTP_HOST   default smtp.gmail.com, SMTP_PORT default 465 (TLS)
//   MAIL_FROM_NAME  name shown to recipients (default "Sousa Group One")
//   MAIL_REPLY_TO   optional address for replies
const nodemailer = require("nodemailer");

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const validEmail = (value) => typeof value === "string" && value.length <= 254 && EMAIL.test(value.trim());

function settings() {
  const user = String(process.env.SMTP_USER || "").trim();
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    host: String(process.env.SMTP_HOST || "smtp.gmail.com").trim(),
    port,
    secure: String(process.env.SMTP_SECURE || (port === 465 ? "true" : "false")) === "true",
    user,
    pass: String(process.env.SMTP_PASS || "").replace(/\s+/g, ""),
    fromName: String(process.env.MAIL_FROM_NAME || "Sousa Group One").replace(/["<>\r\n]/g, "").trim() || "Sousa Group One",
    replyTo: validEmail(process.env.MAIL_REPLY_TO || "") ? process.env.MAIL_REPLY_TO.trim() : "",
  };
}

function configured() {
  const s = settings();
  return !!(s.host && validEmail(s.user) && s.pass);
}

function sender() {
  const s = settings();
  return configured() ? { address: s.user, name: s.fromName, replyTo: s.replyTo } : null;
}

let transport = null,
  transportKey = "";
function getTransport() {
  const s = settings();
  const key = [s.host, s.port, s.secure, s.user, s.pass].join("|");
  if (!transport || transportKey !== key) {
    transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: { user: s.user, pass: s.pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    transportKey = key;
  }
  return transport;
}

// Errors are turned into plain French, without passwords or server messages.
function friendlyError(error) {
  const code = String(error?.code || "");
  const response = Number(error?.responseCode || 0);
  if (code === "EAUTH" || response === 535 || response === 534)
    return "Gmail a refusé la connexion : vérifiez l’adresse d’envoi et le mot de passe d’application.";
  if (response === 550 || response === 553 || code === "EENVELOPE") return "Adresse du destinataire refusée.";
  if (response === 552 || response === 554) return "Message refusé par le serveur d’envoi (pièce jointe trop lourde ou contenu bloqué).";
  if (response === 421 || response === 450 || response === 451 || response === 452)
    return "Le serveur d’envoi est momentanément saturé ou la limite quotidienne Gmail est atteinte. Réessayez plus tard.";
  if (["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNREFUSED", "EDNS", "ENOTFOUND"].includes(code))
    return "Le serveur d’envoi ne répond pas. Réessayez dans quelques minutes.";
  return "L’e-mail n’a pas pu être envoyé.";
}

// attachments: [{ filename, content: Buffer, contentType }]
async function sendMail({ to, subject, text, attachments = [], replyTo = "" }) {
  if (!configured()) {
    const error = new Error("L’envoi d’e-mails n’est pas configuré sur le serveur (SMTP_USER et SMTP_PASS).");
    error.status = 503;
    error.expose = true;
    throw error;
  }
  if (!validEmail(to)) {
    const error = new Error("Adresse e-mail du destinataire invalide.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const s = settings();
  try {
    const info = await getTransport().sendMail({
      from: { name: s.fromName, address: s.user },
      to: to.trim(),
      replyTo: validEmail(replyTo) ? replyTo.trim() : s.replyTo || undefined,
      subject: String(subject || "").replace(/[\r\n]+/g, " ").slice(0, 250),
      text: String(text || ""),
      attachments,
    });
    return { messageId: String(info?.messageId || "") };
  } catch (error) {
    console.warn("mail.send.failed", error?.code || "unknown", error?.responseCode || "");
    const out = new Error(friendlyError(error));
    out.status = 502;
    out.expose = true;
    throw out;
  }
}

module.exports = { configured, sender, sendMail, validEmail, friendlyError, _reset: () => (transport = null) };
