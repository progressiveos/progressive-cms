-- CORE-PAYMENTS-ADMIN-CONFIG-01: Admin-managed merchant credentials.
--
-- Credential VALUES of one provider connection are stored encrypted (AES-256-
-- GCM, structural secret box) keyed by the connection UUID and the provider's
-- declared slot. The namespace is the UUID, never the extension id: several
-- merchant connections of one provider type own independent credentials, and
-- uninstalling an extension never destroys the keys of payment history.
-- Nothing here replaces payment history: the FK cascades only when the empty
-- connection itself is deleted (an instance with payments cannot be deleted).
CREATE TABLE payment_provider_runtime_secret (
  instance_id uuid NOT NULL REFERENCES payment_provider_instance(id) ON DELETE CASCADE,
  slot text NOT NULL,
  value_enc bytea NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT payment_provider_runtime_secret_pkey PRIMARY KEY (instance_id, slot),
  CONSTRAINT payment_provider_runtime_secret_slot_shape
    CHECK (slot ~ '^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$')
);

-- Optimistic-concurrency token for the atomic settings save: config, enabled,
-- credentials and this counter move together in one transaction.
ALTER TABLE payment_provider_instance
  ADD COLUMN settings_generation integer NOT NULL DEFAULT 0;

ALTER TABLE payment_provider_instance
  ADD CONSTRAINT payment_provider_instance_settings_generation_check
  CHECK (settings_generation >= 0);
