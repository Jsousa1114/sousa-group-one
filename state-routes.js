"use strict";
const express = require("express"),
  bcrypt = require("bcryptjs");
const { randomUUID } = require("node:crypto");
const { auth, profile } = require("./auth-middleware"),
  { wrap } = require("./auth-routes"),
  { mutate } = require("./db");
const D = require("./domain");
const { notifyUsers } = require("./messaging-routes");
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
      const view = D.viewState(row.data, req.user);
      if (view.messages.length) {
        const ids = view.messages.map((m) => String(m.id)),
          [readsResult, overridesResult] = await Promise.all([
            db.query(
              "SELECT message_id,user_id FROM message_reads WHERE message_id = ANY($1::text[])",
              [ids],
            ),
            db.query(
              "SELECT message_id,edited_text,edited_at,deleted_for_all,deleted_at FROM message_overrides WHERE message_id = ANY($1::text[])",
              [ids],
            ),
          ]),
          reads = readsResult.rows,
          overrides = new Map(
            overridesResult.rows.map((x) => [String(x.message_id), x]),
          ),
          byMessage = new Map();
        for (const read of reads) {
          const key = String(read.message_id);
          if (!byMessage.has(key)) byMessage.set(key, []);
          byMessage.get(key).push(String(read.user_id));
        }
        for (const message of view.messages) {
          message.readBy = [
            ...new Set([
              ...(message.readBy || []).map(String),
              ...(byMessage.get(String(message.id)) || []),
            ]),
          ];
          const override = overrides.get(String(message.id));
          if (override?.edited_at && !override.deleted_for_all) {
            message.text = override.edited_text || "";
            message.editedAt = override.edited_at;
          }
          if (override?.deleted_for_all) {
            message.text = "";
            message.attachment = null;
            message.sharedRef = null;
            message.encryption = null;
            message.deletedForAll = true;
            message.deletedAt = override.deleted_at;
          }
        }
      }
      res.set("Cache-Control", "no-store").json({
        data: view,
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
  async function ensureProjectThread(c, d, project, actor) {
    if (!project) return null;
    const team = (project.team || []).map(String),
      users = (
        await c.query(
          `SELECT id,employee_id,client_id FROM users
           WHERE deleted_at IS NULL AND disabled=false
             AND (
               ($1::text[] <> '{}'::text[] AND employee_id=ANY($1::text[]))
               OR client_id=$2
               OR id=$3
             )`,
          [team, String(project.clientId || ""), actor.id],
        )
      ).rows,
      participantIds = [
        ...new Set(users.map((u) => String(u.id))),
      ];
    if (!participantIds.some((id) => D.same(id, actor.id)))
      participantIds.push(String(actor.id));
    let thread = d.messageThreads.find(
      (t) => t.type === "project" && D.same(t.projectId, project.id),
    );
    if (!thread) {
      thread = {
        id: randomUUID(),
        type: "project",
        name: project.title || "Discussion chantier",
        participants: participantIds,
        projectId: String(project.id),
        createdBy: actor.id,
        createdAt: new Date().toISOString(),
      };
      d.messageThreads.push(thread);
    } else {
      thread.name = project.title || thread.name;
      thread.participants = participantIds;
    }
    return thread;
  }
  async function addProjectSystemMessage(c, d, project, actor, text) {
    if (!project || !text) return null;
    const thread = await ensureProjectThread(c, d, project, actor);
    if (!thread) return null;
    const message = {
      id: randomUUID(),
      senderId: actor.id,
      recipientId: null,
      threadId: thread.id,
      sender: "Sousa Group One",
      text,
      system: true,
      readBy: [String(actor.id)],
      createdAt: new Date().toISOString(),
    };
    d.messages.push(message);
    return {
      messageId: message.id,
      threadId: thread.id,
      participants: (thread.participants || [])
        .map(Number)
        .filter((id) => !D.same(id, actor.id)),
      projectTitle: project.title || project.id,
    };
  }
  function commandProjectAndText(d, action, result, payload) {
    let project = null,
      text = "";
    if (action === "create" && reqSafeCollection(payload) === "projects") {
      project = d.projects.find((p) => D.same(p.id, result?.id));
      text = project ? "🏗 Chantier créé : " + project.title : "";
    } else if (action === "project.update") {
      project = d.projects.find((p) => D.same(p.id, result?.id));
      text = project
        ? "📌 Chantier mis à jour · " +
          project.status +
          " · " +
          Number(project.progress || 0) +
          " %"
        : "";
    } else if (action === "project.finish") {
      project = d.projects.find((p) => D.same(p.id, result?.id || payload?.id));
      text = project
        ? "✅ Chantier terminé · brouillon de facturation préparé"
        : "";
    } else if (action === "quote.project") {
      project = d.projects.find((p) => D.same(p.id, result?.id));
      text = project ? "🏗 Chantier créé depuis un devis accepté" : "";
    } else if (
      ["quote.accept", "quote.decide", "quote.issue", "quote.convert"].includes(action)
    ) {
      const doc =
        d.quotes.find((q) => D.same(q.id, result?.id)) ||
        d.invoices.find((i) => D.same(i.id, result?.id));
      project = doc?.project
        ? d.projects.find((p) => D.same(p.id, doc.project))
        : null;
      text =
        action === "quote.accept" ||
        (action === "quote.decide" && result?.status === "Accepté")
          ? "✅ Devis accepté : " + (doc?.id || "")
          : action === "quote.issue"
            ? "📄 Devis émis : " + (doc?.id || "")
            : action === "quote.convert"
              ? "🧾 Facture créée depuis le devis"
              : "";
    } else if (action === "invoice.issue") {
      const invoice = d.invoices.find((i) => D.same(i.id, result?.id));
      project = invoice?.project
        ? d.projects.find((p) => D.same(p.id, invoice.project))
        : null;
      text = invoice ? "🧾 Facture émise : " + invoice.id : "";
    } else if (
      action === "create" &&
      reqSafeCollection(payload) === "planning"
    ) {
      project = d.projects.find((p) => D.same(p.id, result?.project));
      const employee = d.employees.find((e) => D.same(e.id, result?.employeeId));
      text = project
        ? "📅 Planning · " +
          (employee?.name || "Salarié") +
          " · " +
          (result?.date || "")
        : "";
    }
    return { project, text };
  }
  function reqSafeCollection(payload) {
    return payload?.__collection || "";
  }
  r.post(
    "/command",
    wrap(async (req, res) => {
      let systemPush = null;
      const bodyForSystem = {
        ...(req.body || {}),
        payload: {
          ...(req.body?.payload || {}),
          __collection: req.body?.collection || "",
        },
      };
      const out = await mutate(db, req.user, req.body, async (c, d) => {
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
        if (req.body.action === "client.delete") {
          const accounts = await c.query(
            "SELECT id FROM users WHERE client_id=$1 AND deleted_at IS NULL",
            [String(result.id)],
          );
          if (accounts.rows.length)
            D.fail(
              "Ce client possède un compte de connexion lié. Supprimez ou dissociez ce compte avant de supprimer le client.",
            );
        }
        if (req.body.action === "record.delete") {
          if (req.body.payload?.kind === "companies") {
            const accounts = await c.query(
              "SELECT id FROM users WHERE company=$1 AND deleted_at IS NULL",
              [String(result.id)],
            );
            if (accounts.rows.length)
              D.fail("Cette entreprise possède encore des comptes liés.");
          }
          if (req.body.payload?.kind === "documents")
            await c.query("DELETE FROM file_contents WHERE id=$1", [
              String(result.id),
            ]);
        }
        Object.assign(d, data);
        const event = commandProjectAndText(
          d,
          req.body.action,
          result,
          bodyForSystem.payload,
        );
        if (event.project && event.text)
          systemPush = await addProjectSystemMessage(
            c,
            d,
            event.project,
            req.user,
            event.text,
          );
        else if (
          req.body.action === "project.update" ||
          (req.body.action === "create" && req.body.collection === "projects")
        ) {
          const project =
            d.projects.find((p) => D.same(p.id, result?.id)) || null;
          if (project) await ensureProjectThread(c, d, project, req.user);
        }
        return result;
      });
      if (systemPush?.participants?.length)
        await notifyUsers(db, systemPush.participants, {
          title: systemPush.projectTitle,
          body: "Nouvelle activité sur le chantier",
          url:
            "/?open=messages&conversation=" +
            encodeURIComponent("thread:" + systemPush.threadId),
          tag: "project-" + systemPush.messageId,
          conversationKey: "thread:" + systemPush.threadId,
        }).catch(() => {});
      res.json(out);
    }),
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
  r.get(
    "/messages/:id/attachment",
    wrap(async (req, res) => {
      const row = (
        await db.query("SELECT data FROM app_state WHERE id=1")
      ).rows[0];
      const visible = D.viewState(row.data, req.user),
        msg = visible.messages.find((m) => D.same(m.id, req.params.id));
      if (!msg?.attachment?.fileId) D.fail("Pièce jointe introuvable.", 404);
      const file = (
        await db.query("SELECT content FROM file_contents WHERE id=$1", [
          msg.attachment.fileId,
        ])
      ).rows[0];
      if (!file) D.fail("Pièce jointe introuvable.", 404);
      res
        .set({
          "Content-Type": msg.attachment.mime || "application/octet-stream",
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(
            msg.attachment.name || "fichier",
          )}`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .send(Buffer.from(file.content));
    }),
  );
  r.post(
    "/message-threads",
    wrap(async (req, res) =>
      res.json(
        await mutate(
          db,
          req.user,
          { ...req.body, action: "Conversation créée" },
          async (c, d) => {
            const p = req.body.payload || {},
              type = p.type === "project" ? "project" : "group",
              participants = [
                ...new Set(
                  [req.user.id, ...(Array.isArray(p.participants) ? p.participants : [])].map(
                    String,
                  ),
                ),
              ];
            if (participants.length < 2)
              D.fail("Ajoutez au moins un participant.");
            if (participants.length > 50)
              D.fail("50 participants maximum.");
            const rows = (
              await c.query(
                "SELECT * FROM users WHERE id = ANY($1::int[]) AND deleted_at IS NULL AND disabled=false",
                [participants.map(Number)],
              )
            ).rows;
            if (rows.length !== participants.length)
              D.fail("Un participant est introuvable ou désactivé.");
            for (const user of rows) {
              if (D.same(user.id, req.user.id)) continue;
              if (!D.canContact(req.user, user, d))
                D.fail("Participant non autorisé : " + user.name, 403);
            }
            let projectId = "";
            if (type === "project") {
              const project = D.ref(d, "projects", p.projectId);
              if (!D.canProject(d, req.user, project))
                D.fail("Accès chantier refusé.", 403);
              for (const user of rows) {
                if (D.same(user.id, req.user.id)) continue;
                const effective = D.effectiveUser(d, user);
                if (!D.canProject(d, effective, project))
                  D.fail(
                    "Un participant sélectionné n’a pas accès à ce chantier : " +
                      user.name,
                    403,
                  );
              }
              projectId = String(project.id);
            }
            const thread = {
              id: randomUUID(),
              type,
              name: D.text(
                p.name ||
                  (type === "project"
                    ? D.ref(d, "projects", projectId).title
                    : "Nouveau groupe"),
                "Nom de la conversation",
                120,
              ),
              participants,
              projectId,
              createdBy: req.user.id,
              createdAt: new Date().toISOString(),
            };
            d.messageThreads.push(thread);
            return { id: thread.id };
          },
        ),
      ),
    ),
  );
  r.post(
    "/messages/read",
    wrap(async (req, res) => {
      const p = req.body?.payload || {},
        row = (
          await db.query("SELECT data,revision FROM app_state WHERE id=1")
        ).rows[0],
        visible = D.viewState(row.data, req.user);
      let messages = [];
      if (p.threadId) {
        const thread = visible.messageThreads.find((t) =>
          D.same(t.id, p.threadId),
        );
        if (!thread) D.fail("Conversation non autorisée.", 403);
        messages = visible.messages.filter(
          (m) =>
            D.same(m.threadId, p.threadId) &&
            !D.same(m.senderId, req.user.id),
        );
      } else if (p.recipientId) {
        messages = visible.messages.filter(
          (m) =>
            !m.threadId &&
            D.same(m.senderId, p.recipientId) &&
            D.same(m.recipientId, req.user.id),
        );
      } else D.fail("Conversation requise.");
      let changed = 0;
      for (const message of messages) {
        const inserted = await db.query(
          "INSERT INTO message_reads(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING message_id",
          [String(message.id), req.user.id],
        );
        if (inserted.rows.length) changed++;
      }
      res.json({ result: { changed }, revision: row.revision });
    }),
  );
  r.post(
    "/messages",
    wrap(async (req, res) => {
      let notificationTargets = [],
        notificationConversation = "",
        notificationPreview = "Nouveau message";
      const out = await mutate(
        db,
        req.user,
        { ...req.body, action: "Message envoyé" },
        async (c, d) => {
          const p = req.body.payload || {},
            text = D.text(p.text, "Message", 5000, true);
          let recipient = null,
            thread = null,
            participants = [];
          if (p.threadId) {
            thread = d.messageThreads.find((t) => D.same(t.id, p.threadId));
            if (
              !thread ||
              !(thread.participants || []).some((id) =>
                D.same(id, req.user.id),
              )
            )
              D.fail("Conversation non autorisée.", 403);
            participants = (
              await c.query(
                "SELECT * FROM users WHERE id=ANY($1::int[]) AND deleted_at IS NULL AND disabled=false",
                [(thread.participants || []).map(Number)],
              )
            ).rows;
            notificationTargets = participants
              .filter((u) => !D.same(u.id, req.user.id))
              .map((u) => Number(u.id));
            notificationConversation = "thread:" + thread.id;
          } else {
            recipient = (
              await c.query(
                "SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL AND disabled=false",
                [p.recipientId],
              )
            ).rows[0];
            if (!recipient || !D.canContact(req.user, recipient, d))
              D.fail("Destinataire non autorisé.", 403);
            participants = [req.user, recipient];
            notificationTargets = [Number(recipient.id)];
            notificationConversation = "direct:" + recipient.id;
          }

          let replyToId = "";
          if (p.replyToId) {
            const replied = d.messages.find((m) => D.same(m.id, p.replyToId));
            if (!replied) D.fail("Message cité introuvable.");
            const visibleReply = D.viewState(d, req.user).messages.some((m) =>
              D.same(m.id, replied.id),
            );
            if (!visibleReply) D.fail("Message cité non autorisé.", 403);
            const sameConversation = thread
              ? D.same(replied.threadId, thread.id)
              : !replied.threadId &&
                ((D.same(replied.senderId, req.user.id) &&
                  D.same(replied.recipientId, recipient.id)) ||
                  (D.same(replied.senderId, recipient.id) &&
                    D.same(replied.recipientId, req.user.id)));
            if (!sameConversation)
              D.fail("Le message cité appartient à une autre conversation.", 403);
            replyToId = replied.id;
          }

          let forwardedFromId = "";
          if (p.forwardedFromId) {
            const source = D.viewState(d, req.user).messages.find((m) =>
              D.same(m.id, p.forwardedFromId),
            );
            if (!source) D.fail("Message à transférer introuvable.", 404);
            forwardedFromId = source.id;
          }

          let sharedRef = null;
          if (p.sharedRef) {
            const kind = String(p.sharedRef.kind || ""),
              id = String(p.sharedRef.id || "");
            if (!["quotes", "invoices", "documents"].includes(kind) || !id)
              D.fail("Élément partagé invalide.");
            const senderView = D.viewState(d, req.user);
            if (!senderView[kind]?.some((x) => D.same(x.id, id)))
              D.fail("Vous n’avez pas accès à cet élément.", 403);
            for (const user of participants) {
              const effective = D.effectiveUser(d, user),
                view = D.viewState(d, effective);
              if (!view[kind]?.some((x) => D.same(x.id, id)))
                D.fail(
                  "Un destinataire n’a pas accès à l’élément partagé.",
                  403,
                );
            }
            const target = d[kind].find((x) => D.same(x.id, id));
            sharedRef = {
              kind,
              id,
              title:
                target?.title ||
                target?.name ||
                target?.number ||
                id,
            };
          }

          let encryption = null;
          if (p.encryption) {
            const e = p.encryption;
            if (
              e.algorithm !== "SGO-E2EE-P256-AESGCM-v1" ||
              typeof e.iv !== "string" ||
              typeof e.ciphertext !== "string" ||
              !e.envelopes ||
              typeof e.envelopes !== "object" ||
              e.ciphertext.length > 15000
            )
              D.fail("Message chiffré invalide.");
            const expected = new Set(
              participants.map((u) => String(u.id)),
            );
            for (const id of expected) {
              const envelope = e.envelopes[id];
              if (
                !envelope ||
                typeof envelope.iv !== "string" ||
                typeof envelope.ciphertext !== "string" ||
                envelope.ciphertext.length > 2000
              )
                D.fail("Clé de chiffrement manquante pour un participant.");
            }
            encryption = {
              algorithm: e.algorithm,
              iv: e.iv.slice(0, 100),
              ciphertext: e.ciphertext,
              envelopes: e.envelopes,
              senderId: String(req.user.id),
            };
          }

          let attachment = null;
          if (p.attachment) {
            const raw = p.attachment,
              name = D.text(raw.name, "Nom du fichier", 200),
              requestedMime = D.text(raw.mime, "Type de fichier", 120),
              encryptedAttachment = !!(encryption && raw.encrypted),
              mime = encryptedAttachment
                ? "application/octet-stream"
                : requestedMime,
              allowed =
                encryptedAttachment ||
                /^image\/(jpeg|png|webp|gif)$/.test(mime) ||
                /^audio\/(webm|ogg|mpeg|mp4|wav|x-m4a)$/.test(mime) ||
                mime === "application/pdf" ||
                mime === "text/plain";
            if (!allowed) D.fail("Type de pièce jointe non autorisé.");
            if (
              typeof raw.content !== "string" ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.content)
            )
              D.fail("Pièce jointe invalide.");
            const content = Buffer.from(raw.content, "base64");
            if (!content.length || content.length > 5 * 1024 * 1024)
              D.fail("Pièce jointe de 5 Mo maximum.");
            const fileId = randomUUID();
            await c.query(
              "INSERT INTO file_contents(id,content) VALUES($1,$2)",
              [fileId, content],
            );
            attachment = {
              fileId,
              name,
              mime,
              originalMime: encryptedAttachment ? requestedMime : "",
              size: content.length,
              encrypted: encryptedAttachment,
              kind: requestedMime.startsWith("image/")
                ? "image"
                : requestedMime.startsWith("audio/")
                  ? "audio"
                  : "file",
            };
          }
          if (!text && !attachment && !sharedRef && !encryption)
            D.fail("Écrivez un message ou ajoutez une pièce jointe.");

          const msg = {
            id: randomUUID(),
            senderId: req.user.id,
            recipientId: recipient?.id || null,
            threadId: thread?.id || "",
            sender: req.user.name,
            text: encryption ? "" : text,
            replyToId,
            forwardedFromId,
            sharedRef,
            encryption,
            attachment,
            readBy: [String(req.user.id)],
            createdAt: new Date().toISOString(),
          };
          d.messages.push(msg);
          notificationPreview = encryption
            ? "🔐 Nouveau message chiffré"
            : sharedRef
              ? "📄 " + sharedRef.title
              : attachment
                ? attachment.kind === "image"
                  ? "📷 Photo"
                  : attachment.kind === "audio"
                    ? "🎤 Message vocal"
                    : "📎 " + attachment.name
                : text.slice(0, 140);
          return { id: msg.id };
        },
      );
      await notifyUsers(db, notificationTargets, {
        title: req.user.name,
        body: notificationPreview || "Nouveau message",
        url:
          "/?open=messages&conversation=" +
          encodeURIComponent(notificationConversation),
        tag: "message-" + out.result.id,
        conversationKey: notificationConversation,
      }).catch(() => {});
      res.json(out);
    }),
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
  async function expireCalls(c) {
    await c.query(
      "UPDATE rtc_calls SET status='missed',ended_at=NOW(),updated_at=NOW() WHERE status='ringing' AND created_at < NOW() - INTERVAL '90 seconds'",
    );
    await c.query(
      "UPDATE rtc_calls SET status='ended',ended_at=NOW(),updated_at=NOW() WHERE status='accepted' AND updated_at < NOW() - INTERVAL '6 hours'",
    );
    await c.query(
      "DELETE FROM rtc_ice_candidates WHERE created_at < NOW() - INTERVAL '24 hours'",
    );
  }
  async function callRow(c, id, userId) {
    const row = (
      await c.query(
        "SELECT * FROM rtc_calls WHERE id=$1 AND (caller_id=$2 OR callee_id=$2)",
        [id, userId],
      )
    ).rows[0];
    if (!row) D.fail("Appel introuvable.", 404);
    return row;
  }
  r.get(
    "/calls/config",
    wrap(async (req, res) => {
      const iceServers = [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      ];
      const turnUrls = String(process.env.RTC_TURN_URLS || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (
        turnUrls.length &&
        process.env.RTC_TURN_USERNAME &&
        process.env.RTC_TURN_CREDENTIAL
      )
        iceServers.push({
          urls: turnUrls,
          username: process.env.RTC_TURN_USERNAME,
          credential: process.env.RTC_TURN_CREDENTIAL,
        });
      res.set("Cache-Control", "no-store").json({ iceServers });
    }),
  );
  r.get(
    "/calls/pending",
    wrap(async (req, res) => {
      await expireCalls(db);
      const active = (
        await db.query(
          "SELECT * FROM rtc_calls WHERE (caller_id=$1 OR callee_id=$1) AND status IN ('ringing','accepted') ORDER BY created_at DESC LIMIT 1",
          [req.user.id],
        )
      ).rows[0];
      res.json({
        call: active
          ? {
              id: active.id,
              callerId: active.caller_id,
              calleeId: active.callee_id,
              callerName: active.caller_name,
              calleeName: active.callee_name,
              status: active.status,
              callType: active.call_type || "audio",
              offer: active.offer,
              answer: active.answer,
              createdAt: active.created_at,
              updatedAt: active.updated_at,
            }
          : null,
      });
    }),
  );
  r.post(
    "/calls/start",
    wrap(async (req, res) => {
      await expireCalls(db);
      const p = req.body || {},
        callType = p.callType === "video" ? "video" : "audio",
        recipient = (
          await db.query(
            "SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL AND disabled=false",
            [p.recipientId],
          )
        ).rows[0];
      const appData = (
        await db.query("SELECT data FROM app_state WHERE id=1")
      ).rows[0]?.data;
      if (!recipient || !D.canContact(req.user, recipient, appData))
        D.fail("Destinataire non autorisé.", 403);
      if (D.same(recipient.id, req.user.id))
        D.fail("Vous ne pouvez pas vous appeler vous-même.");
      if (
        !p.offer ||
        p.offer.type !== "offer" ||
        typeof p.offer.sdp !== "string" ||
        p.offer.sdp.length > 100000
      )
        D.fail("Offre d’appel invalide.");
      const busy = (
        await db.query(
          "SELECT id FROM rtc_calls WHERE status IN ('ringing','accepted') AND (caller_id=ANY($1::int[]) OR callee_id=ANY($1::int[])) LIMIT 1",
          [[Number(req.user.id), Number(recipient.id)]],
        )
      ).rows[0];
      if (busy) D.fail("Un des correspondants est déjà en appel.", 409);
      const id = randomUUID();
      await db.query(
        "INSERT INTO rtc_calls(id,caller_id,callee_id,caller_name,callee_name,status,offer,call_type) VALUES($1,$2,$3,$4,$5,'ringing',$6,$7)",
        [id, req.user.id, recipient.id, req.user.name, recipient.name, p.offer, callType],
      );
      await notifyUsers(db, [Number(recipient.id)], {
        title: callType === "video" ? "Appel vidéo entrant" : "Appel audio entrant",
        body: req.user.name + " vous appelle",
        url:
          "/?open=messages&conversation=" +
          encodeURIComponent("direct:" + req.user.id),
        tag: "call-" + id,
        conversationKey: "direct:" + req.user.id,
        directCallId: id,
      }).catch(() => {});
      res.json({ id, status: "ringing", callType });
    }),
  );
  r.get(
    "/calls/:id",
    wrap(async (req, res) => {
      await expireCalls(db);
      const call = await callRow(db, req.params.id, req.user.id);
      res.json({
        call: {
          id: call.id,
          callerId: call.caller_id,
          calleeId: call.callee_id,
          callerName: call.caller_name,
          calleeName: call.callee_name,
          status: call.status,
          callType: call.call_type || "audio",
          offer: call.offer,
          answer: call.answer,
          createdAt: call.created_at,
          updatedAt: call.updated_at,
        },
      });
    }),
  );
  r.post(
    "/calls/:id/answer",
    wrap(async (req, res) => {
      const call = await callRow(db, req.params.id, req.user.id);
      if (!D.same(call.callee_id, req.user.id) || call.status !== "ringing")
        D.fail("Cet appel ne peut plus être accepté.", 409);
      const answer = req.body?.answer;
      if (
        !answer ||
        answer.type !== "answer" ||
        typeof answer.sdp !== "string" ||
        answer.sdp.length > 100000
      )
        D.fail("Réponse d’appel invalide.");
      await db.query(
        "UPDATE rtc_calls SET status='accepted',answer=$1,updated_at=NOW() WHERE id=$2",
        [answer, call.id],
      );
      res.json({ id: call.id, status: "accepted" });
    }),
  );
  r.post(
    "/calls/:id/reject",
    wrap(async (req, res) => {
      const call = await callRow(db, req.params.id, req.user.id);
      if (!D.same(call.callee_id, req.user.id) || call.status !== "ringing")
        D.fail("Cet appel ne peut plus être refusé.", 409);
      await db.query(
        "UPDATE rtc_calls SET status='rejected',ended_at=NOW(),updated_at=NOW() WHERE id=$1",
        [call.id],
      );
      await db.query("DELETE FROM rtc_ice_candidates WHERE call_id=$1", [call.id]);
      res.json({ id: call.id, status: "rejected" });
    }),
  );
  r.post(
    "/calls/:id/end",
    wrap(async (req, res) => {
      const call = await callRow(db, req.params.id, req.user.id);
      if (!["ringing", "accepted"].includes(call.status))
        return res.json({ id: call.id, status: call.status });
      await db.query(
        "UPDATE rtc_calls SET status='ended',ended_at=NOW(),updated_at=NOW() WHERE id=$1",
        [call.id],
      );
      await db.query("DELETE FROM rtc_ice_candidates WHERE call_id=$1", [call.id]);
      res.json({ id: call.id, status: "ended" });
    }),
  );
  r.post(
    "/calls/:id/candidates",
    wrap(async (req, res) => {
      const call = await callRow(db, req.params.id, req.user.id);
      if (!["ringing", "accepted"].includes(call.status))
        D.fail("Appel terminé.", 409);
      const candidate = req.body?.candidate;
      if (
        !candidate ||
        typeof candidate.candidate !== "string" ||
        candidate.candidate.length > 10000
      )
        D.fail("Candidat réseau invalide.");
      await db.query(
        "INSERT INTO rtc_ice_candidates(call_id,sender_id,candidate) VALUES($1,$2,$3)",
        [call.id, req.user.id, candidate],
      );
      res.json({ ok: true });
    }),
  );
  r.get(
    "/calls/:id/candidates",
    wrap(async (req, res) => {
      await callRow(db, req.params.id, req.user.id);
      const after = Math.max(0, Number(req.query.after) || 0),
        rows = (
          await db.query(
            "SELECT id,sender_id,candidate FROM rtc_ice_candidates WHERE call_id=$1 AND id>$2 ORDER BY id ASC LIMIT 200",
            [req.params.id, after],
          )
        ).rows;
      res.json({
        candidates: rows
          .filter((row) => !D.same(row.sender_id, req.user.id))
          .map((row) => ({
            id: Number(row.id),
            senderId: row.sender_id,
            candidate: row.candidate,
          })),
      });
    }),
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
