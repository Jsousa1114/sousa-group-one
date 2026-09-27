"use strict";
const { randomBytes, createHmac, createHash } = require("node:crypto");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buffer) {
  let bits = "", out = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    out += ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}
function base32Decode(value) {
  const s = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of s) {
    const n = ALPHABET.indexOf(c);
    if (n < 0) continue;
    bits += n.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function codeAt(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buf).digest(),
    offset = digest[digest.length - 1] & 0x0f,
    num =
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff);
  return String(num % 1000000).padStart(6, "0");
}
function verifyTotp(secret, code, now = Date.now()) {
  const value = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(value) || !secret) return false;
  const counter = Math.floor(now / 30000);
  return [-1, 0, 1].some((d) => codeAt(secret, counter + d) === value);
}
function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}
function otpauthUri(secret, email) {
  const issuer = "Sousa Group One";
  return (
    "otpauth://totp/" +
    encodeURIComponent(issuer + ":" + email) +
    "?secret=" +
    encodeURIComponent(secret) +
    "&issuer=" +
    encodeURIComponent(issuer) +
    "&algorithm=SHA1&digits=6&period=30"
  );
}
function normalizeRecoveryCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
function hashRecoveryCode(value) {
  return createHash("sha256")
    .update(normalizeRecoveryCode(value))
    .digest("hex");
}
function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(9)
      .toString("base64url")
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, 12)
      .padEnd(12, "X");
    return raw.match(/.{1,4}/g).join("-");
  });
}
module.exports = {
  generateTotpSecret,
  verifyTotp,
  otpauthUri,
  codeAt,
  normalizeRecoveryCode,
  hashRecoveryCode,
  generateRecoveryCodes,
};
