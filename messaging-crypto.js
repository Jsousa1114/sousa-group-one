"use strict";

(() => {
  const DB_NAME = "sgo-secure-messaging",
    STORE = "keys",
    KEY_ID = "e2ee-p256-v1",
    enc = new TextEncoder(),
    dec = new TextDecoder(),
    publicCache = new Map(),
    registeredPublicKey = false;

  const b64u = (bytes) => {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  };
  const fromB64u = (value) => {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/"),
      padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
      raw = atob(padded),
      out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };
  const b64 = (bytes) => {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s);
  };
  const fromB64 = (value) => {
    const raw = atob(String(value)),
      out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly"),
        req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }
  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }
  async function importPrivate(jwk) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
  }
  async function importPublic(jwk) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  }
  async function identity(api) {
    let saved = await idbGet(KEY_ID);
    if (!saved) {
      const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      saved = {
        privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
        publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
        createdAt: new Date().toISOString(),
      };
      await idbSet(KEY_ID, saved);
    }
    if (!registeredPublicKey) {
      await api("messaging/crypto/key", { publicJwk: saved.publicJwk });
      registeredPublicKey = true;
    }
    return saved;
  }
  async function publicKeys(api, ids) {
    const unique = [...new Set(ids.map(Number).filter(Number.isSafeInteger))],
      missing = unique.filter((id) => !publicCache.has(String(id)));
    if (missing.length) {
      const out = await api("messaging/crypto/keys?ids=" + missing.join(","));
      for (const item of out.keys || []) {
        const id = String(item.userId),
          pinKey = "peer-public-jwk:" + id,
          pinned = await idbGet(pinKey),
          current = JSON.stringify({
            kty: item.publicJwk.kty,
            crv: item.publicJwk.crv,
            x: item.publicJwk.x,
            y: item.publicJwk.y,
          });
        if (pinned && pinned !== current)
          throw new Error(
            "SECURITY_KEY_CHANGED:" +
              id +
              ":La clé de sécurité de ce contact a changé. Vérifiez son appareil avant de reprendre les messages chiffrés.",
          );
        if (!pinned) await idbSet(pinKey, current);
        publicCache.set(id, item.publicJwk);
      }
    }
    return Object.fromEntries(
      unique
        .filter((id) => publicCache.has(String(id)))
        .map((id) => [String(id), publicCache.get(String(id))]),
    );
  }
  async function wrappingKey(privateJwk, publicJwk) {
    const [privateKey, publicKey] = await Promise.all([
        importPrivate(privateJwk),
        importPublic(publicJwk),
      ]),
      bits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: publicKey },
        privateKey,
        256,
      ),
      context = enc.encode("Sousa Group One E2EE key wrap v1"),
      joined = new Uint8Array(bits.byteLength + context.byteLength);
    joined.set(new Uint8Array(bits), 0);
    joined.set(context, bits.byteLength);
    const digest = await crypto.subtle.digest("SHA-256", joined);
    return crypto.subtle.importKey(
      "raw",
      digest,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }
  async function messageKeyFromEnvelope(encryption, userId, api) {
    const me = await identity(api),
      envelope = encryption?.envelopes?.[String(userId)];
    if (!envelope) throw new Error("Clé de déchiffrement absente.");
    const senderId = Number(encryption.senderId),
      keys = await publicKeys(api, [senderId]),
      senderPublic = keys[String(senderId)];
    if (!senderPublic) throw new Error("Clé publique de l’expéditeur indisponible.");
    const wrap = await wrappingKey(me.privateJwk, senderPublic),
      raw = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64u(envelope.iv) },
        wrap,
        fromB64u(envelope.ciphertext),
      );
    return crypto.subtle.importKey(
      "raw",
      raw,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }
  async function readiness(api, participantIds) {
    await identity(api);
    const keys = await publicKeys(api, participantIds);
    return {
      ready: participantIds.every((id) => keys[String(id)]),
      missing: participantIds.filter((id) => !keys[String(id)]),
    };
  }
  async function encryptPayload(api, participantIds, text, attachment) {
    const me = await identity(api),
      keys = await publicKeys(api, participantIds),
      missing = participantIds.filter((id) => !keys[String(id)]);
    if (missing.length)
      throw new Error("E2EE_WAITING:" + missing.join(","));
    const messageKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      ),
      rawMessageKey = await crypto.subtle.exportKey("raw", messageKey),
      iv = crypto.getRandomValues(new Uint8Array(12)),
      encryptedText = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        messageKey,
        enc.encode(text || ""),
      ),
      envelopes = {};
    for (const id of participantIds) {
      const wrap = await wrappingKey(me.privateJwk, keys[String(id)]),
        envelopeIv = crypto.getRandomValues(new Uint8Array(12)),
        wrapped = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: envelopeIv },
          wrap,
          rawMessageKey,
        );
      envelopes[String(id)] = {
        iv: b64u(envelopeIv),
        ciphertext: b64u(wrapped),
      };
    }
    const encryption = {
      algorithm: "SGO-E2EE-P256-AESGCM-v1",
      iv: b64u(iv),
      ciphertext: b64u(encryptedText),
      envelopes,
    };
    let encryptedAttachment = attachment || null;
    if (attachment?.content) {
      const fileIv = crypto.getRandomValues(new Uint8Array(12)),
        fileCiphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: fileIv },
          messageKey,
          fromB64(attachment.content),
        );
      encryption.attachmentIv = b64u(fileIv);
      encryptedAttachment = {
        ...attachment,
        content: b64(fileCiphertext),
        encrypted: true,
      };
    }
    return { encryption, attachment: encryptedAttachment };
  }
  async function decryptText(api, encryption, userId) {
    const key = await messageKeyFromEnvelope(encryption, userId, api),
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64u(encryption.iv) },
        key,
        fromB64u(encryption.ciphertext),
      );
    return dec.decode(plain);
  }
  async function decryptAttachment(api, encryption, userId, bytes, mime) {
    if (!encryption?.attachmentIv)
      throw new Error("Métadonnée de pièce jointe chiffrée absente.");
    const key = await messageKeyFromEnvelope(encryption, userId, api),
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64u(encryption.attachmentIv) },
        key,
        bytes,
      );
    return new Blob([plain], { type: mime || "application/octet-stream" });
  }

  async function fingerprint(jwk) {
    const data = enc.encode(
      [jwk.kty, jwk.crv, jwk.x, jwk.y].map((v) => String(v || "")).join("|"),
    );
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return [...digest]
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .match(/.{1,4}/g)
      .join(" ");
  }

  window.SGOMessageCrypto = {
    ensureIdentity: identity,
    readiness,
    encryptPayload,
    decryptText,
    decryptAttachment,
    fingerprint,
  };
})();
