"use strict";
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { createHash } = require("node:crypto");
const { emptyState, normalize, AppError } = require("./domain");
const MIRRORED_COLLECTIONS = [
  "companies",
  "employees",
  "clients",
  "projects",
  "time",
  "planning",
  "absences",
  "quotes",
  "invoices",
  "payments",
  "expenses",
  "inventory",
  "suppliers",
  "vehicles",
  "tools",
  "maintenance",
  "documents",
  "messageThreads",
];
async function syncEntityCollection(c, collection, rows) {
  const list = Array.isArray(rows) ? rows.filter((x) => x && x.id != null) : [];
  await c.query("DELETE FROM entity_records WHERE collection=$1", [collection]);
  for (let position = 0; position < list.length; position++) {
    const row = list[position];
    await c.query(
      `INSERT INTO entity_records(collection,entity_id,company,data,position,updated_at)
       VALUES($1,$2,$3,$4,$5,NOW())
       ON CONFLICT(collection,entity_id) DO UPDATE SET
       company=EXCLUDED.company,data=EXCLUDED.data,position=EXCLUDED.position,updated_at=NOW()`,
      [
        collection,
        String(row.id),
        row.company ? String(row.company) : null,
        JSON.stringify(row),
        position,
      ],
    );
  }
}
async function syncEntityMirror(c, data, changedOnly = null) {
  const collections = changedOnly || MIRRORED_COLLECTIONS;
  for (const collection of collections)
    await syncEntityCollection(c, collection, data?.[collection]);
}
function canonicalEntityStateEnabled() {
  return process.env.STATE_ENTITY_CANONICAL === "true";
}
async function hydrateEntityMirror(db, rawData) {
  const data = normalize(rawData || {});
  const rows = (
    await db.query(
      `SELECT collection,data
       FROM entity_records
       WHERE collection=ANY($1::text[])
       ORDER BY collection,position,entity_id`,
      [MIRRORED_COLLECTIONS],
    )
  ).rows;
  const grouped = new Map(MIRRORED_COLLECTIONS.map((name) => [name, []]));
  const present = new Set();
  for (const row of rows) {
    present.add(row.collection);
    grouped.get(row.collection)?.push(row.data);
  }
  for (const collection of MIRRORED_COLLECTIONS)
    if (canonicalEntityStateEnabled() || present.has(collection))
      data[collection] = grouped.get(collection) || [];
  return data;
}
function persistedState(data) {
  const normalized = normalize(data || {});
  if (!canonicalEntityStateEnabled()) return normalized;
  const compact = { ...normalized };
  for (const collection of MIRRORED_COLLECTIONS) compact[collection] = [];
  return compact;
}
async function loadState(db, { forUpdate = false } = {}) {
  const row = (
    await db.query(
      "SELECT data,revision FROM app_state WHERE id=1" +
        (forUpdate ? " FOR UPDATE" : ""),
    )
  ).rows[0];
  return {
    data: canonicalEntityStateEnabled()
      ? await hydrateEntityMirror(db, row?.data || {})
      : normalize(row?.data || {}),
    revision: Number(row?.revision || 0),
  };
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});
async function migrate(db = pool) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,email VARCHAR(255) UNIQUE NOT NULL,password_hash TEXT NOT NULL,role VARCHAR(50) NOT NULL,name VARCHAR(160) NOT NULL,avatar VARCHAR(8) NOT NULL,company VARCHAR(50) NOT NULL DEFAULT 'group',created_at TIMESTAMPTZ DEFAULT NOW())`,
  );
  for (const column of [
    "employee_id TEXT",
    "client_id TEXT",
    "disabled BOOLEAN NOT NULL DEFAULT false",
    "deleted_at TIMESTAMPTZ",
    "session_version INTEGER NOT NULL DEFAULT 0",
    "totp_secret TEXT",
    "totp_enabled BOOLEAN NOT NULL DEFAULT false",
    "webauthn_user_id TEXT",
    "last_login_at TIMESTAMPTZ",
    "last_login_ip TEXT",
    "last_login_agent TEXT",
  ])
    await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS " + column);
  await db.query(
    `CREATE TABLE IF NOT EXISTS user_recovery_codes(
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ,
      PRIMARY KEY(user_id,code_hash)
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS user_recovery_codes_unused_idx
     ON user_recovery_codes(user_id,used_at)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS user_sessions(
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_agent TEXT,
      ip TEXT,
      revoked_at TIMESTAMPTZ
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id,last_seen DESC)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS user_passkeys(
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      public_key BYTEA NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports TEXT[] NOT NULL DEFAULT '{}',
      device_type TEXT,
      backed_up BOOLEAN NOT NULL DEFAULT false,
      name VARCHAR(120) NOT NULL DEFAULT 'Passkey',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS user_passkeys_user_idx
     ON user_passkeys(user_id,created_at DESC)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS webauthn_challenges(
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      purpose VARCHAR(30) NOT NULL,
      challenge TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry_idx
     ON webauthn_challenges(expires_at)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS account_preferences(
      user_id INTEGER PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS account_deactivation_requests(
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      reason TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations(
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS entity_records(
      collection TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      company TEXT,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(collection,entity_id)
    )`,
  );
  await db.query(
    "ALTER TABLE entity_records ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0",
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS entity_records_company_idx ON entity_records(collection,company)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS entity_records_order_idx ON entity_records(collection,position,entity_id)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS application_errors(
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT,
      user_id INTEGER,
      method VARCHAR(12),
      path TEXT,
      status INTEGER NOT NULL,
      message TEXT,
      stack TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS application_errors_created_idx
     ON application_errors(created_at DESC)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS app_events(
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      actor_user_id INTEGER,
      company TEXT,
      project_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS app_events_project_idx ON app_events(project_id,created_at DESC)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS user_notifications(
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      url TEXT,
      entity_type TEXT,
      entity_id TEXT,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS user_notifications_user_idx ON user_notifications(user_id,read_at,created_at DESC)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS employee_lifecycle_items(
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      company TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('onboarding','offboarding')),
      label TEXT NOT NULL,
      required BOOLEAN NOT NULL DEFAULT true,
      completed BOOLEAN NOT NULL DEFAULT false,
      due_date DATE,
      completed_by INTEGER,
      completed_at TIMESTAMPTZ,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS employee_lifecycle_employee_phase_idx
     ON employee_lifecycle_items(employee_id,phase,created_at)`,
  );

  await db.query(
    `CREATE TABLE IF NOT EXISTS project_tasks(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'normal',
      assigned_employee_id TEXT,
      due_date DATE,
      position INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS project_tasks_project_idx ON project_tasks(project_id,status,position)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS project_checklist_items(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      company TEXT NOT NULL,
      label TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT false,
      completed_by INTEGER,
      completed_at TIMESTAMPTZ,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS project_checklist_project_idx ON project_checklist_items(project_id,completed)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS project_daily_reports(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      company TEXT NOT NULL,
      report_date DATE NOT NULL,
      weather TEXT,
      summary TEXT NOT NULL,
      issues TEXT,
      materials TEXT,
      team TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id,report_date,created_by)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS project_punch_items(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      severity TEXT NOT NULL DEFAULT 'normal',
      assigned_employee_id TEXT,
      due_date DATE,
      resolved_at TIMESTAMPTZ,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS project_change_orders(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      client_note TEXT,
      approved_by_user_id INTEGER,
      approved_at TIMESTAMPTZ,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query("ALTER TABLE project_change_orders ADD COLUMN IF NOT EXISTS client_signature TEXT");
  await db.query("ALTER TABLE project_change_orders ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ");
  await db.query(
    `CREATE TABLE IF NOT EXISTS crm_opportunities(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      client_id TEXT,
      name TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'lead',
      value NUMERIC(14,2) NOT NULL DEFAULT 0,
      probability INTEGER NOT NULL DEFAULT 0,
      owner_user_id INTEGER,
      next_action TEXT,
      next_action_at TIMESTAMPTZ,
      source TEXT,
      notes TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS crm_pipeline_idx ON crm_opportunities(company,stage,updated_at DESC)`,
  );
  await db.query("ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS email TEXT");
  await db.query("ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS phone TEXT");
  await db.query("ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS street TEXT");
  await db.query("ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS zip TEXT");
  await db.query("ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS city TEXT");
  await db.query("ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'CH'");
  await db.query(
    `CREATE TABLE IF NOT EXISTS crm_activities(
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL,
      company TEXT NOT NULL,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      notes TEXT,
      occurred_at TIMESTAMPTZ NOT NULL,
      next_action_at TIMESTAMPTZ,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS crm_activities_opportunity_idx ON crm_activities(opportunity_id,occurred_at DESC,created_at DESC)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS inventory_locations(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'warehouse',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS inventory_movements(
      id TEXT PRIMARY KEY,
      inventory_id TEXT NOT NULL,
      company TEXT NOT NULL,
      location_id TEXT,
      project_id TEXT,
      employee_id TEXT,
      quantity NUMERIC(14,3) NOT NULL,
      movement_type TEXT NOT NULL,
      note TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS inventory_movements_item_idx ON inventory_movements(inventory_id,created_at DESC)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS work_orders(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      client_id TEXT,
      project_id TEXT,
      maintenance_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      priority TEXT NOT NULL DEFAULT 'normal',
      scheduled_at TIMESTAMPTZ,
      assigned_employee_id TEXT,
      customer_signature TEXT,
      signed_at TIMESTAMPTZ,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS recurring_jobs(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      maintenance_id TEXT,
      title TEXT NOT NULL,
      frequency TEXT NOT NULL,
      next_run DATE NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query("ALTER TABLE recurring_jobs ADD COLUMN IF NOT EXISTS anchor_day INTEGER");
  await db.query("ALTER TABLE recurring_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await db.query("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS recurring_job_id TEXT");
  await db.query("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS occurrence_date DATE");
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS work_orders_recurring_occurrence_idx ON work_orders(recurring_job_id,occurrence_date)");
  await db.query(
    `CREATE TABLE IF NOT EXISTS automation_rules(
      id TEXT PRIMARY KEY,
      company TEXT,
      name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
      actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS outgoing_webhooks(
      id TEXT PRIMARY KEY,
      company TEXT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      event_types TEXT[] NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS webhook_deliveries(
      id BIGSERIAL PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status_code INTEGER,
      success BOOLEAN NOT NULL DEFAULT false,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS integration_settings(
      provider TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT false,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `INSERT INTO schema_migrations(version) VALUES
      ('2026-09-27-platform-p0-p3-baseline')
      ON CONFLICT(version) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO schema_migrations(version) VALUES
      ('2026-09-27-employee-lifecycle')
      ON CONFLICT(version) DO NOTHING`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS app_state(id INTEGER PRIMARY KEY DEFAULT 1,data JSONB NOT NULL,updated_at TIMESTAMPTZ DEFAULT NOW(),updated_by VARCHAR(255))`,
  );
  await db.query(
    "ALTER TABLE app_state ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0",
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS audit_logs(id SERIAL PRIMARY KEY,user_email VARCHAR(255),action VARCHAR(100),metadata JSONB,created_at TIMESTAMPTZ DEFAULT NOW())`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS command_receipts(user_id INTEGER NOT NULL,request_id TEXT NOT NULL,result JSONB NOT NULL,PRIMARY KEY(user_id,request_id))`,
  );
  await db.query(
    "ALTER TABLE command_receipts ADD COLUMN IF NOT EXISTS request_hash TEXT",
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS file_contents(id TEXT PRIMARY KEY,content BYTEA NOT NULL)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS file_objects(
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      object_key TEXT NOT NULL,
      mime TEXT,
      size BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS file_objects_provider_idx
     ON file_objects(provider,updated_at DESC)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS message_reads(
      message_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(message_id,user_id)
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS message_reads_user_idx ON message_reads(user_id,read_at DESC)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS rtc_calls(
      id TEXT PRIMARY KEY,
      caller_id INTEGER NOT NULL,
      callee_id INTEGER NOT NULL,
      caller_name VARCHAR(160) NOT NULL,
      callee_name VARCHAR(160) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'ringing',
      offer JSONB NOT NULL,
      answer JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    )`,
  );
  await db.query(
    "ALTER TABLE rtc_calls ADD COLUMN IF NOT EXISTS call_type VARCHAR(12) NOT NULL DEFAULT 'audio'",
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS rtc_calls_callee_status_idx ON rtc_calls(callee_id,status,created_at DESC)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS rtc_calls_caller_status_idx ON rtc_calls(caller_id,status,created_at DESC)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS rtc_ice_candidates(
      id BIGSERIAL PRIMARY KEY,
      call_id TEXT NOT NULL,
      sender_id INTEGER NOT NULL,
      candidate JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS rtc_ice_call_idx ON rtc_ice_candidates(call_id,id)`,
  );

  await db.query(
    `CREATE TABLE IF NOT EXISTS push_subscriptions(
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id,endpoint)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS user_presence(
      user_id INTEGER PRIMARY KEY,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      typing_key TEXT,
      typing_until TIMESTAMPTZ
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS conversation_prefs(
      user_id INTEGER NOT NULL,
      conversation_key TEXT NOT NULL,
      pinned BOOLEAN NOT NULL DEFAULT false,
      archived BOOLEAN NOT NULL DEFAULT false,
      muted_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id,conversation_key)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS message_reactions(
      message_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      emoji VARCHAR(16) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(message_id,user_id,emoji)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS message_favorites(
      message_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(message_id,user_id)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS message_overrides(
      message_id TEXT PRIMARY KEY,
      edited_text TEXT,
      edited_at TIMESTAMPTZ,
      deleted_for_all BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ
    )`,
  );
  await db.query(
    "ALTER TABLE message_overrides ADD COLUMN IF NOT EXISTS edited_encryption JSONB",
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS user_crypto_keys(
      user_id INTEGER PRIMARY KEY,
      public_jwk JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS rtc_group_rooms(
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      call_type VARCHAR(12) NOT NULL DEFAULT 'audio',
      status VARCHAR(20) NOT NULL DEFAULT 'ringing',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS rtc_group_members(
      room_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TIMESTAMPTZ,
      left_at TIMESTAMPTZ,
      PRIMARY KEY(room_id,user_id)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS rtc_group_signals(
      id BIGSERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      from_user INTEGER NOT NULL,
      to_user INTEGER NOT NULL,
      kind VARCHAR(20) NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS rtc_group_signals_lookup_idx ON rtc_group_signals(room_id,to_user,id)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS retention_policies(
      scope TEXT PRIMARY KEY,
      days INTEGER NOT NULL,
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `INSERT INTO retention_policies(scope,days) VALUES
      ('messages',3650),('call_history',730),('call_signals',7)
      ON CONFLICT(scope) DO NOTHING`,
  );
  // AI usage per person and per day: counts only, never the questions or the answers.
  await db.query(
    `CREATE TABLE IF NOT EXISTS ai_usage(
      day DATE NOT NULL,
      user_id INTEGER NOT NULL,
      feature VARCHAR(40) NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day,user_id,feature)
    )`,
  );
  // E-mails sent by the application: who, what and the outcome (not the message itself).
  await db.query(
    `CREATE TABLE IF NOT EXISTS email_log(
      id TEXT PRIMARY KEY,
      company TEXT,
      kind VARCHAR(40) NOT NULL,
      entity_type VARCHAR(20),
      entity_id TEXT,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      status VARCHAR(12) NOT NULL,
      error TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query("CREATE INDEX IF NOT EXISTS email_log_entity_idx ON email_log(entity_type,entity_id,kind)");
  // Message-ID of each sent e-mail, to recognise the client's replies.
  await db.query("ALTER TABLE email_log ADD COLUMN IF NOT EXISTS message_id TEXT");
  await db.query("CREATE INDEX IF NOT EXISTS email_log_message_idx ON email_log(message_id)");
  // E-mail settings of each company: texts, signature, delays, copy, automatic sendings.
  await db.query(
    `CREATE TABLE IF NOT EXISTS mail_settings(
      company TEXT PRIMARY KEY,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  // One-time links (forgotten password, client portal invitation): only a hash is kept.
  await db.query(
    `CREATE TABLE IF NOT EXISTS password_tokens(
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      purpose VARCHAR(20) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  // Client replies read from the companies' Gmail inboxes (only replies and known clients).
  await db.query(
    `CREATE TABLE IF NOT EXISTS email_inbox(
      id TEXT PRIMARY KEY,
      company TEXT,
      account TEXT NOT NULL,
      message_id TEXT NOT NULL,
      in_reply_to TEXT,
      from_address TEXT NOT NULL,
      from_name TEXT,
      subject TEXT,
      body TEXT,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      received_at TIMESTAMPTZ,
      client_id TEXT,
      entity_type VARCHAR(20),
      entity_id TEXT,
      read_at TIMESTAMPTZ,
      read_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(account,message_id)
    )`,
  );
  await db.query("CREATE INDEX IF NOT EXISTS email_inbox_entity_idx ON email_inbox(entity_type,entity_id)");
  // « Boîte mail »: who may open which Gmail mailbox, and where each inbox stood at the last
  // new-mail check. The messages themselves stay in Gmail.
  await db.query(
    `CREATE TABLE IF NOT EXISTS mailbox_access(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mailbox TEXT NOT NULL,
      granted_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id,mailbox)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS webmail_state(
      account TEXT PRIMARY KEY,
      uid_validity TEXT,
      last_uid BIGINT NOT NULL DEFAULT 0,
      checked_at TIMESTAMPTZ,
      last_error TEXT
    )`,
  );
  // « Boîte mail » 2: messages waiting to leave (10 seconds to cancel, or a time chosen),
  // quick replies of each mailbox, and reminders (the conversation comes back later).
  await db.query(
    `CREATE TABLE IF NOT EXISTS webmail_outbox(
      id TEXT PRIMARY KEY,
      mailbox TEXT NOT NULL,
      user_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'undo',
      status TEXT NOT NULL DEFAULT 'scheduled',
      send_at TIMESTAMPTZ NOT NULL,
      subject TEXT,
      recipients TEXT,
      payload TEXT,
      message_id TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    )`,
  );
  await db.query("CREATE INDEX IF NOT EXISTS webmail_outbox_due_idx ON webmail_outbox(status,send_at)");
  await db.query(
    `CREATE TABLE IF NOT EXISTS webmail_snippets(
      id TEXT PRIMARY KEY,
      mailbox TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query("CREATE INDEX IF NOT EXISTS webmail_snippets_mailbox_idx ON webmail_snippets(mailbox)");
  await db.query(
    `CREATE TABLE IF NOT EXISTS webmail_reminders(
      id TEXT PRIMARY KEY,
      mailbox TEXT NOT NULL,
      user_id INTEGER,
      thread_id TEXT,
      message_id TEXT,
      subject TEXT,
      sender TEXT,
      remind_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      done_at TIMESTAMPTZ
    )`,
  );
  await db.query("CREATE INDEX IF NOT EXISTS webmail_reminders_due_idx ON webmail_reminders(status,remind_at)");
  // WhatsApp (linked like WhatsApp Web): the session (encrypted), the conversations and messages
  // received on the linked number, who may open it, messages waiting to leave and reminders.
  await db.query(
    `CREATE TABLE IF NOT EXISTS whatsapp_auth(
      account TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY(account,key)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS whatsapp_chats(
      account TEXT NOT NULL,
      jid TEXT NOT NULL,
      name TEXT,
      is_group BOOLEAN NOT NULL DEFAULT false,
      unread INTEGER NOT NULL DEFAULT 0,
      last_at TIMESTAMPTZ,
      last_text TEXT,
      last_from_me BOOLEAN NOT NULL DEFAULT false,
      archived BOOLEAN NOT NULL DEFAULT false,
      muted_until TIMESTAMPTZ,
      snoozed_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(account,jid)
    )`,
  );
  await db.query("CREATE INDEX IF NOT EXISTS whatsapp_chats_last_idx ON whatsapp_chats(account,last_at DESC)");
  await db.query(
    `CREATE TABLE IF NOT EXISTS whatsapp_messages(
      account TEXT NOT NULL,
      jid TEXT NOT NULL,
      id TEXT NOT NULL,
      from_me BOOLEAN NOT NULL DEFAULT false,
      sender TEXT,
      sender_name TEXT,
      at TIMESTAMPTZ NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      body TEXT,
      media_mime TEXT,
      media_name TEXT,
      media_size BIGINT,
      thumb TEXT,
      quoted_id TEXT,
      quoted_text TEXT,
      status INTEGER,
      deleted BOOLEAN NOT NULL DEFAULT false,
      edited BOOLEAN NOT NULL DEFAULT false,
      reactions TEXT,
      raw TEXT,
      media_file TEXT,
      seq BIGSERIAL,
      PRIMARY KEY(account,jid,id)
    )`,
  );
  await db.query("CREATE INDEX IF NOT EXISTS whatsapp_messages_chat_idx ON whatsapp_messages(account,jid,at DESC)");
  await db.query(
    `CREATE TABLE IF NOT EXISTS whatsapp_contacts(
      account TEXT NOT NULL,
      jid TEXT NOT NULL,
      name TEXT,
      notify TEXT,
      PRIMARY KEY(account,jid)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS whatsapp_lids(
      account TEXT NOT NULL,
      lid TEXT NOT NULL,
      pn TEXT NOT NULL,
      PRIMARY KEY(account,lid)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS whatsapp_access(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account TEXT NOT NULL,
      granted_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id,account)
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS whatsapp_outbox(
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      jid TEXT NOT NULL,
      user_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'undo',
      status TEXT NOT NULL DEFAULT 'scheduled',
      send_at TIMESTAMPTZ NOT NULL,
      preview TEXT,
      payload TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    )`,
  );
  await db.query("CREATE INDEX IF NOT EXISTS whatsapp_outbox_due_idx ON whatsapp_outbox(status,send_at)");
  await db.query(
    `CREATE TABLE IF NOT EXISTS whatsapp_reminders(
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      jid TEXT NOT NULL,
      user_id INTEGER,
      remind_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      done_at TIMESTAMPTZ
    )`,
  );
  await db.query("CREATE INDEX IF NOT EXISTS whatsapp_reminders_due_idx ON whatsapp_reminders(status,remind_at)");
  await db.query(
    `CREATE TABLE IF NOT EXISTS email_inbox_state(
      account TEXT PRIMARY KEY,
      uid_validity TEXT,
      last_uid BIGINT NOT NULL DEFAULT 0,
      since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT,
      checked_at TIMESTAMPTZ
    )`,
  );
  // One "point du jour" per person and per day (Zurich date), kept to avoid regenerating it.
  await db.query(
    `CREATE TABLE IF NOT EXISTS ai_briefings(
      user_id INTEGER NOT NULL,
      day DATE NOT NULL,
      text TEXT NOT NULL,
      mode VARCHAR(10) NOT NULL DEFAULT 'ai',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      pushed_at TIMESTAMPTZ,
      PRIMARY KEY(user_id,day)
    )`,
  );

  await db.query(
    "INSERT INTO app_state(id,data) VALUES(1,$1) ON CONFLICT(id) DO NOTHING",
    [JSON.stringify(emptyState())],
  );
  const mirrorState = (
    await db.query("SELECT data FROM app_state WHERE id=1")
  ).rows[0]?.data;
  const entityCount = Number(
      (await db.query("SELECT COUNT(*)::int AS count FROM entity_records")).rows[0]?.count || 0,
    ),
    rawHasMirroredData = MIRRORED_COLLECTIONS.some(
      (collection) =>
        Array.isArray(mirrorState?.[collection]) &&
        mirrorState[collection].length > 0,
    );
  if (canonicalEntityStateEnabled()) {
    // First activation: seed the canonical tables from the complete legacy state.
    if (entityCount === 0 || rawHasMirroredData)
      await syncEntityMirror(db, normalize(mirrorState));
    const hydrated = await hydrateEntityMirror(db, mirrorState);
    await db.query(
      "UPDATE app_state SET data=$1,updated_at=NOW(),updated_by='entity-canonical-migration' WHERE id=1",
      [JSON.stringify(persistedState(hydrated))],
    );
  } else if (rawHasMirroredData) {
    // Legacy/default mode stays fully backward-compatible: app_state is authoritative.
    await syncEntityMirror(db, normalize(mirrorState));
  } else if (entityCount > 0) {
    // Safe rollback from canonical mode: rebuild the full legacy snapshot before
    // returning app_state to authoritative mode.
    const restored = await hydrateEntityMirror(db, mirrorState);
    await db.query(
      "UPDATE app_state SET data=$1,updated_at=NOW(),updated_by='entity-canonical-rollback' WHERE id=1",
      [JSON.stringify(restored)],
    );
  }
  await db.query(
    `INSERT INTO schema_migrations(version) VALUES
      ('2026-09-27-entity-records-mirror'),
      ('2026-09-27-webauthn-passkeys'),
      ('2026-09-27-external-file-storage'),
      ('2026-09-30-reliable-recurrences'),
      ('2026-11-24-ai-usage'),
      ('2026-11-24-ai-briefings'),
      ('2026-11-25-email-log'),
      ('2026-11-25-email-settings-inbox'),
      ('2026-11-25-webmail'),
      ('2026-11-26-webmail-2'),
      ('2026-11-26-whatsapp')
      ON CONFLICT(version) DO NOTHING`,
  );
  // Disable the previously published demo credentials, even on an existing installation.
  const users = await db.query(
    "SELECT id,password_hash FROM users WHERE disabled=false",
  );
  for (const u of users.rows)
    if (await bcrypt.compare("demo1234", u.password_hash))
      await db.query(
        "UPDATE users SET disabled=true,session_version=session_version+1 WHERE id=$1",
        [u.id],
      );
  if (
    process.env.BOOTSTRAP_ADMIN_EMAIL &&
    process.env.BOOTSTRAP_ADMIN_PASSWORD
  ) {
    if (process.env.BOOTSTRAP_ADMIN_PASSWORD.length < 12)
      throw new Error(
        "BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters",
      );
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase(),
      hash = await bcrypt.hash(process.env.BOOTSTRAP_ADMIN_PASSWORD, 12);
    const existing = await db.query(
      "SELECT id,password_hash FROM users WHERE email=$1",
      [email],
    );
    if (!existing.rows.length)
      await db.query(
        "INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES($1,$2,'admin','Administration','AD','group')",
        [email, hash],
      );
    else if (await bcrypt.compare("demo1234", existing.rows[0].password_hash))
      await db.query(
        "UPDATE users SET password_hash=$1,role='admin',company='group',disabled=false,session_version=session_version+1 WHERE id=$2",
        [hash, existing.rows[0].id],
      );
  }
}
async function transaction(db, fn) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
// Serialize edits and reject stale views; retries after a lost response are idempotent.
async function mutate(db, user, body, fn) {
  if (
    typeof body.requestId !== "string" ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)
  )
    throw new AppError("Identifiant de requête invalide.");
  if (!Number.isSafeInteger(body.revision) || body.revision < 0)
    throw new AppError("Version de données requise.");
  return transaction(db, async (c) => {
    const row = await loadState(c, { forUpdate: true });
    const previous = (
      await c.query(
        "SELECT result,request_hash FROM command_receipts WHERE user_id=$1 AND request_id=$2",
        [user.id, body.requestId],
      )
    ).rows[0];
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          action: body.action,
          collection: body.collection,
          payload: body.payload,
        }),
      )
      .digest("hex");
    if (previous) {
      if (previous.request_hash !== hash)
        throw new AppError(
          "Cette requête a déjà été enregistrée avec une autre saisie. Actualisez et vérifiez les données.",
          409,
        );
      return previous.result;
    }
    if (row.revision !== body.revision)
      throw new AppError(
        "Les données ont changé. Actualisez puis vérifiez votre saisie avant de réessayer.",
        409,
      );
    const data = row.data,
      beforeSignatures = Object.fromEntries(
        MIRRORED_COLLECTIONS.map((collection) => [
          collection,
          JSON.stringify(data[collection] || []),
        ]),
      ),
      result = await fn(c, data),
      changedCollections = MIRRORED_COLLECTIONS.filter(
        (collection) =>
          JSON.stringify(data[collection] || []) !== beforeSignatures[collection],
      );
    await c.query(
      "UPDATE app_state SET data=$1,revision=revision+1,updated_at=NOW(),updated_by=$2 WHERE id=1",
      [JSON.stringify(persistedState(data)), user.email],
    );
    if (changedCollections.length)
      await syncEntityMirror(c, data, changedCollections);
    await c.query(
      "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
      [
        user.email,
        String(body.action || "Modification").slice(0, 100),
        JSON.stringify({
          id: result?.id,
          collection: body.collection || null,
          company: user.company,
        }),
      ],
    );
    const receipt = { ok: true, revision: row.revision + 1, result };
    await c.query(
      "INSERT INTO command_receipts(user_id,request_id,result,request_hash) VALUES($1,$2,$3,$4)",
      [user.id, body.requestId, JSON.stringify(receipt), hash],
    );
    return receipt;
  });
}
module.exports = {
  pool,
  migrate,
  transaction,
  mutate,
  syncEntityMirror,
  hydrateEntityMirror,
  loadState,
  persistedState,
  canonicalEntityStateEnabled,
  MIRRORED_COLLECTIONS,
};
