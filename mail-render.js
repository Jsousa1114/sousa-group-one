"use strict";
// E-mails laid out with the company's logo and details. The plain text version is always
// included (some clients and mail programs only show that one). The logo is embedded in the
// message rather than linked, so it shows even when remote images are blocked.
const fs = require("node:fs");
const path = require("node:path");
const { companyBrand } = require("./finance");

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const logoCache = new Map();
function logoFor(company) {
  const id = companyBrand(company?.id, company);
  if (!logoCache.has(id)) {
    const file = path.join(__dirname, "assets/logos/email", id + ".png");
    logoCache.set(id, fs.existsSync(file) ? fs.readFileSync(file) : null);
  }
  return logoCache.get(id);
}

// The details printed under the message: address, phone, e-mail, website.
function signatureLines(company, settings) {
  const b = company?.billing || {};
  const address = [[b.street, b.buildingNumber].filter(Boolean).join(" "), [b.zip, b.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [
    company?.name || "Sousa Group One",
    address,
    settings?.signature?.phone ? "Tél. " + settings.signature.phone : "",
    b.email || "",
    settings?.signature?.website || "",
    settings?.signature?.extra || "",
  ].filter(Boolean);
}

function paragraphs(text) {
  return String(text || "")
    .trim()
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 14px;line-height:1.55">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// body: the message without greeting formula at the end; "Meilleures salutations" and the
// signature are added here. button: { label, url } for a link to the client area.
// closing: false when the text already ends with a greeting formula (assistant messages).
function compose({ company, settings, subject, body, button = null, sender = "", closing: withClosing = true }) {
  const lines = signatureLines(company, settings);
  const name = company?.name || "Sousa Group One";
  const closing = withClosing ? `Meilleures salutations\n${sender ? sender + "\n" : ""}${name}` : "";
  const text = [String(body || "").trim(), button ? `${button.label} : ${button.url}` : "", closing, "—\n" + lines.join("\n")].filter(Boolean).join("\n\n");
  const logo = logoFor(company);
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2a37">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e3e7ee">
<tr><td style="padding:22px 28px;border-bottom:1px solid #e9edf3">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
${logo ? `<td style="padding-right:14px"><img src="cid:logo@sousa" width="56" height="56" alt="" style="display:block;border-radius:10px"></td>` : ""}
<td style="font-size:18px;font-weight:700;color:#1f2a37">${escapeHtml(name)}</td></tr></table></td></tr>
<tr><td style="padding:26px 28px 8px;font-size:15px">${paragraphs(body)}
${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td style="background:#283f61;border-radius:8px"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:12px 20px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px">${escapeHtml(button.label)}</a></td></tr></table>` : ""}
${closing ? paragraphs(closing) : ""}</td></tr>
<tr><td style="padding:16px 28px 22px;background:#f8fafc;border-top:1px solid #e9edf3;font-size:12px;line-height:1.6;color:#5b6779">${lines.map(escapeHtml).join("<br>")}</td></tr>
</table></td></tr></table></body></html>`;
  return {
    subject,
    text,
    html,
    attachments: logo ? [{ filename: "logo.png", content: logo, contentType: "image/png", cid: "logo@sousa" }] : [],
  };
}

module.exports = { compose, signatureLines, escapeHtml };
