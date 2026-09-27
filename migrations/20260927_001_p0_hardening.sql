-- P0 hardening baseline: normalized ordering + external object-storage metadata.
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
