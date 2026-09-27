-- P0 hardening baseline: dedicated business tables + external object-storage metadata.
ALTER TABLE entity_records ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS entity_records_order_idx
  ON entity_records(collection,position,entity_id);

ALTER TABLE file_contents ALTER COLUMN content DROP NOT NULL;
ALTER TABLE file_contents
  ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 'database';
ALTER TABLE file_contents ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE file_contents ADD COLUMN IF NOT EXISTS size BIGINT;

CREATE TABLE IF NOT EXISTS object_deletion_queue(
  storage_key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sg_companies(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_companies_company_idx ON sg_companies(company);
CREATE INDEX IF NOT EXISTS sg_companies_position_idx ON sg_companies(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_employees(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_employees_company_idx ON sg_employees(company);
CREATE INDEX IF NOT EXISTS sg_employees_position_idx ON sg_employees(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_clients(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_clients_company_idx ON sg_clients(company);
CREATE INDEX IF NOT EXISTS sg_clients_position_idx ON sg_clients(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_projects(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_projects_company_idx ON sg_projects(company);
CREATE INDEX IF NOT EXISTS sg_projects_position_idx ON sg_projects(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_time_entries(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_time_entries_company_idx ON sg_time_entries(company);
CREATE INDEX IF NOT EXISTS sg_time_entries_position_idx ON sg_time_entries(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_planning(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_planning_company_idx ON sg_planning(company);
CREATE INDEX IF NOT EXISTS sg_planning_position_idx ON sg_planning(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_absences(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_absences_company_idx ON sg_absences(company);
CREATE INDEX IF NOT EXISTS sg_absences_position_idx ON sg_absences(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_quotes(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_quotes_company_idx ON sg_quotes(company);
CREATE INDEX IF NOT EXISTS sg_quotes_position_idx ON sg_quotes(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_invoices(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_invoices_company_idx ON sg_invoices(company);
CREATE INDEX IF NOT EXISTS sg_invoices_position_idx ON sg_invoices(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_payments(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_payments_company_idx ON sg_payments(company);
CREATE INDEX IF NOT EXISTS sg_payments_position_idx ON sg_payments(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_expenses(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_expenses_company_idx ON sg_expenses(company);
CREATE INDEX IF NOT EXISTS sg_expenses_position_idx ON sg_expenses(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_inventory(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_inventory_company_idx ON sg_inventory(company);
CREATE INDEX IF NOT EXISTS sg_inventory_position_idx ON sg_inventory(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_suppliers(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_suppliers_company_idx ON sg_suppliers(company);
CREATE INDEX IF NOT EXISTS sg_suppliers_position_idx ON sg_suppliers(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_vehicles(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_vehicles_company_idx ON sg_vehicles(company);
CREATE INDEX IF NOT EXISTS sg_vehicles_position_idx ON sg_vehicles(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_tools(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_tools_company_idx ON sg_tools(company);
CREATE INDEX IF NOT EXISTS sg_tools_position_idx ON sg_tools(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_maintenance(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_maintenance_company_idx ON sg_maintenance(company);
CREATE INDEX IF NOT EXISTS sg_maintenance_position_idx ON sg_maintenance(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_documents(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_documents_company_idx ON sg_documents(company);
CREATE INDEX IF NOT EXISTS sg_documents_position_idx ON sg_documents(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_messages(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_messages_company_idx ON sg_messages(company);
CREATE INDEX IF NOT EXISTS sg_messages_position_idx ON sg_messages(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_message_threads(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_message_threads_company_idx ON sg_message_threads(company);
CREATE INDEX IF NOT EXISTS sg_message_threads_position_idx ON sg_message_threads(position,entity_id);

CREATE TABLE IF NOT EXISTS sg_clocks(
  entity_id TEXT PRIMARY KEY,
  company TEXT,
  data JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sg_clocks_company_idx ON sg_clocks(company);
CREATE INDEX IF NOT EXISTS sg_clocks_position_idx ON sg_clocks(position,entity_id);

