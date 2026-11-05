-- Markdown representation switches are settings, not generated documents.
CREATE TABLE IF NOT EXISTS agent_markdown_settings (
  id uuid PRIMARY KEY,
  site_key text NOT NULL,
  entry_id uuid REFERENCES entries(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  settings_generation integer NOT NULL DEFAULT 0 CHECK (settings_generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_markdown_settings_site_uq
  ON agent_markdown_settings (site_key) WHERE entry_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_markdown_settings_entry_uq
  ON agent_markdown_settings (site_key, entry_id) WHERE entry_id IS NOT NULL;
