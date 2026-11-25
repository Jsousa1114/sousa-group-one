"use strict";
// WhatsApp in the application, linked like WhatsApp Web (QR code, or a code typed on the phone)
// with the Baileys library. This is not an official WhatsApp access: WhatsApp may block a number
// it considers automated, so the application only does what a person would do (read, answer one
// conversation at a time, at a human pace) and never changes chats on the phone (archiving,
// marking unread stay in the application).
//
// WhatsApp keeps no mailbox to query like Gmail: the messages arrive as events (the history once
// when linking, then each new message) and are stored here. Media files are downloaded from
// WhatsApp the first time they are opened. The session (the keys of the linked device) is stored
// encrypted in the database: anyone holding it could read and send as the company.
const { createHash, createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const D = require("./domain");

const ACCOUNT = "main";
const LABEL = "WhatsApp Sousa Group";
let baileys = null;
const load = async () => (baileys ||= await import("baileys"));
let socketFactory = null; // tests use a stand-in for WhatsApp
let downloader = null;

const runtime = { status: "idle", qr: "", qrAt: 0, pairingCode: "", me: null, error: "", sock: null, timer: null, retries: 0, history: null, since: null };
let chain = Promise.resolve();
const serial = (fn) => {
  chain = chain.then(fn).catch((error) => console.warn("whatsapp.event.failed", error?.code || error?.message?.slice(0, 80) || "unknown"));
  return chain;
};

// ---------------------------------------------------------------------------
// Session, encrypted (AES-256-GCM, key derived from WHATSAPP_STATE_KEY or JWT_SECRET)
// ---------------------------------------------------------------------------
const stateKey = () => createHash("sha256").update("sgo-whatsapp-session:" + String(process.env.WHATSAPP_STATE_KEY || process.env.JWT_SECRET || "")).digest();
function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", stateKey(), iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
function unseal(value) {
  const raw = Buffer.from(String(value).slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", stateKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

async function authState(db) {
  const { initAuthCreds, BufferJSON, proto } = await load();
  const read = async (keys) => {
    const rows = (await db.query("SELECT key,value FROM whatsapp_auth WHERE account=$1 AND key = ANY($2::text[])", [ACCOUNT, keys])).rows;
    const out = new Map();
    for (const row of rows)
      try {
        out.set(row.key, JSON.parse(unseal(row.value), BufferJSON.reviver));
      } catch {
        // written with another key: ignored (the phone must be linked again)
      }
    return out;
  };
  const write = (key, value) =>
    db.query("INSERT INTO whatsapp_auth(account,key,value) VALUES($1,$2,$3) ON CONFLICT(account,key) DO UPDATE SET value=EXCLUDED.value", [ACCOUNT, key, seal(JSON.stringify(value, BufferJSON.replacer))]);
  const saved = (await read(["creds"])).get("creds");
  const creds = saved || initAuthCreds();
  return {
    linked: !!saved?.me,
    creds,
    keys: {
      get: async (type, ids) => {
        const found = await read(ids.map((id) => `${type}-${id}`));
        const out = {};
        for (const id of ids) {
          let value = found.get(`${type}-${id}`);
          if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
          out[id] = value;
        }
        return out;
      },
      set: async (data) => {
        for (const category of Object.keys(data || {}))
          for (const id of Object.keys(data[category] || {})) {
            const value = data[category][id];
            if (value) await write(`${category}-${id}`, value);
            else await db.query("DELETE FROM whatsapp_auth WHERE account=$1 AND key=$2", [ACCOUNT, `${category}-${id}`]);
          }
      },
    },
    saveCreds: () => write("creds", creds),
  };
}

async function hasSession(db) {
  const row = (await db.query("SELECT value FROM whatsapp_auth WHERE account=$1 AND key='creds'", [ACCOUNT])).rows[0];
  if (!row) return false;
  try {
    return !!JSON.parse(unseal(row.value)).me;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Numbers: WhatsApp now often names people by a private id (…@lid) instead of their number.
// Conversations are kept under the number whenever WhatsApp tells it.
// ---------------------------------------------------------------------------
const lids = new Map();
let lidsLoaded = false;
const bare = (jid) => {
  const [user = "", server = ""] = String(jid || "").split("@");
  return user && server ? user.split(":")[0] + "@" + server : "";
};
const ignored = (jid) => !jid || jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");
const isGroup = (jid) => String(jid || "").endsWith("@g.us");

async function loadLids(db) {
  if (lidsLoaded) return;
  for (const row of (await db.query("SELECT lid,pn FROM whatsapp_lids WHERE account=$1", [ACCOUNT])).rows) lids.set(row.lid, row.pn);
  lidsLoaded = true;
}

function canonical(jid, alt) {
  const main = bare(jid);
  const other = bare(alt);
  if (main.endsWith("@lid")) {
    if (other.endsWith("@s.whatsapp.net")) {
      if (lids.get(main) !== other) pendingLids.push([main, other]);
      lids.set(main, other);
      return other;
    }
    return lids.get(main) || main;
  }
  return main;
}

// A lid learned later: its conversation joins the one of the number.
const pendingLids = [];
async function rememberLids(db, pairs) {
  for (const [lid, pn] of pairs) {
    if (!lid.endsWith("@lid") || !pn.endsWith("@s.whatsapp.net")) continue;
    lids.set(lid, pn);
    await db.query("INSERT INTO whatsapp_lids(account,lid,pn) VALUES($1,$2,$3) ON CONFLICT(account,lid) DO UPDATE SET pn=EXCLUDED.pn", [ACCOUNT, lid, pn]);
    // The name known under the private id goes with the number, and so do group senders.
    await db.query(
      `INSERT INTO whatsapp_contacts(account,jid,name,notify) SELECT account,$3,name,notify FROM whatsapp_contacts WHERE account=$1 AND jid=$2
       ON CONFLICT(account,jid) DO UPDATE SET name=COALESCE(whatsapp_contacts.name,EXCLUDED.name),notify=COALESCE(whatsapp_contacts.notify,EXCLUDED.notify)`,
      [ACCOUNT, lid, pn],
    );
    await db.query("UPDATE whatsapp_messages SET sender=$3 WHERE account=$1 AND sender=$2", [ACCOUNT, lid, pn]);
    const old = (await db.query("SELECT * FROM whatsapp_chats WHERE account=$1 AND jid=$2", [ACCOUNT, lid])).rows[0];
    if (!old) continue;
    await db.query("DELETE FROM whatsapp_messages m WHERE account=$1 AND jid=$2 AND EXISTS (SELECT 1 FROM whatsapp_messages n WHERE n.account=$1 AND n.jid=$3 AND n.id=m.id)", [ACCOUNT, lid, pn]);
    await db.query("UPDATE whatsapp_messages SET jid=$3 WHERE account=$1 AND jid=$2", [ACCOUNT, lid, pn]);
    await db.query(
      `INSERT INTO whatsapp_chats(account,jid,name,is_group,unread,last_at,last_text,last_from_me,archived,muted_until,snoozed_until)
       VALUES($1,$2,$3,false,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(account,jid) DO UPDATE SET unread=whatsapp_chats.unread+EXCLUDED.unread,
         name=COALESCE(whatsapp_chats.name,EXCLUDED.name),
         last_at=GREATEST(whatsapp_chats.last_at,EXCLUDED.last_at),
         last_text=CASE WHEN EXCLUDED.last_at > whatsapp_chats.last_at OR whatsapp_chats.last_at IS NULL THEN EXCLUDED.last_text ELSE whatsapp_chats.last_text END`,
      [ACCOUNT, pn, old.name, old.unread, old.last_at, old.last_text, old.last_from_me, old.archived, old.muted_until, old.snoozed_until],
    );
    await db.query("DELETE FROM whatsapp_chats WHERE account=$1 AND jid=$2", [ACCOUNT, lid]);
    await db.query("UPDATE whatsapp_reminders SET jid=$3 WHERE account=$1 AND jid=$2", [ACCOUNT, lid, pn]);
  }
}
async function flushLids(db) {
  if (!pendingLids.length) return;
  await rememberLids(db, pendingLids.splice(0));
}

// "41791234567@s.whatsapp.net" → "+41 79 123 45 67"
function phoneOf(jid) {
  const user = String(jid || "").split("@")[0];
  if (!/^\d{6,16}$/.test(user) || !String(jid).endsWith("@s.whatsapp.net")) return "";
  if (/^41\d{9}$/.test(user)) return `+41 ${user.slice(2, 4)} ${user.slice(4, 7)} ${user.slice(7, 9)} ${user.slice(9)}`;
  return "+" + user;
}
// Last 9 digits, to recognise a client's number whatever the way it was typed.
const phoneKey = (value) => {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits.length >= 9 ? digits.slice(-9) : "";
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
const num = (value) => Number(value?.toNumber?.() ?? value ?? 0) || 0;
const toBuffer = (value) => (value ? Buffer.from(value.data || value) : null);
const KIND_LABEL = { image: "Photo", video: "Vidéo", voice: "Message vocal", audio: "Audio", document: "Document", sticker: "Autocollant", location: "Position", contact: "Contact", poll: "Sondage", other: "Message" };

// What a message contains, in words the application can show and search.
function describe(content, getContentType) {
  const type = getContentType(content);
  const c = content?.[type] || {};
  const out = { kind: "text", body: "", mime: null, name: null, size: null, thumb: null, context: c?.contextInfo || null };
  const thumb = (value) => {
    const b = toBuffer(value);
    return b && b.length && b.length < 60000 ? "data:image/jpeg;base64," + b.toString("base64") : null;
  };
  switch (type) {
    case "conversation":
      out.body = String(content.conversation || "");
      out.context = null;
      break;
    case "extendedTextMessage":
      out.body = String(c.text || "");
      break;
    case "imageMessage":
    case "videoMessage":
    case "stickerMessage":
      out.kind = type === "imageMessage" ? "image" : type === "videoMessage" ? "video" : "sticker";
      out.body = String(c.caption || "");
      out.mime = c.mimetype || null;
      out.size = num(c.fileLength) || null;
      out.thumb = thumb(c.jpegThumbnail);
      break;
    case "audioMessage":
      out.kind = c.ptt ? "voice" : "audio";
      out.mime = c.mimetype || null;
      out.size = num(c.fileLength) || null;
      out.body = c.seconds ? `${Math.floor(num(c.seconds) / 60)}:${String(num(c.seconds) % 60).padStart(2, "0")}` : "";
      break;
    case "documentMessage":
      out.kind = "document";
      out.body = String(c.caption || "");
      out.mime = c.mimetype || "application/octet-stream";
      out.name = String(c.fileName || c.title || "document").slice(0, 200);
      out.size = num(c.fileLength) || null;
      out.thumb = thumb(c.jpegThumbnail);
      break;
    case "locationMessage":
    case "liveLocationMessage":
      out.kind = "location";
      out.body = [c.name, c.address, `${c.degreesLatitude},${c.degreesLongitude}`].filter(Boolean).join("\n");
      break;
    case "contactMessage":
      out.kind = "contact";
      out.body = [c.displayName, ...(String(c.vcard || "").match(/TEL[^:]*:([^\r\n]+)/g) || []).map((l) => l.split(":").pop())].filter(Boolean).join("\n");
      break;
    case "contactsArrayMessage":
      out.kind = "contact";
      out.body = (c.contacts || []).map((x) => x.displayName).filter(Boolean).join(", ");
      break;
    case "pollCreationMessage":
    case "pollCreationMessageV2":
    case "pollCreationMessageV3":
      out.kind = "poll";
      out.body = [String(c.name || ""), ...(c.options || []).map((o) => "- " + o.optionName)].join("\n");
      break;
    default:
      out.kind = "other";
      out.body = "Message à ouvrir dans WhatsApp sur le téléphone.";
  }
  out.body = out.body.slice(0, 20000);
  return out;
}

const preview = (row) => (row.kind === "text" ? row.body : [KIND_LABEL[row.kind] || "Message", row.kind === "document" ? row.name : "", row.body].filter(Boolean).join(" · ")).replace(/\s+/g, " ").slice(0, 160);

async function rawOf(db, jid, id) {
  const row = (await db.query("SELECT raw FROM whatsapp_messages WHERE account=$1 AND jid=$2 AND id=$3", [ACCOUNT, jid, id])).rows[0];
  if (!row?.raw) return null;
  const { BufferJSON } = await load();
  return JSON.parse(row.raw, BufferJSON.reviver);
}

// Stores one message (history or new). Returns { row, inserted } or null.
async function storeMessage(db, msg, { live = false } = {}) {
  const B = await load();
  const key = msg?.key || {};
  const jid = canonical(key.remoteJid, key.remoteJidAlt);
  if (ignored(jid) || !key.id) return null;
  const content = B.extractMessageContent(msg.message);
  if (!content) return null;
  const type = B.getContentType(content);
  if (type === "protocolMessage") {
    const p = content.protocolMessage;
    const target = p?.key?.id;
    if (!target) return null;
    if (num(p.type) === 0) await db.query("UPDATE whatsapp_messages SET deleted=true,body='',thumb=NULL WHERE account=$1 AND jid=$2 AND id=$3", [ACCOUNT, jid, target]);
    else if (p.editedMessage) {
      const edited = describe(B.extractMessageContent(p.editedMessage) || {}, B.getContentType);
      await db.query("UPDATE whatsapp_messages SET body=$4,edited=true WHERE account=$1 AND jid=$2 AND id=$3", [ACCOUNT, jid, target, edited.body]);
    }
    return null;
  }
  if (type === "reactionMessage") {
    await react(db, jid, content.reactionMessage, key);
    return null;
  }
  if (!type || ["senderKeyDistributionMessage", "messageContextInfo"].includes(type)) return null;
  const info = describe(content, B.getContentType);
  const fromMe = !!key.fromMe;
  const group = isGroup(jid);
  const sender = fromMe ? "me" : group ? canonical(key.participant, key.participantAlt) : jid;
  const at = new Date((num(msg.messageTimestamp) || Date.now() / 1000) * 1000);
  let quotedText = null;
  const quotedId = info.context?.stanzaId || null;
  if (quotedId && info.context?.quotedMessage) quotedText = describe(B.extractMessageContent(info.context.quotedMessage) || {}, B.getContentType).body.slice(0, 300) || null;
  if (quotedId) {
    // The quoted message as it is now (edited since, for example).
    const known = (await db.query("SELECT body,kind,media_name,deleted FROM whatsapp_messages WHERE account=$1 AND jid=$2 AND id=$3", [ACCOUNT, jid, quotedId])).rows[0];
    if (known) quotedText = known.deleted ? "Message supprimé" : preview({ kind: known.kind, body: known.body, name: known.media_name }).slice(0, 300) || quotedText;
  }
  let raw = JSON.stringify(msg, B.BufferJSON.replacer);
  if (raw.length > 400000) raw = null;
  const status = msg.status != null ? num(msg.status) : fromMe ? 2 : null;
  const inserted = (
    await db.query(
      `INSERT INTO whatsapp_messages(account,jid,id,from_me,sender,sender_name,at,kind,body,media_mime,media_name,media_size,thumb,quoted_id,quoted_text,status,raw)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT(account,jid,id) DO UPDATE SET status=GREATEST(COALESCE(whatsapp_messages.status,0),COALESCE(EXCLUDED.status,0)),raw=COALESCE(whatsapp_messages.raw,EXCLUDED.raw)
       RETURNING (xmax = 0) AS inserted`,
      [ACCOUNT, jid, key.id, fromMe, sender, fromMe ? null : String(msg.pushName || "").slice(0, 120) || null, at, info.kind, info.body, info.mime, info.name, info.size, info.thumb, quotedId, quotedText, status, raw],
    )
  ).rows[0]?.inserted;
  const row = { jid, id: key.id, fromMe, kind: info.kind, body: info.body, name: info.name, at, sender, senderName: msg.pushName || "" };
  if (!fromMe && !group && msg.pushName) await saveContact(db, jid, { notify: msg.pushName });
  if (!fromMe && group && sender && msg.pushName) await saveContact(db, sender, { notify: msg.pushName });
  await db.query(
    `INSERT INTO whatsapp_chats(account,jid,is_group,unread,last_at,last_text,last_from_me)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(account,jid) DO UPDATE SET
       unread=whatsapp_chats.unread+EXCLUDED.unread,
       -- The preview is the newest stored message (the history does not arrive in order).
       last_text=CASE WHEN EXCLUDED.last_at >= (SELECT MAX(m.at) FROM whatsapp_messages m WHERE m.account=$1 AND m.jid=$2 AND m.deleted=false) THEN EXCLUDED.last_text ELSE whatsapp_chats.last_text END,
       last_from_me=CASE WHEN EXCLUDED.last_at >= (SELECT MAX(m.at) FROM whatsapp_messages m WHERE m.account=$1 AND m.jid=$2 AND m.deleted=false) THEN EXCLUDED.last_from_me ELSE whatsapp_chats.last_from_me END,
       last_at=GREATEST(whatsapp_chats.last_at,EXCLUDED.last_at),
       archived=CASE WHEN EXCLUDED.unread > 0 THEN false ELSE whatsapp_chats.archived END,
       updated_at=NOW()`,
    [ACCOUNT, jid, group, live && inserted && !fromMe ? 1 : 0, at, preview({ kind: info.kind, body: info.body, name: info.name }), fromMe],
  );
  if (group) groupName(db, jid);
  return { row, inserted: !!inserted };
}

async function react(db, jid, reaction, reactorKey) {
  const target = reaction?.key?.id;
  if (!target) return;
  const row = (await db.query("SELECT reactions FROM whatsapp_messages WHERE account=$1 AND jid=$2 AND id=$3", [ACCOUNT, jid, target])).rows[0];
  if (!row) return;
  let map = {};
  try {
    map = JSON.parse(row.reactions || "{}");
  } catch {
    map = {};
  }
  const who = reactorKey?.fromMe ? "me" : canonical(reactorKey?.participant || reactorKey?.remoteJid, reactorKey?.participantAlt || reactorKey?.remoteJidAlt);
  if (reaction.text) map[who] = String(reaction.text).slice(0, 16);
  else delete map[who];
  await db.query("UPDATE whatsapp_messages SET reactions=$4 WHERE account=$1 AND jid=$2 AND id=$3", [ACCOUNT, jid, target, JSON.stringify(map)]);
}

async function saveContact(db, jid, { name, notify }) {
  if (!jid || ignored(jid)) return;
  await db.query(
    `INSERT INTO whatsapp_contacts(account,jid,name,notify) VALUES($1,$2,$3,$4)
     ON CONFLICT(account,jid) DO UPDATE SET name=COALESCE(EXCLUDED.name,whatsapp_contacts.name),notify=COALESCE(EXCLUDED.notify,whatsapp_contacts.notify)`,
    [ACCOUNT, jid, name ? String(name).slice(0, 120) : null, notify ? String(notify).slice(0, 120) : null],
  );
}

const groupNames = new Map();
function groupName(db, jid) {
  if (groupNames.has(jid) || !runtime.sock?.groupMetadata || runtime.status !== "open") return;
  groupNames.set(jid, Date.now());
  runtime.sock
    .groupMetadata(jid)
    .then((meta) => meta?.subject && db.query("UPDATE whatsapp_chats SET name=$3 WHERE account=$1 AND jid=$2 AND (name IS NULL OR name='')", [ACCOUNT, jid, String(meta.subject).slice(0, 120)]))
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Events from WhatsApp
// ---------------------------------------------------------------------------
async function onHistory(db, h) {
  const pairs = (h.lidPnMappings || []).map((m) => [bare(m.lid), bare(m.pn)]);
  if (pairs.length) await rememberLids(db, pairs);
  await onContacts(db, h.contacts || []);
  await onChats(db, h.chats || []);
  for (const msg of h.messages || []) await storeMessage(db, msg, { live: false });
  await flushLids(db);
  runtime.history = { progress: h.progress ?? null, latest: !!h.isLatest, at: new Date().toISOString() };
}

async function onChats(db, list) {
  for (const chat of list || []) {
    const jid = canonical(chat.id, chat.pnJid || chat.lidJid);
    if (ignored(jid)) continue;
    const at = num(chat.conversationTimestamp) ? new Date(num(chat.conversationTimestamp) * 1000) : null;
    const mute = num(chat.muteEndTime);
    await db.query(
      `INSERT INTO whatsapp_chats(account,jid,name,is_group,unread,last_at,archived,muted_until)
       VALUES($1,$2,$3,$4,COALESCE($5,0),$6,COALESCE($7,false),$8)
       ON CONFLICT(account,jid) DO UPDATE SET
         name=COALESCE(EXCLUDED.name,whatsapp_chats.name),
         unread=COALESCE($5,whatsapp_chats.unread),
         last_at=GREATEST(whatsapp_chats.last_at,EXCLUDED.last_at),
         archived=COALESCE($7,whatsapp_chats.archived),
         muted_until=CASE WHEN $9 THEN EXCLUDED.muted_until ELSE whatsapp_chats.muted_until END,
         updated_at=NOW()`,
      [
        ACCOUNT,
        jid,
        chat.name ? String(chat.name).slice(0, 120) : null,
        isGroup(jid),
        chat.unreadCount != null ? Math.max(0, num(chat.unreadCount)) : null,
        at,
        typeof chat.archived === "boolean" ? chat.archived : null,
        mute > 0 ? new Date(mute > 1e12 ? mute : mute * 1000) : null,
        chat.muteEndTime !== undefined,
      ],
    );
  }
}

async function onContacts(db, list) {
  const pairs = [];
  for (const c of list || []) {
    const id = bare(c.id);
    const pn = bare(c.phoneNumber) || (id.endsWith("@s.whatsapp.net") ? id : "");
    const lid = bare(c.lid) || (id.endsWith("@lid") ? id : "");
    if (lid && pn) pairs.push([lid, pn]);
    const jid = pn || lid || id;
    if (!jid) continue;
    await saveContact(db, jid, { name: c.name || c.verifiedName || null, notify: c.notify || null });
  }
  if (pairs.length) await rememberLids(db, pairs);
}

async function onUpdates(db, list) {
  for (const { key, update } of list || []) {
    const jid = canonical(key?.remoteJid, key?.remoteJidAlt);
    if (ignored(jid) || !key?.id || !update) continue;
    if (update.status != null) await db.query("UPDATE whatsapp_messages SET status=GREATEST(COALESCE(status,0),$4) WHERE account=$1 AND jid=$2 AND id=$3", [ACCOUNT, jid, key.id, num(update.status)]);
    if (update.message) await storeMessage(db, { key, message: update.message, messageTimestamp: Date.now() / 1000 });
  }
}

const pendingNotices = new Map();
// New messages: one notification per conversation, gathered for 15 seconds.
function announce(db, row) {
  const entry = pendingNotices.get(row.jid) || { rows: [], timer: null };
  entry.rows.push(row);
  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      pendingNotices.delete(row.jid);
      sendNotice(db, row.jid, entry.rows).catch(() => {});
    }, Number(process.env.WHATSAPP_NOTICE_DELAY_MS ?? 15000));
    entry.timer.unref?.();
  }
  pendingNotices.set(row.jid, entry);
}
async function sendNotice(db, jid, rows) {
  const chat = (await db.query("SELECT name,muted_until,is_group FROM whatsapp_chats WHERE account=$1 AND jid=$2", [ACCOUNT, jid])).rows[0];
  if (chat?.muted_until && new Date(chat.muted_until) > new Date()) return;
  const users = await usersWithAccess(db);
  if (!users.length) return;
  const contact = (await db.query("SELECT name,notify FROM whatsapp_contacts WHERE account=$1 AND jid=$2", [ACCOUNT, jid])).rows[0];
  const title = chat?.name || contact?.name || contact?.notify || rows[0].senderName || phoneOf(jid) || "WhatsApp";
  const last = rows.at(-1);
  const body = rows.length > 1 ? `${rows.length} nouveaux messages` : (chat?.is_group && last.senderName ? last.senderName + " : " : "") + preview(last);
  await require("./messaging-routes")
    .notifyUsers(db, users, { category: "whatsapp", title: "WhatsApp · " + title, body: body.slice(0, 200), url: `/?open=whatsapp&chat=${encodeURIComponent(jid)}`, entityType: "whatsapp", entityId: jid })
    .catch(() => {});
}

async function onUpsert(db, { messages, type }) {
  for (const msg of messages || []) {
    const stored = await storeMessage(db, msg, { live: type === "notify" });
    if (stored?.inserted && type === "notify" && !stored.row.fromMe) announce(db, stored.row);
  }
  await flushLids(db);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
const logger = () => require("pino")({ level: process.env.WHATSAPP_LOG || "silent" });

async function start(db, { fresh = false, phone = "" } = {}) {
  clearTimeout(runtime.timer);
  if (runtime.sock && !fresh) return publicStatus();
  if (fresh) {
    await stop();
    await db.query("DELETE FROM whatsapp_auth WHERE account=$1", [ACCOUNT]);
  }
  await loadLids(db);
  const B = await load();
  const auth = await authState(db);
  const log = logger();
  let options;
  if (socketFactory) options = { auth };
  else {
    let version;
    try {
      version = (await B.fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined;
    }
    options = {
      auth: { creds: auth.creds, keys: B.makeCacheableSignalKeyStore(auth.keys, log) },
      logger: log,
      ...(version ? { version } : {}),
      browser: B.Browsers.macOS("Desktop"),
      syncFullHistory: true,
      // The phone keeps its notifications only while this device stays « offline ».
      markOnlineOnConnect: false,
      getMessage: async (key) => (await rawOf(db, canonical(key.remoteJid, key.remoteJidAlt), key.id).catch(() => null))?.message || undefined,
    };
  }
  const sock = (socketFactory || B.makeWASocket)(options);
  runtime.sock = sock;
  runtime.status = auth.linked ? "connecting" : "waiting";
  runtime.qr = "";
  runtime.qrShown = false;
  runtime.pairingCode = "";
  runtime.error = "";
  runtime.phone = String(phone || "").replace(/\D/g, "");
  const on = (event, fn) => sock.ev.on(event, (payload) => (sock === runtime.sock ? fn(payload) : undefined));
  on("creds.update", () => serial(() => auth.saveCreds()));
  on("connection.update", (u) => serial(() => onConnection(db, sock, u, auth.linked)));
  on("messaging-history.set", (h) => serial(() => onHistory(db, h)));
  on("messages.upsert", (e) => serial(() => onUpsert(db, e)));
  on("messages.update", (list) => serial(() => onUpdates(db, list)));
  on("messages.reaction", (list) => serial(async () => {
    for (const r of list || []) await react(db, canonical(r.key?.remoteJid, r.key?.remoteJidAlt), { ...r.reaction, key: r.key }, r.reaction?.key);
  }));
  on("messages.delete", (e) => serial(async () => {
    for (const key of e?.keys || []) await db.query("UPDATE whatsapp_messages SET deleted=true,body='' WHERE account=$1 AND jid=$2 AND id=$3", [ACCOUNT, canonical(key.remoteJid, key.remoteJidAlt), key.id]);
  }));
  on("chats.upsert", (list) => serial(() => onChats(db, list)));
  on("chats.update", (list) => serial(() => onChats(db, list)));
  on("contacts.upsert", (list) => serial(() => onContacts(db, list)));
  on("contacts.update", (list) => serial(() => onContacts(db, list)));
  on("lid-mapping.update", (m) => serial(() => rememberLids(db, [[bare(m?.lid), bare(m?.pn)]])));
  return publicStatus();
}

async function onConnection(db, sock, u, linked) {
  if (u.qr) {
    runtime.qrShown = true;
    runtime.qr = u.qr;
    runtime.qrAt = Date.now();
    if (runtime.phone && !runtime.pairingCode) {
      try {
        runtime.pairingCode = await sock.requestPairingCode(runtime.phone);
      } catch {
        runtime.error = "WhatsApp n’a pas donné de code pour ce numéro. Vérifiez le numéro (avec l’indicatif, ex. 41791234567) ou utilisez le QR code.";
      }
    }
  }
  if (u.connection === "open") {
    runtime.status = "open";
    runtime.qr = "";
    runtime.pairingCode = "";
    runtime.error = "";
    runtime.retries = 0;
    runtime.since = new Date().toISOString();
    runtime.me = { id: bare(sock.user?.id), name: sock.user?.name || sock.user?.verifiedName || "" };
    sock.sendPresenceUpdate?.("unavailable").catch?.(() => {});
  }
  if (u.connection === "close") {
    const code = u.lastDisconnect?.error?.output?.statusCode;
    if (runtime.sock === sock) runtime.sock = null;
    if (!socketFactory) console.warn(`[whatsapp] connexion fermée (code ${code ?? "?"}) : ${String(u.lastDisconnect?.error?.message || "").slice(0, 200)}`);
    if (code === 401) {
      await db.query("DELETE FROM whatsapp_auth WHERE account=$1", [ACCOUNT]);
      Object.assign(runtime, { status: "logged_out", me: null, qr: "", pairingCode: "", error: "WhatsApp a déconnecté l’application (appareil retiré depuis le téléphone, ou numéro bloqué). Reliez-le à nouveau." });
      return;
    }
    if (code === 440) {
      Object.assign(runtime, { status: "replaced", error: "La même session WhatsApp a été ouverte ailleurs. Reliez à nouveau l’application." });
      return;
    }
    const stillLinked = linked || (await hasSession(db));
    if (!stillLinked && code !== 515) {
      // The QR code was not scanned in time, or WhatsApp could not be reached at all:
      // nothing more until someone asks again.
      const why = runtime.qrShown
        ? "Le QR code a expiré. Cliquez à nouveau sur « Relier WhatsApp »."
        : "Le serveur n’arrive pas à joindre WhatsApp (connexion Internet du serveur ?). Réessayez dans un instant.";
      Object.assign(runtime, { status: "idle", qr: "", pairingCode: "", error: runtime.error || why });
      return;
    }
    runtime.status = "reconnecting";
    const delay = code === 515 ? 0 : Math.min(60000, 3000 * 2 ** Math.min(runtime.retries++, 5));
    runtime.timer = setTimeout(() => start(db).catch(() => {}), delay);
    runtime.timer.unref?.();
  }
}

async function stop() {
  clearTimeout(runtime.timer);
  const sock = runtime.sock;
  runtime.sock = null;
  try {
    sock?.end?.(undefined);
  } catch {
    // already closed
  }
}

// « Délier » : the phone's list of linked devices loses this one; stored messages stay.
async function unlink(db) {
  const sock = runtime.sock;
  if (sock && runtime.status === "open") await sock.logout?.().catch(() => {});
  await stop();
  await db.query("DELETE FROM whatsapp_auth WHERE account=$1", [ACCOUNT]);
  Object.assign(runtime, { status: "idle", me: null, qr: "", pairingCode: "", error: "" });
}

// At server start: reconnects if a phone was linked.
async function boot(db) {
  if (await hasSession(db)) await start(db);
}

function publicStatus() {
  return {
    status: runtime.status,
    connected: runtime.status === "open",
    qr: runtime.qr,
    qrAt: runtime.qrAt,
    pairingCode: runtime.pairingCode,
    me: runtime.me ? { ...runtime.me, phone: phoneOf(runtime.me.id) } : null,
    error: runtime.error,
    history: runtime.history,
    since: runtime.since,
  };
}

// ---------------------------------------------------------------------------
// Access: administrators of the group, and the people they ticked
// ---------------------------------------------------------------------------
const automaticAccess = (user) => !!user && user.role === "admin" && user.company === "group";
async function canOpen(db, user) {
  if (!user || user.role === "client") return false;
  if (automaticAccess(user)) return true;
  return !!(await db.query("SELECT 1 FROM whatsapp_access WHERE user_id=$1 AND account=$2", [user.id, ACCOUNT])).rows[0];
}
async function usersWithAccess(db) {
  const users = (await db.query("SELECT id,role,company FROM users WHERE disabled=false AND deleted_at IS NULL AND role<>'client'")).rows;
  const granted = new Set((await db.query("SELECT user_id FROM whatsapp_access WHERE account=$1", [ACCOUNT])).rows.map((r) => Number(r.user_id)));
  return users.filter((u) => automaticAccess(u) || granted.has(Number(u.id))).map((u) => Number(u.id));
}

// ---------------------------------------------------------------------------
// Sending, reading, media
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sendLog = [];
let lastSend = 0;

function contentFor(file, caption) {
  const buffer = Buffer.from(String(file.data || ""), "base64");
  const type = String(file.type || "").toLowerCase();
  if (/^image\/(jpeg|png|webp)$/.test(type)) return { image: buffer, caption, mimetype: type };
  if (/^video\/(mp4|3gpp)$/.test(type)) return { video: buffer, caption, mimetype: type };
  if (/^audio\//.test(type)) return { audio: buffer, mimetype: type };
  return { document: buffer, mimetype: type || "application/octet-stream", fileName: String(file.name || "document").slice(0, 150), caption };
}

// Sends text and files to one conversation, at a human pace (a few seconds between messages,
// at most 60 messages in 10 minutes): WhatsApp blocks numbers that send like a robot.
async function sendToChat(db, jid, { text = "", files = [], quotedId = "" } = {}) {
  const sock = runtime.sock;
  if (!sock || runtime.status !== "open") D.fail("WhatsApp n’est pas connecté pour le moment. Réessayez dans un instant.", 503);
  if (ignored(jid)) D.fail("Conversation introuvable.", 404);
  const now = Date.now();
  while (sendLog.length && now - sendLog[0] > 10 * 60000) sendLog.shift();
  if (sendLog.length >= 60) D.fail("Pour protéger le numéro, l’application envoie au plus 60 messages en 10 minutes. Réessayez un peu plus tard.", 429);
  const gap = Number(process.env.WHATSAPP_SEND_GAP_MS ?? 1500);
  if (Date.now() - lastSend < gap) await sleep(gap - (Date.now() - lastSend));
  lastSend = Date.now();
  const quoted = quotedId ? await rawOf(db, jid, quotedId).catch(() => null) : null;
  const typing = Number(process.env.WHATSAPP_TYPING_MS ?? 900);
  await sock.sendPresenceUpdate?.("composing", jid).catch?.(() => {});
  if (typing) await sleep(Math.min(typing + String(text).length * 10, 3000));
  const sent = [];
  const captioned = files.length === 1 && text && !/^audio\//.test(String(files[0].type || ""));
  try {
    if (text && !captioned) sent.push(await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined));
    for (const file of files) {
      if (sent.length && typing) await sleep(700);
      sent.push(await sock.sendMessage(jid, contentFor(file, captioned ? text : undefined), !sent.length && quoted ? { quoted } : undefined));
    }
  } finally {
    sock.sendPresenceUpdate?.("paused", jid).catch?.(() => {});
    lastSend = Date.now();
  }
  for (let i = 0; i < sent.length; i++) sendLog.push(Date.now());
  for (const m of sent.filter(Boolean)) await serial(() => storeMessage(db, m, { live: false }));
  return sent.filter(Boolean).map((m) => m.key?.id);
}

// Opening a conversation marks its new messages as read, on the phone too (blue ticks).
async function markRead(db, jid) {
  const chat = (await db.query("SELECT unread FROM whatsapp_chats WHERE account=$1 AND jid=$2", [ACCOUNT, jid])).rows[0];
  if (!chat) return;
  const count = Math.min(Math.max(Number(chat.unread) || 0, 0), 50);
  await db.query("UPDATE whatsapp_chats SET unread=0 WHERE account=$1 AND jid=$2", [ACCOUNT, jid]);
  if (!count || !runtime.sock || runtime.status !== "open") return;
  const rows = (await db.query("SELECT raw FROM whatsapp_messages WHERE account=$1 AND jid=$2 AND from_me=false AND raw IS NOT NULL ORDER BY at DESC, seq DESC LIMIT $3", [ACCOUNT, jid, count])).rows;
  const { BufferJSON } = await load();
  const keys = rows
    .map((r) => {
      try {
        return JSON.parse(r.raw, BufferJSON.reviver).key;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (keys.length) await runtime.sock.readMessages(keys).catch(() => {});
}

const VIEWABLE = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac|amr|opus)|video\/(mp4|3gpp)|application\/pdf)/;
async function media(db, jid, id) {
  const row = (await db.query("SELECT kind,media_mime,media_name,media_file,raw FROM whatsapp_messages WHERE account=$1 AND jid=$2 AND id=$3 AND deleted=false", [ACCOUNT, jid, id])).rows[0];
  if (!row || !["image", "video", "audio", "voice", "document", "sticker"].includes(row.kind)) D.fail("Fichier introuvable.", 404);
  const storage = require("./storage");
  const mime = String(row.media_mime || "application/octet-stream").split(";")[0].trim();
  const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "application/pdf": ".pdf" }[mime] || "";
  const name = row.media_name || `${row.kind}-${id.slice(0, 8)}${extension}`;
  if (row.media_file) {
    const file = await storage.loadFile(db, row.media_file).catch(() => null);
    if (file) return { content: Buffer.from(file.content), mime, name, viewable: VIEWABLE.test(mime) };
  }
  if (!runtime.sock || runtime.status !== "open") D.fail("WhatsApp n’est pas connecté : ce fichier n’a pas encore été téléchargé.", 503);
  if (!row.raw) D.fail("Ce fichier n’est plus disponible : ouvrez-le dans WhatsApp sur le téléphone.", 404);
  const B = await load();
  const message = JSON.parse(row.raw, B.BufferJSON.reviver);
  let content;
  try {
    content = await (downloader || B.downloadMediaMessage)(message, "buffer", {}, { logger: logger(), reuploadRequest: runtime.sock.updateMediaMessage });
  } catch {
    D.fail("WhatsApp n’a plus ce fichier sur ses serveurs : ouvrez-le dans WhatsApp sur le téléphone.", 404);
  }
  if (!content?.length) D.fail("Fichier vide.", 404);
  if (content.length > 100 * 1024 * 1024) D.fail("Fichier trop volumineux pour être ouvert ici.", 413);
  const fileId = "wa-" + createHash("sha256").update(`${ACCOUNT}|${jid}|${id}`).digest("hex").slice(0, 40);
  await storage.saveFile(db, fileId, content, mime);
  await db.query("UPDATE whatsapp_messages SET media_file=$4 WHERE account=$1 AND jid=$2 AND id=$3", [ACCOUNT, jid, id, fileId]);
  return { content: Buffer.from(content), mime, name, viewable: VIEWABLE.test(mime) };
}

module.exports = {
  ACCOUNT,
  LABEL,
  start,
  stop,
  unlink,
  boot,
  status: publicStatus,
  canOpen,
  automaticAccess,
  usersWithAccess,
  sendToChat,
  markRead,
  media,
  storeMessage,
  phoneOf,
  phoneKey,
  isGroup,
  preview,
  KIND_LABEL,
  _seal: seal,
  _unseal: unseal,
  _setSocketFactory(factory, download = null) {
    socketFactory = factory;
    downloader = download;
  },
  async _reset() {
    await stop();
    Object.assign(runtime, { status: "idle", qr: "", qrAt: 0, pairingCode: "", me: null, error: "", retries: 0, history: null, since: null });
    lids.clear();
    lidsLoaded = false;
    groupNames.clear();
    for (const entry of pendingNotices.values()) clearTimeout(entry.timer);
    pendingNotices.clear();
    sendLog.length = 0;
    lastSend = 0;
    await chain;
  },
  _flush: () => chain,
};
