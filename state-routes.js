"use strict";
const express = require("express"),
  bcrypt = require("bcryptjs");
const { randomUUID } = require("node:crypto");
const { auth, profile } = require("./auth-middleware"),
  { wrap } = require("./auth-routes"),
  { mutate } = require("./db");
const D = require("./domain");
function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  r.get(
    ["/finance/:kind/:id.pdf", "/finance/:kind/:id.eml"],
    wrap(async (req, res) => {
      const { kind, id } = req.params;
      if (!["quotes", "invoices"].includes(kind))
        D.fail("Document introuvable.", 404);
      const row = (
        await db.query("SELECT data,revision FROM app_state WHERE id=1")
      ).rows[0];
      const state = D.viewState(row.data, req.user);
      const document = state[kind].find((r) => D.same(r.id, id));
      if (!document) D.fail("Document introuvable.", 404);
      const issuer =
        document.issuer || D.ref(state, "companies", document.company);
      const customer =
        document.customer || D.ref(state, "clients", document.clientId);
      const buffer = await require("./finance-pdf").renderPDF(
        document,
        kind,
        issuer,
        customer,
        req.query.qr === "1",
      );
      if (req.path.endsWith(".eml")) {
        if (!D.privileged(req.user, D.FIN) || document.status === "Brouillon")
          D.fail("Émettez le document avant de préparer son envoi.", 403);
        if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(customer.email || ""))
          D.fail("E-mail client invalide.");
        const boundary = "sousa-" + randomUUID();
        const subject = Buffer.from(
          `${kind === "quotes" ? "Devis" : "Facture"} ${document.id} — ${issuer.name}`,
        ).toString("base64");
        const body = Buffer.from(
          document.message ||
            "Bonjour,\n\nVous trouverez votre document en pièce jointe.\n\n" +
              issuer.name,
        ).toString("base64");
        const base64 = buffer
          .toString("base64")
          .match(/.{1,76}/g)
          .join("\r\n");
        const eml = [
          `To: ${customer.email}`,
          `Subject: =?UTF-8?B?${subject}?=`,
          "X-Unsent: 1",
          "MIME-Version: 1.0",
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          "",
          `--${boundary}`,
          'Content-Type: text/plain; charset="UTF-8"',
          "Content-Transfer-Encoding: base64",
          "",
          body,
          `--${boundary}`,
          "Content-Type: application/pdf",
          `Content-Disposition: attachment; filename="${encodeURIComponent(document.id)}.pdf"`,
          "Content-Transfer-Encoding: base64",
          "",
          base64,
          `--${boundary}--`,
          "",
        ].join("\r\n");
        return res
          .set({
            "Content-Type": "message/rfc822",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(document.id)}.eml"`,
          })
          .send(eml);
      }
      res
        .set({
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(document.id)}.pdf"`,
        })
        .send(buffer);
    }),
  );
  r.get(
    "/",
    wrap(async (req, res) => {
      const row = (
        await db.query("SELECT data,revision FROM app_state WHERE id=1")
      ).rows[0];
      const users = (
        await db.query(
          "SELECT id,email,name,role,company,employee_id,client_id,disabled FROM users",
        )
      ).rows;
      const employeePhotos = new Map(
        (row.data.employees || [])
          .filter((e) => !e.deletedAt)
          .map((e) => [String(e.id), e.photo || ""]),
      );
      const contactPhoto = (u) =>
        employeePhotos.get(String(u.employee_id)) || "";
      res.set("Cache-Control", "no-store").json({
        data: D.viewState(row.data, req.user),
        revision: row.revision,
        contacts: users
          .filter(
            (u) =>
              !D.same(u.id, req.user.id) && D.canContact(req.user, u, row.data),
          )
          .map((u) => ({
            id: u.id,
            name: u.name,
            role: u.role,
            photo: contactPhoto(u),
          })),
        profile: { ...profile(req.user), photo: contactPhoto(req.user) },
      });
    }),
  );
  r.post("/", (req, res) =>
    res.status(405).json({
      error:
        "La sauvegarde complète est désactivée. Utilisez une opération métier.",
    }),
  );
  r.post(
    "/command",
    wrap(async (req, res) =>
      res.json(
        await mutate(db, req.user, req.body, async (c, d) => {
          const { data, result } = D.applyCommand(d, req.user, req.body);
          if (req.body.action === "employee.delete") {
            if (D.same(req.user.employee_id, result.id))
              D.fail("Vous ne pouvez pas supprimer votre propre fiche.");
            const protectedAccounts = await c.query(
              "SELECT id FROM users WHERE employee_id=$1 AND role='admin' AND disabled=false",
              [String(result.id)],
            );
            if (protectedAccounts.rows.length)
              D.fail("Retirez d’abord le rôle administrateur du compte lié.");
            await c.query(
              "UPDATE users SET disabled=true,session_version=session_version+1 WHERE employee_id=$1",
              [String(result.id)],
            );
          }
          Object.assign(d, data);
          return result;
        }),
      ),
    ),
  );
  r.get(
    "/audit",
    wrap(async (req, res) => {
      if (!D.privileged(req.user, [...D.HR])) D.fail("Accès refusé.", 403);
      const rows = (
        await db.query(
          "SELECT user_email,action,metadata,created_at FROM audit_logs ORDER BY id DESC LIMIT 500",
        )
      ).rows;
      res.json({
        rows: rows.filter((x) => D.inCompany(req.user, x.metadata?.company)),
      });
    }),
  );
  r.get(
    "/users",
    wrap(async (req, res) => {
      if (req.user.role !== "admin" || req.user.company !== "group")
        D.fail("Accès administrateur groupe requis.", 403);
      res.json({
        users: (
          await db.query(
            "SELECT id,email,name,role,company,employee_id,client_id,disabled FROM users WHERE deleted_at IS NULL ORDER BY id",
          )
        ).rows,
      });
    }),
  );
  r.post(
    "/users",
    wrap(async (req, res) => {
      if (req.user.role !== "admin" || req.user.company !== "group")
        D.fail("Accès administrateur groupe requis.", 403);
      res.json(
        await mutate(
          db,
          req.user,
          { ...req.body, action: "Compte créé" },
          async (c, d) => {
            const p = req.body.payload || {},
              role = p.role;
            if (!D.ROLES.includes(role)) D.fail("Rôle invalide.");
            const email = D.text(p.email, "E-mail", 255).toLowerCase(),
              password = D.text(p.password, "Mot de passe", 200, Boolean(p.id));
            if (
              ((!p.id || password) && password.length < 12) ||
              !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
            )
              D.fail(
                "E-mail invalide ou mot de passe de moins de 12 caractères.",
              );
            const company = D.ref(d, "companies", p.company).id;
            let employee = p.employeeId
                ? D.ref(d, "employees", p.employeeId)
                : null,
              client = p.clientId ? D.ref(d, "clients", p.clientId) : null;
            if (p.newEmployee) {
              if (
                p.isEmployee !== "yes" ||
                employee ||
                role === "client" ||
                company === "group"
              )
                D.fail(
                  "Choisissez une entreprise et un compte salarié sans fiche existante.",
                );
              if (
                d.employees.some(
                  (e) =>
                    !e.deletedAt && String(e.email).toLowerCase() === email,
                )
              )
                D.fail(
                  "Une fiche salarié utilise déjà cet e-mail. Sélectionnez la fiche existante.",
                );
              employee = D.applyCommand(d, req.user, {
                action: "create",
                collection: "employees",
                payload: { ...p.newEmployee, name: p.name, email, company },
              }).result;
            }
            if (p.employeeCompanies !== undefined) {
              if (!employee || !Array.isArray(p.employeeCompanies))
                D.fail("Entreprises du salarié invalides.");
              D.applyCommand(d, req.user, {
                action: "employee.companies",
                payload: { id: employee.id, companies: p.employeeCompanies },
              });
            }
            if (p.newClient) {
              if (
                role !== "client" ||
                client ||
                employee ||
                p.isEmployee === "yes" ||
                company === "group"
              )
                D.fail(
                  "Choisissez une entreprise et un compte client sans fiche existante.",
                );
              if (
                d.clients.some(
                  (x) =>
                    x.company === company &&
                    String(x.email).toLowerCase() === email,
                )
              )
                D.fail(
                  "Une fiche client utilise déjà cet e-mail. Sélectionnez la fiche existante.",
                );
              client = D.applyCommand(d, req.user, {
                action: "create",
                collection: "clients",
                payload: { ...p.newClient, name: p.name, email, company },
              }).result;
            }
            if (
              p.isEmployee !== undefined &&
              !["yes", "no"].includes(p.isEmployee)
            )
              D.fail("Type de compte invalide.");
            if (
              (p.isEmployee === "yes" && !employee) ||
              (p.isEmployee === "no" && employee)
            )
              D.fail("Le choix salarié doit correspondre à la fiche liée.");
            if (employee?.deletedAt) D.fail("Ce salarié a été supprimé.");
            if (
              (role === "employee" && !employee) ||
              (role === "client" && !client)
            )
              D.fail("Liez le compte à sa fiche salarié ou client.");
            if (
              (employee && !D.employeeInCompany(employee, company)) ||
              (client && client.company && client.company !== company)
            )
              D.fail("Entreprise incompatible.");
            if (
              (role === "client" && employee) ||
              (role !== "client" && client)
            )
              D.fail("Lien de compte incompatible.");
            if (
              employee &&
              (
                await c.query(
                  "SELECT id FROM users WHERE employee_id=$1 AND id<>$2 AND deleted_at IS NULL",
                  [String(employee.id), p.id || 0],
                )
              ).rows.length
            )
              D.fail("Ce salarié a déjà un compte.");
            if (
              client &&
              (
                await c.query(
                  "SELECT id FROM users WHERE client_id=$1 AND id<>$2 AND deleted_at IS NULL",
                  [String(client.id), p.id || 0],
                )
              ).rows.length
            )
              D.fail("Ce client a déjà un compte.");
            if (p.id) {
              const target = (
                await c.query(
                  "SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL",
                  [p.id],
                )
              ).rows[0];
              if (!target) D.fail("Compte introuvable.", 404);
              if (
                D.same(p.id, req.user.id) &&
                (role !== "admin" || company !== "group")
              )
                D.fail("Vous ne pouvez pas retirer vos propres droits.");
              await c.query(
                "UPDATE users SET email=$1,password_hash=COALESCE($2,password_hash),role=$3,name=$4,company=$5,employee_id=$6,client_id=$7,disabled=false,session_version=session_version+1 WHERE id=$8",
                [
                  email,
                  password ? await bcrypt.hash(password, 12) : null,
                  role,
                  D.text(p.name, "Nom", 160),
                  company,
                  employee ? String(employee.id) : null,
                  client ? String(client.id) : null,
                  p.id,
                ],
              );
              return {
                id: p.id,
                employeeId: employee?.id || null,
                clientId: client?.id || null,
              };
            }
            // Release an old address only for an explicit new-account request.
            // Keeping it on deletion prevents bootstrap from recreating a deleted admin.
            await c.query(
              "UPDATE users SET email='deleted-' || id || '@removed.invalid' WHERE email=$1 AND deleted_at IS NOT NULL",
              [email],
            );
            const out = await c.query(
              "INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
              [
                email,
                await bcrypt.hash(password, 12),
                role,
                D.text(p.name, "Nom", 160),
                "",
                company,
                employee ? String(employee.id) : null,
                client ? String(client.id) : null,
              ],
            );
            return {
              id: out.rows[0].id,
              employeeId: employee?.id || null,
              clientId: client?.id || null,
            };
          },
        ),
      );
    }),
  );
  r.post(
    "/users/delete",
    wrap(async (req, res) => {
      if (req.user.role !== "admin" || req.user.company !== "group")
        D.fail("Accès refusé.", 403);
      res.json(
        await mutate(
          db,
          req.user,
          { ...req.body, action: "Compte supprimé" },
          async (c) => {
            const id = req.body.payload?.id;
            if (D.same(id, req.user.id))
              D.fail("Vous ne pouvez pas supprimer votre propre compte.");
            const target = (
              await c.query(
                "SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL",
                [id],
              )
            ).rows[0];
            if (!target) D.fail("Compte introuvable.", 404);
            await c.query(
              "UPDATE users SET deleted_at=NOW(),disabled=true,session_version=session_version+1,employee_id=NULL,client_id=NULL WHERE id=$1",
              [id],
            );
            return { id: target.id };
          },
        ),
      );
    }),
  );
  r.post(
    "/users/disable",
    wrap(async (req, res) => {
      if (req.user.role !== "admin" || req.user.company !== "group")
        D.fail("Accès refusé.", 403);
      res.json(
        await mutate(
          db,
          req.user,
          { ...req.body, action: "Compte désactivé" },
          async (c) => {
            if (D.same(req.body.payload?.id, req.user.id))
              D.fail("Vous ne pouvez pas désactiver votre propre compte.");
            await c.query(
              "UPDATE users SET disabled=true,session_version=session_version+1 WHERE id=$1",
              [req.body.payload.id],
            );
            return { id: req.body.payload.id };
          },
        ),
      );
    }),
  );
  r.post(
    "/users/password",
    wrap(async (req, res) => {
      if (req.user.role !== "admin" || req.user.company !== "group")
        D.fail("Accès refusé.", 403);
      res.json(
        await mutate(
          db,
          req.user,
          { ...req.body, action: "Mot de passe réinitialisé" },
          async (c) => {
            const p = D.text(req.body.payload?.password, "Mot de passe", 200);
            if (p.length < 12) D.fail("12 caractères minimum.");
            const target = (
              await c.query(
                "SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL",
                [req.body.payload.id],
              )
            ).rows[0];
            if (!target) D.fail("Compte introuvable.", 404);
            await c.query(
              "UPDATE users SET password_hash=$1,disabled=false,session_version=session_version+1 WHERE id=$2 AND deleted_at IS NULL",
              [await bcrypt.hash(p, 12), req.body.payload.id],
            );
            return { id: req.body.payload.id };
          },
        ),
      );
    }),
  );
  r.post(
    "/messages",
    wrap(async (req, res) =>
      res.json(
        await mutate(
          db,
          req.user,
          { ...req.body, action: "Message envoyé" },
          async (c, d) => {
            const p = req.body.payload || {},
              recipient = (
                await c.query("SELECT * FROM users WHERE id=$1", [
                  p.recipientId,
                ])
              ).rows[0];
            if (!recipient || !D.canContact(req.user, recipient, d))
              D.fail("Destinataire non autorisé.", 403);
            const msg = {
              id: randomUUID(),
              senderId: req.user.id,
              recipientId: recipient.id,
              sender: req.user.name,
              text: D.text(p.text, "Message", 5000),
              createdAt: new Date().toISOString(),
            };
            d.messages.push(msg);
            return { id: msg.id };
          },
        ),
      ),
    ),
  );
  r.post(
    "/documents",
    wrap(async (req, res) =>
      res.json(
        await mutate(
          db,
          req.user,
          { ...req.body, action: "Document ajouté" },
          async (c, d) => {
            const p = req.body.payload || {};
            if (req.user.role === "client")
              D.fail("Dépôt réservé à l’équipe.", 403);
            const company = D.ref(d, "companies", p.company).id;
            if (!D.inCompany(req.user, company)) D.fail("Accès refusé.", 403);
            const m = {
              id: randomUUID(),
              name: D.text(p.name, "Nom du fichier", 200),
              company,
              project: p.project || "",
              employeeId: p.employeeId || "",
              clientId: p.clientId || "",
              createdAt: new Date().toISOString(),
              uploadedBy: req.user.id,
              visibility: p.visibility === "client" ? "client" : "team",
            };
            if (p.category === "identity") {
              if (
                !m.employeeId ||
                m.project ||
                m.clientId ||
                p.visibility === "client"
              )
                D.fail(
                  "Les pièces d’identité doivent être liées uniquement à un salarié.",
                );
              if (
                ![
                  "Carte d’identité",
                  "Passeport",
                  "Permis de conduire",
                  "Permis de séjour",
                  "Autre justificatif",
                ].includes(p.documentType)
              )
                D.fail("Type de justificatif invalide.");
              m.category = "identity";
              m.documentType = p.documentType;
              m.description = D.text(p.description, "Description", 200, true);
              m.visibility = "hr";
            }
            if (m.visibility === "client" && !D.privileged(req.user, D.OPS))
              D.fail(
                "Seuls les responsables peuvent partager avec le client.",
                403,
              );
            if (m.visibility === "client" && m.employeeId)
              D.fail(
                "Un document salarié ne peut pas être partagé aux clients.",
              );
            if (
              [m.project, m.employeeId, m.clientId].filter(Boolean).length !== 1
            )
              D.fail("Choisissez un chantier, un salarié ou un client.");
            const target = m.project
              ? D.ref(d, "projects", m.project)
              : m.employeeId
                ? D.ref(d, "employees", m.employeeId)
                : D.ref(d, "clients", m.clientId);
            if (target.company !== company || !D.canDocument(d, req.user, m))
              D.fail("Dossier non autorisé.", 403);
            const mime = D.text(p.mime, "Type de fichier", 100);
            if (
              ![
                "application/pdf",
                "image/jpeg",
                "image/png",
                "image/webp",
                "text/plain",
              ].includes(mime)
            )
              D.fail("Formats acceptés : PDF, JPEG, PNG, WebP, TXT.");
            if (
              typeof p.content !== "string" ||
              !/^[A-Za-z0-9+/]*={0,2}$/.test(p.content)
            )
              D.fail("Fichier invalide.");
            const bytes = Buffer.from(p.content, "base64");
            if (!bytes.length || bytes.length > 5 * 1024 * 1024)
              D.fail("Fichier vide ou supérieur à 5 Mo.");
            if (m.category === "identity") {
              const valid =
                mime === "application/pdf"
                  ? bytes.subarray(0, 5).toString() === "%PDF-"
                  : mime === "image/jpeg"
                    ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
                    : mime === "image/png"
                      ? bytes
                          .subarray(0, 8)
                          .equals(
                            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
                          )
                      : mime === "image/webp"
                        ? bytes.subarray(0, 4).toString() === "RIFF" &&
                          bytes.subarray(8, 12).toString() === "WEBP"
                        : false;
              if (!valid)
                D.fail("Choisissez une photo JPG, PNG, WebP ou un PDF valide.");
            }
            m.mime = mime;
            m.size = bytes.length;
            await c.query(
              "INSERT INTO file_contents(id,content) VALUES($1,$2)",
              [m.id, bytes],
            );
            d.documents.push(m);
            return { id: m.id };
          },
        ),
      ),
    ),
  );
  r.get(
    "/documents/:id",
    wrap(async (req, res) => {
      const row = (await db.query("SELECT data FROM app_state WHERE id=1"))
        .rows[0];
      const d = D.normalize(row.data),
        m = D.ref(d, "documents", req.params.id);
      if (!D.canDocument(d, req.user, m)) D.fail("Accès refusé.", 403);
      const file = (
        await db.query("SELECT content FROM file_contents WHERE id=$1", [m.id])
      ).rows[0];
      if (!file) D.fail("Fichier introuvable.", 404);
      res
        .set({
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(m.name)}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .send(Buffer.from(file.content));
    }),
  );
  return r;
}
module.exports = { routes };
