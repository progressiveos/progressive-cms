-- Immutable Theme lifecycle snapshots and a recoverable publication journal.
CREATE TABLE theme_revisions (
  id uuid PRIMARY KEY,
  site_key text NOT NULL,
  theme_key text NOT NULL,
  package_version text NOT NULL,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^[a-f0-9-]{36}$'),
  settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_key, id)
);
CREATE TABLE theme_operations (
  id uuid PRIMARY KEY,
  site_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('UPDATE', 'ACTIVATE', 'SETTINGS', 'ROLLBACK')),
  from_revision_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  expected_generation bigint NOT NULL,
  phase text NOT NULL CHECK (phase IN ('PREPARED', 'COMMITTED', 'ABORTED')),
  catalog_theme_key text,
  catalog_before_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (site_key, from_revision_id) REFERENCES theme_revisions(site_key, id),
  FOREIGN KEY (site_key, target_revision_id) REFERENCES theme_revisions(site_key, id),
  FOREIGN KEY (site_key, catalog_before_revision_id) REFERENCES theme_revisions(site_key, id),
  UNIQUE (site_key, id)
);
CREATE UNIQUE INDEX theme_operations_pending ON theme_operations(site_key) WHERE phase = 'PREPARED';
ALTER TABLE admin_theme_state
  ADD COLUMN active_revision_id uuid,
  ADD COLUMN theme_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN pending_operation_id uuid,
  ADD FOREIGN KEY (site_key, active_revision_id) REFERENCES theme_revisions(site_key, id),
  ADD FOREIGN KEY (site_key, pending_operation_id) REFERENCES theme_operations(site_key, id);
