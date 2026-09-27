"use strict";
const jwt = require("jsonwebtoken");
const { loadState } = require("./db");
function sessionCookieToken(req) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name !== "sgo_session") continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return part.slice(i + 1).trim();
    }
  }
  return "";
}
function auth(db) {
  return async (req, res, next) => {
    try {
      const bearer = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i),
        token = bearer?.[1] || sessionCookieToken(req);
      if (!token)
        return res.status(401).json({ error: "Authentification requise." });
      const claims = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: "sousa-group-one",
        audience: "sgo-web",
      });
      const u = (
        await db.query("SELECT * FROM users WHERE id=$1", [claims.sub])
      ).rows[0];
      if (!u || u.disabled || u.deleted_at || u.session_version !== claims.sv)
        return res
          .status(401)
          .json({ error: "Session expirée. Reconnectez-vous." });
      if (claims.sid) {
        const session = (
          await db.query(
            "SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL",
            [claims.sid, u.id],
          )
        ).rows[0];
        if (!session)
          return res
            .status(401)
            .json({ error: "Cette session a été déconnectée." });
        await db.query(
          "UPDATE user_sessions SET last_seen=NOW() WHERE id=$1 AND last_seen < NOW()-INTERVAL '1 minute'",
          [claims.sid],
        );
      }
      const { data } = await loadState(db);
      req.user = require("./domain").effectiveUser(data || {}, u);
      try {
        const row = (
          await db.query(
            "SELECT grant_roles,deny_roles FROM p2_permission_overrides WHERE user_id=$1",
            [u.id],
          )
        ).rows[0];
        req.user.permission_grants = row?.grant_roles || [];
        req.user.permission_denials = row?.deny_roles || [];
      } catch (error) {
        if (error?.code !== "42P01") throw error;
        req.user.permission_grants = [];
        req.user.permission_denials = [];
      }
      req.authClaims = claims;
      next();
    } catch (e) {
      if (
        e.name === "JsonWebTokenError" ||
        e.name === "TokenExpiredError" ||
        e.name === "NotBeforeError"
      )
        return res.status(401).json({ error: "Authentification requise." });
      next(e);
    }
  };
}
const profile = (u) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  name: u.name,
  company: u.company,
  companies: u.companies || [u.company],
  employee_id: u.employee_id,
  client_id: u.client_id,
  permission_grants: u.permission_grants || [],
  permission_denials: u.permission_denials || [],
});
module.exports = { auth, profile };
