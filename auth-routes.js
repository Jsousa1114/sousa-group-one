"use strict";
const express = require("express"),
  bcrypt = require("bcryptjs"),
  jwt = require("jsonwebtoken");
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
      attempts.delete(key);
      const token = jwt.sign(
        { sv: u.session_version },
        process.env.JWT_SECRET,
        {
          subject: String(u.id),
          expiresIn: "8h",
          issuer: "sousa-group-one",
          audience: "sgo-web",
          algorithm: "HS256",
        },
      );
      await db.query(
        "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
        [u.email, "Connexion", "{}"],
      );
      res.json({ token, profile: profile(u) });
    }),
  );
  router.use(auth(db));
  router.get("/me", (req, res) => res.json({ profile: profile(req.user) }));
  router.post(
    "/logout",
    wrap(async (req, res) => {
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
