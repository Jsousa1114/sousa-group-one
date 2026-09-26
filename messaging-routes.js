"use strict";
const express = require("express");
const { randomUUID } = require("node:crypto");
const { auth, profile } = require("./auth-middleware");
const { wrap } = require("./auth-routes");
const D = require("./domain");

let webPush = null;
try {
  webPush = require("web-push");
} catch {}

function routes(db) {
  const r = express.Router();
  r.use(auth(db));

  async function stateRow() {
    return (await db.query("SELECT data,revision FROM app_state WHERE id=1")).rows[0];
  }
  async function context(user) {
    const row = await stateRow();
    return {
      row,
      data: D.normalize(row.data),
      view: D.viewState(row.data, user),
      user: D.effectiveUser(row.data, user),
    };
  }
  function visibleMessage(ctx, id) {
    const message = ctx.view.messages.find((m) => D.same(m.id, id));
    if (!message) D.fail("Message introuvable.", 404);
    return message;
  }
  async function conversation(ctx, key) {
    if (typeof key !== "string" || key.length > 180)
      D.fail("Conversation invalide.");
    if (key.startsWith("thread:")) {
      const id = key.slice(7),
        thread = ctx.view.messageThreads.find((t) => D.same(t.id, id));
      if (!thread) D.fail("Conversation non autorisée.", 403);
      return { key, type: "thread", thread, participantIds: thread.participants || [] };
    }
    if (key.startsWith("direct:")) {
      const id = Number(key.slice(7));
      if (!Number.isSafeInteger(id)) D.fail("Contact invalide.");
      const contact = (
        await db.query(
          "SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL AND disabled=false",
          [id],
        )
      ).rows[0];
      if (!contact || !D.canContact(ctx.user, contact, ctx.data))
        D.fail("Contact non autorisé.", 403);
      return {
        key,
        type: "direct",
        contact,
        participantIds: [String(ctx.user.id), String(contact.id)],
      };
    }
    D.fail("Conversation invalide.");
  }
  function configurePush() {
    if (
      !webPush ||
      !process.env.VAPID_PUBLIC_KEY ||
      !process.env.VAPID_PRIVATE_KEY
    )
      return false;
    webPush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:notifications@sousa-group.local",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    return true;
  }

  r.get("/push/key", (req, res) =>
    res.json({
      publicKey: process.env.VAPID_PUBLIC_KEY || "",
      available: !!(
        webPush &&
        process.env.VAPID_PUBLIC_KEY &&
        process.env.VAPID_PRIVATE_KEY
      ),
    }),
  );
  r.post(
    "/push/subscription",
    wrap(async (req, res) => {
      const sub = req.body?.subscription;
      if (
        !sub?.endpoint ||
        !sub?.keys?.p256dh ||
        !sub?.keys?.auth ||
        String(sub.endpoint).length > 3000
      )
        D.fail("Abonnement push invalide.");
      await db.query(
        `INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(user_id,endpoint)
         DO UPDATE SET p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,updated_at=NOW()`,
        [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
      );
      res.json({ ok: true });
    }),
  );
  r.delete(
    "/push/subscription",
    wrap(async (req, res) => {
      const endpoint = String(req.body?.endpoint || "");
      if (endpoint)
        await db.query(
          "DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2",
          [req.user.id, endpoint],
        );
      res.json({ ok: true });
    }),
  );

  r.post(
    "/presence",
    wrap(async (req, res) => {
      const typingKey = req.body?.typingKey
        ? String(req.body.typingKey).slice(0, 180)
        : null;
      if (typingKey) {
        const ctx = await context(req.user);
        await conversation(ctx, typingKey);
      }
      await db.query(
        `INSERT INTO user_presence(user_id,last_seen,typing_key,typing_until)
         VALUES($1,NOW(),$2,CASE WHEN $2 IS NULL THEN NULL ELSE NOW()+INTERVAL '6 seconds' END)
         ON CONFLICT(user_id) DO UPDATE SET
           last_seen=NOW(),
           typing_key=EXCLUDED.typing_key,
           typing_until=EXCLUDED.typing_until`,
        [req.user.id, typingKey],
      );
      res.json({ ok: true, at: new Date().toISOString() });
    }),
  );
  r.get(
    "/presence",
    wrap(async (req, res) => {
      const ctx = await context(req.user),
        users = (
          await db.query(
            "SELECT id,name,role,company,employee_id,client_id,disabled,deleted_at FROM users WHERE deleted_at IS NULL AND disabled=false",
          )
        ).rows.filter(
          (u) =>
            D.same(u.id, req.user.id) ||
            D.canContact(ctx.user, u, ctx.data),
        ),
        ids = users.map((u) => Number(u.id)),
        rows = ids.length
          ? (
              await db.query(
                "SELECT user_id,last_seen,typing_key,typing_until FROM user_presence WHERE user_id=ANY($1::int[])",
                [ids],
              )
            ).rows
          : [];
      res.json({
        presence: rows.map((x) => ({
          userId: x.user_id,
          lastSeen: x.last_seen,
          typingKey:
            x.typing_until && new Date(x.typing_until) > new Date()
              ? x.typing_key
              : null,
          online:
            x.last_seen &&
            Date.now() - new Date(x.last_seen).getTime() < 45000,
        })),
      });
    }),
  );

  r.get(
    "/preferences",
    wrap(async (req, res) => {
      const rows = (
        await db.query(
          "SELECT conversation_key,pinned,archived,muted_until FROM conversation_prefs WHERE user_id=$1",
          [req.user.id],
        )
      ).rows;
      res.json({
        preferences: rows.map((x) => ({
          key: x.conversation_key,
          pinned: x.pinned,
          archived: x.archived,
          mutedUntil: x.muted_until,
        })),
      });
    }),
  );
  r.post(
    "/preferences",
    wrap(async (req, res) => {
      const ctx = await context(req.user),
        key = String(req.body?.key || "");
      await conversation(ctx, key);
      const pinned = !!req.body?.pinned,
        archived = !!req.body?.archived,
        mutedUntil = req.body?.mutedUntil
          ? new Date(req.body.mutedUntil)
          : null;
      if (mutedUntil && Number.isNaN(mutedUntil.getTime()))
        D.fail("Date de mise en sourdine invalide.");
      await db.query(
        `INSERT INTO conversation_prefs(user_id,conversation_key,pinned,archived,muted_until)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(user_id,conversation_key) DO UPDATE SET
           pinned=EXCLUDED.pinned,
           archived=EXCLUDED.archived,
           muted_until=EXCLUDED.muted_until,
           updated_at=NOW()`,
        [req.user.id, key, pinned, archived, mutedUntil],
      );
      res.json({ ok: true });
    }),
  );

  r.post(
    "/messages/:id/edit",
    wrap(async (req, res) => {
      const ctx = await context(req.user),
        message = visibleMessage(ctx, req.params.id);
      if (!D.same(message.senderId, req.user.id))
        D.fail("Vous pouvez uniquement modifier vos propres messages.", 403);
      if (Date.now() - new Date(message.createdAt).getTime() > 15 * 60 * 1000)
        D.fail("La modification est disponible pendant 15 minutes.", 409);
      if (message.system) D.fail("Un message système ne peut pas être modifié.");
      const text = D.text(req.body?.text, "Message", 5000, true),
        encryption = req.body?.encryption || null;
      if (encryption) {
        if (message.attachment?.encrypted)
          D.fail(
            "Un message chiffré contenant une pièce jointe ne peut pas être modifié sans renvoyer le fichier.",
            409,
          );
        if (
          encryption.algorithm !== "SGO-E2EE-P256-AESGCM-v1" ||
          typeof encryption.iv !== "string" ||
          typeof encryption.ciphertext !== "string" ||
          !encryption.envelopes ||
          typeof encryption.envelopes !== "object"
        )
          D.fail("Édition chiffrée invalide.");
        encryption.senderId = String(req.user.id);
      }
      if (!text && !encryption && !message.attachment && !message.sharedRef)
        D.fail("Le message ne peut pas être vide.");
      await db.query(
        `INSERT INTO message_overrides(message_id,edited_text,edited_encryption,edited_at,deleted_for_all)
         VALUES($1,$2,$3,NOW(),false)
         ON CONFLICT(message_id) DO UPDATE SET
           edited_text=EXCLUDED.edited_text,
           edited_encryption=EXCLUDED.edited_encryption,
           edited_at=NOW(),
           deleted_for_all=false,
           deleted_at=NULL`,
        [String(message.id), encryption ? "" : text, encryption],
      );
      res.json({ ok: true });
    }),
  );
  r.post(
    "/messages/:id/delete-for-all",
    wrap(async (req, res) => {
      const ctx = await context(req.user),
        message = visibleMessage(ctx, req.params.id);
      if (!D.same(message.senderId, req.user.id) && req.user.role !== "admin")
        D.fail("Vous pouvez uniquement supprimer vos propres messages.", 403);
      if (
        req.user.role !== "admin" &&
        Date.now() - new Date(message.createdAt).getTime() > 60 * 60 * 1000
      )
        D.fail("La suppression pour tous est disponible pendant 1 heure.", 409);
      if (message.system && req.user.role !== "admin")
        D.fail("Un message système ne peut pas être supprimé.", 403);
      await db.query(
        `INSERT INTO message_overrides(message_id,deleted_for_all,deleted_at)
         VALUES($1,true,NOW())
         ON CONFLICT(message_id) DO UPDATE SET
           deleted_for_all=true,
           deleted_at=NOW()`,
        [String(message.id)],
      );
      res.json({ ok: true });
    }),
  );

  r.get(
    "/message-meta",
    wrap(async (req, res) => {
      const ctx = await context(req.user),
        ids = ctx.view.messages.map((m) => String(m.id));
      if (!ids.length)
        return res.json({ reactions: [], favorites: [] });
      const [reactions, favorites] = await Promise.all([
        db.query(
          "SELECT message_id,user_id,emoji FROM message_reactions WHERE message_id=ANY($1::text[])",
          [ids],
        ),
        db.query(
          "SELECT message_id FROM message_favorites WHERE user_id=$1 AND message_id=ANY($2::text[])",
          [req.user.id, ids],
        ),
      ]);
      res.json({
        reactions: reactions.rows.map((x) => ({
          messageId: x.message_id,
          userId: x.user_id,
          emoji: x.emoji,
        })),
        favorites: favorites.rows.map((x) => x.message_id),
      });
    }),
  );
  r.post(
    "/messages/:id/reaction",
    wrap(async (req, res) => {
      const ctx = await context(req.user);
      visibleMessage(ctx, req.params.id);
      const emoji = String(req.body?.emoji || "").trim();
      if (!["👍", "❤️", "😂", "😮", "😢", "🙏", "✅"].includes(emoji))
        D.fail("Réaction invalide.");
      const existing = (
        await db.query(
          "SELECT 1 FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3",
          [req.params.id, req.user.id, emoji],
        )
      ).rows.length;
      if (existing)
        await db.query(
          "DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3",
          [req.params.id, req.user.id, emoji],
        );
      else
        await db.query(
          "INSERT INTO message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3)",
          [req.params.id, req.user.id, emoji],
        );
      res.json({ active: !existing });
    }),
  );
  r.post(
    "/messages/:id/favorite",
    wrap(async (req, res) => {
      const ctx = await context(req.user);
      visibleMessage(ctx, req.params.id);
      const existing = (
        await db.query(
          "SELECT 1 FROM message_favorites WHERE message_id=$1 AND user_id=$2",
          [req.params.id, req.user.id],
        )
      ).rows.length;
      if (existing)
        await db.query(
          "DELETE FROM message_favorites WHERE message_id=$1 AND user_id=$2",
          [req.params.id, req.user.id],
        );
      else
        await db.query(
          "INSERT INTO message_favorites(message_id,user_id) VALUES($1,$2)",
          [req.params.id, req.user.id],
        );
      res.json({ active: !existing });
    }),
  );

  r.get(
    "/crypto/keys",
    wrap(async (req, res) => {
      const ctx = await context(req.user),
        requested = String(req.query.ids || "")
          .split(",")
          .filter(Boolean)
          .map(Number)
          .filter(Number.isSafeInteger),
        permitted = [];
      for (const id of requested.slice(0, 50)) {
        if (D.same(id, req.user.id)) {
          permitted.push(id);
          continue;
        }
        const u = (
          await db.query(
            "SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL AND disabled=false",
            [id],
          )
        ).rows[0];
        if (u && D.canContact(ctx.user, u, ctx.data)) permitted.push(id);
      }
      if (!permitted.length) return res.json({ keys: [] });
      const rows = (
        await db.query(
          "SELECT user_id,public_jwk,updated_at FROM user_crypto_keys WHERE user_id=ANY($1::int[])",
          [permitted],
        )
      ).rows;
      res.json({
        keys: rows.map((x) => ({
          userId: x.user_id,
          publicJwk: x.public_jwk,
          updatedAt: x.updated_at,
        })),
      });
    }),
  );
  r.post(
    "/crypto/key",
    wrap(async (req, res) => {
      const jwk = req.body?.publicJwk;
      if (
        !jwk ||
        jwk.kty !== "EC" ||
        jwk.crv !== "P-256" ||
        typeof jwk.x !== "string" ||
        typeof jwk.y !== "string"
      )
        D.fail("Clé publique invalide.");
      await db.query(
        `INSERT INTO user_crypto_keys(user_id,public_jwk)
         VALUES($1,$2)
         ON CONFLICT(user_id) DO UPDATE SET public_jwk=EXCLUDED.public_jwk,updated_at=NOW()`,
        [req.user.id, jwk],
      );
      res.json({ ok: true });
    }),
  );

  r.get(
    "/calls/history",
    wrap(async (req, res) => {
      const direct = (
          await db.query(
            `SELECT id,caller_id,callee_id,caller_name,callee_name,status,call_type,created_at,ended_at
             FROM rtc_calls
             WHERE caller_id=$1 OR callee_id=$1
             ORDER BY created_at DESC LIMIT 150`,
            [req.user.id],
          )
        ).rows,
        groups = (
          await db.query(
            `SELECT r.id,r.thread_id,r.created_by,r.call_type,r.status,r.created_at,r.ended_at
             FROM rtc_group_rooms r
             JOIN rtc_group_members m ON m.room_id=r.id
             WHERE m.user_id=$1
             ORDER BY r.created_at DESC LIMIT 100`,
            [req.user.id],
          )
        ).rows;
      res.json({
        direct: direct.map((x) => ({
          id: x.id,
          callerId: x.caller_id,
          calleeId: x.callee_id,
          callerName: x.caller_name,
          calleeName: x.callee_name,
          status: x.status,
          callType: x.call_type || "audio",
          createdAt: x.created_at,
          endedAt: x.ended_at,
        })),
        groups: groups.map((x) => ({
          id: x.id,
          threadId: x.thread_id,
          createdBy: x.created_by,
          callType: x.call_type,
          status: x.status,
          createdAt: x.created_at,
          endedAt: x.ended_at,
        })),
      });
    }),
  );

  r.get(
    "/group-calls/pending",
    wrap(async (req, res) => {
      const rows = (
        await db.query(
          `SELECT r.*
           FROM rtc_group_rooms r
           JOIN rtc_group_members m ON m.room_id=r.id
           WHERE m.user_id=$1 AND m.left_at IS NULL AND r.status IN ('ringing','active')
           ORDER BY r.created_at DESC LIMIT 5`,
          [req.user.id],
        )
      ).rows;
      res.json({
        rooms: rows.map((x) => ({
          id: x.id,
          threadId: x.thread_id,
          createdBy: x.created_by,
          callType: x.call_type,
          status: x.status,
          createdAt: x.created_at,
        })),
      });
    }),
  );
  r.post(
    "/group-calls",
    wrap(async (req, res) => {
      const ctx = await context(req.user),
        threadId = String(req.body?.threadId || ""),
        thread = ctx.view.messageThreads.find((t) => D.same(t.id, threadId));
      if (!thread) D.fail("Conversation de groupe introuvable.", 404);
      const participants = (thread.participants || []).map(Number).filter(Number.isSafeInteger);
      if (participants.length < 2) D.fail("Deux participants minimum.");
      if (participants.length > 8) D.fail("Les appels de groupe sont limités à 8 participants.");
      const type = req.body?.callType === "video" ? "video" : "audio",
        id = randomUUID();
      await db.query(
        "INSERT INTO rtc_group_rooms(id,thread_id,created_by,call_type,status) VALUES($1,$2,$3,$4,'ringing')",
        [id, threadId, req.user.id, type],
      );
      for (const userId of participants)
        await db.query(
          "INSERT INTO rtc_group_members(room_id,user_id,joined_at) VALUES($1,$2,CASE WHEN $2=$3 THEN NOW() ELSE NULL END)",
          [id, userId, req.user.id],
        );
      await notifyUsers(
        db,
        participants.filter((id) => !D.same(id, req.user.id)),
        {
          title: type === "video" ? "Appel vidéo de groupe" : "Appel de groupe",
          body: req.user.name + " vous appelle dans " + thread.name,
          url: "/?open=messages&thread=" + encodeURIComponent(threadId),
          tag: "group-call-" + id,
          callRoomId: id,
        },
      );
      res.json({ id, status: "ringing", callType: type });
    }),
  );
  r.post(
    "/group-calls/:id/join",
    wrap(async (req, res) => {
      const member = (
        await db.query(
          "SELECT r.*,m.user_id FROM rtc_group_rooms r JOIN rtc_group_members m ON m.room_id=r.id WHERE r.id=$1 AND m.user_id=$2",
          [req.params.id, req.user.id],
        )
      ).rows[0];
      if (!member || !["ringing", "active"].includes(member.status))
        D.fail("Appel de groupe indisponible.", 404);
      await db.query(
        "UPDATE rtc_group_members SET joined_at=COALESCE(joined_at,NOW()),left_at=NULL WHERE room_id=$1 AND user_id=$2",
        [req.params.id, req.user.id],
      );
      await db.query(
        "UPDATE rtc_group_rooms SET status='active' WHERE id=$1 AND status='ringing'",
        [req.params.id],
      );
      res.json({ ok: true, callType: member.call_type, threadId: member.thread_id });
    }),
  );
  r.post(
    "/group-calls/:id/leave",
    wrap(async (req, res) => {
      const member = (
        await db.query(
          "SELECT 1 FROM rtc_group_members WHERE room_id=$1 AND user_id=$2",
          [req.params.id, req.user.id],
        )
      ).rows[0];
      if (!member) D.fail("Appel introuvable.", 404);
      await db.query(
        "UPDATE rtc_group_members SET left_at=NOW() WHERE room_id=$1 AND user_id=$2",
        [req.params.id, req.user.id],
      );
      const active = (
        await db.query(
          "SELECT COUNT(*)::int n FROM rtc_group_members WHERE room_id=$1 AND joined_at IS NOT NULL AND left_at IS NULL",
          [req.params.id],
        )
      ).rows[0].n;
      if (!active)
        await db.query(
          "UPDATE rtc_group_rooms SET status='ended',ended_at=NOW() WHERE id=$1",
          [req.params.id],
        );
      res.json({ ok: true });
    }),
  );
  r.post(
    "/group-calls/:id/end",
    wrap(async (req, res) => {
      const room = (
        await db.query(
          "SELECT * FROM rtc_group_rooms WHERE id=$1",
          [req.params.id],
        )
      ).rows[0];
      if (!room || (!D.same(room.created_by, req.user.id) && req.user.role !== "admin"))
        D.fail("Vous ne pouvez pas terminer cet appel.", 403);
      await db.query(
        "UPDATE rtc_group_rooms SET status='ended',ended_at=NOW() WHERE id=$1",
        [req.params.id],
      );
      await db.query(
        "UPDATE rtc_group_members SET left_at=COALESCE(left_at,NOW()) WHERE room_id=$1",
        [req.params.id],
      );
      res.json({ ok: true });
    }),
  );
  r.get(
    "/group-calls/:id/members",
    wrap(async (req, res) => {
      const allowed = (
        await db.query(
          "SELECT 1 FROM rtc_group_members WHERE room_id=$1 AND user_id=$2",
          [req.params.id, req.user.id],
        )
      ).rows[0];
      if (!allowed) D.fail("Appel non autorisé.", 403);
      const rows = (
        await db.query(
          "SELECT user_id,joined_at,left_at FROM rtc_group_members WHERE room_id=$1 ORDER BY user_id",
          [req.params.id],
        )
      ).rows;
      res.json({
        members: rows.map((x) => ({
          userId: x.user_id,
          joinedAt: x.joined_at,
          leftAt: x.left_at,
        })),
      });
    }),
  );
  r.post(
    "/group-calls/:id/signal",
    wrap(async (req, res) => {
      const toUser = Number(req.body?.toUser),
        kind = String(req.body?.kind || ""),
        payload = req.body?.payload;
      if (!Number.isSafeInteger(toUser) || !["offer", "answer", "ice"].includes(kind))
        D.fail("Signal invalide.");
      const members = (
        await db.query(
          "SELECT user_id FROM rtc_group_members WHERE room_id=$1 AND user_id=ANY($2::int[])",
          [req.params.id, [Number(req.user.id), toUser]],
        )
      ).rows;
      if (members.length !== 2) D.fail("Participants non autorisés.", 403);
      await db.query(
        "INSERT INTO rtc_group_signals(room_id,from_user,to_user,kind,payload) VALUES($1,$2,$3,$4,$5)",
        [req.params.id, req.user.id, toUser, kind, payload || {}],
      );
      res.json({ ok: true });
    }),
  );
  r.get(
    "/group-calls/:id/signals",
    wrap(async (req, res) => {
      const after = Math.max(0, Number(req.query.after) || 0),
        allowed = (
          await db.query(
            "SELECT 1 FROM rtc_group_members WHERE room_id=$1 AND user_id=$2",
            [req.params.id, req.user.id],
          )
        ).rows[0];
      if (!allowed) D.fail("Appel non autorisé.", 403);
      const rows = (
        await db.query(
          `SELECT id,from_user,kind,payload FROM rtc_group_signals
           WHERE room_id=$1 AND to_user=$2 AND id>$3
           ORDER BY id ASC LIMIT 300`,
          [req.params.id, req.user.id, after],
        )
      ).rows;
      res.json({
        signals: rows.map((x) => ({
          id: Number(x.id),
          fromUser: x.from_user,
          kind: x.kind,
          payload: x.payload,
        })),
      });
    }),
  );

  r.get(
    "/retention",
    wrap(async (req, res) => {
      if (req.user.role !== "admin") D.fail("Accès administrateur requis.", 403);
      const rows = (
        await db.query("SELECT scope,days,updated_at FROM retention_policies ORDER BY scope")
      ).rows;
      res.json({ policies: rows });
    }),
  );
  r.post(
    "/retention",
    wrap(async (req, res) => {
      if (req.user.role !== "admin") D.fail("Accès administrateur requis.", 403);
      const scope = String(req.body?.scope || ""),
        days = Number(req.body?.days);
      if (!["messages", "call_history", "call_signals"].includes(scope))
        D.fail("Politique invalide.");
      if (!Number.isInteger(days) || days < 1 || days > 3650)
        D.fail("Durée de conservation invalide.");
      await db.query(
        `INSERT INTO retention_policies(scope,days,updated_by)
         VALUES($1,$2,$3)
         ON CONFLICT(scope) DO UPDATE SET days=EXCLUDED.days,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
        [scope, days, req.user.id],
      );
      res.json({ ok: true });
    }),
  );

  return r;
}

async function notifyUsers(db, userIds, payload) {
  if (
    !webPush ||
    !process.env.VAPID_PUBLIC_KEY ||
    !process.env.VAPID_PRIVATE_KEY ||
    !userIds?.length
  )
    return { sent: 0 };
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:notifications@sousa-group.local",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  let allowedUserIds = userIds.map(Number);
  if (payload?.conversationKey) {
    const muted = (
      await db.query(
        `SELECT user_id FROM conversation_prefs
         WHERE user_id=ANY($1::int[])
           AND conversation_key=$2
           AND muted_until IS NOT NULL
           AND muted_until > NOW()`,
        [allowedUserIds, payload.conversationKey],
      )
    ).rows.map((x) => Number(x.user_id));
    const mutedSet = new Set(muted);
    allowedUserIds = allowedUserIds.filter((id) => !mutedSet.has(id));
  }
  if (!allowedUserIds.length) return { sent: 0 };
  const rows = (
    await db.query(
      "SELECT id,user_id,endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=ANY($1::int[])",
      [allowedUserIds],
    )
  ).rows;
  let sent = 0;
  for (const row of rows) {
    try {
      await webPush.sendNotification(
        {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        },
        JSON.stringify(payload),
        { TTL: 90 },
      );
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410)
        await db.query("DELETE FROM push_subscriptions WHERE id=$1", [row.id]);
    }
  }
  return { sent };
}

async function cleanupRetention(db) {
  const policies = Object.fromEntries(
    (
      await db.query("SELECT scope,days FROM retention_policies")
    ).rows.map((x) => [x.scope, Number(x.days)]),
  );
  const signalDays = Math.max(1, policies.call_signals || 7),
    callDays = Math.max(1, policies.call_history || 730);
  await db.query(
    "DELETE FROM rtc_group_signals WHERE created_at < NOW() - ($1::text || ' days')::interval",
    [String(signalDays)],
  );
  await db.query(
    "DELETE FROM rtc_ice_candidates WHERE created_at < NOW() - ($1::text || ' days')::interval",
    [String(signalDays)],
  );
  await db.query(
    "DELETE FROM rtc_calls WHERE ended_at IS NOT NULL AND ended_at < NOW() - ($1::text || ' days')::interval",
    [String(callDays)],
  );
  await db.query(
    "DELETE FROM rtc_group_rooms WHERE ended_at IS NOT NULL AND ended_at < NOW() - ($1::text || ' days')::interval",
    [String(callDays)],
  );
  const messageDays = Math.max(1, policies.messages || 3650),
    row = (await db.query("SELECT data,revision FROM app_state WHERE id=1")).rows[0],
    data = D.normalize(row.data),
    cutoff = Date.now() - messageDays * 86400000,
    expired = data.messages.filter(
      (m) => m.createdAt && new Date(m.createdAt).getTime() < cutoff,
    );
  if (expired.length) {
    const fileIds = expired
      .map((m) => m.attachment?.fileId)
      .filter(Boolean);
    data.messages = data.messages.filter((m) => !expired.includes(m));
    await db.query(
      "UPDATE app_state SET data=$1,revision=revision+1,updated_at=NOW(),updated_by='retention-policy' WHERE id=1",
      [JSON.stringify(data)],
    );
    if (fileIds.length)
      await db.query("DELETE FROM file_contents WHERE id=ANY($1::text[])", [fileIds]);
    const ids = expired.map((m) => String(m.id));
    await db.query("DELETE FROM message_reads WHERE message_id=ANY($1::text[])", [ids]);
    await db.query("DELETE FROM message_reactions WHERE message_id=ANY($1::text[])", [ids]);
    await db.query("DELETE FROM message_favorites WHERE message_id=ANY($1::text[])", [ids]);
    await db.query("DELETE FROM message_overrides WHERE message_id=ANY($1::text[])", [ids]);
  }
}

module.exports = { routes, notifyUsers, cleanupRetention };
