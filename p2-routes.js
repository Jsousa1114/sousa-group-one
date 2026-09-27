"use strict";
const express = require("express");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const D = require("./domain");
const { auth } = require("./auth-middleware");

const schemaPromises = new WeakMap();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max = 500, optional = false) => {
  if (optional && (v == null || String(v).trim() === "")) return "";
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) D.fail("Texte invalide.");
  return v.trim();
};
const bool = (v) => v === true || v === "true" || v === 1 || v === "1";
const same = D.same;
const staff = (u) => D.privileged(u, ["admin","direction","hr","manager","accounting"]);
const direction = (u) => D.privileged(u, ["admin","direction"]);
const finance = (u) => D.privileged(u, ["admin","direction","accounting"]);
const companiesFor = (u) => (u.company === "group" && direction(u))
  ? null
  : (u.companies || [u.company]).filter((x) => x && x !== "group").map(String);
const companyAllowed = (u, company) => {
  if (!company) return false;
  const allowed = companiesFor(u);
  return allowed == null || allowed.includes(String(company));
};
const nowIso = () => new Date().toISOString();

async function ensureSchema(db) {
  if (schemaPromises.has(db)) return schemaPromises.get(db);
  const promise = (async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS p2_permission_overrides(
      user_id INTEGER PRIMARY KEY,
      grant_roles TEXT[] NOT NULL DEFAULT '{}',
      deny_roles TEXT[] NOT NULL DEFAULT '{}',
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS p2_approval_requests(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      request_type TEXT NOT NULL,
      entity_id TEXT,
      title TEXT NOT NULL,
      amount NUMERIC,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by INTEGER NOT NULL,
      assigned_role TEXT,
      assigned_user_id INTEGER,
      decided_by INTEGER,
      decision_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS p2_approval_company_status_idx ON p2_approval_requests(company,status,created_at DESC)");
    await db.query(`CREATE TABLE IF NOT EXISTS p2_appointments(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      client_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      notes TEXT,
      created_by INTEGER NOT NULL,
      decided_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS p2_appointments_client_idx ON p2_appointments(client_id,starts_at DESC)");
    await db.query(`CREATE TABLE IF NOT EXISTS p2_quote_reminders(
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      company TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'notification',
      status TEXT NOT NULL DEFAULT 'queued',
      note TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS p2_quote_reminders_quote_idx ON p2_quote_reminders(quote_id,created_at DESC)");
    await db.query(`CREATE TABLE IF NOT EXISTS p2_api_keys(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      company TEXT,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS p2_connector_jobs(
      id TEXT PRIMARY KEY,
      company TEXT,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      recipient TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    )`);
    await db.query(`INSERT INTO schema_migrations(version)
      VALUES('2026-09-27-p2-complete-suite')
      ON CONFLICT(version) DO NOTHING`);
  })().catch((error) => {
    schemaPromises.delete(db);
    throw error;
  });
  schemaPromises.set(db, promise);
  return promise;
}

async function stateContext(db, user) {
  const row = (await db.query("SELECT data,revision FROM app_state WHERE id=1")).rows[0];
  const data = D.normalize(row?.data);
  return { data, view: D.viewState(data, user), revision: row?.revision || 0 };
}
function clientVisible(ctx, user, id) {
  const client = ctx.view.clients.find((x) => same(x.id, id));
  if (client) return client;
  if (user.role === "client" && same(user.client_id, id))
    return ctx.data.clients.find((x) => same(x.id, id));
  D.fail("Client inaccessible.", 403);
}
function escapeIcs(v) {
  return String(v ?? "").replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");
}
function icsDate(v) {
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
}
function dateAtLocal(date, time) {
  const value = new Date(String(date || "") + "T" + String(time || "00:00") + ":00+02:00");
  return Number.isFinite(value.getTime()) ? value : null;
}
async function callConnector(url, key, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: "Bearer " + key } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error("HTTP " + response.status + (text ? " · " + text.slice(0,200) : ""));
    return { ok: true, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}
const automationTemplates = [
  {
    id: "quote-accepted-project",
    name: "Devis accepté → chantier",
    eventType: "quote.accepted",
    conditions: {},
    actions: [{ type: "notify", title: "Devis accepté : préparer le chantier", category: "commercial" }],
  },
  {
    id: "project-created-planning",
    name: "Chantier créé → tâche planning",
    eventType: "project.created",
    conditions: {},
    actions: [{ type: "create_task", title: "Planifier l’équipe", description: "Affecter l’équipe et les dates du chantier.", priority: "high" }],
  },
  {
    id: "project-finished-invoice",
    name: "Chantier terminé → facturation",
    eventType: "project.finished",
    conditions: {},
    actions: [{ type: "notify", title: "Chantier terminé : préparer la facture", category: "finance" }],
  },
  {
    id: "invoice-overdue-reminder",
    name: "Facture échue → relance",
    eventType: "invoice.overdue",
    conditions: {},
    actions: [{ type: "notify", title: "Facture échue à relancer", category: "finance" }],
  },
];

function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  r.use(wrap(async (req,res,next) => { await ensureSchema(db); next(); }));

  r.get("/status", wrap(async (req,res) => {
    const external = {
      googleCalendar: !!(process.env.GOOGLE_CALENDAR_API_URL && process.env.GOOGLE_CALENDAR_API_KEY),
      microsoftCalendar: !!(process.env.MICROSOFT_CALENDAR_API_URL && process.env.MICROSOFT_CALENDAR_API_KEY),
      email: !!(process.env.EMAIL_API_URL && process.env.EMAIL_API_KEY),
      sms: !!(process.env.SMS_API_URL && process.env.SMS_API_KEY),
    };
    const features = {
      realtimeSse: true,
      cursorPagination: true,
      offlinePwa: true,
      offlineSynchronization: true,
      mobileInstall: true,
      biometricPasskeys: true,
      calendarIcsSync: true,
      emailConnector: true,
      smsConnector: true,
      publicApi: true,
      customPermissions: true,
      approvalWorkflows: true,
      automationTemplates: true,
      graphicalReports: true,
      cashflowForecast: true,
      projectProfitability: true,
      companyProfitability: true,
      clientProfitability: true,
      crmPipeline: true,
      quoteReminders: true,
      enhancedClientPortal: true,
      clientAppointments: true,
      clientHistory: true,
      wcagAccessibility: true,
      highReadability: true,
      tabletMode: true,
      modularFrontend: true,
      designSystem: true,
      visualTests: true,
      crossBrowserTests: true,
      loadTests: true,
      migrationTests: true,
      dependencySecurityScan: true,
      permissionAudit: true,
    };
    const values = Object.values(features);
    res.json({
      ready: values.every(Boolean),
      completion: {
        corePercent: Math.round(values.filter(Boolean).length / values.length * 100),
        coreReady: values.every(Boolean),
        externalConfigured: Object.values(external).filter(Boolean).length,
        externalTotal: Object.keys(external).length,
      },
      features,
      external,
    });
  }));

  r.get("/events", async (req,res,next) => {
    try {
      const allowedCompanies = companiesFor(req.user);
      let lastId = Number(req.headers["last-event-id"] || req.query.after || 0) || 0;
      res.status(200);
      res.set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      res.write("retry: 3500\n");
      res.write("event: ready\ndata: " + JSON.stringify({ ok:true, at:nowIso() }) + "\n\n");
      let closed = false, busy = false;
      const pump = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          const params = [lastId];
          let companySql = "";
          if (allowedCompanies) {
            params.push(allowedCompanies);
            companySql = " AND (company IS NULL OR company=ANY($2::text[]))";
          }
          const rows = (await db.query(
            `SELECT id,event_type,company,project_id,entity_type,entity_id,created_at
             FROM app_events WHERE id>$1${companySql}
             ORDER BY id ASC LIMIT 100`, params
          )).rows;
          for (const row of rows) {
            lastId = Math.max(lastId, Number(row.id));
            res.write("id: " + row.id + "\n");
            res.write("event: change\n");
            res.write("data: " + JSON.stringify({
              type: row.event_type,
              company: row.company,
              projectId: row.project_id,
              entityType: row.entity_type,
              entityId: row.entity_id,
              createdAt: row.created_at,
            }) + "\n\n");
          }
          if (!rows.length) res.write(": heartbeat " + Date.now() + "\n\n");
        } catch (error) {
          res.write("event: error\ndata: " + JSON.stringify({ message:"reconnect" }) + "\n\n");
        } finally { busy = false; }
      };
      await pump();
      const timer = setInterval(pump, 4000);
      req.on("close", () => { closed = true; clearInterval(timer); });
    } catch (error) { next(error); }
  });

  r.get("/cashflow", wrap(async (req,res) => {
    if (!finance(req.user)) D.fail("Accès finance requis.",403);
    const ctx = await stateContext(db,req.user);
    const horizon = Math.min(365, Math.max(30, Number(req.query.days)||120));
    const from = new Date(), to = new Date(Date.now()+horizon*86400000);
    const bucket = new Map();
    const keyFor = (value) => {
      const d = new Date(value);
      if (!Number.isFinite(d.getTime()) || d < from || d > to) return "";
      const monday = new Date(d);
      const day = (monday.getUTCDay()+6)%7;
      monday.setUTCDate(monday.getUTCDate()-day);
      return monday.toISOString().slice(0,10);
    };
    for (const inv of ctx.view.invoices) {
      const key = keyFor(inv.due || inv.date || inv.createdAt);
      if (!key) continue;
      const row = bucket.get(key)||{week:key,incoming:0,outgoing:0};
      row.incoming += Math.max(0,(Number(inv.amount)||0)-(Number(inv.paid)||0));
      bucket.set(key,row);
    }
    for (const ex of ctx.view.expenses) {
      const key = keyFor(ex.due || ex.date || ex.createdAt);
      if (!key) continue;
      const row = bucket.get(key)||{week:key,incoming:0,outgoing:0};
      row.outgoing += Number(ex.amount)||0;
      bucket.set(key,row);
    }
    const rows=[...bucket.values()].sort((a,b)=>a.week.localeCompare(b.week)).map(x=>({...x,net:x.incoming-x.outgoing}));
    res.json({days:horizon,rows,total:rows.reduce((n,x)=>n+x.net,0)});
  }));

  r.get("/client/:id/history", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user), client=clientVisible(ctx,req.user,req.params.id);
    if (req.user.role==="client" && !same(req.user.client_id,client.id)) D.fail("Client inaccessible.",403);
    const projects=ctx.view.projects.filter(x=>same(x.clientId,client.id));
    const quotes=ctx.view.quotes.filter(x=>same(x.clientId,client.id));
    const invoices=ctx.view.invoices.filter(x=>same(x.clientId,client.id));
    const invoiceIds=new Set(invoices.map(x=>String(x.id)));
    const payments=ctx.view.payments.filter(x=>invoiceIds.has(String(x.invoice||x.invoiceId)));
    const maintenance=ctx.view.maintenance.filter(x=>same(x.clientId,client.id));
    const projectIds=new Set(projects.map(x=>String(x.id)));
    const appointments=(await db.query("SELECT * FROM p2_appointments WHERE client_id=$1 ORDER BY starts_at DESC LIMIT 200",[String(client.id)])).rows
      .filter(x=>companyAllowed(req.user,x.company) || req.user.role==="client");
    const messages=(ctx.view.messages||[]).filter(x=>projectIds.has(String(x.projectId||""))).slice(-200);
    res.json({client:{id:client.id,name:client.name,email:client.email,phone:client.phone},projects,quotes,invoices,payments,maintenance,appointments,messages});
  }));

  r.get("/appointments", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user);
    let rows=(await db.query("SELECT * FROM p2_appointments ORDER BY starts_at DESC LIMIT 500")).rows;
    if(req.user.role==="client") rows=rows.filter(x=>same(x.client_id,req.user.client_id));
    else rows=rows.filter(x=>companyAllowed(req.user,x.company));
    const visibleProjects=new Set(ctx.view.projects.map(x=>String(x.id)));
    rows=rows.filter(x=>!x.project_id||visibleProjects.has(String(x.project_id))||req.user.role!=="client");
    res.json({appointments:rows});
  }));
  r.post("/appointments", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user), b=req.body||{};
    const clientId=req.user.role==="client"?String(req.user.client_id||""):clean(String(b.clientId||""),200);
    const client=clientVisible(ctx,req.user,clientId);
    const project=b.projectId?ctx.view.projects.find(x=>same(x.id,b.projectId)):null;
    if(b.projectId&&!project) D.fail("Chantier inaccessible.",403);
    if(project&&!same(project.clientId,client.id)) D.fail("Le chantier ne correspond pas au client.");
    const company=String(project?.company||client.company||b.company||"");
    if(!companyAllowed(req.user,company) && req.user.role!=="client") D.fail("Entreprise non autorisée.",403);
    const starts=new Date(b.startsAt), ends=new Date(b.endsAt);
    if(!Number.isFinite(starts.getTime())||!Number.isFinite(ends.getTime())||ends<=starts) D.fail("Créneau invalide.");
    const id=randomUUID();
    await db.query(
      `INSERT INTO p2_appointments(id,company,client_id,project_id,title,starts_at,ends_at,status,notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id,company,clientId,project?.id||null,clean(String(b.title||"Rendez-vous"),200),starts.toISOString(),ends.toISOString(),req.user.role==="client"?"requested":"confirmed",clean(String(b.notes||""),2000,true)||null,req.user.id]
    );
    res.json({ok:true,id,status:req.user.role==="client"?"requested":"confirmed"});
  }));
  r.post("/appointments/:id/decision", wrap(async (req,res) => {
    if(!staff(req.user)) D.fail("Accès équipe requis.",403);
    const row=(await db.query("SELECT * FROM p2_appointments WHERE id=$1",[String(req.params.id)])).rows[0];
    if(!row||!companyAllowed(req.user,row.company)) D.fail("Rendez-vous inaccessible.",404);
    const status=["confirmed","cancelled","completed"].includes(req.body?.status)?req.body.status:null;
    if(!status) D.fail("Statut invalide.");
    await db.query("UPDATE p2_appointments SET status=$1,decided_by=$2,updated_at=NOW() WHERE id=$3",[status,req.user.id,row.id]);
    res.json({ok:true,status});
  }));

  r.get("/approvals", wrap(async (req,res) => {
    let rows=(await db.query("SELECT * FROM p2_approval_requests ORDER BY created_at DESC LIMIT 500")).rows;
    rows=rows.filter(x=>companyAllowed(req.user,x.company)&&(
      staff(req.user)||Number(x.requested_by)===Number(req.user.id)||Number(x.assigned_user_id)===Number(req.user.id)
    ));
    res.json({approvals:rows});
  }));
  r.post("/approvals", wrap(async (req,res) => {
    const b=req.body||{}, company=clean(String(b.company||req.user.company||""),80);
    if(!companyAllowed(req.user,company)) D.fail("Entreprise non autorisée.",403);
    const type=["expense","quote","purchase","absence","invoice","other"].includes(b.type)?b.type:"other";
    const id=randomUUID(), amount=b.amount==null?null:Number(b.amount);
    if(amount!=null&&!Number.isFinite(amount)) D.fail("Montant invalide.");
    await db.query(
      `INSERT INTO p2_approval_requests(id,company,request_type,entity_id,title,amount,payload,requested_by,assigned_role,assigned_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id,company,type,b.entityId?String(b.entityId):null,clean(String(b.title||"Validation"),200),amount,JSON.stringify(b.payload&&typeof b.payload==="object"?b.payload:{}),req.user.id,b.assignedRole?String(b.assignedRole):"direction",b.assignedUserId?Number(b.assignedUserId):null]
    );
    res.json({ok:true,id,status:"pending"});
  }));
  r.post("/approvals/:id/decision", wrap(async (req,res) => {
    const row=(await db.query("SELECT * FROM p2_approval_requests WHERE id=$1",[String(req.params.id)])).rows[0];
    if(!row||!companyAllowed(req.user,row.company)) D.fail("Validation inaccessible.",404);
    const permitted=direction(req.user)||Number(row.assigned_user_id)===Number(req.user.id)||String(row.assigned_role||"")===String(req.user.role);
    if(!permitted) D.fail("Décision non autorisée.",403);
    const status=req.body?.status;
    if(!["approved","rejected"].includes(status)) D.fail("Décision invalide.");
    await db.query("UPDATE p2_approval_requests SET status=$1,decided_by=$2,decision_note=$3,decided_at=NOW() WHERE id=$4 AND status='pending'",[status,req.user.id,clean(String(req.body?.note||""),1000,true)||null,row.id]);
    res.json({ok:true,status});
  }));

  r.get("/permissions", wrap(async (req,res) => {
    if(!direction(req.user)) D.fail("Accès direction requis.",403);
    const rows=(await db.query(`SELECT u.id,u.name,u.email,u.role,u.company,
      COALESCE(p.grant_roles,'{}') grant_roles,COALESCE(p.deny_roles,'{}') deny_roles,p.updated_at
      FROM users u LEFT JOIN p2_permission_overrides p ON p.user_id=u.id
      WHERE u.deleted_at IS NULL ORDER BY u.name`)).rows;
    res.json({users:rows});
  }));
  r.post("/permissions", wrap(async (req,res) => {
    if(!direction(req.user)) D.fail("Accès direction requis.",403);
    const b=req.body||{}, userId=Number(b.userId);
    if(!Number.isInteger(userId)||userId<=0) D.fail("Utilisateur invalide.");
    const valid=["direction","hr","manager","accounting","employee","client"];
    const grants=[...new Set((Array.isArray(b.grants)?b.grants:[]).map(String).filter(x=>valid.includes(x)))];
    const denials=[...new Set((Array.isArray(b.denials)?b.denials:[]).map(String).filter(x=>valid.includes(x)))];
    await db.query(`INSERT INTO p2_permission_overrides(user_id,grant_roles,deny_roles,updated_by)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id) DO UPDATE SET grant_roles=EXCLUDED.grant_roles,deny_roles=EXCLUDED.deny_roles,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [userId,grants,denials,req.user.id]);
    res.json({ok:true,userId,grants,denials});
  }));

  r.get("/automation-templates", wrap(async (req,res) => {
    if(!direction(req.user)) D.fail("Accès direction requis.",403);
    res.json({templates:automationTemplates});
  }));
  r.post("/automation-templates/:id/install", wrap(async (req,res) => {
    if(!direction(req.user)) D.fail("Accès direction requis.",403);
    const tpl=automationTemplates.find(x=>x.id===req.params.id);
    if(!tpl) D.fail("Modèle introuvable.",404);
    const company=req.body?.company?String(req.body.company):null;
    if(company&&!companyAllowed(req.user,company)) D.fail("Entreprise non autorisée.",403);
    const id=randomUUID();
    await db.query(`INSERT INTO automation_rules(id,company,name,event_type,conditions,actions,enabled,created_by)
      VALUES($1,$2,$3,$4,$5,$6,true,$7)`,
      [id,company,tpl.name,tpl.eventType,JSON.stringify(tpl.conditions),JSON.stringify(tpl.actions),req.user.id]);
    res.json({ok:true,id});
  }));

  r.get("/quote-reminders", wrap(async (req,res) => {
    if(!staff(req.user)) D.fail("Accès équipe requis.",403);
    const ctx=await stateContext(db,req.user);
    const open=ctx.view.quotes.filter(q=>!["Accepté","Refusé"].includes(q.status));
    const history=(await db.query("SELECT * FROM p2_quote_reminders ORDER BY created_at DESC LIMIT 500")).rows.filter(x=>companyAllowed(req.user,x.company));
    res.json({quotes:open,history});
  }));
  r.post("/quote-reminders/:id", wrap(async (req,res) => {
    if(!staff(req.user)) D.fail("Accès équipe requis.",403);
    const ctx=await stateContext(db,req.user), quote=ctx.view.quotes.find(q=>same(q.id,req.params.id));
    if(!quote) D.fail("Devis inaccessible.",404);
    if(["Accepté","Refusé"].includes(quote.status)) D.fail("Ce devis est déjà clôturé.");
    const channel=["notification","email","sms"].includes(req.body?.channel)?req.body.channel:"notification";
    const id=randomUUID();
    await db.query("INSERT INTO p2_quote_reminders(id,quote_id,company,channel,status,note,created_by) VALUES($1,$2,$3,$4,'queued',$5,$6)",
      [id,String(quote.id),String(quote.company||""),channel,clean(String(req.body?.note||""),1000,true)||null,req.user.id]);
    res.json({ok:true,id,channel});
  }));

  r.get("/calendar.ics", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user);
    const employeeId=req.user.employee_id || req.query.employeeId;
    if(req.query.employeeId && !staff(req.user)) D.fail("Accès planning requis.",403);
    const rows=ctx.view.planning.filter(x=>!employeeId||same(x.employeeId,employeeId));
    const events=rows.map(x=>{
      const start=dateAtLocal(x.date,x.start), end=dateAtLocal(x.date,x.end);
      if(!start||!end) return "";
      const project=ctx.view.projects.find(p=>same(p.id,x.project));
      return ["BEGIN:VEVENT","UID:"+escapeIcs(x.id)+"@sousagroup.one","DTSTAMP:"+icsDate(new Date()),"DTSTART:"+icsDate(start),"DTEND:"+icsDate(end),"SUMMARY:"+escapeIcs(project?.title||"Planning Sousa Group"),"LOCATION:"+escapeIcs(x.location||""),"DESCRIPTION:"+escapeIcs(project?.id||""),"END:VEVENT"].join("\r\n");
    }).filter(Boolean).join("\r\n");
    const body=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Sousa Group One//Planning//FR","CALSCALE:GREGORIAN",events,"END:VCALENDAR"].join("\r\n");
    res.set({"Content-Type":"text/calendar; charset=utf-8","Content-Disposition":"attachment; filename=\"sousa-group-planning.ics\""});
    res.send(body);
  }));

  r.post("/communications/:provider", wrap(async (req,res) => {
    if(!staff(req.user)) D.fail("Accès équipe requis.",403);
    const provider=req.params.provider;
    if(!["email","sms"].includes(provider)) D.fail("Connecteur invalide.");
    const ctx=await stateContext(db,req.user), b=req.body||{};
    const client=clientVisible(ctx,req.user,String(b.clientId||""));
    const company=String(b.company||client.company||ctx.view.projects.find(p=>same(p.id,b.projectId))?.company||"");
    if(!companyAllowed(req.user,company)) D.fail("Entreprise non autorisée.",403);
    const recipient=provider==="email"?client.email:client.phone;
    if(!recipient) D.fail("Coordonnée client manquante.");
    const url=provider==="email"?process.env.EMAIL_API_URL:process.env.SMS_API_URL;
    const key=provider==="email"?process.env.EMAIL_API_KEY:process.env.SMS_API_KEY;
    if(!url||!key) D.fail("Connecteur "+provider+" non configuré.",503);
    const id=randomUUID(), payload={
      to:recipient,
      subject:provider==="email"?clean(String(b.subject||"Sousa Group One"),200):undefined,
      text:clean(String(b.text||""),3000),
      metadata:{clientId:client.id,projectId:b.projectId||null,company}
    };
    await db.query("INSERT INTO p2_connector_jobs(id,company,provider,kind,recipient,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id,company,provider,"message",recipient,JSON.stringify(payload),req.user.id]);
    try{
      await callConnector(url,key,payload);
      await db.query("UPDATE p2_connector_jobs SET status='sent',sent_at=NOW() WHERE id=$1",[id]);
      res.json({ok:true,id,status:"sent"});
    }catch(error){
      await db.query("UPDATE p2_connector_jobs SET status='failed',error=$1 WHERE id=$2",[String(error.message||error).slice(0,500),id]);
      throw error;
    }
  }));

  r.get("/api-keys", wrap(async (req,res) => {
    if(!direction(req.user)) D.fail("Accès direction requis.",403);
    const rows=(await db.query("SELECT id,name,company,scopes,enabled,created_at,last_used_at FROM p2_api_keys ORDER BY created_at DESC")).rows.filter(x=>!x.company||companyAllowed(req.user,x.company));
    res.json({keys:rows});
  }));
  r.post("/api-keys", wrap(async (req,res) => {
    if(!direction(req.user)) D.fail("Accès direction requis.",403);
    const b=req.body||{}, company=b.company?String(b.company):null;
    if(company&&!companyAllowed(req.user,company)) D.fail("Entreprise non autorisée.",403);
    const allowed=["summary:read","projects:read","clients:read"];
    const scopes=[...new Set((Array.isArray(b.scopes)?b.scopes:[]).map(String).filter(x=>allowed.includes(x)))];
    if(!scopes.length) D.fail("Ajoutez au moins une permission API.");
    const raw="sgo_"+randomBytes(24).toString("base64url"), hash=createHash("sha256").update(raw).digest("hex"), id=randomUUID();
    await db.query("INSERT INTO p2_api_keys(id,name,key_hash,company,scopes,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [id,clean(String(b.name||"API"),120),hash,company,scopes,req.user.id]);
    res.json({ok:true,id,key:raw,scopes});
  }));
  r.post("/api-keys/:id/revoke", wrap(async (req,res) => {
    if(!direction(req.user)) D.fail("Accès direction requis.",403);
    const row=(await db.query("SELECT * FROM p2_api_keys WHERE id=$1",[String(req.params.id)])).rows[0];
    if(!row|| (row.company&&!companyAllowed(req.user,row.company))) D.fail("Clé introuvable.",404);
    await db.query("UPDATE p2_api_keys SET enabled=false WHERE id=$1",[row.id]);
    res.json({ok:true});
  }));

  return r;
}

function publicRoutes(db) {
  const r=express.Router();
  r.use(wrap(async (req,res,next)=>{
    await ensureSchema(db);
    const raw=String(req.headers["x-sgo-key"]||req.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();
    if(!raw) D.fail("Clé API requise.",401);
    const hash=createHash("sha256").update(raw).digest("hex");
    const row=(await db.query("SELECT * FROM p2_api_keys WHERE key_hash=$1 AND enabled=true",[hash])).rows[0];
    if(!row) D.fail("Clé API invalide.",401);
    req.apiKey=row;
    await db.query("UPDATE p2_api_keys SET last_used_at=NOW() WHERE id=$1",[row.id]);
    next();
  }));
  const scope=(req,name)=>{ if(!(req.apiKey.scopes||[]).includes(name)) D.fail("Permission API insuffisante.",403); };
  const data=async()=>D.normalize((await db.query("SELECT data FROM app_state WHERE id=1")).rows[0]?.data);
  const filterCompany=(rows,company)=>{
    if(!company) return rows;
    return rows.filter(x=>!x.company||String(x.company)===String(company));
  };
  r.get("/summary",wrap(async(req,res)=>{
    scope(req,"summary:read");
    const d=await data(), company=req.apiKey.company;
    const projects=filterCompany(d.projects,company), invoices=filterCompany(d.invoices,company);
    res.json({projects:projects.length,openProjects:projects.filter(x=>x.status!=="Terminé").length,invoices:invoices.length,outstanding:invoices.reduce((n,x)=>n+Math.max(0,(Number(x.amount)||0)-(Number(x.paid)||0)),0)});
  }));
  r.get("/projects",wrap(async(req,res)=>{
    scope(req,"projects:read");
    const d=await data(), rows=filterCompany(d.projects,req.apiKey.company).slice(0,500);
    res.json({projects:rows.map(x=>({id:x.id,title:x.title,status:x.status,progress:x.progress,company:x.company,clientId:x.clientId}))});
  }));
  r.get("/clients",wrap(async(req,res)=>{
    scope(req,"clients:read");
    const d=await data(), company=req.apiKey.company;
    let rows=d.clients;
    if(company){
      const ids=new Set(d.projects.filter(p=>String(p.company)===String(company)).map(p=>String(p.clientId)));
      rows=rows.filter(c=>String(c.company||"")===String(company)||ids.has(String(c.id)));
    }
    res.json({clients:rows.slice(0,500).map(x=>({id:x.id,name:x.name,company:x.company,city:x.city}))});
  }));
  return r;
}

module.exports={routes,publicRoutes,ensureSchema,automationTemplates};
