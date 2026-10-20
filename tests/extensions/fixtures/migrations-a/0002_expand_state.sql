ALTER TABLE ext_site_basics_state ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
