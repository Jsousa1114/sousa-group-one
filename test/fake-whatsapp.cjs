"use strict";
// A stand-in for WhatsApp as the Baileys socket shows it: events (QR code, connection, history,
// new messages, receipts, reactions, numbers), and the calls the application makes (send, read,
// pairing code, group names, logout). The test drives the events.
const { EventEmitter } = require("node:events");

function fakeWhatsApp() {
  const calls = { sent: [], read: [], presence: [], logout: 0, pairing: [], sockets: 0 };
  let current = null;
  let counter = 0;
  function factory(options) {
    calls.sockets++;
    const ev = new EventEmitter();
    const sock = {
      ev,
      options,
      user: null,
      async sendMessage(jid, content, opts) {
        const id = "OUT" + ++counter;
        calls.sent.push({ jid, content, opts });
        let message;
        if (content.text != null) message = opts?.quoted ? { extendedTextMessage: { text: content.text, contextInfo: { stanzaId: opts.quoted.key.id, quotedMessage: opts.quoted.message } } } : { conversation: content.text };
        else if (content.document) message = { documentMessage: { fileName: content.fileName, mimetype: content.mimetype, fileLength: content.document.length, caption: content.caption } };
        else if (content.image) message = { imageMessage: { mimetype: content.mimetype, fileLength: content.image.length, caption: content.caption } };
        else message = { conversation: "?" };
        return { key: { remoteJid: jid, fromMe: true, id }, message, messageTimestamp: Math.floor(Date.now() / 1000), status: 1 };
      },
      async readMessages(keys) {
        calls.read.push(...keys);
      },
      async sendPresenceUpdate(type, jid) {
        calls.presence.push([type, jid]);
      },
      async requestPairingCode(phone) {
        calls.pairing.push(phone);
        return "ABCD1234";
      },
      async groupMetadata(jid) {
        return { id: jid, subject: "Équipe chantier" };
      },
      async logout() {
        calls.logout++;
        ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
      },
      end() {},
      updateMediaMessage: async (m) => m,
    };
    current = sock;
    return sock;
  }
  const emit = (event, payload) => current.ev.emit(event, payload);
  return {
    calls,
    factory,
    emit,
    socket: () => current,
    showQr: (qr = "2@QRCODE-TEST,abc,def") => emit("connection.update", { qr }),
    // The phone scanned the code: the session is saved, then WhatsApp asks for a restart.
    scan(me = { id: "41790000000:7@s.whatsapp.net", name: "Sousa Group" }) {
      current.options.auth.creds.me = me;
      current.options.auth.creds.registered = true;
      emit("creds.update", { me });
    },
    open(me = { id: "41790000000:7@s.whatsapp.net", name: "Sousa Group" }) {
      current.user = me;
      emit("connection.update", { connection: "open" });
    },
    close: (statusCode, message = "") => emit("connection.update", { connection: "close", lastDisconnect: { error: { message, output: { statusCode } } } }),
  };
}

module.exports = { fakeWhatsApp };
