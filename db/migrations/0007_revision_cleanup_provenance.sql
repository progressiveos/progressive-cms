-- Sanctioned cleanup may detach ancestry; sealed content remains immutable.
CREATE OR REPLACE FUNCTION public.revisions_guard_sealed_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.state = 'SEALED' AND (
           NEW.state IS DISTINCT FROM OLD.state
        OR NEW.payload IS DISTINCT FROM OLD.payload
        OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
        OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
        OR NEW.media_versions IS DISTINCT FROM OLD.media_versions
        OR NEW.sidecar IS DISTINCT FROM OLD.sidecar
        OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
        OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
        OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
        OR (NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id AND NOT (
               coalesce(current_setting('pcms.allow_sealed_delete', true), '') = 'on'
               AND NEW.parent_revision_id IS NULL
           ))
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.locale IS DISTINCT FROM OLD.locale
        OR NEW.origin IS DISTINCT FROM OLD.origin
        OR NEW.created_by_type IS DISTINCT FROM OLD.created_by_type
        OR NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.source_run_id IS DISTINCT FROM OLD.source_run_id
        OR NEW.bundle_id IS DISTINCT FROM OLD.bundle_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
        OR NEW.edit_generation IS DISTINCT FROM OLD.edit_generation
    ) THEN
        RAISE EXCEPTION 'SEALED revision % is immutable (Publication spec §6)', OLD.id;
    END IF;
    RETURN NEW;
END $$;
