"use strict";
// SMS of a person's own number, through the free Android application « SMS Gateway for
// Android » (open source) installed on their phone. Sending goes through the application's
// relay server (cloud) or a private one; received messages come straight from the phone to
// this server (webhook). With a passphrase, the text and the numbers sent are encrypted end to
// end (the relay cannot read them), in the application's own format.
// Apple does not let any iPhone application read or send SMS: there, SMS stay on the phone.
const { createHmac, timingSafeEqual, randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } = require("node:crypto");

const CLOUD_URL = "https://api.sms-gate.app/3rdparty/v1";
const EVENTS = ["sms:received", "sms:batch:received", "sms:sent", "sms:delivered", "sms:failed"];
const ALGORITHM = "aes-256-cbc/pbkdf2-sha1/v2";
const ITERATIONS = 300000;

let fetcher = (...args) => fetch(...args); // tests use a stand-in for the relay server

// --- end-to-end encryption (same format as the Android application) ---
function encrypt(text, passphrase) {
  const iv = randomBytes(16);
  const salt = randomBytes(16);
  const key = pbkdf2Sync(String(passphrase), salt, ITERATIONS, 32, "sha1");
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return `$${ALGORITHM}$i=${ITERATIONS}$${iv.toString("base64")}$${salt.toString("base64")}$${data.toString("base64")}`;
}
function decrypt(value, passphrase) {
  const chunks = String(value).split("$");
  if (chunks.length < 5 || chunks[0] !== "") throw new Error("format");
  const algorithm = chunks[1];
  const params = Object.fromEntries(chunks[2].split(",").map((p) => p.split("=")));
  const iterations = Number(params.i);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5000000) throw new Error("format");
  let iv, salt, data;
  if (algorithm === ALGORITHM) [iv, salt, data] = chunks.slice(3, 6).map((c) => Buffer.from(c, "base64"));
  else if (algorithm === "aes-256-cbc/pbkdf2-sha1") {
    salt = iv = Buffer.from(chunks[3], "base64");
    data = Buffer.from(chunks[4], "base64");
  } else throw new Error("algorithm");
  const key = pbkdf2Sync(String(passphrase), salt, iterations, 32, "sha1");
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
const looksEncrypted = (value) => /^\$aes-256-cbc\/pbkdf2-sha1(\/v2)?\$i=\d+\$/.test(String(value || ""));

// --- webhook signature (X-Signature = HMAC-SHA256(body + X-Timestamp), when a key is set) ---
function validSignature(rawBody, headers, key) {
  const signature = String(headers["x-signature"] || "");
  const timestamp = String(headers["x-timestamp"] || "");
  if (!key) return true;
  if (!signature || !/^\d{9,12}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 15 * 60) return false;
  const expected = createHmac("sha256", key).update(Buffer.concat([Buffer.from(rawBody || ""), Buffer.from(timestamp)])).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- the relay server's API ---
function client({ url = CLOUD_URL, login, password }) {
  const base = String(url || CLOUD_URL).replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
  return async (method, path, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetcher(base + path, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: "error",
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const error = new Error(res.status === 401 || res.status === 403 ? "Identifiants refusés par le serveur SMS." : `Le serveur SMS a répondu ${res.status}.`);
        error.status = res.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.status) throw error;
      throw new Error("Le serveur SMS ne répond pas.");
    } finally {
      clearTimeout(timer);
    }
  };
}

// Points the phone's events (received, sent, delivered, failed) to this server.
async function register(settings, hookUrl) {
  const call = client(settings);
  const existing = (await call("GET", "/webhooks").catch(() => [])) || [];
  for (const hook of Array.isArray(existing) ? existing : [])
    if (hook?.id && String(hook.url || "").startsWith(hookUrl.replace(/\/[^/]+$/, "/"))) await call("DELETE", "/webhooks/" + encodeURIComponent(hook.id)).catch(() => {});
  const ids = [];
  for (const event of EVENTS) {
    const out = await call("POST", "/webhooks", { url: hookUrl, event });
    if (out?.id) ids.push(out.id);
  }
  return ids;
}
async function unregister(settings, ids = []) {
  const call = client(settings);
  for (const id of ids) await call("DELETE", "/webhooks/" + encodeURIComponent(id)).catch(() => {});
}

async function send(settings, number, text) {
  const call = client(settings);
  const encrypted = !!settings.passphrase;
  const body = {
    textMessage: { text: encrypted ? encrypt(text, settings.passphrase) : String(text) },
    phoneNumbers: [encrypted ? encrypt(number, settings.passphrase) : number],
    withDeliveryReport: true,
    ...(encrypted ? { isEncrypted: true } : {}),
  };
  const out = await call("POST", "/messages", body);
  return { id: String(out?.id || ""), state: String(out?.state || "Pending") };
}

// What a webhook says, as rows for the application: received messages and status changes.
function readEvent(body, passphrase = "") {
  const event = String(body?.event || "");
  const payload = body?.payload || {};
  const open = (value) => {
    if (passphrase && looksEncrypted(value)) {
      try {
        return decrypt(value, passphrase);
      } catch {
        return "";
      }
    }
    return String(value ?? "");
  };
  if (event === "sms:received" || event === "sms:batch:received") {
    const list = event === "sms:received" ? [payload] : Array.isArray(payload.messages) ? payload.messages : [];
    return {
      received: list
        .filter((m) => m && (m.phoneNumber || m.sender))
        .map((m) => ({
          id: String(m.messageId || m.id || ""),
          number: open(m.phoneNumber || m.sender),
          body: open(m.message ?? m.text ?? "").slice(0, 5000),
          at: m.receivedAt && !Number.isNaN(Date.parse(m.receivedAt)) ? new Date(m.receivedAt) : new Date(),
        })),
      statuses: [],
    };
  }
  const STATUS = { "sms:sent": "sent", "sms:delivered": "delivered", "sms:failed": "failed" };
  if (STATUS[event] && payload.messageId) return { received: [], statuses: [{ id: String(payload.messageId), status: STATUS[event], reason: String(payload.reason || "").slice(0, 200) }] };
  return { received: [], statuses: [] };
}

const newToken = () => randomBytes(24).toString("base64url");
const newPassphrase = () => {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{4}/g).join("-");
};

module.exports = {
  CLOUD_URL,
  EVENTS,
  encrypt,
  decrypt,
  looksEncrypted,
  validSignature,
  register,
  unregister,
  send,
  readEvent,
  newToken,
  newPassphrase,
  _setFetch: (fn) => (fetcher = fn || ((...args) => fetch(...args))),
};
