"use strict";
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomBytes, randomUUID } = require("node:crypto");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const { auth, profile } = require("./auth-middleware");
const { wrap } = require("./auth-routes");
const D = require("./domain");

const SESSION_COOKIE = "sgo_session";
const CHALLENGE_TTL_MINUTES = 5;

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    secure:
      process.env.COOKIE_SECURE === "true" ||
      !!process.env.RENDER ||
      !!req.secure,
    sameSite: "strict",
    path: "/",
    maxAge: 8 * 60 * 60 * 1000,
  };
}

function webauthnConfig(req) {
  const rpID = String(process.env.WEBAUTHN_RP_ID || req.hostname || "").trim();
  const origin = String(
    process.env.WEBAUTHN_ORIGIN ||
      `${req.protocol}://${req.get("host") || ""}`,
  ).replace(/\/$/, "");
  if (!rpID || !origin) D.fail("Configuration Passkey incomplète.", 503);
  return {
    rpID,
    origin,
    rpName: String(process.env.WEBAUTHN_RP_NAME || "Sousa Group One").slice(
      0,
      120,
    ),
  };
}

async function cleanupChallenges(db) {
  await db.query(
    "DELETE FROM webauthn_challenges WHERE expires_at < NOW()-INTERVAL '1 hour'",
  );
}

async function ensureWebauthnUserId(db, user) {
  if (user.webauthn_user_id) return user.webauthn_user_id;
  const id = randomBytes(32).toString("base64url");
  const row = (
    await db.query(
      `UPDATE users
       SET webauthn_user_id=COALESCE(webauthn_user_id,$1)
       WHERE id=$2
       RETURNING webauthn_user_id`,
      [id, user.id],
    )
  ).rows[0];
  return row?.webauthn_user_id || id;
}

function publicPasskey(row) {
  return {
    id: row.id,
    name: row.name || "Passkey",
    transports: row.transports || [],
    deviceType: row.device_type || "",
    backedUp: !!row.backed_up,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

async function listPasskeys(db, userId) {
  return (
    await db.query(
      `SELECT id,name,transports,device_type,backed_up,created_at,last_used_at
       FROM user_passkeys
       WHERE user_id=$1
       ORDER BY created_at DESC`,
      [userId],
    )
  ).rows.map(publicPasskey);
}

async function issuePasskeySession(db, req, res, user) {
  const sid = randomUUID();
  const token = jwt.sign(
    { sv: user.session_version, sid },
    process.env.JWT_SECRET,
    {
      subject: String(user.id),
      expiresIn: "8h",
      issuer: "sousa-group-one",
      audience: "sgo-web",
      algorithm: "HS256",
    },
  );
  const agent = String(req.headers["user-agent"] || "").slice(0, 500);
  const ip = String(req.ip || "").slice(0, 120);
  await db.query(
    "INSERT INTO user_sessions(id,user_id,user_agent,ip) VALUES($1,$2,$3,$4)",
    [sid, user.id, agent, ip],
  );
  await db.query(
    "UPDATE users SET last_login_at=NOW(),last_login_ip=$1,last_login_agent=$2 WHERE id=$3",
    [ip, agent, user.id],
  );
  await db.query(
    "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
    [user.email, "Connexion par passkey", JSON.stringify({ sessionId: sid })],
  );
  require("./messaging-routes")
    .notifyUsers(db, [Number(user.id)], {
      title: "Connexion par passkey",
      body: "Une nouvelle session vient d’être ouverte sur Sousa Group One.",
      url: "/?open=settings",
      tag: "security-passkey-login-" + sid,
      category: "security",
    })
    .catch(() => {});
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req));
  return profile(user);
}

function routes(db) {
  const r = express.Router();
  const requireAuth = auth(db);

  r.post(
    "/login/options",
    wrap(async (req, res) => {
      await cleanupChallenges(db);
      const email = D.text(req.body?.email, "E-mail", 255).toLowerCase();
      const user = (
        await db.query(
          `SELECT * FROM users
           WHERE email=$1 AND disabled=false AND deleted_at IS NULL`,
          [email],
        )
      ).rows[0];
      if (!user)
        D.fail("Aucune passkey disponible pour ce compte.", 404);

      const credentials = (
        await db.query(
          `SELECT id,transports FROM user_passkeys
           WHERE user_id=$1 ORDER BY created_at`,
          [user.id],
        )
      ).rows;
      if (!credentials.length)
        D.fail("Aucune passkey disponible pour ce compte.", 404);

      const cfg = webauthnConfig(req);
      const options = await generateAuthenticationOptions({
        rpID: cfg.rpID,
        allowCredentials: credentials.map((x) => ({
          id: x.id,
          transports: x.transports || undefined,
        })),
        userVerification: "required",
        timeout: 60000,
      });
      const challengeId = randomUUID();
      await db.query(
        `INSERT INTO webauthn_challenges
         (id,user_id,purpose,challenge,rp_id,origin,expires_at)
         VALUES($1,$2,'authentication',$3,$4,$5,NOW()+INTERVAL '${CHALLENGE_TTL_MINUTES} minutes')`,
        [challengeId, user.id, options.challenge, cfg.rpID, cfg.origin],
      );
      res.set("Cache-Control", "no-store").json({ challengeId, options });
    }),
  );

  r.post(
    "/login/verify",
    wrap(async (req, res) => {
      const challengeId = D.text(req.body?.challengeId, "Challenge", 100);
      const response = req.body?.response;
      if (!response?.id) D.fail("Réponse Passkey invalide.");

      const challenge = (
        await db.query(
          `DELETE FROM webauthn_challenges
           WHERE id=$1 AND purpose='authentication' AND expires_at>NOW()
           RETURNING *`,
          [challengeId],
        )
      ).rows[0];
      if (!challenge)
        D.fail("La demande Passkey a expiré. Recommencez.", 409);

      const user = (
        await db.query(
          `SELECT * FROM users
           WHERE id=$1 AND disabled=false AND deleted_at IS NULL`,
          [challenge.user_id],
        )
      ).rows[0];
      if (!user) D.fail("Compte indisponible.", 401);

      const passkey = (
        await db.query(
          `SELECT * FROM user_passkeys
           WHERE user_id=$1 AND id=$2`,
          [user.id, String(response.id)],
        )
      ).rows[0];
      if (!passkey) D.fail("Passkey inconnue.", 401);

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: challenge.origin,
          expectedRPID: challenge.rp_id,
          requireUserVerification: true,
          credential: {
            id: passkey.id,
            publicKey: new Uint8Array(passkey.public_key),
            counter: Number(passkey.counter || 0),
            transports: passkey.transports || undefined,
          },
        });
      } catch {
        D.fail("La vérification Passkey a échoué.", 401);
      }
      if (!verification?.verified)
        D.fail("La vérification Passkey a échoué.", 401);

      const newCounter = Number(
        verification.authenticationInfo?.newCounter ??
          passkey.counter ??
          0,
      );
      await db.query(
        `UPDATE user_passkeys
         SET counter=$1,last_used_at=NOW()
         WHERE id=$2 AND user_id=$3`,
        [newCounter, passkey.id, user.id],
      );
      const account = await issuePasskeySession(db, req, res, user);
      res.set("Cache-Control", "no-store").json({ profile: account });
    }),
  );

  r.get(
    "/",
    requireAuth,
    wrap(async (req, res) => {
      res.set("Cache-Control", "no-store").json({
        available: true,
        passkeys: await listPasskeys(db, req.user.id),
      });
    }),
  );

  r.post(
    "/register/options",
    requireAuth,
    wrap(async (req, res) => {
      await cleanupChallenges(db);
      const user = (
        await db.query("SELECT * FROM users WHERE id=$1", [req.user.id])
      ).rows[0];
      if (!user || user.disabled || user.deleted_at)
        D.fail("Compte indisponible.", 401);
      if (
        !(await bcrypt.compare(
          String(req.body?.currentPassword || ""),
          user.password_hash,
        ))
      )
        D.fail("Mot de passe actuel incorrect.", 403);

      const existing = (
        await db.query(
          "SELECT id,transports FROM user_passkeys WHERE user_id=$1 ORDER BY created_at",
          [user.id],
        )
      ).rows;
      const webauthnUserId = await ensureWebauthnUserId(db, user);
      const cfg = webauthnConfig(req);
      const options = await generateRegistrationOptions({
        rpName: cfg.rpName,
        rpID: cfg.rpID,
        userID: Buffer.from(webauthnUserId, "base64url"),
        userName: user.email,
        userDisplayName: user.name || user.email,
        attestationType: "none",
        excludeCredentials: existing.map((x) => ({
          id: x.id,
          transports: x.transports || undefined,
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
        },
        supportedAlgorithmIDs: [-7, -257],
        timeout: 60000,
      });
      const challengeId = randomUUID();
      await db.query(
        `INSERT INTO webauthn_challenges
         (id,user_id,purpose,challenge,rp_id,origin,expires_at)
         VALUES($1,$2,'registration',$3,$4,$5,NOW()+INTERVAL '${CHALLENGE_TTL_MINUTES} minutes')`,
        [challengeId, user.id, options.challenge, cfg.rpID, cfg.origin],
      );
      res.set("Cache-Control", "no-store").json({ challengeId, options });
    }),
  );

  r.post(
    "/register/verify",
    requireAuth,
    wrap(async (req, res) => {
      const challengeId = D.text(req.body?.challengeId, "Challenge", 100);
      const response = req.body?.response;
      if (!response?.id) D.fail("Réponse Passkey invalide.");
      const challenge = (
        await db.query(
          `DELETE FROM webauthn_challenges
           WHERE id=$1 AND user_id=$2 AND purpose='registration'
             AND expires_at>NOW()
           RETURNING *`,
          [challengeId, req.user.id],
        )
      ).rows[0];
      if (!challenge)
        D.fail("La demande Passkey a expiré. Recommencez.", 409);

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: challenge.origin,
          expectedRPID: challenge.rp_id,
          requireUserVerification: true,
        });
      } catch {
        D.fail("La vérification Passkey a échoué.", 400);
      }
      if (!verification?.verified || !verification.registrationInfo)
        D.fail("La vérification Passkey a échoué.", 400);

      const {
        credential,
        credentialDeviceType,
        credentialBackedUp,
      } = verification.registrationInfo;
      const name = String(req.body?.name || "Passkey")
        .trim()
        .slice(0, 120) || "Passkey";
      const transports =
        credential.transports ||
        response?.response?.transports ||
        [];

      try {
        await db.query(
          `INSERT INTO user_passkeys
           (id,user_id,public_key,counter,transports,device_type,backed_up,name)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            credential.id,
            req.user.id,
            Buffer.from(credential.publicKey),
            Number(credential.counter || 0),
            transports,
            credentialDeviceType || null,
            !!credentialBackedUp,
            name,
          ],
        );
      } catch (error) {
        if (error?.code === "23505")
          D.fail("Cette passkey est déjà enregistrée.", 409);
        throw error;
      }
      await db.query(
        "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
        [
          req.user.email,
          "Passkey ajoutée",
          JSON.stringify({ credentialId: credential.id, name }),
        ],
      );
      res.json({
        ok: true,
        passkeys: await listPasskeys(db, req.user.id),
      });
    }),
  );

  r.post(
    "/delete",
    requireAuth,
    wrap(async (req, res) => {
      const id = D.text(req.body?.id, "Passkey", 1500);
      const user = (
        await db.query("SELECT * FROM users WHERE id=$1", [req.user.id])
      ).rows[0];
      if (
        !(await bcrypt.compare(
          String(req.body?.currentPassword || ""),
          user.password_hash,
        ))
      )
        D.fail("Mot de passe actuel incorrect.", 403);
      const removed = (
        await db.query(
          "DELETE FROM user_passkeys WHERE id=$1 AND user_id=$2 RETURNING name",
          [id, req.user.id],
        )
      ).rows[0];
      if (!removed) D.fail("Passkey introuvable.", 404);
      await db.query(
        "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
        [
          req.user.email,
          "Passkey supprimée",
          JSON.stringify({ credentialId: id, name: removed.name || "" }),
        ],
      );
      res.json({
        ok: true,
        passkeys: await listPasskeys(db, req.user.id),
      });
    }),
  );

  return r;
}

module.exports = { routes };
