"use strict";
// An in-memory stand-in for Gmail's IMAP service, with the parts of the ImapFlow client that
// webmail.js uses: folders with special uses, labels (X-GM-LABELS), conversations (X-GM-THRID),
// Gmail search (X-GM-RAW), flags, moves and downloads. Like Gmail, a message lives once and
// appears in every folder whose label it carries; "All messages" holds everything except the
// spam and the trash.
const { Readable } = require("node:stream");
const MailComposer = require("nodemailer/lib/mail-composer");

const FOLDERS = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "[Gmail]", flags: new Set(["\\Noselect", "\\HasChildren"]) },
  { path: "[Gmail]/Tous les messages", specialUse: "\\All" },
  { path: "[Gmail]/Brouillons", specialUse: "\\Drafts" },
  { path: "[Gmail]/Messages envoyés", specialUse: "\\Sent" },
  { path: "[Gmail]/Spam", specialUse: "\\Junk" },
  { path: "[Gmail]/Suivis", specialUse: "\\Flagged" },
  { path: "[Gmail]/Corbeille", specialUse: "\\Trash" },
  { path: "Clients" },
];

function fakeGmail({ password }) {
  const store = { messages: [], nextId: 1, connections: 0 };
  const inFolder = (m, path) => {
    if (m.deleted) return false;
    if (path === "[Gmail]/Corbeille") return m.trash;
    if (path === "[Gmail]/Spam") return m.spam && !m.trash;
    if (m.trash || m.spam) return false;
    if (path === "INBOX") return m.labels.has("\\Inbox");
    if (path === "[Gmail]/Tous les messages") return true;
    if (path === "[Gmail]/Messages envoyés") return m.labels.has("\\Sent");
    if (path === "[Gmail]/Brouillons") return m.flags.has("\\Draft");
    if (path === "[Gmail]/Suivis") return m.flags.has("\\Flagged");
    return m.labels.has(path);
  };
  const messagesIn = (path) => store.messages.filter((m) => inFolder(m, path)).sort((a, b) => a.id - b.id);

  async function add({ from, to = ["moving@sousa.test"], cc = [], subject = "", text = "", html, date = new Date(), threadId, labels = ["\\Inbox"], flags = [], attachments = [], messageId, inReplyTo, references, raw }) {
    const id = store.nextId++;
    const mid = messageId || `<m${id}@fake.test>`;
    const source =
      raw ||
      (await new Promise((resolve, reject) =>
        new MailComposer({ from, to, cc, subject, text, html, date, messageId: mid, inReplyTo, references, attachments }).compile().build((e, m) => (e ? reject(e) : resolve(m))),
      ));
    const parts = {};
    const childNodes = [{ part: "1", type: html ? "text/html" : "text/plain" }];
    attachments.forEach((a, i) => {
      const part = String(i + 2);
      parts[part] = Buffer.from(a.content);
      childNodes.push({
        part,
        type: a.contentType || "application/octet-stream",
        disposition: a.cid ? "inline" : "attachment",
        dispositionParameters: { filename: a.filename },
        id: a.cid ? `<${a.cid}>` : undefined,
        size: Math.ceil(parts[part].length / 0.75),
        encoding: "base64",
      });
    });
    const address = (value) => {
      const m = String(value).match(/^(.*?)\s*<([^>]+)>$/);
      return m ? { name: m[1].replace(/"/g, "").trim(), address: m[2] } : { name: "", address: String(value) };
    };
    const message = {
      id,
      threadId: String(threadId || 1000 + id),
      labels: new Set(labels),
      flags: new Set(flags),
      trash: false,
      spam: false,
      deleted: false,
      source,
      parts,
      date,
      structure: attachments.length ? { type: "multipart/mixed", childNodes } : { type: childNodes[0].type },
      envelope: { date, subject, messageId: mid, inReplyTo, from: [address(from)], to: to.map(address), cc: cc.map(address) },
    };
    store.messages.push(message);
    return message;
  }

  class Client {
    constructor(options) {
      this.options = options;
      this.usable = false;
      this.capabilities = new Map([["X-GM-EXT-1", true], ["IMAP4REV1", true]]);
      this.mailbox = false;
      this.handlers = {};
    }
    on(event, fn) {
      (this.handlers[event] ||= []).push(fn);
    }
    async connect() {
      if (this.options.auth.pass !== password()) {
        const error = new Error("Command failed");
        error.authenticationFailed = true;
        error.responseText = "[AUTHENTICATIONFAILED] Invalid credentials (Failure)";
        throw error;
      }
      store.connections++;
      this.usable = true;
    }
    close() {
      this.usable = false;
      for (const fn of this.handlers.close || []) fn();
    }
    async logout() {
      this.close();
    }
    async noop() {}
    async list() {
      return FOLDERS.map((f) => ({ path: f.path, name: f.path.split("/").pop(), delimiter: "/", flags: f.flags || new Set(), specialUse: f.specialUse }));
    }
    async status(path) {
      const list = messagesIn(path);
      return { path, messages: list.length, unseen: list.filter((m) => !m.flags.has("\\Seen")).length, uidNext: store.nextId, uidValidity: 7n };
    }
    async getMailboxLock(path) {
      const folder = FOLDERS.find((f) => f.path === path);
      if (!folder || folder.flags) {
        const error = new Error("Command failed");
        error.responseText = "[NONEXISTENT] Unknown Mailbox";
        throw error;
      }
      this.mailbox = { path, uidValidity: 7n, exists: messagesIn(path).length };
      return { release() {} };
    }
    current() {
      return messagesIn(this.mailbox.path);
    }
    resolve(range, options = {}) {
      const list = this.current();
      if (Array.isArray(range)) return list.filter((m) => range.map(Number).includes(m.id));
      const out = [];
      for (const piece of String(range).split(",")) {
        const [a, b] = piece.split(":");
        if (options.uid) {
          const from = Number(a);
          const to = b === "*" ? Infinity : Number(b ?? a);
          const found = list.filter((m) => m.id >= from && m.id <= to);
          // IMAP: "N:*" always matches the newest message.
          out.push(...(found.length || b !== "*" ? found : list.slice(-1)));
        } else {
          const from = Number(a);
          const to = b === "*" ? list.length : Number(b ?? a);
          out.push(...list.slice(from - 1, to));
        }
      }
      return [...new Set(out)];
    }
    async search(query) {
      let list = this.current();
      if (query.threadId) list = list.filter((m) => m.threadId === String(query.threadId));
      const words = String(query.gmraw || query.text || "").toLowerCase();
      if (words) list = list.filter((m) => `${m.envelope.subject} ${m.envelope.from[0].name} ${m.envelope.from[0].address}`.toLowerCase().includes(words));
      if (query.uid) list = this.resolve(query.uid, { uid: true });
      return list.map((m) => m.id);
    }
    view(m) {
      return {
        seq: this.current().indexOf(m) + 1,
        uid: m.id,
        flags: new Set(m.flags),
        labels: new Set(m.labels),
        threadId: m.threadId,
        envelope: m.envelope,
        internalDate: m.date,
        size: m.source.length,
        bodyStructure: m.structure,
      };
    }
    async *fetch(range, query, options) {
      for (const m of this.resolve(range, options)) yield this.view(m);
    }
    async fetchOne(seq, query, options) {
      const m = seq === "*" ? this.current().at(-1) : this.resolve(seq, options)[0];
      return m ? this.view(m) : false;
    }
    async download(uid, part) {
      const m = this.current().find((x) => x.id === Number(uid));
      if (!m) return {};
      return { meta: {}, content: Readable.from([part ? m.parts[part] : m.source]) };
    }
    async messageFlagsAdd(range, flags, options = {}) {
      for (const m of this.resolve(range, options)) for (const f of flags) (options.useLabels ? m.labels : m.flags).add(f);
      return true;
    }
    async messageFlagsRemove(range, flags, options = {}) {
      for (const m of this.resolve(range, options)) for (const f of flags) (options.useLabels ? m.labels : m.flags).delete(f);
      return true;
    }
    async messageMove(range, destination, options = {}) {
      const from = this.mailbox.path;
      if (from === "[Gmail]/Tous les messages" && !["[Gmail]/Corbeille", "[Gmail]/Spam"].includes(destination))
        throw new Error("test: moving out of All Mail would delete the message in Gmail");
      for (const m of this.resolve(range, options)) {
        if (destination === "[Gmail]/Corbeille") m.trash = true;
        else if (destination === "[Gmail]/Spam") m.spam = true;
        else {
          if (from === "[Gmail]/Corbeille") m.trash = false;
          if (from === "[Gmail]/Spam") m.spam = false;
          m.labels.add(destination === "INBOX" ? "\\Inbox" : destination);
        }
        if (from === "INBOX" && destination !== "[Gmail]/Corbeille" && destination !== "[Gmail]/Spam") m.labels.delete("\\Inbox");
        else if (!FOLDERS.find((f) => f.path === from)?.specialUse && from !== "INBOX") m.labels.delete(from);
      }
      return { path: from, destination };
    }
    // APPEND (drafts): the message as sent by the application, kept as it is.
    async append(path, content, flags = []) {
      const parsed = await require("mailparser").simpleParser(content);
      const list = (field) => (parsed[field]?.value || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address));
      const m = await add({
        raw: Buffer.from(content),
        from: list("from")[0] || "",
        to: list("to"),
        cc: list("cc"),
        subject: parsed.subject || "",
        text: parsed.text || "",
        html: parsed.html || undefined,
        labels: path === "INBOX" ? ["\\Inbox"] : [],
        flags,
        attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
      });
      return { destination: path, uid: m.id, uidValidity: 7n };
    }
    async messageDelete(range, options = {}) {
      for (const m of this.resolve(range, options)) m.deleted = true;
      return true;
    }
  }

  return { store, add, factory: (imap) => new Client({ auth: { user: imap.user, pass: imap.pass } }), messagesIn };
}

module.exports = { fakeGmail };
