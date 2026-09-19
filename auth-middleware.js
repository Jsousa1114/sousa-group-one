"use strict";
const jwt = require("jsonwebtoken");
function auth(db) {
  return async (req, res, next) => {
    try {
      const token = (req.headers.authorization || "").replace(/^Bearer /, "");
      const claims = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: "sousa-group-one",
        audience: "sgo-web",
      });
      const u = (
        await db.query("SELECT * FROM users WHERE id=$1", [claims.sub])
      ).rows[0];
      if (!u || u.disabled || u.session_version !== claims.sv)
        return res
          .status(401)
          .json({ error: "Session expirée. Reconnectez-vous." });
      const data = (await db.query("SELECT data FROM app_state WHERE id=1"))
        .rows[0]?.data;
      req.user = require("./domain").effectiveUser(data || {}, u);
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
});
module.exports = { auth, profile };
