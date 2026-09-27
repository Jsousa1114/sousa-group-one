"use strict";
const express = require("express");
const bcrypt = require("bcryptjs");
const { auth } = require("./auth-middleware");
const { wrap } = require("./auth-routes");
const D = require("./domain");
const { transaction } = require("./db");
const {
  generateTotpSecret,
  verifyTotp,
  otpauthUri,
} = require("./account-security");

const DEFAULT_PREFS = Object.freeze({
  language: "fr",
  theme: "system",
  defaultCompany: "",
  defaultPage: "dashboard",
  dateFormat: "CH",
  textSize: "normal",
  notifications: {
    messages: true,
    groups: true,
    calls: true,
    projects: true,
    planning: true,
    absences: true,
    finance: true,
    push: true,
    sound: true,
    vibration: true,
  },
  privacy: {
    lastSeen: true,
    online: true,
    readReceipts: true,
  },
});

function mergePrefs(value) {
  const p = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_PREFS,
    ...p,
    notifications: {
      ...DEFAULT_PREFS.notifications,
      ...(p.notifications || {}),
    },
    privacy: {
      ...DEFAULT_PREFS.privacy,
      ...(p.privacy || {}),
    },
  };
}
function bool(v) {
  return v === true || v === "true";
}
function cleanText(v, max = 200) {
  const s = String(v == null ? "" : v).trim();
  if (s.length > max) D.fail("Valeur trop longue.");
  return s;
}
function validPhoto(v) {
  if (!v) return "";
  if (
    typeof v !== "string" ||
    v.length > 350000 ||
    !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)
  )
    D.fail("Photo invalide ou trop volumineuse.");
  const bytes = Buffer.from(v.split(",")[1], "base64");
  const ok = v.startsWith("data:image/jpeg;")
    ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : v.startsWith("data:image/png;")
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP";
  if (!ok) D.fail("Format de photo invalide.");
  return v;
}
function publicSession(row, currentId) {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    userAgent: row.user_agent || "Appareil inconnu",
    ip: row.ip || "",
    current: !!currentId && String(row.id) === String(currentId),
  };
}
async function getPrefs(db, userId) {
  const row = (
    await db.query("SELECT data FROM account_preferences WHERE user_id=$1", [
      userId,
    ])
  ).rows[0];
  return mergePrefs(row?.data);
}
function validatePrefs(input) {
  const p = mergePrefs(input);
  if (!["fr", "en", "de", "it", "pt", "es", "sq"].includes(p.language))
    D.fail("Langue invalide.");
  if (!["system", "dark", "light"].includes(p.theme))
    D.fail("Thème invalide.");
  if (!["dashboard", "time", "planning", "projects", "messages", "settings"].includes(p.defaultPage))
    D.fail("Page d’accueil invalide.");
  if (!["CH", "ISO"].includes(p.dateFormat)) D.fail("Format de date invalide.");
  if (!["small", "normal", "large"].includes(p.textSize))
    D.fail("Taille de texte invalide.");
  p.defaultCompany = cleanText(p.defaultCompany, 80);
  for (const key of Object.keys(DEFAULT_PREFS.notifications))
    p.notifications[key] = bool(p.notifications[key]);
  for (const key of Object.keys(DEFAULT_PREFS.privacy))
    p.privacy[key] = bool(p.privacy[key]);
  return p;
}

function routes(db) {
  const r = express.Router();
  r.use(auth(db));

  r.get(
    "/preferences",
    wrap(async (req, res) => {
      res.json({ preferences: await getPrefs(db, req.user.id) });
    }),
  );

  r.post(
    "/preferences",
    wrap(async (req, res) => {
      const prefs = validatePrefs(req.body?.preferences || {});
      await db.query(
        `INSERT INTO account_preferences(user_id,data,updated_at)
         VALUES($1,$2,NOW())
         ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
        [req.user.id, JSON.stringify(prefs)],
      );
      await db.query(
        "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
        [req.user.email, "Préférences du compte modifiées", "{}"],
      );
      res.json({ ok: true, preferences: prefs });
    }),
  );

  r.get(
    "/summary",
    wrap(async (req, res) => {
      const stateRow = (
          await db.query("SELECT data FROM app_state WHERE id=1")
        ).rows[0],
        data = D.normalize(stateRow?.data),
        view = D.viewState(data, req.user),
        employee = req.user.employee_id
          ? data.employees.find((e) => D.same(e.id, req.user.employee_id) && !e.deletedAt)
          : null,
        client = req.user.client_id
          ? data.clients.find((c) => D.same(c.id, req.user.client_id))
          : null,
        prefs = await getPrefs(db, req.user.id),
        sessions = (
          await db.query(
            `SELECT id,created_at,last_seen,user_agent,ip
             FROM user_sessions
             WHERE user_id=$1 AND revoked_at IS NULL
             ORDER BY last_seen DESC LIMIT 30`,
            [req.user.id],
          )
        ).rows.map((x) => publicSession(x, req.authClaims?.sid)),
        activity = (
          await db.query(
            `SELECT action,metadata,created_at
             FROM audit_logs WHERE user_email=$1
             ORDER BY created_at DESC LIMIT 12`,
            [req.user.email],
          )
        ).rows,
        userRow = (
          await db.query(
            `SELECT created_at,totp_enabled,last_login_at,last_login_ip,last_login_agent
             FROM users WHERE id=$1`,
            [req.user.id],
          )
        ).rows[0],
        pendingDeactivation = (
          await db.query(
            `SELECT id,reason,status,created_at
             FROM account_deactivation_requests
             WHERE user_id=$1 AND status='pending'
             ORDER BY created_at DESC LIMIT 1`,
            [req.user.id],
          )
        ).rows[0] || null;

      const month = new Date().toISOString().slice(0, 7),
        monthHours = view.time
          .filter((x) => String(x.date || "").startsWith(month))
          .reduce((n, x) => n + (Number(x.hours) || 0), 0),
        projects = view.projects.filter((p) =>
          req.user.employee_id
            ? (p.team || []).some((id) => D.same(id, req.user.employee_id))
            : true,
        );

      const ownDocs = view.documents.filter((doc) =>
        req.user.employee_id
          ? D.same(doc.employeeId, req.user.employee_id)
          : req.user.client_id
            ? D.same(doc.clientId, req.user.client_id)
            : false,
      );

      res.json({
        account: {
          id: req.user.id,
          email: req.user.email,
          name: employee?.name || client?.name || req.user.name,
          role: req.user.role,
          company: req.user.company,
          companies: req.user.companies || [req.user.company],
          createdAt: userRow?.created_at,
          photo: employee?.photo || "",
        },
        employee: employee
          ? {
              id: employee.id,
              job: employee.job || "",
              email: employee.email || req.user.email,
              phone: employee.phone || "",
              street: employee.street || "",
              zip: employee.zip || "",
              city: employee.city || "",
              country: employee.country || "",
              birthDate: employee.birthDate || "",
              nationality: employee.nationality || "",
              residencePermit: employee.residencePermit || "",
              residencePermitExpiry: employee.residencePermitExpiry || "",
              emergencyName: employee.emergencyName || "",
              emergencyPhone: employee.emergencyPhone || "",
              contractType: employee.contractType || "",
              entry: employee.entry || "",
              endDate: employee.endDate || "",
              activity: employee.activity ?? "",
              vacation: employee.vacation ?? "",
              companies: D.employeeCompanies(employee),
            }
          : null,
        client: client
          ? {
              id: client.id,
              email: client.email || req.user.email,
              phone: client.phone || "",
              street: client.street || "",
              buildingNumber: client.buildingNumber || "",
              zip: client.zip || "",
              city: client.city || "",
              country: client.country || "",
              type: client.type || "",
            }
          : null,
        professional: {
          monthHours: Math.round(monthHours * 100) / 100,
          activeProjects: projects.filter((p) => p.status !== "Terminé").length,
          projects: projects.slice(0, 12).map((p) => ({
            id: p.id,
            title: p.title,
            status: p.status,
            progress: p.progress || 0,
          })),
        },
        security: {
          twoFactorEnabled: !!userRow?.totp_enabled,
          lastLoginAt: userRow?.last_login_at,
          lastLoginIp: userRow?.last_login_ip || "",
          lastLoginAgent: userRow?.last_login_agent || "",
          sessions,
        },
        preferences: prefs,
        documents: ownDocs.map((d) => ({
          id: d.id,
          name: d.name,
          documentType: d.documentType || "",
          category: d.category || "",
          description: d.description || "",
          mime: d.mime,
          size: d.size,
          createdAt: d.createdAt,
          expiresAt: d.expiresAt || "",
        })),
        activity,
        pendingDeactivation,
      });
    }),
  );

  r.post(
    "/profile",
    wrap(async (req, res) => {
      const p = req.body || {};
      const result = await transaction(db, async (c) => {
        const row = (
            await c.query("SELECT data,revision FROM app_state WHERE id=1 FOR UPDATE")
          ).rows[0],
          data = D.normalize(row.data);
        if (req.user.employee_id) {
          const e = data.employees.find((x) => D.same(x.id, req.user.employee_id));
          if (!e || e.deletedAt) D.fail("Fiche salarié introuvable.", 404);
          Object.assign(e, {
            phone: cleanText(p.phone, 40),
            street: cleanText(p.street),
            zip: cleanText(p.zip, 20),
            city: cleanText(p.city),
            country: cleanText(p.country, 100),
            emergencyName: cleanText(p.emergencyName),
            emergencyPhone: cleanText(p.emergencyPhone, 40),
          });
          if (Object.prototype.hasOwnProperty.call(p, "photo"))
            e.photo = validPhoto(p.photo);
        } else if (req.user.client_id) {
          const c = data.clients.find((x) => D.same(x.id, req.user.client_id));
          if (!c) D.fail("Fiche client introuvable.", 404);
          Object.assign(c, {
            phone: cleanText(p.phone, 40),
            street: cleanText(p.street),
            buildingNumber: cleanText(p.buildingNumber, 30),
            zip: cleanText(p.zip, 20),
            city: cleanText(p.city),
            country: cleanText(p.country, 100),
          });
        } else {
          D.fail("Ce compte n’a pas de fiche personnelle modifiable.", 403);
        }
        await c.query(
          `UPDATE app_state
           SET data=$1,revision=revision+1,updated_at=NOW(),updated_by=$2
           WHERE id=1`,
          [JSON.stringify(data), req.user.email],
        );
        await c.query(
          "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
          [req.user.email, "Profil personnel modifié", "{}"],
        );
        return { revision: row.revision + 1 };
      });
      res.json({ ok: true, revision: result.revision });
    }),
  );
  r.post(
    "/2fa/setup",
    wrap(async (req, res) => {
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
      const secret = generateTotpSecret();
      await db.query(
        "UPDATE users SET totp_secret=$1,totp_enabled=false WHERE id=$2",
        [secret, req.user.id],
      );
      res.json({
        secret,
        uri: otpauthUri(secret, req.user.email),
        issuer: "Sousa Group One",
      });
    }),
  );

  r.post(
    "/2fa/enable",
    wrap(async (req, res) => {
      const user = (
        await db.query("SELECT totp_secret FROM users WHERE id=$1", [req.user.id])
      ).rows[0];
      if (!user?.totp_secret) D.fail("Commencez la configuration 2FA.");
      if (!verifyTotp(user.totp_secret, req.body?.code))
        D.fail("Code de vérification invalide.", 403);
      await db.query(
        "UPDATE users SET totp_enabled=true WHERE id=$1",
        [req.user.id],
      );
      await db.query(
        "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
        [req.user.email, "Double authentification activée", "{}"],
      );
      res.json({ ok: true });
    }),
  );

  r.post(
    "/2fa/disable",
    wrap(async (req, res) => {
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
      if (user.totp_enabled && !verifyTotp(user.totp_secret, req.body?.code))
        D.fail("Code de sécurité invalide.", 403);
      await db.query(
        "UPDATE users SET totp_enabled=false,totp_secret=NULL WHERE id=$1",
        [req.user.id],
      );
      await db.query(
        "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
        [req.user.email, "Double authentification désactivée", "{}"],
      );
      res.json({ ok: true });
    }),
  );

  r.post(
    "/sessions/logout-others",
    wrap(async (req, res) => {
      const sid = req.authClaims?.sid || "";
      await db.query(
        `UPDATE user_sessions SET revoked_at=NOW()
         WHERE user_id=$1 AND revoked_at IS NULL AND id<>$2`,
        [req.user.id, sid],
      );
      res.json({ ok: true });
    }),
  );

  r.post(
    "/sessions/:id/revoke",
    wrap(async (req, res) => {
      const id = String(req.params.id || "");
      await db.query(
        `UPDATE user_sessions SET revoked_at=NOW()
         WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
        [id, req.user.id],
      );
      res.json({ ok: true, current: id === String(req.authClaims?.sid || "") });
    }),
  );

  r.get(
    "/export",
    wrap(async (req, res) => {
      const stateRow = (
          await db.query("SELECT data FROM app_state WHERE id=1")
        ).rows[0],
        data = D.normalize(stateRow?.data),
        view = D.viewState(data, req.user),
        prefs = await getPrefs(db, req.user.id),
        activity = (
          await db.query(
            "SELECT action,metadata,created_at FROM audit_logs WHERE user_email=$1 ORDER BY created_at DESC",
            [req.user.email],
          )
        ).rows;
      const payload = {
        exportedAt: new Date().toISOString(),
        account: {
          id: req.user.id,
          email: req.user.email,
          name: req.user.name,
          role: req.user.role,
          company: req.user.company,
        },
        preferences: prefs,
        employee: req.user.employee_id
          ? view.employees.find((e) => D.same(e.id, req.user.employee_id)) || null
          : null,
        client: req.user.client_id
          ? view.clients.find((c) => D.same(c.id, req.user.client_id)) || null
          : null,
        projects: view.projects,
        time: view.time,
        planning: view.planning,
        absences: view.absences,
        documents: view.documents,
        activity,
      };
      res
        .set({
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": 'attachment; filename="sousa-group-one-mes-donnees.json"',
        })
        .send(JSON.stringify(payload, null, 2));
    }),
  );

  r.post(
    "/deactivation-request",
    wrap(async (req, res) => {
      const existing = (
        await db.query(
          "SELECT id FROM account_deactivation_requests WHERE user_id=$1 AND status='pending' LIMIT 1",
          [req.user.id],
        )
      ).rows[0];
      if (existing) return res.json({ ok: true, id: existing.id });
      const reason = cleanText(req.body?.reason, 1000);
      const row = (
        await db.query(
          `INSERT INTO account_deactivation_requests(user_id,reason)
           VALUES($1,$2) RETURNING id`,
          [req.user.id, reason],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
        [
          req.user.email,
          "Demande de désactivation du compte",
          JSON.stringify({ requestId: row.id }),
        ],
      );
      res.json({ ok: true, id: row.id });
    }),
  );

  return r;
}

module.exports = { routes, DEFAULT_PREFS, mergePrefs };
