"use strict";
const express = require("express"),
  bcrypt = require("bcryptjs"),
  jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { verifyTotp, hashRecoveryCode } = require("./account-security");
const { auth, profile } = require("./auth-middleware");
const { AppError, text } = require("./domain");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
function routes(db) {
  const router = express.Router(),
    attempts = new Map();
  router.post(
    "/login",
    wrap(async (req, res) => {
      const email = text(req.body.email, "E-mail", 255).toLowerCase(),
        password = text(req.body.password, "Mot de passe", 200);
      const key = req.ip + ":" + email,
        now = Date.now();
      if (attempts.size > 10000)
        for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
      let a = attempts.get(key);
      if (!a || a.until < now) {
        a = { count: 0, until: now + 15 * 60000 };
        attempts.set(key, a);
      }
      if (++a.count > 20)
        throw new AppError(
          "Trop de tentatives. Réessayez dans 15 minutes.",
          429,
        );
      const u = (await db.query("SELECT * FROM users WHERE email=$1", [email]))
        .rows[0];
      if (
        !u ||
        u.disabled ||
        u.deleted_at ||
        !(await bcrypt.compare(password, u.password_hash))
      )
        throw new AppError("E-mail ou mot de passe incorrect.", 401);
      if (u.totp_enabled) {
        if (!req.body?.totpCode)
          return res.status(401).json({
            error: "Code de double authentification ou code de secours requis.",
            code: "TOTP_REQUIRED",
          });
        const secondFactor = String(req.body.totpCode || "");
        if (!verifyTotp(u.totp_secret, secondFactor)) {
          const recoveryHash = hashRecoveryCode(secondFactor),
            used = (
              await db.query(
                `UPDATE user_recovery_codes SET used_at=NOW()
                 WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL
                 RETURNING code_hash`,
                [u.id, recoveryHash],
              )
            ).rows[0];
          if (!used)
            throw new AppError(
              "Code de double authentification ou code de secours invalide.",
              401,
            );
        }
      }
      attempts.delete(key);
      const sid = randomUUID(),
        token = jwt.sign(
          { sv: u.session_version, sid },
          process.env.JWT_SECRET,
          {
            subject: String(u.id),
            expiresIn: "8h",
            issuer: "sousa-group-one",
            audience: "sgo-web",
            algorithm: "HS256",
          },
        ),
        agent = String(req.headers["user-agent"] || "").slice(0, 500),
        ip = String(req.ip || "").slice(0, 120);
      await db.query(
        "INSERT INTO user_sessions(id,user_id,user_agent,ip) VALUES($1,$2,$3,$4)",
        [sid, u.id, agent, ip],
      );
      await db.query(
        "UPDATE users SET last_login_at=NOW(),last_login_ip=$1,last_login_agent=$2 WHERE id=$3",
        [ip, agent, u.id],
      );
      await db.query(
        "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
        [u.email, "Connexion", JSON.stringify({ sessionId: sid })],
      );
      // Best-effort security alert to previously registered devices.
      require("./messaging-routes")
        .notifyUsers(db, [Number(u.id)], {
          title: "Nouvelle connexion à Sousa Group One",
          body: "Une nouvelle session vient d’être ouverte sur " +
            (/iPhone/.test(agent)
              ? "iPhone"
              : /Android/.test(agent)
                ? "Android"
                : /Macintosh/.test(agent)
                  ? "Mac"
                  : /Windows/.test(agent)
                    ? "Windows"
                    : "un appareil"),
          url: "/?open=settings",
          tag: "security-login-" + sid,
          category: "security",
        })
        .catch(() => {});
      res.json({ token, profile: profile(u) });
    }),
  );
  router.use(auth(db));
  router.get("/me", (req, res) => res.json({ profile: profile(req.user) }));
  router.post(
    "/logout",
    wrap(async (req, res) => {
      if (req.authClaims?.sid)
        await db.query(
          "UPDATE user_sessions SET revoked_at=NOW() WHERE id=$1 AND user_id=$2",
          [req.authClaims.sid, req.user.id],
        );
      else
        await db.query(
          "UPDATE users SET session_version=session_version+1 WHERE id=$1",
          [req.user.id],
        );
      res.json({ ok: true });
    }),
  );
  router.post(
    "/password",
    wrap(async (req, res) => {
      const p = text(req.body.password, "Nouveau mot de passe", 200);
      if (p.length < 12) throw new AppError("12 caractères minimum.");
      if (
        !(await bcrypt.compare(
          String(req.body.currentPassword || ""),
          req.user.password_hash,
        ))
      )
        throw new AppError("Mot de passe actuel incorrect.", 403);
      await db.query(
        "UPDATE users SET password_hash=$1,session_version=session_version+1 WHERE id=$2",
        [await bcrypt.hash(p, 12), req.user.id],
      );
      res.json({ ok: true });
    }),
  );
  return router;
}
module.exports = { routes, wrap };
