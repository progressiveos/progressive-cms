-- Keep the journal/FKs while retiring heavy snapshots durably before file removal.
ALTER TABLE theme_revisions
  ADD COLUMN pruned_at timestamptz,
  ADD COLUMN files_deleted_at timestamptz,
  ADD CONSTRAINT theme_revision_cleanup_state CHECK (files_deleted_at IS NULL OR pruned_at IS NOT NULL);
CREATE INDEX theme_revisions_cleanup_pending ON theme_revisions(site_key)
  WHERE pruned_at IS NOT NULL AND files_deleted_at IS NULL;
