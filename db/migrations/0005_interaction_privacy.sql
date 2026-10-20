-- Addressed owner operations; no consent/legal policy is imposed on websites.
CREATE TABLE interaction_privacy_subjects (
  entity text NOT NULL CHECK (entity IN ('submission', 'quiz_run')),
  entity_id uuid NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  erased boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity, entity_id)
);
ALTER TABLE publication_outbox ADD COLUMN privacy_blocked boolean NOT NULL DEFAULT false, ADD COLUMN privacy_retired boolean NOT NULL DEFAULT false;
ALTER TABLE integration_delivery ADD COLUMN external_copy_possible boolean NOT NULL DEFAULT true, ADD COLUMN privacy_blocked boolean NOT NULL DEFAULT false, ADD COLUMN privacy_retired boolean NOT NULL DEFAULT false;
-- Historical attempts may have reached a recipient before outcome persistence.
-- PostgreSQL fast defaults mark existing rows conservatively without a table rewrite.
ALTER TABLE integration_delivery ALTER COLUMN external_copy_possible SET DEFAULT false;
CREATE TABLE interaction_privacy_cases (
  id uuid PRIMARY KEY,
  target_entity text NOT NULL CHECK (target_entity IN ('submission', 'quiz_run', 'lead')),
  target_id uuid NOT NULL,
  source_entity text NOT NULL CHECK (source_entity IN ('submission', 'quiz_run')),
  source_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('rectify', 'block', 'unblock', 'erase')),
  local_state text NOT NULL CHECK (local_state IN ('rectified', 'blocked', 'unblocked', 'erased')),
  operation_fingerprint text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  request_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE interaction_privacy_followups (
  case_id uuid NOT NULL REFERENCES interaction_privacy_cases(id),
  delivery_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'acknowledged', 'owner_exception')),
  external_id text,
  evidence_ref text,
  resolved_actor_type text,
  resolved_by text,
  resolved_at timestamptz,
  PRIMARY KEY (case_id, delivery_id)
);
