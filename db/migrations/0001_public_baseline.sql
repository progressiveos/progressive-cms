-- Public Core baseline: composed from a clean database at the Architecture Freeze.
-- Rebuild only for a new public baseline; post-baseline changes get numbered forward migrations.
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-1.pgdg24.04+2)
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-1.pgdg24.04+2)


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: analytics_events_guard_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analytics_events_guard_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'analytics_events are append-only';
END $$;


--
-- Name: publication_events_guard_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publication_events_guard_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'publication_events are append-only (Publication spec §61)';
END $$;


--
-- Name: revisions_guard_sealed_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revisions_guard_sealed_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF coalesce(current_setting('pcms.allow_sealed_delete', true), '') = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'SEALED revision % cannot be deleted (Publication spec §6)', OLD.id;
END $$;


--
-- Name: revisions_guard_sealed_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revisions_guard_sealed_update() RETURNS trigger
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
        OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
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


--
-- Name: search_locale_config(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_locale_config(locale text) RETURNS regconfig
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN locale LIKE 'ru%' THEN 'russian'::regconfig
    WHEN locale LIKE 'en%' THEN 'english'::regconfig
    ELSE 'simple'::regconfig
  END
$$;




--
-- Name: access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_tokens (
    id uuid NOT NULL,
    service_account_id uuid NOT NULL,
    prefix text NOT NULL,
    token_hash text NOT NULL,
    scopes text[] NOT NULL,
    site_key text,
    environment text,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_reason text
);


--
-- Name: admin_theme_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_theme_state (
    site_key text NOT NULL,
    theme_key text,
    theme_version text,
    settings jsonb,
    settings_generation integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: analytics_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_events (
    id uuid NOT NULL,
    site_key text NOT NULL,
    event_type text NOT NULL,
    provider text,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    transport text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analytics_events_event_type_check CHECK ((event_type = ANY (ARRAY['ANALYTICS_SETTINGS_UPDATED'::text, 'ANALYTICS_PROVIDER_ENABLED'::text, 'ANALYTICS_PROVIDER_DISABLED'::text, 'ANALYTICS_NETWORK_RULE_ADDED'::text, 'ANALYTICS_NETWORK_RULE_UPDATED'::text, 'ANALYTICS_NETWORK_RULE_REMOVED'::text])))
);


--
-- Name: analytics_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_settings (
    site_key text NOT NULL,
    settings jsonb NOT NULL,
    settings_generation integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_idempotency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_idempotency (
    key text NOT NULL,
    scope text NOT NULL,
    operation text NOT NULL,
    request_hash text NOT NULL,
    status text NOT NULL,
    response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: auth_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_credentials (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    verifier text,
    params jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_one_time_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_one_time_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text
);


--
-- Name: auth_recovery_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_recovery_codes (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_role_permissions (
    role_key text NOT NULL,
    permission_key text NOT NULL
);


--
-- Name: auth_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_roles (
    key text NOT NULL,
    name text NOT NULL,
    builtin boolean DEFAULT false NOT NULL,
    immutable boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text
);


--
-- Name: auth_security_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_security_events (
    id uuid NOT NULL,
    event_type text NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    subject_type text,
    subject_id text,
    site_key text,
    environment text,
    transport text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    authenticated_at timestamp with time zone NOT NULL,
    mfa_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_reason text,
    metadata jsonb,
    csrf_hash text
);


--
-- Name: auth_throttle_buckets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_throttle_buckets (
    bucket text NOT NULL,
    fail_count integer DEFAULT 0 NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_totp; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_totp (
    user_id uuid NOT NULL,
    secret_encrypted bytea NOT NULL,
    digits integer DEFAULT 6 NOT NULL,
    period_seconds integer DEFAULT 30 NOT NULL,
    algorithm text DEFAULT 'SHA1'::text NOT NULL,
    pending boolean DEFAULT true NOT NULL,
    confirmed_at timestamp with time zone,
    last_used_step bigint,
    disabled_at timestamp with time zone,
    disabled_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user_roles (
    user_id uuid NOT NULL,
    role_key text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    granted_by text
);


--
-- Name: changeset_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.changeset_items (
    id uuid NOT NULL,
    changeset_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    context text DEFAULT 'default'::text NOT NULL,
    intent text NOT NULL,
    target_revision_id uuid,
    expected_generation integer NOT NULL,
    route_operation jsonb,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT changeset_items_check CHECK (((intent = 'UNPUBLISH'::text) OR (target_revision_id IS NOT NULL))),
    CONSTRAINT changeset_items_intent_check CHECK ((intent = ANY (ARRAY['PUBLISH'::text, 'UNPUBLISH'::text])))
);


--
-- Name: changesets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.changesets (
    id uuid NOT NULL,
    title text NOT NULL,
    state text NOT NULL,
    created_by_type text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT changesets_created_by_type_check CHECK ((created_by_type = ANY (ARRAY['human'::text, 'service_account'::text, 'system'::text, 'operator'::text]))),
    CONSTRAINT changesets_state_check CHECK ((state = ANY (ARRAY['OPEN'::text, 'READY'::text, 'APPLIED'::text, 'PARTIALLY_SCHEDULED'::text, 'CANCELLED'::text, 'FAILED'::text])))
);


--
-- Name: content_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_references (
    source_entry_id uuid NOT NULL,
    source_path text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_references_target_kind_check CHECK ((target_kind = ANY (ARRAY['entry'::text, 'media'::text])))
);


--
-- Name: domain_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domain_bindings (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    hostname text NOT NULL,
    scheme_policy text DEFAULT 'https'::text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    canonical_redirect_policy text DEFAULT 'redirect'::text NOT NULL,
    locale text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entries (
    id uuid NOT NULL,
    content_type_id text NOT NULL,
    parent_entry_id uuid,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    locale text DEFAULT 'default'::text NOT NULL,
    translation_group_id uuid,
    entry_kind text DEFAULT 'content'::text NOT NULL,
    template_key text,
    CONSTRAINT entries_entry_kind_check CHECK ((entry_kind = ANY (ARRAY['content'::text, 'folder'::text])))
);


--
-- Name: entry_external_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entry_external_identities (
    site_key text DEFAULT 'default'::text NOT NULL,
    source_namespace text NOT NULL,
    external_id text NOT NULL,
    entry_id uuid NOT NULL,
    last_agent_generation integer,
    source_hash text,
    last_agent_run_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: extension_runtime_secret; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.extension_runtime_secret (
    extension_id text NOT NULL,
    slot text NOT NULL,
    value_enc bytea NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    updated_by text NOT NULL
);


--
-- Name: forms_form_definition_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms_form_definition_versions (
    definition_id uuid NOT NULL,
    schema_version integer NOT NULL,
    fields jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT forms_form_definition_versions_schema_version_check CHECK ((schema_version >= 1))
);


--
-- Name: forms_form_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms_form_definitions (
    id uuid NOT NULL,
    key text NOT NULL,
    title text NOT NULL,
    current_schema_version integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT forms_form_definitions_current_schema_version_check CHECK ((current_schema_version >= 1)),
    CONSTRAINT forms_form_definitions_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'ARCHIVED'::text])))
);


--
-- Name: forms_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms_leads (
    id uuid NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    status text DEFAULT 'NEW'::text NOT NULL,
    name text,
    email text,
    phone text,
    summary text DEFAULT ''::text NOT NULL,
    classification text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    presentation text DEFAULT ''::text NOT NULL,
    attribution jsonb,
    CONSTRAINT forms_leads_source_type_check CHECK ((source_type = ANY (ARRAY['FORM_SUBMISSION'::text, 'QUIZ_RUN'::text]))),
    CONSTRAINT forms_leads_status_check CHECK ((status = ANY (ARRAY['NEW'::text, 'VIEWED'::text, 'PROCESSED'::text, 'ARCHIVED'::text, 'SPAM'::text])))
);


--
-- Name: forms_quiz_answers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms_quiz_answers (
    id uuid NOT NULL,
    run_id uuid NOT NULL,
    question_id text NOT NULL,
    value jsonb NOT NULL,
    answered_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forms_quiz_definition_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms_quiz_definition_versions (
    quiz_definition_id uuid NOT NULL,
    schema_version integer NOT NULL,
    steps jsonb NOT NULL,
    branching_rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    scoring_rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    outcomes jsonb DEFAULT '[]'::jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT forms_quiz_definition_versions_schema_version_check CHECK ((schema_version >= 1))
);


--
-- Name: forms_quiz_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms_quiz_definitions (
    id uuid NOT NULL,
    key text NOT NULL,
    title text NOT NULL,
    current_schema_version integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT forms_quiz_definitions_current_schema_version_check CHECK ((current_schema_version >= 1)),
    CONSTRAINT forms_quiz_definitions_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'ARCHIVED'::text])))
);


--
-- Name: forms_quiz_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms_quiz_runs (
    id uuid NOT NULL,
    quiz_definition_id uuid NOT NULL,
    quiz_schema_version integer NOT NULL,
    state text DEFAULT 'STARTED'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    source_entry_id uuid,
    session_token_hash text NOT NULL,
    session_expires_at timestamp with time zone NOT NULL,
    score integer,
    outcome_id text,
    lead_id uuid,
    submit_ip_hash text,
    user_agent text,
    anonymized_at timestamp with time zone,
    attribution jsonb,
    CONSTRAINT forms_quiz_runs_state_check CHECK ((state = ANY (ARRAY['STARTED'::text, 'COMPLETED'::text, 'ABANDONED'::text, 'EXPIRED'::text])))
);


--
-- Name: forms_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms_submissions (
    id uuid NOT NULL,
    form_definition_id uuid NOT NULL,
    form_schema_version integer NOT NULL,
    status text DEFAULT 'ACCEPTED'::text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    source_entry_id uuid,
    source_url_snapshot text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    consent_snapshot jsonb DEFAULT '[]'::jsonb NOT NULL,
    submission_token_hash text,
    submit_ip_hash text,
    user_agent text,
    spam_reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    anonymized_at timestamp with time zone,
    locale text,
    attribution jsonb,
    CONSTRAINT forms_submissions_status_check CHECK ((status = ANY (ARRAY['ACCEPTED'::text, 'SPAM'::text, 'ARCHIVED'::text])))
);


--
-- Name: global_content; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.global_content (
    id uuid NOT NULL,
    key text NOT NULL,
    content_type_key text NOT NULL,
    schema_version integer NOT NULL,
    fields jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT global_content_schema_version_check CHECK ((schema_version >= 1))
);


--
-- Name: integration_binding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_binding (
    id uuid NOT NULL,
    event_type text NOT NULL,
    source_filter text,
    conditions jsonb DEFAULT '[]'::jsonb NOT NULL,
    actions jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    failure_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: integration_delivery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_delivery (
    id uuid NOT NULL,
    outbox_event_id uuid NOT NULL,
    event_type text NOT NULL,
    binding_id uuid NOT NULL,
    action_index integer NOT NULL,
    instance_id uuid NOT NULL,
    action_type text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    next_attempt_at timestamp with time zone,
    external_id text,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    body_revision smallint DEFAULT 1 NOT NULL,
    CONSTRAINT integration_delivery_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'SUCCEEDED'::text, 'FAILED_RETRYABLE'::text, 'FAILED_PERMANENT'::text, 'CANCELLED'::text])))
);


--
-- Name: integration_delivery_attempt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_delivery_attempt (
    id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    attempt_no integer NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    result text NOT NULL,
    http_status integer,
    provider_error_code text,
    error_summary text,
    CONSTRAINT integration_delivery_attempt_result_check CHECK ((result = ANY (ARRAY['SUCCEEDED'::text, 'FAILED_RETRYABLE'::text, 'FAILED_PERMANENT'::text])))
);


--
-- Name: integration_inbound_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_inbound_event (
    id uuid NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    provider_event_id text,
    dedup_key text NOT NULL,
    payload_hash text NOT NULL,
    event_type text,
    raw_payload jsonb,
    status text DEFAULT 'RECEIVED'::text NOT NULL,
    error_code text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    transport jsonb,
    headers jsonb,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    CONSTRAINT integration_inbound_event_source_type_check CHECK ((source_type = ANY (ARRAY['integration_instance'::text, 'payment_provider'::text]))),
    CONSTRAINT integration_inbound_event_status_check CHECK ((status = ANY (ARRAY['RECEIVED'::text, 'PROCESSED'::text, 'FAILED'::text])))
);


--
-- Name: integration_instance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_instance (
    id uuid NOT NULL,
    connector_type text NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    secret_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
    site_key text,
    environment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: integration_runtime_secret; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_runtime_secret (
    instance_id uuid NOT NULL,
    key text NOT NULL,
    value_enc bytea NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    updated_by text NOT NULL
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    claim_expires_at timestamp with time zone,
    last_error text,
    error_kind text,
    origin text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    payload_version integer,
    CONSTRAINT jobs_error_kind_check CHECK ((error_kind = ANY (ARRAY['transient'::text, 'permanent'::text, 'cancelled'::text]))),
    CONSTRAINT jobs_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'DEAD'::text, 'CANCELLED'::text])))
);


--
-- Name: media_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_assets (
    id uuid NOT NULL,
    kind text NOT NULL,
    current_version_no integer NOT NULL,
    original_blob_id uuid NOT NULL,
    filename_original text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    width integer,
    height integer,
    duration_ms integer,
    focal_x numeric(4,3),
    focal_y numeric(4,3),
    title text,
    alt_default text,
    caption_default text,
    description text,
    source_name text,
    source_url text,
    author text,
    license text,
    copyright text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    folder_id uuid,
    origin text DEFAULT 'upload'::text NOT NULL,
    provider_id text,
    provider_asset_id text,
    provenance jsonb,
    CONSTRAINT media_assets_current_version_no_check CHECK ((current_version_no >= 1)),
    CONSTRAINT media_assets_focal_x_check CHECK (((focal_x IS NULL) OR ((focal_x >= (0)::numeric) AND (focal_x <= (1)::numeric)))),
    CONSTRAINT media_assets_focal_y_check CHECK (((focal_y IS NULL) OR ((focal_y >= (0)::numeric) AND (focal_y <= (1)::numeric)))),
    CONSTRAINT media_assets_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'document'::text, 'generic_file'::text, 'video'::text, 'audio'::text]))),
    CONSTRAINT media_assets_origin_check CHECK ((origin = ANY (ARRAY['upload'::text, 'import'::text, 'stock'::text, 'generated'::text]))),
    CONSTRAINT media_assets_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: media_blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_blobs (
    id uuid NOT NULL,
    sha256 text NOT NULL,
    size_bytes bigint NOT NULL,
    storage_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_blobs_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_blobs_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: media_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_folders (
    id uuid NOT NULL,
    name text NOT NULL,
    parent_id uuid,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_folders_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 200)))
);


--
-- Name: media_generation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_generation_runs (
    id uuid NOT NULL,
    provider_id text NOT NULL,
    extension_id text NOT NULL,
    model text,
    prompt text NOT NULL,
    negative_prompt text,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    candidates jsonb DEFAULT '[]'::jsonb NOT NULL,
    provider_request_id text,
    cost numeric,
    error_code text,
    error_message text,
    accepted jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT media_generation_runs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'ready'::text, 'failed'::text])))
);


--
-- Name: media_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_variants (
    id uuid NOT NULL,
    asset_id uuid NOT NULL,
    version_no integer NOT NULL,
    preset_id text NOT NULL,
    format text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    size_bytes bigint NOT NULL,
    blob_id uuid NOT NULL,
    variant_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_variants_format_check CHECK ((format = ANY (ARRAY['avif'::text, 'webp'::text, 'jpeg'::text, 'png'::text]))),
    CONSTRAINT media_variants_height_check CHECK ((height > 0)),
    CONSTRAINT media_variants_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT media_variants_width_check CHECK ((width > 0))
);


--
-- Name: media_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_versions (
    asset_id uuid NOT NULL,
    version_no integer NOT NULL,
    blob_id uuid NOT NULL,
    filename_original text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    width integer,
    height integer,
    note text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_versions_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT media_versions_version_no_check CHECK ((version_no >= 1))
);


--
-- Name: navigation_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.navigation_items (
    id uuid NOT NULL,
    set_id uuid NOT NULL,
    parent_item_id uuid,
    sibling_order integer NOT NULL,
    item_type text NOT NULL,
    label text,
    target jsonb,
    ui_intent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_key uuid GENERATED ALWAYS AS (COALESCE(parent_item_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED
);


--
-- Name: navigation_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.navigation_overrides (
    id uuid NOT NULL,
    set_id uuid NOT NULL,
    target_item_id uuid NOT NULL,
    op text NOT NULL,
    payload jsonb NOT NULL,
    apply_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: navigation_placement_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.navigation_placement_bindings (
    placement_key text NOT NULL,
    navigation_set_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: navigation_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.navigation_revisions (
    id uuid NOT NULL,
    set_id uuid NOT NULL,
    revision integer NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: navigation_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.navigation_sets (
    id uuid NOT NULL,
    key text NOT NULL,
    title text NOT NULL,
    derived_from_set_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: notification_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_cursors (
    source text NOT NULL,
    cursor text NOT NULL
);


--
-- Name: notification_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_events (
    id uuid NOT NULL,
    category text NOT NULL,
    event_type text NOT NULL,
    source_id text DEFAULT ''::text NOT NULL,
    title text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    chips jsonb DEFAULT '[]'::jsonb NOT NULL,
    form_definition_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT notification_events_category_check CHECK ((category = ANY (ARRAY['leads'::text, 'forms'::text, 'quizzes'::text, 'system'::text])))
);


--
-- Name: notification_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_sends (
    notification_id uuid NOT NULL,
    user_id uuid NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_settings (
    id smallint DEFAULT 1 NOT NULL,
    settings jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_settings_id_check CHECK ((id = 1))
);


--
-- Name: payment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment (
    id uuid NOT NULL,
    provider_instance_id uuid NOT NULL,
    external_payment_id text,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    amount numeric(14,2) NOT NULL,
    currency text NOT NULL,
    status text NOT NULL,
    description text,
    idempotency_key text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    refunded_amount numeric(14,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    CONSTRAINT payment_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT payment_check CHECK ((refunded_amount <= amount)),
    CONSTRAINT payment_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT payment_description_check CHECK (((description IS NULL) OR (length(description) <= 500))),
    CONSTRAINT payment_idempotency_key_check CHECK (((length(idempotency_key) >= 8) AND (length(idempotency_key) <= 200))),
    CONSTRAINT payment_refunded_amount_check CHECK ((refunded_amount >= (0)::numeric)),
    CONSTRAINT payment_status_check CHECK ((status = ANY (ARRAY['CREATED'::text, 'PENDING'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'CANCELLED'::text, 'PARTIALLY_REFUNDED'::text, 'REFUNDED'::text]))),
    CONSTRAINT payment_subject_type_check CHECK (((subject_type = ANY (ARRAY['form_submission'::text, 'quiz_run'::text, 'lead'::text, 'order'::text])) OR (subject_type ~~ 'extension:%'::text)))
);


--
-- Name: payment_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_event (
    id uuid NOT NULL,
    seq bigint NOT NULL,
    payment_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_type text,
    actor_id text,
    source text DEFAULT 'system'::text NOT NULL,
    provider_event_id text,
    inbound_event_id uuid,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_event_event_type_check CHECK ((event_type = ANY (ARRAY['CREATED'::text, 'PROVIDER_PENDING'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'CANCELLED'::text, 'REFUND_REQUESTED'::text, 'PARTIALLY_REFUNDED'::text, 'REFUNDED'::text, 'SYNCED'::text]))),
    CONSTRAINT payment_event_source_check CHECK ((source = ANY (ARRAY['operator'::text, 'provider'::text, 'system'::text])))
);


--
-- Name: payment_event_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.payment_event ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.payment_event_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: payment_provider_instance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_provider_instance (
    id uuid NOT NULL,
    provider_type text NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    secret_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_refund; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_refund (
    id uuid NOT NULL,
    payment_id uuid NOT NULL,
    provider_instance_id uuid NOT NULL,
    amount numeric(14,2) NOT NULL,
    currency text NOT NULL,
    status text NOT NULL,
    idempotency_key text NOT NULL,
    provider_refund_id text,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_refund_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT payment_refund_status_check CHECK ((status = ANY (ARRAY['REQUESTED'::text, 'SUBMITTED'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'NEEDS_REVIEW'::text])))
);


--
-- Name: pcms_content_type_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_content_type_overrides (
    content_type_id text NOT NULL,
    version integer NOT NULL,
    definition jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text NOT NULL
);


--
-- Name: pcms_extension_event_consumptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_extension_event_consumptions (
    event_id uuid NOT NULL,
    extension_id text NOT NULL,
    subscription_id text NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcms_extension_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_extension_installations (
    extension_id text NOT NULL,
    version text NOT NULL,
    state text NOT NULL,
    manifest_fingerprint text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    installed_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    artifact_digest text,
    CONSTRAINT pcms_extension_installations_state_check CHECK ((state = ANY (ARRAY['INSTALLED'::text, 'ENABLED'::text, 'DISABLED'::text])))
);


--
-- Name: pcms_extension_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_extension_migrations (
    extension_id text NOT NULL,
    extension_version text NOT NULL,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcms_extension_mount_redirects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_extension_mount_redirects (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    extension_id text NOT NULL,
    from_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone
);


--
-- Name: pcms_extension_route_mounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_extension_route_mounts (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    extension_id text NOT NULL,
    mount_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone
);


--
-- Name: pcms_extension_state_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_extension_state_revision (
    id boolean DEFAULT true NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT pcms_extension_state_revision_id_check CHECK (id)
);


--
-- Name: pcms_kernel_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_kernel_metadata (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pcms_mail_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_mail_settings (
    id integer NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    from_address text,
    host text,
    port integer,
    mode text,
    username text,
    password_enc bytea,
    updated_at timestamp with time zone NOT NULL,
    updated_by text NOT NULL,
    CONSTRAINT pcms_mail_settings_id_check CHECK ((id = 1)),
    CONSTRAINT pcms_mail_settings_mode_check CHECK ((mode = ANY (ARRAY['smtps'::text, 'starttls'::text, 'plain'::text])))
);


--
-- Name: pcms_maintenance_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_maintenance_state (
    id integer NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    promo_label text NOT NULL,
    promo_url text NOT NULL,
    retry_after_seconds integer DEFAULT 3600 NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    updated_by text NOT NULL,
    CONSTRAINT pcms_maintenance_state_id_check CHECK ((id = 1))
);


--
-- Name: pcms_metric_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_metric_samples (
    ts timestamp with time zone NOT NULL,
    cpu_percent real,
    memory_used_bytes bigint,
    memory_limit_bytes bigint,
    queue_pending integer,
    queue_dead integer,
    outbox_pending integer
);


--
-- Name: pcms_site_localization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_site_localization (
    id integer NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    default_locale text DEFAULT 'ru-RU'::text NOT NULL,
    locales jsonb DEFAULT '[]'::jsonb NOT NULL,
    routing_strategy text DEFAULT 'path_prefix'::text NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    updated_by text NOT NULL,
    CONSTRAINT pcms_site_localization_id_check CHECK ((id = 1)),
    CONSTRAINT pcms_site_localization_routing_strategy_check CHECK ((routing_strategy = 'path_prefix'::text))
);


--
-- Name: pcms_update_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_update_history (
    id uuid NOT NULL,
    from_version text NOT NULL,
    to_version text NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    status text NOT NULL,
    core_migrations jsonb DEFAULT '[]'::jsonb NOT NULL,
    extension_migrations jsonb DEFAULT '[]'::jsonb NOT NULL,
    validation_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    failure_code text,
    rollback_policy text NOT NULL,
    CONSTRAINT pcms_update_history_status_check CHECK ((status = ANY (ARRAY['RUNNING'::text, 'SUCCEEDED'::text, 'FAILED'::text])))
);


--
-- Name: pcms_worker_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcms_worker_heartbeat (
    id integer NOT NULL,
    boot_id text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    last_beat_at timestamp with time zone NOT NULL,
    loop_count bigint DEFAULT 0 NOT NULL,
    CONSTRAINT pcms_worker_heartbeat_id_check CHECK ((id = 1))
);


--
-- Name: publication_bundle_ingest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publication_bundle_ingest (
    id uuid NOT NULL,
    bundle_id text NOT NULL,
    principal_type text NOT NULL,
    principal_id text NOT NULL,
    pcpub_version integer NOT NULL,
    pcmd_version integer NOT NULL,
    payload_digest text NOT NULL,
    archive_sha256 text NOT NULL,
    stage text NOT NULL,
    outcome text,
    changeset_id uuid,
    result jsonb,
    manifest_json jsonb NOT NULL,
    principal_permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    error_code text,
    safe_error_detail jsonb,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    quarantine_path text,
    CONSTRAINT publication_bundle_ingest_bundle_id_check CHECK ((bundle_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT publication_bundle_ingest_outcome_check CHECK ((outcome = ANY (ARRAY['sealed'::text, 'published'::text, 'conflict'::text, 'rejected'::text, 'failed'::text]))),
    CONSTRAINT publication_bundle_ingest_stage_known CHECK ((stage = ANY (ARRAY['received'::text, 'validating_archive'::text, 'validating_documents'::text, 'staging_media'::text, 'resolving_refs'::text, 'creating_candidates'::text, 'validating_candidates'::text, 'creating_changeset'::text, 'applying_intent'::text, 'complete'::text])))
);


--
-- Name: publication_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publication_events (
    id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    context text NOT NULL,
    event_type text NOT NULL,
    from_revision_id uuid,
    to_revision_id uuid,
    actor_class text NOT NULL,
    actor_id text NOT NULL,
    reason text,
    changeset_id uuid,
    job_id uuid,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_events_actor_class_check CHECK ((actor_class = ANY (ARRAY['human'::text, 'service_account'::text, 'system'::text, 'operator'::text]))),
    CONSTRAINT publication_events_event_type_check CHECK ((event_type = ANY (ARRAY['PUBLISH_FIRST'::text, 'PUBLISH_UPDATE'::text, 'UNPUBLISH'::text, 'ROLLBACK'::text, 'SCHEDULE_CREATED'::text, 'SCHEDULE_CANCELLED'::text])))
);


--
-- Name: publication_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publication_outbox (
    id uuid NOT NULL,
    aggregate text NOT NULL,
    aggregate_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    claim_expires_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT publication_outbox_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'DONE'::text, 'DEAD'::text])))
);


--
-- Name: publication_plan_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publication_plan_items (
    id uuid NOT NULL,
    plan_id uuid NOT NULL,
    changeset_item_id uuid NOT NULL,
    batch_no integer NOT NULL,
    publish_at timestamp with time zone,
    unpublish_at timestamp with time zone,
    state text DEFAULT 'SCHEDULED'::text NOT NULL,
    publish_job_id uuid,
    unpublish_job_id uuid,
    last_error text,
    executed_at timestamp with time zone,
    CONSTRAINT publication_plan_items_state_check CHECK ((state = ANY (ARRAY['SCHEDULED'::text, 'PUBLISHED'::text, 'UNPUBLISHED'::text, 'FAILED'::text, 'CANCELLED'::text, 'PAUSED'::text])))
);


--
-- Name: publication_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publication_plans (
    id uuid NOT NULL,
    changeset_id uuid NOT NULL,
    status text NOT NULL,
    failure_policy text DEFAULT 'continue'::text NOT NULL,
    timezone text NOT NULL,
    created_by_type text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT publication_plans_created_by_type_check CHECK ((created_by_type = ANY (ARRAY['human'::text, 'service_account'::text, 'system'::text, 'operator'::text]))),
    CONSTRAINT publication_plans_failure_policy_check CHECK ((failure_policy = ANY (ARRAY['continue'::text, 'pause_batch'::text, 'pause_plan'::text]))),
    CONSTRAINT publication_plans_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'COMPILED'::text, 'COMPLETED'::text, 'CANCELLED'::text, 'PAUSED'::text])))
);


--
-- Name: publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publications (
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    context text DEFAULT 'default'::text NOT NULL,
    state text NOT NULL,
    current_revision_id uuid,
    current_payload_hash text,
    generation integer DEFAULT 0 NOT NULL,
    first_published_at timestamp with time zone,
    published_at timestamp with time zone,
    modified_at timestamp with time zone,
    unpublished_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publications_check CHECK (((state = 'UNPUBLISHED'::text) OR ((current_revision_id IS NOT NULL) AND (current_payload_hash IS NOT NULL) AND (first_published_at IS NOT NULL) AND (published_at IS NOT NULL) AND (modified_at IS NOT NULL)))),
    CONSTRAINT publications_state_check CHECK ((state = ANY (ARRAY['PUBLISHED'::text, 'UNPUBLISHED'::text])))
);


--
-- Name: revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revisions (
    id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    revision_no integer NOT NULL,
    parent_revision_id uuid,
    state text NOT NULL,
    payload jsonb NOT NULL,
    schema_version text NOT NULL,
    locale text DEFAULT 'default'::text NOT NULL,
    origin text NOT NULL,
    created_by_type text NOT NULL,
    created_by text NOT NULL,
    source_run_id text,
    bundle_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sealed_at timestamp with time zone,
    edit_generation integer DEFAULT 0 NOT NULL,
    payload_hash text,
    media_versions jsonb,
    sidecar jsonb,
    CONSTRAINT revisions_check CHECK (((state = 'WORKING'::text) OR ((sealed_at IS NOT NULL) AND (payload_hash IS NOT NULL)))),
    CONSTRAINT revisions_created_by_type_check CHECK ((created_by_type = ANY (ARRAY['human'::text, 'service_account'::text, 'system'::text, 'operator'::text]))),
    CONSTRAINT revisions_origin_check CHECK ((origin = ANY (ARRAY['human'::text, 'service_account'::text, 'import'::text, 'migration'::text, 'system'::text]))),
    CONSTRAINT revisions_state_check CHECK ((state = ANY (ARRAY['WORKING'::text, 'SEALED'::text])))
);


--
-- Name: route_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.route_history (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    domain_binding_id uuid,
    locale text DEFAULT 'x-default'::text NOT NULL,
    old_path text NOT NULL,
    target_type text,
    target_id text,
    status_code integer NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone
);


--
-- Name: routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.routes (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    domain_binding_id uuid,
    locale text DEFAULT 'x-default'::text NOT NULL,
    path text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    is_canonical boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone
);


--
-- Name: search_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_documents (
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    context text DEFAULT 'default'::text NOT NULL,
    site_id text NOT NULL,
    locale text DEFAULT 'default'::text NOT NULL,
    content_type text,
    revision_id text NOT NULL,
    generation integer NOT NULL,
    epoch bigint NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    structured_text text DEFAULT ''::text NOT NULL,
    body_text text DEFAULT ''::text NOT NULL,
    aux_text text DEFAULT ''::text NOT NULL,
    route text,
    published_at timestamp with time zone,
    modified_at timestamp with time zone,
    indexed_at timestamp with time zone DEFAULT now() NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (((setweight(to_tsvector(public.search_locale_config(locale), title), 'A'::"char") || setweight(to_tsvector(public.search_locale_config(locale), ((summary || ' '::text) || structured_text)), 'B'::"char")) || setweight(to_tsvector(public.search_locale_config(locale), body_text), 'C'::"char"))) STORED,
    aux_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, aux_text)) STORED
);


--
-- Name: search_index_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_index_state (
    id smallint DEFAULT 1 NOT NULL,
    index_version integer DEFAULT 0 NOT NULL,
    active_epoch bigint DEFAULT 1 NOT NULL,
    building_epoch bigint,
    building_run_id uuid,
    last_event_id text,
    last_event_at timestamp with time zone,
    last_error text,
    last_reindex_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_index_state_id_check CHECK ((id = 1))
);


--
-- Name: search_reindex_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_reindex_chunks (
    run_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    documents integer DEFAULT 0 NOT NULL,
    done_at timestamp with time zone DEFAULT now() NOT NULL,
    last_entity_id text,
    complete boolean DEFAULT false NOT NULL,
    phase text DEFAULT 'entry'::text NOT NULL
);


--
-- Name: search_reindex_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_reindex_runs (
    id uuid NOT NULL,
    epoch bigint NOT NULL,
    state text NOT NULL,
    index_version integer NOT NULL,
    total_documents integer DEFAULT 0 NOT NULL,
    chunks_total integer DEFAULT 0 NOT NULL,
    documents_indexed integer DEFAULT 0 NOT NULL,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    phases text[] DEFAULT ARRAY['entry'::text] NOT NULL,
    CONSTRAINT search_reindex_runs_state_check CHECK ((state = ANY (ARRAY['BUILDING'::text, 'ACTIVE'::text, 'FAILED'::text])))
);


--
-- Name: seo_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_documents (
    entry_id uuid NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_indexnow_pending; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_indexnow_pending (
    id uuid NOT NULL,
    site_key text NOT NULL,
    url text NOT NULL,
    reason text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    not_before timestamp with time zone DEFAULT now() NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT seo_indexnow_pending_reason_check CHECK ((reason = ANY (ARRAY['published'::text, 'updated'::text, 'unpublished'::text, 'route_changed'::text, 'rollback'::text, 'verification'::text])))
);


--
-- Name: seo_indexnow_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_indexnow_settings (
    site_key text NOT NULL,
    settings jsonb NOT NULL,
    settings_generation integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_site_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_site_settings (
    site_id uuid NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: service_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_accounts (
    id uuid NOT NULL,
    name text NOT NULL,
    purpose text NOT NULL,
    status text DEFAULT 'ENABLED'::text NOT NULL,
    allowed_scopes text[],
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone
);


--
-- Name: sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sites (
    id uuid NOT NULL,
    key text NOT NULL,
    title text NOT NULL,
    home_entry_id uuid,
    default_locale text DEFAULT 'x-default'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    path_policy jsonb DEFAULT '{"slug": {"cyrillic": "transliterate"}, "lowercase": true, "trailingSlash": true, "allowedExtensions": []}'::jsonb NOT NULL
);


-- Core-issued bearer capability for anonymous extension-owned state.
-- The raw cookie token is never stored; only its SHA-256 digest is indexed.
CREATE TABLE public.pcms_guest_sessions (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT pcms_guest_sessions_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: user_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_emails (
    user_id uuid NOT NULL,
    email_normalized text NOT NULL,
    email_display text NOT NULL,
    verified_at timestamp with time zone,
    is_primary boolean DEFAULT false NOT NULL
);


--
-- Name: user_notification_prefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notification_prefs (
    user_id uuid NOT NULL,
    disabled jsonb DEFAULT '[]'::jsonb NOT NULL,
    digest_minutes integer DEFAULT 0 NOT NULL,
    digest_since timestamp with time zone DEFAULT to_timestamp((0)::double precision) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    locale text DEFAULT 'ru'::text NOT NULL,
    CONSTRAINT user_notification_prefs_digest_minutes_check CHECK ((digest_minutes = ANY (ARRAY[0, 60, 180, 360, 720])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    display_name text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone
);


--
-- Name: access_tokens access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_tokens
    ADD CONSTRAINT access_tokens_pkey PRIMARY KEY (id);


--
-- Name: admin_theme_state admin_theme_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_theme_state
    ADD CONSTRAINT admin_theme_state_pkey PRIMARY KEY (site_key);


--
-- Name: analytics_events analytics_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events
    ADD CONSTRAINT analytics_events_pkey PRIMARY KEY (id);


--
-- Name: analytics_settings analytics_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_settings
    ADD CONSTRAINT analytics_settings_pkey PRIMARY KEY (site_key);


--
-- Name: api_idempotency api_idempotency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_idempotency
    ADD CONSTRAINT api_idempotency_pkey PRIMARY KEY (key, scope);


--
-- Name: auth_credentials auth_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_credentials
    ADD CONSTRAINT auth_credentials_pkey PRIMARY KEY (id);


--
-- Name: auth_one_time_tokens auth_one_time_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_one_time_tokens
    ADD CONSTRAINT auth_one_time_tokens_pkey PRIMARY KEY (id);


--
-- Name: auth_recovery_codes auth_recovery_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_pkey PRIMARY KEY (id);


--
-- Name: auth_role_permissions auth_role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_role_permissions
    ADD CONSTRAINT auth_role_permissions_pkey PRIMARY KEY (role_key, permission_key);


--
-- Name: auth_roles auth_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_roles
    ADD CONSTRAINT auth_roles_pkey PRIMARY KEY (key);


--
-- Name: auth_security_events auth_security_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_security_events
    ADD CONSTRAINT auth_security_events_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: auth_throttle_buckets auth_throttle_buckets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_throttle_buckets
    ADD CONSTRAINT auth_throttle_buckets_pkey PRIMARY KEY (bucket);


--
-- Name: auth_totp auth_totp_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_totp
    ADD CONSTRAINT auth_totp_pkey PRIMARY KEY (user_id);


--
-- Name: auth_user_roles auth_user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user_roles
    ADD CONSTRAINT auth_user_roles_pkey PRIMARY KEY (user_id, role_key);


--
-- Name: changeset_items changeset_items_changeset_id_entity_type_entity_id_context_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.changeset_items
    ADD CONSTRAINT changeset_items_changeset_id_entity_type_entity_id_context_key UNIQUE (changeset_id, entity_type, entity_id, context);


--
-- Name: changeset_items changeset_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.changeset_items
    ADD CONSTRAINT changeset_items_pkey PRIMARY KEY (id);


--
-- Name: changesets changesets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.changesets
    ADD CONSTRAINT changesets_pkey PRIMARY KEY (id);


--
-- Name: content_references content_references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_references
    ADD CONSTRAINT content_references_pkey PRIMARY KEY (source_entry_id, source_path, target_kind, target_id);


--
-- Name: domain_bindings domain_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_bindings
    ADD CONSTRAINT domain_bindings_pkey PRIMARY KEY (id);


--
-- Name: entries entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entries
    ADD CONSTRAINT entries_pkey PRIMARY KEY (id);


--
-- Name: entry_external_identities entry_external_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entry_external_identities
    ADD CONSTRAINT entry_external_identities_pkey PRIMARY KEY (site_key, source_namespace, external_id);


--
-- Name: extension_runtime_secret extension_runtime_secret_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extension_runtime_secret
    ADD CONSTRAINT extension_runtime_secret_pkey PRIMARY KEY (extension_id, slot);


--
-- Name: forms_form_definition_versions forms_form_definition_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_form_definition_versions
    ADD CONSTRAINT forms_form_definition_versions_pkey PRIMARY KEY (definition_id, schema_version);


--
-- Name: forms_form_definitions forms_form_definitions_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_form_definitions
    ADD CONSTRAINT forms_form_definitions_key_key UNIQUE (key);


--
-- Name: forms_form_definitions forms_form_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_form_definitions
    ADD CONSTRAINT forms_form_definitions_pkey PRIMARY KEY (id);


--
-- Name: forms_leads forms_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_leads
    ADD CONSTRAINT forms_leads_pkey PRIMARY KEY (id);


--
-- Name: forms_leads forms_leads_source_type_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_leads
    ADD CONSTRAINT forms_leads_source_type_source_id_key UNIQUE (source_type, source_id);


--
-- Name: forms_quiz_answers forms_quiz_answers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_quiz_answers
    ADD CONSTRAINT forms_quiz_answers_pkey PRIMARY KEY (id);


--
-- Name: forms_quiz_answers forms_quiz_answers_run_id_question_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_quiz_answers
    ADD CONSTRAINT forms_quiz_answers_run_id_question_id_key UNIQUE (run_id, question_id);


--
-- Name: forms_quiz_definition_versions forms_quiz_definition_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_quiz_definition_versions
    ADD CONSTRAINT forms_quiz_definition_versions_pkey PRIMARY KEY (quiz_definition_id, schema_version);


--
-- Name: forms_quiz_definitions forms_quiz_definitions_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_quiz_definitions
    ADD CONSTRAINT forms_quiz_definitions_key_key UNIQUE (key);


--
-- Name: forms_quiz_definitions forms_quiz_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_quiz_definitions
    ADD CONSTRAINT forms_quiz_definitions_pkey PRIMARY KEY (id);


--
-- Name: forms_quiz_runs forms_quiz_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_quiz_runs
    ADD CONSTRAINT forms_quiz_runs_pkey PRIMARY KEY (id);


--
-- Name: forms_submissions forms_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_submissions
    ADD CONSTRAINT forms_submissions_pkey PRIMARY KEY (id);


--
-- Name: global_content global_content_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_content
    ADD CONSTRAINT global_content_key_key UNIQUE (key);


--
-- Name: global_content global_content_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_content
    ADD CONSTRAINT global_content_pkey PRIMARY KEY (id);


--
-- Name: integration_binding integration_binding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_binding
    ADD CONSTRAINT integration_binding_pkey PRIMARY KEY (id);


--
-- Name: integration_delivery_attempt integration_delivery_attempt_delivery_id_attempt_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_delivery_attempt
    ADD CONSTRAINT integration_delivery_attempt_delivery_id_attempt_no_key UNIQUE (delivery_id, attempt_no);


--
-- Name: integration_delivery_attempt integration_delivery_attempt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_delivery_attempt
    ADD CONSTRAINT integration_delivery_attempt_pkey PRIMARY KEY (id);


--
-- Name: integration_delivery integration_delivery_outbox_event_id_binding_id_action_inde_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_delivery
    ADD CONSTRAINT integration_delivery_outbox_event_id_binding_id_action_inde_key UNIQUE (outbox_event_id, binding_id, action_index);


--
-- Name: integration_delivery integration_delivery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_delivery
    ADD CONSTRAINT integration_delivery_pkey PRIMARY KEY (id);


--
-- Name: integration_inbound_event integration_inbound_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_inbound_event
    ADD CONSTRAINT integration_inbound_event_pkey PRIMARY KEY (id);


--
-- Name: integration_inbound_event integration_inbound_event_source_type_source_id_dedup_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_inbound_event
    ADD CONSTRAINT integration_inbound_event_source_type_source_id_dedup_key_key UNIQUE (source_type, source_id, dedup_key);


--
-- Name: integration_instance integration_instance_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_instance
    ADD CONSTRAINT integration_instance_name_key UNIQUE (name);


--
-- Name: integration_instance integration_instance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_instance
    ADD CONSTRAINT integration_instance_pkey PRIMARY KEY (id);


--
-- Name: integration_runtime_secret integration_runtime_secret_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_runtime_secret
    ADD CONSTRAINT integration_runtime_secret_pkey PRIMARY KEY (instance_id, key);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: media_assets media_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);


--
-- Name: media_blobs media_blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_blobs
    ADD CONSTRAINT media_blobs_pkey PRIMARY KEY (id);


--
-- Name: media_blobs media_blobs_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_blobs
    ADD CONSTRAINT media_blobs_sha256_key UNIQUE (sha256);


--
-- Name: media_folders media_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_folders
    ADD CONSTRAINT media_folders_pkey PRIMARY KEY (id);


--
-- Name: media_generation_runs media_generation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_generation_runs
    ADD CONSTRAINT media_generation_runs_pkey PRIMARY KEY (id);


--
-- Name: media_variants media_variants_asset_id_version_no_variant_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_variants
    ADD CONSTRAINT media_variants_asset_id_version_no_variant_key_key UNIQUE (asset_id, version_no, variant_key);


--
-- Name: media_variants media_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_variants
    ADD CONSTRAINT media_variants_pkey PRIMARY KEY (id);


--
-- Name: media_versions media_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_versions
    ADD CONSTRAINT media_versions_pkey PRIMARY KEY (asset_id, version_no);


--
-- Name: navigation_items navigation_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_items
    ADD CONSTRAINT navigation_items_pkey PRIMARY KEY (id);


--
-- Name: navigation_items navigation_items_sibling_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_items
    ADD CONSTRAINT navigation_items_sibling_uniq UNIQUE (set_id, parent_key, sibling_order) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_overrides navigation_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_overrides
    ADD CONSTRAINT navigation_overrides_pkey PRIMARY KEY (id);


--
-- Name: navigation_placement_bindings navigation_placement_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_placement_bindings
    ADD CONSTRAINT navigation_placement_bindings_pkey PRIMARY KEY (placement_key);


--
-- Name: navigation_revisions navigation_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_revisions
    ADD CONSTRAINT navigation_revisions_pkey PRIMARY KEY (id);


--
-- Name: navigation_revisions navigation_revisions_set_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_revisions
    ADD CONSTRAINT navigation_revisions_set_id_revision_key UNIQUE (set_id, revision);


--
-- Name: navigation_sets navigation_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_sets
    ADD CONSTRAINT navigation_sets_pkey PRIMARY KEY (id);


--
-- Name: notification_cursors notification_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_cursors
    ADD CONSTRAINT notification_cursors_pkey PRIMARY KEY (source);


--
-- Name: notification_events notification_events_category_event_type_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_category_event_type_source_id_key UNIQUE (category, event_type, source_id);


--
-- Name: notification_events notification_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_pkey PRIMARY KEY (id);


--
-- Name: notification_sends notification_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_sends
    ADD CONSTRAINT notification_sends_pkey PRIMARY KEY (notification_id, user_id);


--
-- Name: notification_settings notification_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_pkey PRIMARY KEY (id);


--
-- Name: payment_event payment_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_event
    ADD CONSTRAINT payment_event_pkey PRIMARY KEY (id);


--
-- Name: payment payment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_pkey PRIMARY KEY (id);


--
-- Name: payment payment_provider_instance_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_provider_instance_id_idempotency_key_key UNIQUE (provider_instance_id, idempotency_key);


--
-- Name: payment_provider_instance payment_provider_instance_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_instance
    ADD CONSTRAINT payment_provider_instance_name_key UNIQUE (name);


--
-- Name: payment_provider_instance payment_provider_instance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_provider_instance
    ADD CONSTRAINT payment_provider_instance_pkey PRIMARY KEY (id);


--
-- Name: payment_refund payment_refund_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refund
    ADD CONSTRAINT payment_refund_pkey PRIMARY KEY (id);


--
-- Name: pcms_content_type_overrides pcms_content_type_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_content_type_overrides
    ADD CONSTRAINT pcms_content_type_overrides_pkey PRIMARY KEY (content_type_id, version);


--
-- Name: pcms_extension_event_consumptions pcms_extension_event_consumptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_extension_event_consumptions
    ADD CONSTRAINT pcms_extension_event_consumptions_pkey PRIMARY KEY (event_id, extension_id, subscription_id);


--
-- Name: pcms_extension_installations pcms_extension_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_extension_installations
    ADD CONSTRAINT pcms_extension_installations_pkey PRIMARY KEY (extension_id);


--
-- Name: pcms_extension_migrations pcms_extension_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_extension_migrations
    ADD CONSTRAINT pcms_extension_migrations_pkey PRIMARY KEY (extension_id, name);


--
-- Name: pcms_extension_mount_redirects pcms_extension_mount_redirects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_extension_mount_redirects
    ADD CONSTRAINT pcms_extension_mount_redirects_pkey PRIMARY KEY (id);


--
-- Name: pcms_extension_route_mounts pcms_extension_route_mounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_extension_route_mounts
    ADD CONSTRAINT pcms_extension_route_mounts_pkey PRIMARY KEY (id);


--
-- Name: pcms_extension_state_revision pcms_extension_state_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_extension_state_revision
    ADD CONSTRAINT pcms_extension_state_revision_pkey PRIMARY KEY (id);


--
-- Name: pcms_kernel_metadata pcms_kernel_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_kernel_metadata
    ADD CONSTRAINT pcms_kernel_metadata_pkey PRIMARY KEY (key);


--
-- Name: pcms_mail_settings pcms_mail_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_mail_settings
    ADD CONSTRAINT pcms_mail_settings_pkey PRIMARY KEY (id);


--
-- Name: pcms_maintenance_state pcms_maintenance_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_maintenance_state
    ADD CONSTRAINT pcms_maintenance_state_pkey PRIMARY KEY (id);


--
-- Name: pcms_site_localization pcms_site_localization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_site_localization
    ADD CONSTRAINT pcms_site_localization_pkey PRIMARY KEY (id);


--
-- Name: pcms_update_history pcms_update_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_update_history
    ADD CONSTRAINT pcms_update_history_pkey PRIMARY KEY (id);


--
-- Name: pcms_worker_heartbeat pcms_worker_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_worker_heartbeat
    ADD CONSTRAINT pcms_worker_heartbeat_pkey PRIMARY KEY (id);


--
-- Name: publication_bundle_ingest publication_bundle_ingest_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_bundle_ingest
    ADD CONSTRAINT publication_bundle_ingest_identity UNIQUE (principal_type, principal_id, bundle_id);


--
-- Name: publication_bundle_ingest publication_bundle_ingest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_bundle_ingest
    ADD CONSTRAINT publication_bundle_ingest_pkey PRIMARY KEY (id);


--
-- Name: publication_events publication_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_events
    ADD CONSTRAINT publication_events_pkey PRIMARY KEY (id);


--
-- Name: publication_outbox publication_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_outbox
    ADD CONSTRAINT publication_outbox_pkey PRIMARY KEY (id);


--
-- Name: publication_plan_items publication_plan_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_plan_items
    ADD CONSTRAINT publication_plan_items_pkey PRIMARY KEY (id);


--
-- Name: publication_plan_items publication_plan_items_plan_id_changeset_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_plan_items
    ADD CONSTRAINT publication_plan_items_plan_id_changeset_item_id_key UNIQUE (plan_id, changeset_item_id);


--
-- Name: publication_plans publication_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_plans
    ADD CONSTRAINT publication_plans_pkey PRIMARY KEY (id);


--
-- Name: publications publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_pkey PRIMARY KEY (entity_type, entity_id, context);


--
-- Name: revisions revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_pkey PRIMARY KEY (id);


--
-- Name: route_history route_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_history
    ADD CONSTRAINT route_history_pkey PRIMARY KEY (id);


--
-- Name: routes routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_pkey PRIMARY KEY (id);


--
-- Name: search_documents search_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_documents
    ADD CONSTRAINT search_documents_pkey PRIMARY KEY (epoch, entity_type, entity_id, context);


--
-- Name: search_index_state search_index_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_index_state
    ADD CONSTRAINT search_index_state_pkey PRIMARY KEY (id);


--
-- Name: search_reindex_chunks search_reindex_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_reindex_chunks
    ADD CONSTRAINT search_reindex_chunks_pkey PRIMARY KEY (run_id, chunk_index);


--
-- Name: search_reindex_runs search_reindex_runs_epoch_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_reindex_runs
    ADD CONSTRAINT search_reindex_runs_epoch_key UNIQUE (epoch);


--
-- Name: search_reindex_runs search_reindex_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_reindex_runs
    ADD CONSTRAINT search_reindex_runs_pkey PRIMARY KEY (id);


--
-- Name: seo_documents seo_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_documents
    ADD CONSTRAINT seo_documents_pkey PRIMARY KEY (entry_id);


--
-- Name: seo_indexnow_pending seo_indexnow_pending_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_indexnow_pending
    ADD CONSTRAINT seo_indexnow_pending_pkey PRIMARY KEY (id);


--
-- Name: seo_indexnow_pending seo_indexnow_pending_site_key_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_indexnow_pending
    ADD CONSTRAINT seo_indexnow_pending_site_key_url_key UNIQUE (site_key, url);


--
-- Name: seo_indexnow_settings seo_indexnow_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_indexnow_settings
    ADD CONSTRAINT seo_indexnow_settings_pkey PRIMARY KEY (site_key);


--
-- Name: seo_site_settings seo_site_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_site_settings
    ADD CONSTRAINT seo_site_settings_pkey PRIMARY KEY (site_id);


--
-- Name: service_accounts service_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_accounts
    ADD CONSTRAINT service_accounts_pkey PRIMARY KEY (id);


--
-- Name: sites sites_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_key_key UNIQUE (key);


--
-- Name: sites sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);


-- Name: pcms_guest_sessions pcms_guest_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--
ALTER TABLE ONLY public.pcms_guest_sessions
    ADD CONSTRAINT pcms_guest_sessions_pkey PRIMARY KEY (id);


-- Name: pcms_guest_sessions pcms_guest_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--
ALTER TABLE ONLY public.pcms_guest_sessions
    ADD CONSTRAINT pcms_guest_sessions_token_hash_key UNIQUE (token_hash);


-- Name: pcms_guest_sessions pcms_guest_sessions_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--
ALTER TABLE ONLY public.pcms_guest_sessions
    ADD CONSTRAINT pcms_guest_sessions_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: user_emails user_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_emails
    ADD CONSTRAINT user_emails_pkey PRIMARY KEY (user_id, email_normalized);


--
-- Name: user_notification_prefs user_notification_prefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_prefs
    ADD CONSTRAINT user_notification_prefs_pkey PRIMARY KEY (user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: access_tokens_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX access_tokens_account_idx ON public.access_tokens USING btree (service_account_id);


--
-- Name: access_tokens_hash_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX access_tokens_hash_uniq ON public.access_tokens USING btree (token_hash);


--
-- Name: access_tokens_prefix_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX access_tokens_prefix_idx ON public.access_tokens USING btree (prefix);


--
-- Name: analytics_events_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_events_time_idx ON public.analytics_events USING btree (site_key, created_at DESC);


--
-- Name: api_idempotency_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_idempotency_expiry_idx ON public.api_idempotency USING btree (expires_at);


-- Name: pcms_guest_sessions_expiry_idx; Type: INDEX; Schema: public; Owner: -
--
CREATE INDEX pcms_guest_sessions_expiry_idx ON public.pcms_guest_sessions USING btree (expires_at);


--
-- Name: auth_credentials_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_credentials_user_idx ON public.auth_credentials USING btree (user_id, kind);


--
-- Name: auth_one_time_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_one_time_tokens_user_idx ON public.auth_one_time_tokens USING btree (user_id, kind);


--
-- Name: auth_recovery_codes_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_recovery_codes_user_idx ON public.auth_recovery_codes USING btree (user_id, used_at);


--
-- Name: auth_security_events_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_security_events_subject_idx ON public.auth_security_events USING btree (subject_id, created_at DESC);


--
-- Name: auth_security_events_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_security_events_time_idx ON public.auth_security_events USING btree (created_at DESC);


--
-- Name: auth_security_events_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_security_events_type_idx ON public.auth_security_events USING btree (event_type, created_at DESC);


--
-- Name: auth_sessions_token_hash_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_sessions_token_hash_uniq ON public.auth_sessions USING btree (token_hash);


--
-- Name: auth_sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_user_idx ON public.auth_sessions USING btree (user_id, revoked_at);


--
-- Name: auth_user_roles_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_user_roles_role_idx ON public.auth_user_roles USING btree (role_key);


--
-- Name: changeset_items_changeset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX changeset_items_changeset_idx ON public.changeset_items USING btree (changeset_id, "position");


--
-- Name: content_references_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_references_target_idx ON public.content_references USING btree (target_kind, target_id);


--
-- Name: domain_bindings_hostname_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX domain_bindings_hostname_uniq ON public.domain_bindings USING btree (lower(hostname));


--
-- Name: domain_bindings_primary_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX domain_bindings_primary_uniq ON public.domain_bindings USING btree (site_id) WHERE is_primary;


--
-- Name: entries_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entries_parent_idx ON public.entries USING btree (parent_entry_id);


--
-- Name: entries_translation_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entries_translation_group_idx ON public.entries USING btree (COALESCE(translation_group_id, id));


--
-- Name: entries_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entries_type_idx ON public.entries USING btree (content_type_id, created_at);


--
-- Name: entry_external_identities_entry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entry_external_identities_entry_idx ON public.entry_external_identities USING btree (entry_id);


--
-- Name: ext_mount_redirect_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ext_mount_redirect_lookup ON public.pcms_extension_mount_redirects USING btree (from_path) WHERE (retired_at IS NULL);


--
-- Name: forms_form_definitions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forms_form_definitions_status_idx ON public.forms_form_definitions USING btree (status, created_at DESC);


--
-- Name: forms_leads_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forms_leads_status_idx ON public.forms_leads USING btree (status, created_at DESC, id DESC);


--
-- Name: forms_quiz_definitions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forms_quiz_definitions_status_idx ON public.forms_quiz_definitions USING btree (status, created_at DESC);


--
-- Name: forms_quiz_runs_definition_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forms_quiz_runs_definition_idx ON public.forms_quiz_runs USING btree (quiz_definition_id, started_at DESC, id DESC);


--
-- Name: forms_quiz_runs_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forms_quiz_runs_state_idx ON public.forms_quiz_runs USING btree (state, started_at DESC, id DESC);


--
-- Name: forms_submissions_definition_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forms_submissions_definition_idx ON public.forms_submissions USING btree (form_definition_id, submitted_at DESC, id DESC);


--
-- Name: forms_submissions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forms_submissions_status_idx ON public.forms_submissions USING btree (status, submitted_at DESC, id DESC);


--
-- Name: forms_submissions_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX forms_submissions_token_idx ON public.forms_submissions USING btree (form_definition_id, submission_token_hash) WHERE (submission_token_hash IS NOT NULL);


--
-- Name: global_content_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX global_content_type_idx ON public.global_content USING btree (content_type_key, schema_version);


--
-- Name: integration_binding_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_binding_event_idx ON public.integration_binding USING btree (event_type) WHERE enabled;


--
-- Name: integration_delivery_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_delivery_due_idx ON public.integration_delivery USING btree (next_attempt_at) WHERE (status = ANY (ARRAY['PENDING'::text, 'FAILED_RETRYABLE'::text]));


--
-- Name: integration_delivery_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_delivery_event_idx ON public.integration_delivery USING btree (outbox_event_id);


--
-- Name: integration_inbound_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_inbound_received_idx ON public.integration_inbound_event USING btree (received_at DESC);


--
-- Name: integration_inbound_recovery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_inbound_recovery ON public.integration_inbound_event USING btree (next_attempt_at, id) WHERE ((source_type = 'payment_provider'::text) AND (status = ANY (ARRAY['RECEIVED'::text, 'FAILED'::text])));


--
-- Name: jobs_active_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX jobs_active_idempotency_idx ON public.jobs USING btree (idempotency_key) WHERE ((idempotency_key IS NOT NULL) AND (state = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'SUCCEEDED'::text])));


--
-- Name: jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_claim_idx ON public.jobs USING btree (run_at) WHERE (state = 'PENDING'::text);


--
-- Name: jobs_dead_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_dead_idx ON public.jobs USING btree (updated_at) WHERE (state = 'DEAD'::text);


--
-- Name: jobs_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_lease_idx ON public.jobs USING btree (claim_expires_at) WHERE (state = 'RUNNING'::text);


--
-- Name: media_assets_author_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_author_trgm_idx ON public.media_assets USING gin (author public.gin_trgm_ops);


--
-- Name: media_assets_caption_default_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_caption_default_trgm_idx ON public.media_assets USING gin (caption_default public.gin_trgm_ops);


--
-- Name: media_assets_filename_original_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_filename_original_trgm_idx ON public.media_assets USING gin (filename_original public.gin_trgm_ops);


--
-- Name: media_assets_folder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_folder_idx ON public.media_assets USING btree (folder_id);


--
-- Name: media_assets_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_hash_idx ON public.media_assets USING btree (sha256);


--
-- Name: media_assets_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_kind_idx ON public.media_assets USING btree (kind, created_at);


--
-- Name: media_assets_provider_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_provider_asset_idx ON public.media_assets USING btree (provider_id, provider_asset_id) WHERE (provider_id IS NOT NULL);


--
-- Name: media_assets_source_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_source_name_trgm_idx ON public.media_assets USING gin (source_name public.gin_trgm_ops);


--
-- Name: media_assets_title_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_title_trgm_idx ON public.media_assets USING gin (title public.gin_trgm_ops);


--
-- Name: media_folders_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_folders_parent_idx ON public.media_folders USING btree (parent_id);


--
-- Name: media_generation_runs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_generation_runs_created_at_idx ON public.media_generation_runs USING btree (created_at);


--
-- Name: media_variants_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_variants_asset_idx ON public.media_variants USING btree (asset_id, version_no);


--
-- Name: media_variants_blob_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_variants_blob_idx ON public.media_variants USING btree (blob_id);


--
-- Name: media_versions_blob_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_versions_blob_idx ON public.media_versions USING btree (blob_id);


--
-- Name: navigation_items_set_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_items_set_idx ON public.navigation_items USING btree (set_id);


--
-- Name: navigation_overrides_set_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_overrides_set_idx ON public.navigation_overrides USING btree (set_id, apply_order);


--
-- Name: navigation_placement_bindings_set_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_placement_bindings_set_idx ON public.navigation_placement_bindings USING btree (navigation_set_id);


--
-- Name: navigation_sets_key_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX navigation_sets_key_uniq ON public.navigation_sets USING btree (key) WHERE (archived_at IS NULL);


--
-- Name: notification_events_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_events_created_idx ON public.notification_events USING btree (created_at);


--
-- Name: payment_event_payment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_event_payment_idx ON public.payment_event USING btree (payment_id, seq);


--
-- Name: payment_external_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_external_idx ON public.payment USING btree (provider_instance_id, external_payment_id) WHERE (external_payment_id IS NOT NULL);


--
-- Name: payment_refund_idem_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_refund_idem_key ON public.payment_refund USING btree (idempotency_key);


--
-- Name: payment_refund_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_refund_one_active ON public.payment_refund USING btree (payment_id) WHERE (status = ANY (ARRAY['REQUESTED'::text, 'SUBMITTED'::text]));


--
-- Name: payment_refund_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_refund_payment ON public.payment_refund USING btree (payment_id, created_at);


--
-- Name: payment_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_status_idx ON public.payment USING btree (status, created_at DESC);


--
-- Name: payment_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_subject_idx ON public.payment USING btree (subject_type, subject_id);


--
-- Name: pcms_metric_samples_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pcms_metric_samples_ts_idx ON public.pcms_metric_samples USING btree (ts DESC);


--
-- Name: publication_bundle_ingest_principal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publication_bundle_ingest_principal_idx ON public.publication_bundle_ingest USING btree (principal_id, received_at DESC);


--
-- Name: publication_events_changeset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publication_events_changeset_idx ON public.publication_events USING btree (changeset_id) WHERE (changeset_id IS NOT NULL);


--
-- Name: publication_events_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publication_events_entity_idx ON public.publication_events USING btree (entity_type, entity_id, context, created_at);


--
-- Name: publication_outbox_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publication_outbox_pending_idx ON public.publication_outbox USING btree (available_at) WHERE (state = 'PENDING'::text);


--
-- Name: publication_outbox_recover_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publication_outbox_recover_idx ON public.publication_outbox USING btree (claim_expires_at) WHERE (state = 'PROCESSING'::text);


--
-- Name: publication_plan_items_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publication_plan_items_due_idx ON public.publication_plan_items USING btree (publish_at) WHERE (state = 'SCHEDULED'::text);


--
-- Name: publication_plans_changeset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publication_plans_changeset_idx ON public.publication_plans USING btree (changeset_id);


--
-- Name: publications_public_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_public_idx ON public.publications USING btree (entity_type, context, state) WHERE (state = 'PUBLISHED'::text);


--
-- Name: revisions_entity_list_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX revisions_entity_list_idx ON public.revisions USING btree (entity_type, entity_id, revision_no DESC);


--
-- Name: revisions_entity_revision_no_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX revisions_entity_revision_no_idx ON public.revisions USING btree (entity_type, entity_id, revision_no);


--
-- Name: revisions_working_per_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX revisions_working_per_entity_idx ON public.revisions USING btree (entity_type, entity_id, locale) WHERE (state = 'WORKING'::text);


--
-- Name: route_history_active_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX route_history_active_uniq ON public.route_history USING btree (site_id, locale, old_path) WHERE (retired_at IS NULL);


--
-- Name: routes_active_domain_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX routes_active_domain_uniq ON public.routes USING btree (site_id, domain_binding_id, locale, path) WHERE ((retired_at IS NULL) AND is_canonical AND (domain_binding_id IS NOT NULL));


--
-- Name: routes_active_site_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX routes_active_site_uniq ON public.routes USING btree (site_id, locale, path) WHERE ((retired_at IS NULL) AND is_canonical AND (domain_binding_id IS NULL));


--
-- Name: routes_active_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX routes_active_target_idx ON public.routes USING btree (site_id, target_id) WHERE ((retired_at IS NULL) AND is_canonical);


--
-- Name: search_documents_aux_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_documents_aux_idx ON public.search_documents USING gin (aux_vector);


--
-- Name: search_documents_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_documents_scope_idx ON public.search_documents USING btree (epoch, site_id, locale, content_type, published_at DESC);


--
-- Name: search_documents_vector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_documents_vector_idx ON public.search_documents USING gin (search_vector);


--
-- Name: seo_indexnow_pending_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_indexnow_pending_due_idx ON public.seo_indexnow_pending USING btree (site_key, not_before);


--
-- Name: uq_ext_mount_active_extension; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ext_mount_active_extension ON public.pcms_extension_route_mounts USING btree (site_id, extension_id) WHERE (retired_at IS NULL);


--
-- Name: uq_ext_mount_active_path; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ext_mount_active_path ON public.pcms_extension_route_mounts USING btree (site_id, mount_path) WHERE (retired_at IS NULL);


--
-- Name: user_emails_normalized_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_emails_normalized_uniq ON public.user_emails USING btree (email_normalized);


--
-- Name: user_emails_primary_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_emails_primary_uniq ON public.user_emails USING btree (user_id) WHERE is_primary;


--
-- Name: analytics_events analytics_events_append_only_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_events_append_only_guard BEFORE DELETE OR UPDATE ON public.analytics_events FOR EACH STATEMENT EXECUTE FUNCTION public.analytics_events_guard_append_only();


--
-- Name: publication_events publication_events_append_only_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER publication_events_append_only_guard BEFORE DELETE OR UPDATE ON public.publication_events FOR EACH STATEMENT EXECUTE FUNCTION public.publication_events_guard_append_only();


--
-- Name: revisions revisions_sealed_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revisions_sealed_delete_guard BEFORE DELETE ON public.revisions FOR EACH ROW WHEN ((old.state = 'SEALED'::text)) EXECUTE FUNCTION public.revisions_guard_sealed_delete();


--
-- Name: revisions revisions_sealed_update_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revisions_sealed_update_guard BEFORE UPDATE ON public.revisions FOR EACH ROW EXECUTE FUNCTION public.revisions_guard_sealed_update();


--
-- Name: access_tokens access_tokens_service_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_tokens
    ADD CONSTRAINT access_tokens_service_account_id_fkey FOREIGN KEY (service_account_id) REFERENCES public.service_accounts(id);


--
-- Name: auth_credentials auth_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_credentials
    ADD CONSTRAINT auth_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: auth_one_time_tokens auth_one_time_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_one_time_tokens
    ADD CONSTRAINT auth_one_time_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: auth_recovery_codes auth_recovery_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: auth_role_permissions auth_role_permissions_role_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_role_permissions
    ADD CONSTRAINT auth_role_permissions_role_key_fkey FOREIGN KEY (role_key) REFERENCES public.auth_roles(key) ON DELETE CASCADE;


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: auth_totp auth_totp_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_totp
    ADD CONSTRAINT auth_totp_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: auth_user_roles auth_user_roles_role_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user_roles
    ADD CONSTRAINT auth_user_roles_role_key_fkey FOREIGN KEY (role_key) REFERENCES public.auth_roles(key);


--
-- Name: auth_user_roles auth_user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user_roles
    ADD CONSTRAINT auth_user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: changeset_items changeset_items_changeset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.changeset_items
    ADD CONSTRAINT changeset_items_changeset_id_fkey FOREIGN KEY (changeset_id) REFERENCES public.changesets(id);


--
-- Name: content_references content_references_source_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_references
    ADD CONSTRAINT content_references_source_entry_id_fkey FOREIGN KEY (source_entry_id) REFERENCES public.entries(id) ON DELETE CASCADE;


--
-- Name: domain_bindings domain_bindings_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_bindings
    ADD CONSTRAINT domain_bindings_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: entries entries_parent_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entries
    ADD CONSTRAINT entries_parent_entry_id_fkey FOREIGN KEY (parent_entry_id) REFERENCES public.entries(id);


--
-- Name: entries entries_translation_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entries
    ADD CONSTRAINT entries_translation_group_id_fkey FOREIGN KEY (translation_group_id) REFERENCES public.entries(id);


--
-- Name: entry_external_identities entry_external_identities_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entry_external_identities
    ADD CONSTRAINT entry_external_identities_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.entries(id);


--
-- Name: extension_runtime_secret extension_runtime_secret_extension_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extension_runtime_secret
    ADD CONSTRAINT extension_runtime_secret_extension_id_fkey FOREIGN KEY (extension_id) REFERENCES public.pcms_extension_installations(extension_id) ON DELETE CASCADE;


--
-- Name: forms_form_definition_versions forms_form_definition_versions_definition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_form_definition_versions
    ADD CONSTRAINT forms_form_definition_versions_definition_id_fkey FOREIGN KEY (definition_id) REFERENCES public.forms_form_definitions(id);


--
-- Name: forms_quiz_answers forms_quiz_answers_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_quiz_answers
    ADD CONSTRAINT forms_quiz_answers_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.forms_quiz_runs(id) ON DELETE CASCADE;


--
-- Name: forms_quiz_definition_versions forms_quiz_definition_versions_quiz_definition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_quiz_definition_versions
    ADD CONSTRAINT forms_quiz_definition_versions_quiz_definition_id_fkey FOREIGN KEY (quiz_definition_id) REFERENCES public.forms_quiz_definitions(id);


--
-- Name: forms_quiz_runs forms_quiz_runs_quiz_definition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_quiz_runs
    ADD CONSTRAINT forms_quiz_runs_quiz_definition_id_fkey FOREIGN KEY (quiz_definition_id) REFERENCES public.forms_quiz_definitions(id);


--
-- Name: forms_submissions forms_submissions_form_definition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_submissions
    ADD CONSTRAINT forms_submissions_form_definition_id_fkey FOREIGN KEY (form_definition_id) REFERENCES public.forms_form_definitions(id);


--
-- Name: integration_delivery_attempt integration_delivery_attempt_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_delivery_attempt
    ADD CONSTRAINT integration_delivery_attempt_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.integration_delivery(id);


--
-- Name: integration_delivery integration_delivery_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_delivery
    ADD CONSTRAINT integration_delivery_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.integration_binding(id);


--
-- Name: integration_delivery integration_delivery_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_delivery
    ADD CONSTRAINT integration_delivery_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.integration_instance(id);


--
-- Name: integration_runtime_secret integration_runtime_secret_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_runtime_secret
    ADD CONSTRAINT integration_runtime_secret_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.integration_instance(id) ON DELETE CASCADE;


--
-- Name: media_assets media_assets_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.media_folders(id) ON DELETE RESTRICT;


--
-- Name: media_assets media_assets_original_blob_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_original_blob_id_fkey FOREIGN KEY (original_blob_id) REFERENCES public.media_blobs(id);


--
-- Name: media_folders media_folders_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_folders
    ADD CONSTRAINT media_folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.media_folders(id) ON DELETE RESTRICT;


--
-- Name: media_variants media_variants_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_variants
    ADD CONSTRAINT media_variants_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(id) ON DELETE CASCADE;


--
-- Name: media_variants media_variants_blob_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_variants
    ADD CONSTRAINT media_variants_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES public.media_blobs(id);


--
-- Name: media_versions media_versions_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_versions
    ADD CONSTRAINT media_versions_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(id);


--
-- Name: media_versions media_versions_blob_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_versions
    ADD CONSTRAINT media_versions_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES public.media_blobs(id);


--
-- Name: navigation_items navigation_items_parent_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_items
    ADD CONSTRAINT navigation_items_parent_item_id_fkey FOREIGN KEY (parent_item_id) REFERENCES public.navigation_items(id);


--
-- Name: navigation_items navigation_items_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_items
    ADD CONSTRAINT navigation_items_set_id_fkey FOREIGN KEY (set_id) REFERENCES public.navigation_sets(id);


--
-- Name: navigation_overrides navigation_overrides_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_overrides
    ADD CONSTRAINT navigation_overrides_set_id_fkey FOREIGN KEY (set_id) REFERENCES public.navigation_sets(id);


--
-- Name: navigation_placement_bindings navigation_placement_bindings_navigation_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_placement_bindings
    ADD CONSTRAINT navigation_placement_bindings_navigation_set_id_fkey FOREIGN KEY (navigation_set_id) REFERENCES public.navigation_sets(id);


--
-- Name: navigation_revisions navigation_revisions_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_revisions
    ADD CONSTRAINT navigation_revisions_set_id_fkey FOREIGN KEY (set_id) REFERENCES public.navigation_sets(id);


--
-- Name: navigation_sets navigation_sets_derived_from_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_sets
    ADD CONSTRAINT navigation_sets_derived_from_set_id_fkey FOREIGN KEY (derived_from_set_id) REFERENCES public.navigation_sets(id);


--
-- Name: notification_sends notification_sends_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_sends
    ADD CONSTRAINT notification_sends_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notification_events(id) ON DELETE CASCADE;


--
-- Name: payment_event payment_event_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_event
    ADD CONSTRAINT payment_event_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payment(id);


--
-- Name: payment payment_provider_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_provider_instance_id_fkey FOREIGN KEY (provider_instance_id) REFERENCES public.payment_provider_instance(id);


--
-- Name: payment_refund payment_refund_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refund
    ADD CONSTRAINT payment_refund_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payment(id);


--
-- Name: payment_refund payment_refund_provider_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refund
    ADD CONSTRAINT payment_refund_provider_instance_id_fkey FOREIGN KEY (provider_instance_id) REFERENCES public.payment_provider_instance(id);


--
-- Name: pcms_extension_mount_redirects pcms_extension_mount_redirects_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_extension_mount_redirects
    ADD CONSTRAINT pcms_extension_mount_redirects_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: pcms_extension_route_mounts pcms_extension_route_mounts_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcms_extension_route_mounts
    ADD CONSTRAINT pcms_extension_route_mounts_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: publication_plan_items publication_plan_items_changeset_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_plan_items
    ADD CONSTRAINT publication_plan_items_changeset_item_id_fkey FOREIGN KEY (changeset_item_id) REFERENCES public.changeset_items(id);


--
-- Name: publication_plan_items publication_plan_items_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_plan_items
    ADD CONSTRAINT publication_plan_items_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.publication_plans(id);


--
-- Name: publication_plans publication_plans_changeset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_plans
    ADD CONSTRAINT publication_plans_changeset_id_fkey FOREIGN KEY (changeset_id) REFERENCES public.changesets(id);


--
-- Name: revisions revisions_parent_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_parent_revision_id_fkey FOREIGN KEY (parent_revision_id) REFERENCES public.revisions(id);


--
-- Name: route_history route_history_domain_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_history
    ADD CONSTRAINT route_history_domain_binding_id_fkey FOREIGN KEY (domain_binding_id) REFERENCES public.domain_bindings(id);


--
-- Name: route_history route_history_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_history
    ADD CONSTRAINT route_history_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: routes routes_domain_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_domain_binding_id_fkey FOREIGN KEY (domain_binding_id) REFERENCES public.domain_bindings(id);


--
-- Name: routes routes_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: search_reindex_chunks search_reindex_chunks_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_reindex_chunks
    ADD CONSTRAINT search_reindex_chunks_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.search_reindex_runs(id) ON DELETE CASCADE;


--
-- Name: user_emails user_emails_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_emails
    ADD CONSTRAINT user_emails_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--



-- Baseline seed rows and sequence states.
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-1.pgdg24.04+2)
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-1.pgdg24.04+2)


--
-- Data for Name: service_accounts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: access_tokens; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: admin_theme_state; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: analytics_events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: analytics_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: api_idempotency; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_credentials; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_one_time_tokens; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_recovery_codes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_roles; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.auth_roles VALUES ('OWNER', 'Owner', true, true, '2026-10-12 19:21:42.41564+03', NULL);
INSERT INTO public.auth_roles VALUES ('ADMIN', 'Administrator', true, true, '2026-10-12 19:21:42.41564+03', NULL);
INSERT INTO public.auth_roles VALUES ('DEVELOPER', 'Developer', true, true, '2026-10-12 19:21:42.41564+03', NULL);
INSERT INTO public.auth_roles VALUES ('EDITOR', 'Editor', true, true, '2026-10-12 19:21:42.41564+03', NULL);
INSERT INTO public.auth_roles VALUES ('AUTHOR', 'Author', true, true, '2026-10-12 19:21:42.41564+03', NULL);


--
-- Data for Name: auth_role_permissions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_security_events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_sessions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_throttle_buckets; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_totp; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_user_roles; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: changesets; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: changeset_items; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: entries; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: content_references; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: sites; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: domain_bindings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: entry_external_identities; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pcms_extension_installations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: extension_runtime_secret; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: forms_form_definitions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: forms_form_definition_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: forms_leads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: forms_quiz_definitions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: forms_quiz_runs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: forms_quiz_answers; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: forms_quiz_definition_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: forms_submissions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: global_content; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: integration_binding; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: integration_instance; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: integration_delivery; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: integration_delivery_attempt; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: integration_inbound_event; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: integration_runtime_secret; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: jobs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: media_blobs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: media_folders; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: media_assets; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: media_generation_runs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: media_variants; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: media_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: navigation_sets; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: navigation_items; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: navigation_overrides; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: navigation_placement_bindings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: navigation_revisions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: notification_cursors; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: notification_events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: notification_sends; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: notification_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: payment_provider_instance; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: payment; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: payment_event; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: payment_refund; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pcms_content_type_overrides; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pcms_extension_event_consumptions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pcms_extension_migrations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pcms_extension_mount_redirects; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pcms_extension_route_mounts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pcms_extension_state_revision; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pcms_extension_state_revision VALUES (true, 0);


--
-- Data for Name: pcms_kernel_metadata; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pcms_kernel_metadata VALUES ('schema_baseline', '1', '2026-10-12 19:21:42.038107+03');


--
-- Data for Name: pcms_mail_settings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pcms_mail_settings VALUES (1, false, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-12 19:21:42.825638+03', 'system');


--
-- Data for Name: pcms_maintenance_state; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pcms_maintenance_state VALUES (1, false, 'Сайт временно недоступен', 'Сайт временно готовится к запуску.

Мы обновляем его на Progressive CMS — современной системе управления сайтами от Progressive OS.

Скоро сайт снова будет доступен.', 'Подробнее о Progressive CMS', 'https://p-os.ru/', 3600, '2026-10-12 19:21:42.806198+03', 'system');


--
-- Data for Name: pcms_metric_samples; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pcms_site_localization; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pcms_site_localization VALUES (1, false, 'ru-RU', '[]', 'path_prefix', '2026-10-12 19:21:42.841224+03', 'system');


--
-- Data for Name: pcms_update_history; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pcms_worker_heartbeat; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: publication_bundle_ingest; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: publication_events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: publication_outbox; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: publication_plans; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: publication_plan_items; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: publications; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: revisions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: route_history; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: routes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: search_documents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: search_index_state; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.search_index_state VALUES (1, 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-12 19:21:42.545162+03');


--
-- Data for Name: search_reindex_runs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: search_reindex_chunks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: seo_documents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: seo_indexnow_pending; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: seo_indexnow_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: seo_site_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: user_emails; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: user_notification_prefs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: payment_event_seq_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payment_event_seq_seq', 1, false);


--
-- PostgreSQL database dump complete
--
