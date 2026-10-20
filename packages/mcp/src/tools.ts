// The CMS tool catalog (PCMS-API-T020; API spec §48–§53).
// Tools are semantic, high-level and permission-scoped: every mutation
// handler delegates to the application operation bound at the composition
// root — authorization/CAS/errors are identical to REST by construction.
// Tool names are a stable contract (spec §50); outputs are structured
// objects, never prose-only (spec §51).
import type { McpOperations, OperationContextLike, PrivacyOperationInput } from "./operations.js";

export interface McpTool {
  readonly name: string;
  readonly description: string;
  /** Permission enforced by the trusted application gate and domain operation. */
  readonly permission?: string;
  readonly siteArgument?: boolean;
  readonly permissionFor?: (args: Record<string, unknown>) => string;
  /** True when the tool mutates state (read/write separation, spec §25). */
  readonly mutation: boolean;
  readonly inputSchema: Record<string, unknown>;
  run(
    operations: McpOperations,
    ctx: OperationContextLike,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

const STR_ID = { type: "string", pattern: "^[0-9a-f-]{36}$" } as const;
const PLAN_OVERRIDES = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      changeset_item_id: STR_ID,
      publish_at: { type: "string", format: "date-time" },
      unpublish_at: { type: "string", format: "date-time" },
    },
    required: ["changeset_item_id"],
    minProperties: 2,
  },
} as const;
function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

const PRIVACY_ID = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
};
const PRIVACY_PROPERTIES = {
  target: objectSchema(
    { entity: { type: "string", enum: ["submission", "quiz_run", "lead"] }, id: PRIVACY_ID },
    ["entity", "id"],
  ),
  action: { type: "string", enum: ["rectify", "block", "unblock", "erase"] },
  correction: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      submission_payload: { type: "object", maxProperties: 256 },
      quiz_answers: {
        type: "array",
        maxItems: 256,
        items: objectSchema({ question_id: { type: "string", maxLength: 128 }, value: {} }, [
          "question_id",
          "value",
        ]),
      },
    },
  },
};
export const TOOLS: readonly McpTool[] = [
  {
    name: "cms_preview_interaction_privacy",
    permission: "privacy.manage",
    mutation: false,
    description:
      "Preview a selected personal-data action and all controlled copies; no writes. Owner chooses whether to apply.",
    inputSchema: objectSchema(PRIVACY_PROPERTIES, ["target", "action"]),
    run: (operations, ctx, args) =>
      operations.previewInteractionPrivacy(ctx, args as unknown as PrivacyOperationInput),
  },
  {
    name: "cms_apply_interaction_privacy",
    permission: "privacy.manage",
    mutation: true,
    description:
      "Explicit addressed block/unblock/rectify/erase. Requires preview token and stable request_id for safe retries. External copies need followup, not automatic claims of remote deletion.",
    inputSchema: objectSchema(
      {
        ...PRIVACY_PROPERTIES,
        request_id: PRIVACY_ID,
        expected_token: { type: "string", minLength: 1, maxLength: 128 },
        request_ref: { type: "string", minLength: 1, maxLength: 300 },
      },
      ["target", "action", "request_id", "expected_token"],
    ),
    run: (operations, ctx, args) =>
      operations.applyInteractionPrivacy(
        ctx,
        args as unknown as PrivacyOperationInput & {
          request_id: string;
          expected_token: string;
          request_ref?: string;
        },
      ),
  },
  {
    name: "cms_get_interaction_privacy_case",
    permission: "privacy.manage",
    mutation: false,
    description: "Read a personal-data operation receipt and pending processor followups.",
    inputSchema: objectSchema({ case_id: PRIVACY_ID }, ["case_id"]),
    run: (operations, ctx, args) =>
      operations.getInteractionPrivacyCase(ctx, args.case_id as string),
  },
  {
    name: "cms_acknowledge_interaction_privacy",
    permission: "privacy.manage",
    mutation: true,
    description:
      "Record external processor action evidence or an explicit owner exception; this does not contact a processor.",
    inputSchema: objectSchema(
      {
        case_id: PRIVACY_ID,
        delivery_id: PRIVACY_ID,
        decision: { type: "string", enum: ["acknowledged", "owner_exception"] },
        evidence_ref: { type: "string", minLength: 1, maxLength: 300 },
      },
      ["case_id", "delivery_id", "decision"],
    ),
    run: (operations, ctx, args) =>
      operations.acknowledgeInteractionPrivacy(
        ctx,
        args.case_id as string,
        args.delivery_id as string,
        {
          decision: args.decision as "acknowledged" | "owner_exception",
          ...(args.evidence_ref === undefined ? {} : { evidence_ref: args.evidence_ref as string }),
        },
      ),
  },
  {
    name: "cms_list_theme_revisions",
    description: "List retained theme revisions for the current site; excludes pruned snapshots.",
    permission: "theme.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.listThemeRevisions(ctx);
    },
  },
  {
    name: "cms_cleanup_theme_revisions",
    description:
      "Preview old theme snapshots (default dry_run=true, theme.read); apply with dry_run=false, explicit revision_ids and expected_generation (theme.write). Keeps active, previous good, latest five and snapshots used within one day. At most 100 per batch. Pruning is irreversible; retry pending file removal with the same IDs.",
    permission: "theme.read",
    permissionFor: (args) => (args.dry_run === false ? "theme.write" : "theme.read"),
    mutation: true,
    inputSchema: objectSchema({
      dry_run: { type: "boolean", default: true },
      keep_last: { type: "integer", minimum: 5, maximum: 100, default: 5 },
      older_than_days: { type: "integer", minimum: 1, maximum: 36500, default: 1 },
      expected_generation: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      revision_ids: { type: "array", maxItems: 100, uniqueItems: true, items: STR_ID },
    }),
    async run(operations, ctx, args) {
      return operations.cleanupThemeRevisions(ctx, args);
    },
  },
  // --- general discovery (spec §20) ---
  {
    name: "cms_get_server_info",
    description: "Server identity and subsystem contract versions.",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return operations.getServerInfo();
    },
  },
  {
    name: "cms_get_capabilities",
    description:
      "Capability report for the current actor: installed subsystems, allowed operation classes, contract versions.",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.buildCapabilities(ctx);
    },
  },
  {
    name: "cms_get_current_actor",
    description:
      "Non-secret projection of the authenticated actor (scopes, site/environment binding) — agents detect missing permissions before large workflows (spec §53).",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.getCurrentActor(ctx);
    },
  },
  {
    name: "cms_get_agent_bootstrap",
    description:
      "M16 agent bootstrap: target site, environment classification, actor + effective scopes, contract versions, capabilities, installed skills with compatibility, preview/domain readiness. Secret-free; call this before any workflow.",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.getAgentBootstrap(ctx);
    },
  },
  {
    name: "cms_resolve_external_identity",
    description:
      "Resolve an external source item (source_namespace + external_id) to its bound entry, with the human-edit reconciliation verdict (IN_SYNC / HUMAN_EDIT_CONFLICT / BASELINE_UNSET) — never overwrite on conflict (M16).",
    permission: "content.read",
    mutation: false,
    inputSchema: objectSchema(
      {
        source_namespace: { type: "string", minLength: 1, maxLength: 200 },
        external_id: { type: "string", minLength: 1, maxLength: 500 },
        source_hash: { type: "string", maxLength: 256 },
      },
      ["source_namespace", "external_id"],
    ),
    async run(operations, ctx, args) {
      return operations.resolveExternalIdentity(ctx, args);
    },
  },
  {
    name: "cms_bind_external_identity",
    description:
      "Bind an external source item to an entry and/or refresh the agent sync baseline (last applied generation, source hash, run id). Idempotent for the same entry; conflicts on a different bound entry (M16).",
    permission: "content.edit",
    mutation: true,
    inputSchema: objectSchema(
      {
        source_namespace: { type: "string", minLength: 1, maxLength: 200 },
        external_id: { type: "string", minLength: 1, maxLength: 500 },
        entry_id: STR_ID,
        source_hash: { type: "string", maxLength: 256 },
        last_agent_generation: { type: "integer", minimum: 0 },
        run_id: { type: "string", maxLength: 200 },
      },
      ["source_namespace", "external_id", "entry_id"],
    ),
    async run(operations, ctx, args) {
      return operations.bindExternalIdentity(ctx, args);
    },
  },
  {
    name: "cms_get_site_info",
    description: "Baseline site identity, route policy and domain bindings.",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return operations.getSiteInfo();
    },
  },

  // --- content/block discovery (spec §21) ---
  {
    name: "cms_list_content_types",
    description: "Registered content types (deterministic order).",
    permission: "content.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return { items: operations.listContentTypes() };
    },
  },
  {
    name: "cms_get_content_type",
    description: "Full content type schema — round-trippable payload contract.",
    permission: "content.read",
    mutation: false,
    inputSchema: objectSchema(
      { key: { type: "string" }, version: { type: "integer", minimum: 1 } },
      ["key"],
    ),
    async run(operations, _ctx, args) {
      const schema = operations.getContentTypeSchema(
        args["key"] as string,
        args["version"] as number | undefined,
      );
      if (schema === null) throw new Error("content type not found");
      return schema;
    },
  },
  {
    name: "cms_list_block_types",
    description: "Registered block types.",
    permission: "content.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return { items: operations.listBlockTypes() };
    },
  },
  {
    name: "cms_get_block_schema",
    description: "Block schema: props, children policy, references.",
    permission: "content.read",
    mutation: false,
    inputSchema: objectSchema({ type_id: { type: "string" } }, ["type_id"]),
    async run(operations, _ctx, args) {
      const schema = operations.getBlockSchema(args["type_id"] as string);
      if (schema === null) throw new Error("block type not found");
      return schema;
    },
  },
  {
    name: "cms_get_collection_capabilities",
    description: "Collection DSL capabilities (typed allowlist operations).",
    permission: "content.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return operations.getCollectionCapabilities();
    },
  },

  // --- theme discovery (spec §22) ---
  {
    name: "cms_get_theme_contract",
    description:
      "Theme contract snapshot: manifest, templates, placements (unavailable when no theme source is configured).",
    permission: "theme.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return operations.getThemeContract();
    },
  },

  // --- navigation/media/seo discovery (spec §23/§24/§25) ---
  {
    name: "cms_list_navigation_sets",
    description: "Navigation sets.",
    permission: "navigation.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return { items: await operations.listNavigationSets() };
    },
  },
  {
    name: "cms_get_navigation_tree",
    description: "Materialized navigation tree by set id or key.",
    permission: "navigation.read",
    mutation: false,
    inputSchema: objectSchema({ set_ref: { type: "string" } }, ["set_ref"]),
    async run(operations, _ctx, args) {
      return { items: await operations.getNavigationTree(args["set_ref"] as string) };
    },
  },
  {
    name: "cms_list_media_presets",
    description: "Registered media presets.",
    permission: "media.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return { items: operations.listMediaPresets() };
    },
  },
  {
    name: "cms_search_query",
    description:
      "Public site search over the derived PostgreSQL full-text index (bounded, paginated; Search spec §23). Same site/locale scoping as REST.",
    mutation: false,
    inputSchema: objectSchema(
      {
        q: { type: "string", maxLength: 256 },
        locale: { type: "string", maxLength: 16 },
        site: { type: "string", maxLength: 64 },
        content_type: { type: "string", maxLength: 64 },
        date_from: { type: "string", maxLength: 32 },
        date_to: { type: "string", maxLength: 32 },
        sort: { type: "string", enum: ["relevance", "date"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        cursor: { type: "string", maxLength: 64 },
      },
      ["q", "locale"],
    ),
    async run(operations, _ctx, args) {
      return operations.searchQuery({
        q: args["q"] as string,
        locale: args["locale"] as string,
        ...(args["site"] === undefined ? {} : { site: args["site"] as string }),
        ...(args["content_type"] === undefined
          ? {}
          : { content_type: args["content_type"] as string }),
        ...(args["date_from"] === undefined ? {} : { date_from: args["date_from"] as string }),
        ...(args["date_to"] === undefined ? {} : { date_to: args["date_to"] as string }),
        ...(args["sort"] === undefined ? {} : { sort: args["sort"] as string }),
        ...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
        ...(args["cursor"] === undefined ? {} : { cursor: args["cursor"] as string }),
      });
    },
  },
  {
    name: "cms_search_admin",
    siteArgument: true,
    description:
      "Authorized admin search across the public index, draft titles, media metadata and navigation labels (Search spec §24).",
    permission: "search.admin",
    mutation: false,
    inputSchema: objectSchema(
      {
        q: { type: "string", maxLength: 256 },
        locale: { type: "string", maxLength: 16 },
        site: { type: "string", maxLength: 64 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      ["q", "locale"],
    ),
    async run(operations, _ctx, args) {
      return operations.searchAdmin({
        q: args["q"] as string,
        locale: args["locale"] as string,
        ...(args["site"] === undefined ? {} : { site: args["site"] as string }),
        ...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
      });
    },
  },
  {
    name: "cms_get_indexnow_settings",
    description:
      "IndexNow settings (site-level, DISABLED by default): enabled state, notify flags, CAS generation (IndexNow spec §29).",
    permission: "seo.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.getIndexNowSettings(ctx);
    },
  },
  {
    name: "cms_update_indexnow_settings",
    description:
      "Enable/disable IndexNow and its notify flags (CAS on expected_generation; enabling generates the verification key and queues at most ONE homepage notification — never a backfill).",
    permission: "seo.site_settings",
    mutation: true,
    inputSchema: objectSchema(
      {
        enabled: { type: "boolean" },
        expected_generation: { type: "integer", minimum: 0 },
      },
      ["enabled", "expected_generation"],
    ),
    async run(operations, ctx, args) {
      return operations.updateIndexNowSettings(ctx, {
        settings: { enabled: args["enabled"] as boolean },
        expected_generation: args["expected_generation"] as number,
      });
    },
  },
  {
    name: "cms_get_indexnow_status",
    description:
      "IndexNow delivery status: state, key file URL, pending count, last HTTP result, diagnostics. Never claims indexing.",
    permission: "seo.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return operations.getIndexNowStatus();
    },
  },
  {
    name: "cms_check_indexnow",
    description:
      "Local IndexNow checks + enqueue the single homepage verification notification (delivered asynchronously by the worker).",
    permission: "seo.site_settings",
    mutation: true,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.checkIndexNow(ctx);
    },
  },
  {
    name: "cms_rotate_indexnow_key",
    description:
      "Rotate the IndexNow verification key (queued jobs resolve the key at send time; audit recorded).",
    permission: "seo.site_settings",
    mutation: true,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.rotateIndexNowKey(ctx);
    },
  },
  {
    name: "cms_get_analytics_settings",
    description:
      "Analytics & tagging settings with CAS generation: enabled providers, ids, network rules (Analytics spec §10).",
    permission: "analytics.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.getAnalyticsSettings(ctx);
    },
  },
  {
    name: "cms_update_analytics_settings",
    description:
      "Save analytics & tagging settings (CAS on expected_generation; strict validation, typed provider configs only — arbitrary script/HTML is impossible by contract).",
    permission: "analytics.manage",
    mutation: true,
    inputSchema: objectSchema(
      {
        settings: { type: "object" },
        expected_generation: { type: "integer", minimum: 0 },
      },
      ["settings", "expected_generation"],
    ),
    async run(operations, ctx, args) {
      return operations.updateAnalyticsSettings(ctx, {
        settings: args["settings"],
        expected_generation: args["expected_generation"] as number,
      });
    },
  },
  {
    name: "cms_list_analytics_providers",
    description:
      "Registered analytics tag providers: ids, titles, strict config schemas, privacy categories.",
    permission: "analytics.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return operations.listAnalyticsProviders();
    },
  },
  {
    name: "cms_analytics_doctor",
    description:
      "Analytics installation diagnostics: config validity, render-plan probe, slot presence, CSP compatibility, duplication warnings.",
    permission: "analytics.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.runAnalyticsDoctor(ctx);
    },
  },
  {
    name: "cms_get_search_status",
    description:
      "Search index health: document count, index version vs expected, last event, reindex progress (Search spec §26).",
    permission: "search.diagnostics",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return operations.getSearchStatus();
    },
  },
  {
    name: "cms_get_search_capabilities",
    description: "Machine-readable search capabilities: entity types, filters, sorts, hard limits.",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return operations.getSearchCapabilities();
    },
  },
  {
    name: "cms_validate_search_document",
    description:
      "Re-derive one entity's public search document and return structural issues without exposing content (Search spec §31).",
    permission: "search.admin",
    mutation: false,
    inputSchema: objectSchema(
      {
        entity_type: { type: "string", maxLength: 64 },
        entity_id: { type: "string", maxLength: 64 },
      },
      ["entity_type", "entity_id"],
    ),
    async run(operations, _ctx, args) {
      return operations.validateSearchDocument({
        entity_type: args["entity_type"] as string,
        entity_id: args["entity_id"] as string,
      });
    },
  },
  {
    name: "cms_reindex_search",
    description:
      "Start (or resume) a full shadow-epoch reindex; returns run progress fields (Search spec §19/§20).",
    permission: "search.reindex",
    mutation: true,
    inputSchema: objectSchema({
      resume: { type: "boolean" },
    }),
    async run(operations, _ctx, args) {
      return operations.reindexSearch({
        ...(args["resume"] === undefined ? {} : { resume: args["resume"] as boolean }),
      });
    },
  },
  {
    name: "cms_list_forms",
    description: "List form definitions with their current schema version (Forms spec §36).",
    permission: "forms.read_definition",
    mutation: false,
    inputSchema: objectSchema({
      status: { type: "string", enum: ["ACTIVE", "ARCHIVED"] },
    }),
    async run(operations, ctx, args) {
      return operations.listForms(ctx, {
        ...(args["status"] === undefined ? {} : { status: args["status"] as string }),
      });
    },
  },
  {
    name: "cms_get_form_definition",
    description:
      "One form definition: stable identity, field set and server-validation rules of the current version (Forms spec §4–§8).",
    permission: "forms.read_definition",
    mutation: false,
    inputSchema: objectSchema({ form_id: { type: "string", maxLength: 64 } }, ["form_id"]),
    async run(operations, ctx, args) {
      return operations.getFormDefinition(ctx, args["form_id"] as string);
    },
  },
  {
    name: "cms_list_quizzes",
    description: "List quiz definitions with their current schema version (Forms spec §36).",
    permission: "quizzes.read_definition",
    mutation: false,
    inputSchema: objectSchema({
      status: { type: "string", enum: ["ACTIVE", "ARCHIVED"] },
    }),
    async run(operations, ctx, args) {
      return operations.listQuizzes(ctx, {
        ...(args["status"] === undefined ? {} : { status: args["status"] as string }),
      });
    },
  },
  {
    name: "cms_get_quiz_definition",
    description:
      "One quiz definition: steps, questions, declarative branching/scoring rules and outcomes (Forms spec §9–§15).",
    permission: "quizzes.read_definition",
    mutation: false,
    inputSchema: objectSchema({ quiz_id: { type: "string", maxLength: 64 } }, ["quiz_id"]),
    async run(operations, ctx, args) {
      return operations.getQuizDefinition(ctx, args["quiz_id"] as string);
    },
  },
  {
    name: "cms_get_quiz_public_schema",
    description:
      "Sanitized public quiz schema (steps/questions only — no scoring weights or branch targets) for rendering clients (Forms spec §36).",
    permission: "quizzes.read_definition",
    mutation: false,
    inputSchema: objectSchema({ quiz_id: { type: "string", maxLength: 64 } }, ["quiz_id"]),
    async run(operations, ctx, args) {
      return operations.getQuizPublicSchema(ctx, args["quiz_id"] as string);
    },
  },
  {
    name: "cms_list_submissions",
    description:
      "Bounded, cursor-paginated form submission history (Forms spec §36; interactions.read).",
    permission: "interactions.read",
    mutation: false,
    inputSchema: objectSchema({
      form_definition_id: { type: "string", maxLength: 64 },
      status: { type: "string", enum: ["ACCEPTED", "SPAM", "ARCHIVED"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", maxLength: 128 },
    }),
    async run(operations, ctx, args) {
      return operations.listSubmissions(ctx, {
        ...(args["form_definition_id"] === undefined
          ? {}
          : { form_definition_id: args["form_definition_id"] as string }),
        ...(args["status"] === undefined ? {} : { status: args["status"] as string }),
        ...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
        ...(args["cursor"] === undefined ? {} : { cursor: args["cursor"] as string }),
      });
    },
  },
  {
    name: "cms_get_submission",
    description:
      "One form submission with normalized payload and consent snapshot (interactions.read; PII).",
    permission: "interactions.read",
    mutation: false,
    inputSchema: objectSchema({ submission_id: { type: "string", maxLength: 64 } }, [
      "submission_id",
    ]),
    async run(operations, ctx, args) {
      return operations.getSubmission(ctx, args["submission_id"] as string);
    },
  },
  {
    name: "cms_list_quiz_runs",
    description: "Bounded quiz run history with server-computed score/outcome (interactions.read).",
    permission: "interactions.read",
    mutation: false,
    inputSchema: objectSchema({
      quiz_definition_id: { type: "string", maxLength: 64 },
      state: { type: "string", enum: ["STARTED", "COMPLETED", "ABANDONED", "EXPIRED"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", maxLength: 128 },
    }),
    async run(operations, ctx, args) {
      return operations.listQuizRuns(ctx, {
        ...(args["quiz_definition_id"] === undefined
          ? {}
          : { quiz_definition_id: args["quiz_definition_id"] as string }),
        ...(args["state"] === undefined ? {} : { state: args["state"] as string }),
        ...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
        ...(args["cursor"] === undefined ? {} : { cursor: args["cursor"] as string }),
      });
    },
  },
  {
    name: "cms_get_quiz_run",
    description:
      "One quiz run: lifecycle, score/outcome and all server-recorded answers (interactions.read).",
    permission: "interactions.read",
    mutation: false,
    inputSchema: objectSchema({ run_id: { type: "string", maxLength: 64 } }, ["run_id"]),
    async run(operations, ctx, args) {
      return operations.getQuizRun(ctx, args["run_id"] as string);
    },
  },
  {
    name: "cms_list_leads",
    description: "Bounded lead list — PII, permission-gated (leads.read).",
    permission: "leads.read",
    mutation: false,
    inputSchema: objectSchema({
      status: { type: "string", enum: ["NEW", "VIEWED", "PROCESSED", "ARCHIVED", "SPAM"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", maxLength: 128 },
    }),
    async run(operations, ctx, args) {
      return operations.listLeads(ctx, {
        ...(args["status"] === undefined ? {} : { status: args["status"] as string }),
        ...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
        ...(args["cursor"] === undefined ? {} : { cursor: args["cursor"] as string }),
      });
    },
  },
  {
    name: "cms_update_lead_status",
    description: "Lead lifecycle transition; emits LeadStatusChanged atomically (leads.manage).",
    permission: "leads.manage",
    mutation: true,
    inputSchema: objectSchema(
      {
        lead_id: { type: "string", maxLength: 64 },
        status: { type: "string", enum: ["NEW", "VIEWED", "PROCESSED", "ARCHIVED", "SPAM"] },
      },
      ["lead_id", "status"],
    ),
    async run(operations, ctx, args) {
      return operations.updateLeadStatus(ctx, {
        lead_id: args["lead_id"] as string,
        status: args["status"] as string,
      });
    },
  },
  {
    name: "cms_export_interactions",
    permissionFor: (args) => (args["entity"] === "leads" ? "leads.export" : "interactions.export"),
    description:
      "Permission-gated, audited CSV/JSON export of submissions, quiz runs or leads (Forms spec §29; interactions.export / leads.export).",
    permission: "interactions.export",
    mutation: false,
    inputSchema: objectSchema(
      {
        entity: { type: "string", enum: ["submissions", "quiz_runs", "leads"] },
        format: { type: "string", enum: ["csv", "json"] },
        form_definition_id: { type: "string", maxLength: 64 },
        status: { type: "string", maxLength: 32 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      ["entity"],
    ),
    async run(operations, ctx, args) {
      return operations.exportInteractions(ctx, {
        entity: args["entity"],
        ...(args["format"] === undefined ? {} : { format: args["format"] }),
        ...(args["form_definition_id"] === undefined
          ? {}
          : { form_definition_id: args["form_definition_id"] }),
        ...(args["status"] === undefined ? {} : { status: args["status"] }),
        ...(args["limit"] === undefined ? {} : { limit: args["limit"] }),
      });
    },
  },
  {
    name: "cms_search_media",
    description:
      "Bounded media search with typed filters (text, kind). Follow next_cursor until has_more=false for a full catalog.",
    permission: "media.read",
    mutation: false,
    inputSchema: objectSchema({
      cursor: { type: "string", maxLength: 512 },
      text: { type: "string", maxLength: 200 },
      kind: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }),
    async run(operations, ctx, args) {
      return operations.searchMedia(ctx, {
        ...(args["cursor"] === undefined ? {} : { cursor: args["cursor"] as string }),
        ...(args["text"] === undefined ? {} : { text: args["text"] as string }),
        ...(args["kind"] === undefined ? {} : { kind: args["kind"] as string }),
        ...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
      });
    },
  },
  {
    name: "cms_get_media",
    description: "Full media asset view: versions and variants.",
    permission: "media.read",
    mutation: false,
    inputSchema: objectSchema({ media_id: STR_ID }, ["media_id"]),
    async run(operations, _ctx, args) {
      return operations.getMedia(args["media_id"] as string);
    },
  },
  {
    name: "cms_get_media_usage",
    description: "Inbound references and source titles. Review before media cleanup.",
    permission: "media.read",
    mutation: false,
    inputSchema: objectSchema({ media_id: STR_ID }, ["media_id"]),
    async run(operations, ctx, args) {
      return operations.getMediaUsage(ctx, args["media_id"] as string);
    },
  },
  {
    name: "cms_archive_media",
    description:
      "Archive an unused media asset after explicit confirmation. Usage is checked first; referenced assets are refused. Requires media.read and media.archive.",
    permission: "media.archive",
    mutation: true,
    inputSchema: objectSchema({ media_id: STR_ID, confirmed: { type: "boolean", const: true } }, [
      "media_id",
      "confirmed",
    ]),
    async run(operations, ctx, args) {
      if (args["confirmed"] !== true)
        throw Object.assign(new Error("review usage and explicitly confirm archival"), {
          code: "TARGET_UNCONFIRMED",
        });
      const usage = (await operations.getMediaUsage(ctx, args["media_id"] as string)) as {
        inboundCount: number;
      };
      if (usage.inboundCount > 0)
        throw Object.assign(new Error("cleanup refuses referenced media"), {
          code: "MEDIA_IN_USE",
          details: usage,
        });
      const archived = await operations.archiveMedia(ctx, args["media_id"] as string);
      return { ok: true, usage, archived };
    },
  },
  {
    name: "cms_list_seo_entries",
    description:
      "Active Content Tree page for a full SEO audit. Skip folders; follow next_cursor to exhaustion and validate each entry with cms_validate_seo.",
    permission: "content.read",
    mutation: false,
    inputSchema: objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", maxLength: 512 },
    }),
    async run(operations, ctx, args) {
      return operations.listSeoEntries(ctx, args as { limit?: number; cursor?: string });
    },
  },
  {
    name: "cms_validate_seo",
    description:
      "SEO validation report for one entry: issues, severities and resolved metadata. Requires seo.validate.",
    permission: "seo.validate",
    mutation: false,
    inputSchema: objectSchema({ entry_id: STR_ID }, ["entry_id"]),
    async run(operations, ctx, args) {
      return operations.validateEntrySeo(ctx, args["entry_id"] as string);
    },
  },
  {
    name: "cms_change_entry_route",
    description:
      "Explicit canonical route change, recording the old URL as a 301 redirect. Requires navigation.edit and explicit confirmation. Conflicts are never forced.",
    permission: "navigation.edit",
    mutation: true,
    inputSchema: objectSchema(
      {
        entry_id: STR_ID,
        to_path: { type: "string", minLength: 1, maxLength: 500 },
        reason: { type: "string", maxLength: 500 },
        confirmed: { type: "boolean", const: true },
      },
      ["entry_id", "to_path", "confirmed"],
    ),
    async run(operations, ctx, args) {
      if (args["confirmed"] !== true)
        throw Object.assign(new Error("explicitly confirm canonical move and 301 impact"), {
          code: "TARGET_UNCONFIRMED",
        });
      return operations.changeEntryRoute(ctx, {
        entry_id: args["entry_id"] as string,
        to_path: args["to_path"] as string,
        ...(args["reason"] === undefined ? {} : { reason: args["reason"] as string }),
      });
    },
  },
  {
    name: "cms_get_seo_schema",
    description: "SEO document schema descriptor and diagnostic codes.",
    permission: "seo.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return operations.getSeoSchema();
    },
  },
  {
    name: "cms_check_route_available",
    description: "Route availability check (typed issues; never reserves).",
    permission: "site.validate",
    mutation: false,
    inputSchema: objectSchema({ path: { type: "string", maxLength: 512 } }, ["path"]),
    async run(operations, _ctx, args) {
      return operations.checkRouteAvailable(args["path"] as string);
    },
  },

  // --- publication discovery (spec §26) ---
  {
    name: "cms_list_revisions",
    description: "Revision history of an entity (bounded).",
    permission: "publication.read",
    mutation: false,
    inputSchema: objectSchema({ entity_type: { type: "string" }, entity_id: STR_ID }, [
      "entity_type",
      "entity_id",
    ]),
    async run(operations, _ctx, args) {
      return {
        items: await operations.listRevisions(
          args["entity_type"] as string,
          args["entity_id"] as string,
        ),
      };
    },
  },
  {
    name: "cms_get_changeset",
    description: "ChangeSet with its items.",
    permission: "publication.read",
    mutation: false,
    inputSchema: objectSchema({ changeset_id: STR_ID }, ["changeset_id"]),
    async run(operations, _ctx, args) {
      return operations.getChangeset(args["changeset_id"] as string);
    },
  },
  {
    name: "cms_list_changesets",
    description: "Recent ChangeSets (bounded).",
    permission: "publication.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      return { items: await operations.listChangesets() };
    },
  },
  {
    name: "cms_list_publication_calendar",
    description: "Publication calendar window.",
    permission: "publication.read",
    mutation: false,
    inputSchema: objectSchema({ from: { type: "string" }, to: { type: "string" } }),
    async run(operations, _ctx, args) {
      return {
        items: await operations.listPublicationCalendar({
          ...(args["from"] === undefined ? {} : { from: args["from"] as string }),
          ...(args["to"] === undefined ? {} : { to: args["to"] as string }),
        }),
      };
    },
  },

  // --- content mutations (spec §31/§33) ---
  {
    name: "cms_create_draft",
    description:
      "Create an entry + first working revision atomically. Payload: {fields, blocks} per the content type schema. parent_entry_id may be a folder (kind=folder rows in /discovery/content/tree are structural only: they cannot be sealed, published, routed, previewed, SEO-documented or duplicated).",
    permission: "content.create",
    mutation: true,
    inputSchema: objectSchema(
      {
        content_type: { type: "string", maxLength: 64 },
        entry_id: STR_ID,
        parent_entry_id: STR_ID,
        payload: objectSchema({ fields: { type: "object" }, blocks: { type: ["object", "null"] } }),
        locale: { type: "string", maxLength: 16 },
      },
      ["content_type", "payload"],
    ),
    async run(operations, ctx, args) {
      return operations.createDraft(ctx, {
        content_type: args["content_type"] as string,
        payload: (args["payload"] ?? {}) as { fields?: unknown; blocks?: unknown },
        ...(args["entry_id"] === undefined ? {} : { entry_id: args["entry_id"] as string }),
        ...(args["parent_entry_id"] === undefined
          ? {}
          : { parent_entry_id: args["parent_entry_id"] as string }),
        ...(args["locale"] === undefined ? {} : { locale: args["locale"] as string }),
      });
    },
  },
  {
    name: "cms_update_draft",
    description: "Autosave a working revision; requires the current edit_generation (CAS).",
    permission: "content.edit",
    mutation: true,
    inputSchema: objectSchema(
      {
        revision_id: STR_ID,
        payload: objectSchema({ fields: { type: "object" }, blocks: { type: ["object", "null"] } }),
        expected_edit_generation: { type: "integer", minimum: 0 },
      },
      ["revision_id", "payload", "expected_edit_generation"],
    ),
    async run(operations, ctx, args) {
      return operations.updateDraft(ctx, {
        revision_id: args["revision_id"] as string,
        payload: (args["payload"] ?? {}) as { fields?: unknown; blocks?: unknown },
        expected_edit_generation: args["expected_edit_generation"] as number,
      });
    },
  },
  {
    name: "cms_validate_revision",
    description: "Validate a revision against publish-level rules; returns structured issues.",
    permission: "content.edit",
    mutation: false,
    inputSchema: objectSchema({ revision_id: STR_ID }, ["revision_id"]),
    async run(operations, ctx, args) {
      return operations.validateRevision(ctx, { revision_id: args["revision_id"] as string });
    },
  },
  {
    name: "cms_seal_revision",
    description: "Seal a working revision (publish-level validation runs inside the domain).",
    permission: "revision.seal",
    mutation: true,
    inputSchema: objectSchema(
      { revision_id: STR_ID, expected_edit_generation: { type: "integer", minimum: 0 } },
      ["revision_id"],
    ),
    async run(operations, ctx, args) {
      return operations.sealRevision(ctx, {
        revision_id: args["revision_id"] as string,
        ...(args["expected_edit_generation"] === undefined
          ? {}
          : { expected_edit_generation: args["expected_edit_generation"] as number }),
      });
    },
  },

  {
    name: "cms_cleanup_entry_revisions",
    description:
      "Bulk cleanup (iterative-editing case): delete all SEALED revisions of an entry except the currently published one. The working revision is always kept; refuses entries without a published revision (409 REVISION_CLEANUP_NO_PUBLISHED). Requires content.edit.",
    permission: "content.edit",
    mutation: true,
    inputSchema: objectSchema({ entry_id: { type: "string" } }, ["entry_id"]),
    async run(operations, ctx, args) {
      return operations.cleanupEntryRevisions(ctx, { entry_id: args["entry_id"] as string });
    },
  },
  {
    name: "cms_delete_revision",
    description:
      "Delete a WORKING or SEALED revision (cleanup of drafts/garbage). The currently published revision is rejected (REVISION_PUBLISHED) — unpublish or publish another revision first. Audited, irreversible.",
    permission: "content.edit",
    mutation: true,
    inputSchema: objectSchema({ revision_id: STR_ID }, ["revision_id"]),
    async run(operations, ctx, args) {
      return operations.deleteRevision(ctx, { revision_id: args["revision_id"] as string });
    },
  },

  // --- changeset/plan mutations (spec §41) ---
  {
    name: "cms_create_changeset",
    description: "Create a ChangeSet (coordinated release container).",
    permission: "publication.plan",
    mutation: true,
    inputSchema: objectSchema({ title: { type: "string", minLength: 1, maxLength: 300 } }, [
      "title",
    ]),
    async run(operations, ctx, args) {
      return operations.createChangeset(ctx, { title: args["title"] as string });
    },
  },
  {
    name: "cms_add_changeset_item",
    description:
      "Add a candidate (sealed revision + optional route operation) to a ChangeSet with its CAS generation.",
    permission: "publication.plan",
    mutation: true,
    inputSchema: objectSchema(
      {
        changeset_id: STR_ID,
        entity_type: { type: "string" },
        entity_id: STR_ID,
        intent: { enum: ["PUBLISH", "UNPUBLISH"] },
        target_revision_id: STR_ID,
        expected_generation: { type: "integer", minimum: 0 },
        route_operation: {
          type: "object",
          properties: {
            kind: { enum: ["set", "retire", "none"] },
            site_id: STR_ID,
            path: { type: "string" },
            frees_path: { type: "string" },
          },
        },
      },
      ["changeset_id", "entity_type", "entity_id", "intent", "expected_generation"],
    ),
    async run(operations, ctx, args) {
      const route = args["route_operation"] as Record<string, unknown> | undefined;
      return operations.addChangesetItem(ctx, {
        changeset_id: args["changeset_id"] as string,
        entity_type: args["entity_type"] as string,
        entity_id: args["entity_id"] as string,
        intent: args["intent"] as "PUBLISH" | "UNPUBLISH",
        expected_generation: args["expected_generation"] as number,
        ...(args["target_revision_id"] === undefined
          ? {}
          : { target_revision_id: args["target_revision_id"] as string }),
        ...(route === undefined
          ? {}
          : {
              route_operation:
                route["kind"] === "set"
                  ? {
                      kind: "set",
                      site_id: route["site_id"],
                      path: route["path"],
                      ...(route["frees_path"] === undefined
                        ? {}
                        : { frees_path: route["frees_path"] }),
                    }
                  : { kind: route["kind"] },
            }),
      });
    },
  },
  {
    name: "cms_preflight_changeset",
    description: "Validate the whole release without applying it.",
    permission: "publication.plan",
    mutation: false,
    inputSchema: objectSchema({ changeset_id: STR_ID }, ["changeset_id"]),
    async run(operations, ctx, args) {
      return operations.preflightChangeset(ctx, { changeset_id: args["changeset_id"] as string });
    },
  },
  {
    name: "cms_apply_changeset",
    description:
      "Apply the release: every public pointer/route move in ONE transaction. Requires publication.publish.",
    permission: "publication.publish",
    mutation: true,
    inputSchema: objectSchema({ changeset_id: STR_ID }, ["changeset_id"]),
    async run(operations, ctx, args) {
      return operations.applyChangeset(ctx, { changeset_id: args["changeset_id"] as string });
    },
  },
  {
    name: "cms_create_plan",
    description: "Create a publication plan (timezone-aware batch scheduling).",
    permission: "publication.plan",
    mutation: true,
    inputSchema: objectSchema(
      {
        changeset_id: STR_ID,
        timezone: { type: "string", maxLength: 64 },
        failure_policy: { enum: ["continue", "pause_batch", "pause_plan"] },
      },
      ["changeset_id", "timezone"],
    ),
    async run(operations, ctx, args) {
      return operations.createPlan(ctx, {
        changeset_id: args["changeset_id"] as string,
        timezone: args["timezone"] as string,
        ...(args["failure_policy"] === undefined
          ? {}
          : { failure_policy: args["failure_policy"] as string }),
      });
    },
  },
  {
    name: "cms_preview_plan",
    description: "Dry-run the batch schedule (nothing persisted).",
    permission: "publication.plan",
    mutation: false,
    inputSchema: objectSchema(
      { plan_id: STR_ID, spec: { type: "object" }, overrides: PLAN_OVERRIDES },
      ["plan_id", "spec"],
    ),
    async run(operations, ctx, args) {
      return {
        items: await operations.previewPlan(ctx, {
          plan_id: args["plan_id"] as string,
          spec: args["spec"] as never,
          ...(args["overrides"] === undefined ? {} : { overrides: args["overrides"] as unknown[] }),
        }),
      };
    },
  },
  {
    name: "cms_schedule_plan",
    description: "Materialize timestamps and enqueue idempotent publish jobs.",
    permission: "publication.schedule",
    mutation: true,
    inputSchema: objectSchema(
      { plan_id: STR_ID, spec: { type: "object" }, overrides: PLAN_OVERRIDES },
      ["plan_id", "spec"],
    ),
    async run(operations, ctx, args) {
      return {
        items: await operations.schedulePlan(ctx, {
          plan_id: args["plan_id"] as string,
          spec: args["spec"] as never,
          ...(args["overrides"] === undefined ? {} : { overrides: args["overrides"] as unknown[] }),
        }),
      };
    },
  },
  {
    name: "cms_publish_now",
    description:
      "Cancel the pending schedule and publish exactly once. Requires publication.publish.",
    permission: "publication.publish",
    mutation: true,
    inputSchema: objectSchema({ plan_id: STR_ID, item_id: STR_ID }, ["plan_id", "item_id"]),
    async run(operations, ctx, args) {
      await operations.publishNow(ctx, {
        plan_id: args["plan_id"] as string,
        item_id: args["item_id"] as string,
      });
      return { ok: true };
    },
  },
  {
    name: "cms_publish_revision",
    description:
      "Direct single-entity publish with generation CAS. Requires publication.publish — never granted to default agent scopes.",
    permission: "publication.publish",
    mutation: true,
    inputSchema: objectSchema(
      {
        entity_type: { type: "string" },
        entity_id: STR_ID,
        target_revision_id: STR_ID,
        expected_generation: { type: "integer", minimum: 0 },
      },
      ["entity_type", "entity_id", "target_revision_id", "expected_generation"],
    ),
    async run(operations, ctx, args) {
      return operations.publishRevision(ctx, {
        entity_type: args["entity_type"] as string,
        entity_id: args["entity_id"] as string,
        target_revision_id: args["target_revision_id"] as string,
        expected_generation: args["expected_generation"] as number,
      });
    },
  },

  // --- themes/previews/bundle ---
  {
    name: "cms_validate_theme",
    description: "Validate the configured theme source against the theme contract.",
    permission: "theme.validate",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.validateTheme(ctx);
    },
  },
  {
    name: "cms_create_preview",
    description: "Create a signed, expiring preview reference for a revision or changeset.",
    permission: "preview.create",
    mutation: false,
    inputSchema: objectSchema(
      {
        scope: {
          oneOf: [
            objectSchema(
              {
                kind: { enum: ["revision"] },
                entity_type: { type: "string" },
                entity_id: STR_ID,
                revision_id: STR_ID,
              },
              ["kind", "entity_type", "entity_id", "revision_id"],
            ),
            objectSchema({ kind: { enum: ["changeset"] }, changeset_id: STR_ID }, [
              "kind",
              "changeset_id",
            ]),
          ],
        },
      },
      ["scope"],
    ),
    async run(operations, ctx, args) {
      return operations.createPreview(ctx, args["scope"] as never);
    },
  },
  {
    name: "cms_submit_bundle",
    description:
      "Publication Bundle: validate or atomically apply a coordinated content batch (mode: validate|apply). Strict all-or-nothing; supports ref:<id> intra-bundle references.",
    permission: "content.create",
    mutation: true,
    inputSchema: objectSchema(
      {
        mode: { enum: ["validate", "apply"] },
        bundle: { type: "object" },
      },
      ["mode", "bundle"],
    ),
    async run(operations, ctx, args) {
      return operations.submitBundle(
        ctx,
        args["bundle"] as Record<string, unknown>,
        args["mode"] as "validate" | "apply",
      );
    },
  },
  {
    name: "cms_update_media_metadata",
    description: "Update descriptive media metadata (title/alt/caption).",
    permission: "media.write",
    mutation: true,
    inputSchema: objectSchema(
      {
        media_id: STR_ID,
        title: { type: "string", maxLength: 300 },
        alt_default: { type: "string", maxLength: 300 },
        caption_default: { type: "string", maxLength: 500 },
      },
      ["media_id"],
    ),
    async run(operations, ctx, args) {
      return operations.updateMediaMetadata(ctx, {
        media_id: args["media_id"] as string,
        ...(args["title"] === undefined ? {} : { title: args["title"] as string }),
        ...(args["alt_default"] === undefined
          ? {}
          : { alt_default: args["alt_default"] as string }),
        ...(args["caption_default"] === undefined
          ? {}
          : { caption_default: args["caption_default"] as string }),
      });
    },
  },
  {
    name: "cms_archive_entry",
    description: "Archive an entry (idempotent; never a hard delete).",
    permission: "content.archive",
    mutation: true,
    inputSchema: objectSchema({ entry_id: STR_ID }, ["entry_id"]),
    async run(operations, ctx, args) {
      return operations.archiveEntry(ctx, { entry_id: args["entry_id"] as string });
    },
  },

  // --- integrations (M13; Integrations spec §43) — the same audited
  // application operations REST uses; scopes enforced in the ops layer ---
  {
    name: "cms_list_connectors",
    description: "Registered integration connector catalog with typed contracts.",
    permission: "integrations.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.listConnectors(ctx);
    },
  },
  {
    name: "cms_get_connector_schema",
    description: "Connector config schema, secret requirements and supported actions.",
    permission: "integrations.read",
    mutation: false,
    inputSchema: objectSchema({ connector_type: { type: "string" } }, ["connector_type"]),
    async run(operations, ctx, args) {
      return operations.getConnectorSchema(ctx, {
        connector_type: args["connector_type"] as string,
      });
    },
  },
  {
    name: "cms_list_integration_instances",
    description: "Configured connections (secret refs are names, never values).",
    permission: "integrations.read",
    mutation: false,
    inputSchema: objectSchema({ connector_type: { type: "string" } }),
    async run(operations, ctx, args) {
      return operations.listIntegrationInstances(
        ctx,
        args["connector_type"] === undefined
          ? undefined
          : { connector_type: args["connector_type"] as string },
      );
    },
  },
  {
    name: "cms_create_integration_instance",
    description:
      "Configure a connection (integrations.configure; secret refs additionally integrations.secrets.manage).",
    permission: "integrations.configure",
    mutation: true,
    inputSchema: objectSchema(
      {
        connector_type: { type: "string" },
        name: { type: "string" },
        enabled: { type: "boolean" },
        config: { type: "object" },
        secret_refs: { type: "object" },
      },
      ["connector_type", "name", "config"],
    ),
    async run(operations, ctx, args) {
      return operations.createIntegrationInstance(ctx, args);
    },
  },
  {
    name: "cms_update_integration_instance",
    description: "Update a configured connection.",
    permission: "integrations.configure",
    mutation: true,
    inputSchema: objectSchema({ instance_id: { type: "string" } }, ["instance_id"]),
    async run(operations, ctx, args) {
      return operations.updateIntegrationInstance(ctx, args);
    },
  },
  {
    name: "cms_test_integration_instance",
    description: "Run the safe connector-specific connection probe (audited).",
    permission: "integrations.test",
    mutation: true,
    inputSchema: objectSchema({ instance_id: { type: "string" } }, ["instance_id"]),
    async run(operations, ctx, args) {
      return operations.testIntegrationInstance(ctx, {
        instance_id: args["instance_id"] as string,
      });
    },
  },
  {
    name: "cms_list_integration_bindings",
    description: "Event-to-action bindings with bounded conditions.",
    permission: "integrations.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.listIntegrationBindings(ctx);
    },
  },
  {
    name: "cms_create_integration_binding",
    description: "Bind a domain event type to configured actions.",
    permission: "integrations.configure",
    mutation: true,
    inputSchema: objectSchema({ binding: { type: "object" } }, ["binding"]),
    async run(operations, ctx, args) {
      return operations.createIntegrationBinding(ctx, args["binding"]);
    },
  },
  {
    name: "cms_update_integration_binding",
    description: "Update a binding (enable/disable, conditions, actions, policy).",
    permission: "integrations.configure",
    mutation: true,
    inputSchema: objectSchema({ binding_id: { type: "string" }, patch: { type: "object" } }, [
      "binding_id",
      "patch",
    ]),
    async run(operations, ctx, args) {
      return operations.updateIntegrationBinding(ctx, {
        binding_id: args["binding_id"] as string,
        patch: args["patch"],
      });
    },
  },
  {
    name: "cms_list_integration_deliveries",
    description: "Outbound delivery history with reliability states.",
    permission: "integrations.deliveries.read",
    mutation: false,
    inputSchema: objectSchema({
      status: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    }),
    async run(operations, ctx, args) {
      return operations.listIntegrationDeliveries(
        ctx,
        args["status"] === undefined && args["limit"] === undefined
          ? undefined
          : {
              ...(args["status"] === undefined ? {} : { status: args["status"] as string }),
              ...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
            },
      );
    },
  },
  {
    name: "cms_get_integration_delivery",
    description: "One delivery with its complete attempt history.",
    permission: "integrations.deliveries.read",
    mutation: false,
    inputSchema: objectSchema({ delivery_id: { type: "string" } }, ["delivery_id"]),
    async run(operations, ctx, args) {
      return operations.getIntegrationDelivery(ctx, { delivery_id: args["delivery_id"] as string });
    },
  },
  {
    name: "cms_retry_integration_delivery",
    description: "Manual retry of a failed delivery (permission-gated, audited).",
    permission: "integrations.retry",
    mutation: true,
    inputSchema: objectSchema({ delivery_id: { type: "string" } }, ["delivery_id"]),
    async run(operations, ctx, args) {
      return operations.retryIntegrationDelivery(ctx, {
        delivery_id: args["delivery_id"] as string,
      });
    },
  },
  {
    name: "cms_list_inbound_events",
    description: "Inbound provider events (metadata only; raw payloads protected).",
    permission: "integrations.inbound.read",
    mutation: false,
    inputSchema: objectSchema({
      status: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    }),
    async run(operations, ctx, args) {
      return operations.listInboundEvents(
        ctx,
        args["status"] === undefined ? undefined : { status: args["status"] as string },
      );
    },
  },
  {
    name: "cms_get_contract_versions",
    description:
      "Independent contract versions: cms, config, extension, REST, MCP, theme, blocks, search.",
    permission: "extensions.manage",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.getContractVersions(ctx);
    },
  },
  {
    // ADR-0013 reconciliation fix: this M14 tool previously collided with the
    // M09 actor-capabilities tool of the same name — tools/call resolved the
    // first match, so this tool was unreachable. Renaming makes it reachable;
    // `cms_get_capabilities` keeps its M09 behavior (no agent-visible change).
    name: "cms_get_extension_capabilities",
    description: "Effective capability provisions (key, version, provider).",
    permission: "extensions.manage",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.getCapabilities(ctx);
    },
  },
  {
    name: "cms_list_extensions",
    description: "Deployed extensions with lifecycle state, capabilities and compatibility.",
    permission: "extensions.manage",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.listExtensions(ctx);
    },
  },
  {
    name: "cms_get_extension_compatibility",
    description: "Machine-readable compatibility issues for one extension.",
    permission: "extensions.manage",
    mutation: false,
    inputSchema: objectSchema({ extension_id: { type: "string" } }, ["extension_id"]),
    async run(operations, ctx, args) {
      return operations.getExtensionCompatibility(ctx, {
        extension_id: args["extension_id"] as string,
      });
    },
  },
  {
    name: "cms_get_update_preflight",
    description: "Read-only update preflight against the configured target release manifest.",
    permission: "extensions.manage",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.getUpdatePreflight(ctx);
    },
  },
  {
    name: "cms_list_deprecations",
    description: "Deprecation records with replacement and planned removal metadata.",
    permission: "extensions.manage",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.listDeprecations(ctx);
    },
  },
  {
    name: "cms_extension_install",
    description:
      "Activate an already-deployed trusted extension artifact (extensions.manage; audited).",
    permission: "extensions.manage",
    mutation: true,
    inputSchema: objectSchema({ extension_id: { type: "string" } }, ["extension_id"]),
    async run(operations, ctx, args) {
      return operations.installExtension(ctx, { extension_id: args["extension_id"] as string });
    },
  },
  {
    name: "cms_extension_enable",
    description: "Enable an installed extension after its preflight (audited).",
    permission: "extensions.manage",
    mutation: true,
    inputSchema: objectSchema({ extension_id: { type: "string" } }, ["extension_id"]),
    async run(operations, ctx, args) {
      return operations.enableExtension(ctx, { extension_id: args["extension_id"] as string });
    },
  },
  {
    name: "cms_extension_disable",
    description: "Disable an extension; impact preflight blocks active dependents (audited).",
    permission: "extensions.manage",
    mutation: true,
    inputSchema: objectSchema({ extension_id: { type: "string" } }, ["extension_id"]),
    async run(operations, ctx, args) {
      return operations.disableExtension(ctx, { extension_id: args["extension_id"] as string });
    },
  },
  {
    name: "cms_extension_uninstall",
    description:
      "Remove executable extension state; destructive data policies need the confirmation (audited).",
    permission: "extensions.manage",
    mutation: true,
    inputSchema: objectSchema(
      { extension_id: { type: "string" }, confirmation: { type: "string" } },
      ["extension_id"],
    ),
    async run(operations, ctx, args) {
      return operations.uninstallExtension(ctx, {
        extension_id: args["extension_id"] as string,
        ...(args["confirmation"] === undefined
          ? {}
          : { confirmation: args["confirmation"] as string }),
      });
    },
  },
  {
    name: "cms_list_payment_providers",
    description: "Registered payment provider types with secret requirements.",
    permission: "payments.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.listPaymentProviders(ctx);
    },
  },
  {
    name: "cms_list_payment_provider_instances",
    description: "Configured provider instances (secret refs are names, never values).",
    permission: "payments.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.listPaymentProviderInstances(ctx);
    },
  },
  {
    name: "cms_get_payment_provider_capabilities",
    description: "Capability report: cancel/refund/provider idempotency/status sync.",
    permission: "payments.read",
    mutation: false,
    inputSchema: objectSchema({ provider_type: { type: "string" } }, ["provider_type"]),
    async run(operations, ctx, args) {
      return operations.getPaymentProviderCapabilities(ctx, {
        provider_type: args["provider_type"] as string,
      });
    },
  },
  {
    name: "cms_create_payment",
    description: "Create a payment; idempotency_key is the retry identity (payments.create).",
    permission: "payments.create",
    mutation: true,
    inputSchema: objectSchema(
      {
        provider_instance_id: { type: "string" },
        subject_type: { type: "string" },
        subject_id: { type: "string" },
        amount: { type: "number", exclusiveMinimum: 0 },
        currency: { type: "string" },
        description: { type: "string" },
        idempotency_key: { type: "string" },
        metadata: { type: "object" },
      },
      [
        "provider_instance_id",
        "subject_type",
        "subject_id",
        "amount",
        "currency",
        "idempotency_key",
      ],
    ),
    async run(operations, ctx, args) {
      return operations.createPayment(ctx, args);
    },
  },
  {
    name: "cms_list_payments",
    description: "Payment list with bounded filters.",
    permission: "payments.read",
    mutation: false,
    inputSchema: objectSchema({
      status: { type: "string" },
      subject_type: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    }),
    async run(operations, ctx, args) {
      return operations.listPayments(
        ctx,
        args["status"] === undefined &&
          args["subject_type"] === undefined &&
          args["limit"] === undefined
          ? undefined
          : {
              ...(args["status"] === undefined ? {} : { status: args["status"] as string }),
              ...(args["subject_type"] === undefined
                ? {}
                : { subject_type: args["subject_type"] as string }),
              ...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
            },
      );
    },
  },
  {
    name: "cms_get_payment",
    description: "One payment with normalized/provider status and amounts.",
    permission: "payments.read",
    mutation: false,
    inputSchema: objectSchema({ payment_id: { type: "string" } }, ["payment_id"]),
    async run(operations, ctx, args) {
      return operations.getPayment(ctx, { payment_id: args["payment_id"] as string });
    },
  },
  {
    name: "cms_cancel_payment",
    description: "Cancel a CREATED/PENDING payment (payments.cancel).",
    permission: "payments.cancel",
    mutation: true,
    inputSchema: objectSchema({ payment_id: { type: "string" } }, ["payment_id"]),
    async run(operations, ctx, args) {
      return operations.cancelPayment(ctx, { payment_id: args["payment_id"] as string });
    },
  },
  {
    name: "cms_refund_payment",
    description: "Privileged refund, partial or full (payments.refund; audited).",
    permission: "payments.refund",
    mutation: true,
    inputSchema: objectSchema(
      {
        payment_id: { type: "string" },
        amount: { type: "number", exclusiveMinimum: 0 },
        reason: { type: "string" },
      },
      ["payment_id"],
    ),
    async run(operations, ctx, args) {
      return operations.refundPayment(ctx, {
        payment_id: args["payment_id"] as string,
        ...(args["amount"] === undefined ? {} : { amount: args["amount"] as number }),
        ...(args["reason"] === undefined ? {} : { reason: args["reason"] as string }),
      });
    },
  },
  {
    name: "cms_list_payment_events",
    description: "Append-only payment timeline (payments.events.read).",
    permission: "payments.events.read",
    mutation: false,
    inputSchema: objectSchema({ payment_id: { type: "string" } }, ["payment_id"]),
    async run(operations, ctx, args) {
      return operations.listPaymentEvents(ctx, { payment_id: args["payment_id"] as string });
    },
  },
  {
    name: "cms_list_media_providers",
    description:
      "List installed, enabled media acquisition providers (stock/generation) with configured state. No credential material.",
    permission: "media.read",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations, ctx) {
      return operations.listMediaProviders(ctx);
    },
  },
  {
    name: "cms_search_stock_media",
    description:
      "Provider-neutral stock image search. Returns candidates with opaque candidate_ref handles (import these; never construct URLs).",
    permission: "media.stock.search",
    mutation: false,
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 300 },
        provider_id: { type: "string", maxLength: 64 },
        orientation: { enum: ["landscape", "portrait", "square"] },
        min_width: { type: "integer", minimum: 1, maximum: 20000 },
        min_height: { type: "integer", minimum: 1, maximum: 20000 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        cursor: { type: "string", maxLength: 4096 },
      },
      ["query"],
    ),
    async run(operations, ctx, args) {
      return operations.searchStockMedia(ctx, args);
    },
  },
  {
    name: "cms_import_stock_candidate",
    description:
      "Import a stock candidate (from cms_search_stock_media) into the Media Library as a canonical asset. Duplicate-safe per provider asset.",
    permission: "media.stock.import",
    mutation: true,
    inputSchema: objectSchema(
      {
        candidate_ref: { type: "string", minLength: 16, maxLength: 8192 },
      },
      ["candidate_ref"],
    ),
    async run(operations, ctx, args) {
      return operations.importStockCandidate(ctx, {
        candidate_ref: args["candidate_ref"] as string,
      });
    },
  },
  {
    name: "cms_generate_media",
    description:
      "Generate ONE image (cost-bearing; requires media.generate). Agent contract: read cms_get_media_provider_capabilities for models/sizes first, call cms_estimate_media_generation for the price, then generate with aspect+resolution from the model's size options (never raw pixels). count is clamped to 1 for agents. Poll cms_get_media_generation until ready — every candidate already carries media_id in the library; accept is optional replay.",
    permission: "media.generate",
    mutation: true,
    inputSchema: objectSchema(
      {
        prompt: { type: "string", minLength: 1, maxLength: 2000 },
        provider_id: { type: "string", maxLength: 64 },
        negative_prompt: { type: "string", maxLength: 2000 },
        aspect: { type: "string", maxLength: 16 },
        resolution: { enum: ["0.5k", "1k", "2k", "4k"] },
        count: { type: "integer", minimum: 1, maximum: 1 },
        model: { type: "string", maxLength: 200 },
        seed: { type: "integer", minimum: 0 },
        reference_media_ids: {
          type: "array",
          items: { type: "string", maxLength: 64 },
          maxItems: 16,
        },
      },
      ["prompt"],
    ),
    async run(operations, ctx, args) {
      // Count ladder (owner decision 2026-09-28): agents generate exactly
      // one image per call — clamp here, at the agent transport boundary.
      return operations.createMediaGeneration(ctx, { ...args, count: 1 });
    },
  },
  {
    name: "cms_get_media_generation",
    description:
      "Inspect a generation run: status, actual cost, and candidates — each with media_id (auto-imported into the library), preview_url, model, seed. Never reference preview URLs; use media_id.",
    permission: "media.generate",
    mutation: false,
    inputSchema: objectSchema({ generation_id: { type: "string" } }, ["generation_id"]),
    async run(operations, ctx, args) {
      return operations.getMediaGeneration(ctx, { generation_id: args["generation_id"] as string });
    },
  },
  {
    name: "cms_get_media_provider_capabilities",
    description:
      "Models configured on a generation provider with their contracts: size options (aspect+pixels), resolution tiers, limits, negative/seed support, reference-image caps and published prices. Read this BEFORE generating.",
    permission: "media.read",
    mutation: false,
    inputSchema: objectSchema({ provider_id: { type: "string", maxLength: 64 } }, ["provider_id"]),
    async run(operations, ctx, args) {
      return operations.getMediaProviderCapabilities(ctx, {
        provider_id: args["provider_id"] as string,
      });
    },
  },
  {
    name: "cms_estimate_media_generation",
    description:
      "Approximate generation cost for model+aspect+resolution+count BEFORE paying. Token-priced or unpublished-price models return an explicit refusal instead of a number.",
    permission: "media.generate",
    mutation: false,
    inputSchema: objectSchema(
      {
        provider_id: { type: "string", maxLength: 64 },
        model: { type: "string", maxLength: 200 },
        aspect: { type: "string", maxLength: 16 },
        resolution: { enum: ["0.5k", "1k", "2k", "4k"] },
        count: { type: "integer", minimum: 1, maximum: 1 },
      },
      [],
    ),
    async run(operations, ctx, args) {
      return operations.estimateMediaGeneration(ctx, args);
    },
  },
  {
    name: "cms_validate_redirect_import",
    siteArgument: true,
    description:
      "Dry-run a legacy-URL redirect batch before importing (site migrations, SEO). Per-row report (invalid path, reserved, collision with a live route, duplicates, self-redirects, open-redirect targets) plus redirect-graph issues (loops, chains) checked against EXISTING history. Writes nothing. Workflow: validate first, show the owner the report, only then apply. Rows: source (old path), target (new site path or stable entry id; omit for 410 gone), status_code (301 default; 410 = permanently gone), reason.",
    permission: "routing.redirects.import",
    inputSchema: objectSchema(
      {
        site: { type: "string", maxLength: 100 },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: 10000,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["source"],
            properties: {
              source: { type: "string", minLength: 1, maxLength: 500 },
              target: { type: ["string", "null"], maxLength: 500 },
              status_code: { type: "integer", enum: [301, 302, 307, 308, 410] },
              reason: { type: "string", maxLength: 200 },
            },
          },
        },
      },
      ["rows"],
    ),
    async run(operations, ctx, args) {
      return operations.validateRedirectImport(ctx, args);
    },
    mutation: false,
  },
  {
    name: "cms_apply_redirect_import",
    siteArgument: true,
    description:
      "Validate and apply a legacy-URL redirect batch atomically (any row or redirect-graph error aborts the whole batch). Sources must not shadow live routes; absolute/javascript targets are refused; loops and >3-hop chains across the batch AND existing history are refused. Requests go to old URLs from sitemaps, external links and search indexes afterwards resolve 301/410.",
    permission: "routing.redirects.import",
    mutation: true,
    inputSchema: objectSchema(
      {
        site: { type: "string", maxLength: 100 },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: 10000,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["source"],
            properties: {
              source: { type: "string", minLength: 1, maxLength: 500 },
              target: { type: ["string", "null"], maxLength: 500 },
              status_code: { type: "integer", enum: [301, 302, 307, 308, 410] },
              reason: { type: "string", maxLength: 200 },
            },
          },
        },
      },
      ["rows"],
    ),
    async run(operations, ctx, args) {
      return operations.applyRedirectImport(ctx, args);
    },
  },
  {
    name: "cms_import_media_url",
    description:
      "Server-side pull of one remote image/file into the media library (site migrations, content imports). SSRF-safe fetch with per-hop checks, sha256 dedupe — an already-imported file returns the existing media_id with duplicate_blob true, so repeated references to the same source image cost nothing — and variants generated on accept. Returns media_id; reference it in content instead of the source URL.",
    permission: "media.import",
    mutation: true,
    inputSchema: objectSchema({ url: { type: "string", minLength: 8, maxLength: 2048 } }, ["url"]),
    async run(operations, ctx, args) {
      return operations.importMediaUrl(ctx, { url: args["url"] as string });
    },
  },
  {
    name: "cms_accept_generated_media",
    description:
      "Optional replay path: candidates are already auto-imported into the library. Accepting again returns the existing asset (duplicate: true).",
    permission: "media.generate",
    mutation: true,
    inputSchema: objectSchema(
      {
        generation_id: { type: "string" },
        candidate_index: { type: "integer", minimum: 0, maximum: 64 },
      },
      ["generation_id", "candidate_index"],
    ),
    async run(operations, ctx, args) {
      return operations.acceptGeneratedMedia(ctx, {
        generation_id: args["generation_id"] as string,
        candidate_index: args["candidate_index"] as number,
      });
    },
  },
  // --- domains / identity repair / registry (owner 2026-10-06 audit) ---
  {
    name: "cms_list_site_domains",
    siteArgument: true,
    description: "Domain bindings of a site (?site= key, default site). Requires domains.manage.",
    permission: "domains.manage",
    mutation: false,
    inputSchema: objectSchema({ site: { type: "string" } }),
    async run(operations, ctx, args) {
      return operations.listSiteDomains(ctx, args["site"] as string | undefined);
    },
  },
  {
    name: "cms_add_site_domain",
    siteArgument: true,
    description:
      "Add a domain binding (hostname normalized/validated; first binding becomes primary; single-primary invariant). Requires domains.manage.",
    permission: "domains.manage",
    mutation: true,
    inputSchema: objectSchema(
      {
        hostname: { type: "string" },
        is_primary: { type: "boolean" },
        locale: { type: ["string", "null"] },
        scheme_policy: { enum: ["https", "http"] },
        canonical_redirect_policy: { enum: ["redirect", "serve"] },
        site: { type: "string" },
      },
      ["hostname"],
    ),
    async run(operations, ctx, args) {
      return operations.addSiteDomain(ctx, {
        hostname: args["hostname"] as string,
        ...(args["is_primary"] === undefined ? {} : { is_primary: args["is_primary"] as boolean }),
        ...(args["locale"] === undefined ? {} : { locale: args["locale"] as string | null }),
        ...(args["scheme_policy"] === undefined
          ? {}
          : { scheme_policy: args["scheme_policy"] as "https" | "http" }),
        ...(args["canonical_redirect_policy"] === undefined
          ? {}
          : {
              canonical_redirect_policy: args["canonical_redirect_policy"] as "redirect" | "serve",
            }),
        ...(args["site"] === undefined ? {} : { site: args["site"] as string }),
      });
    },
  },
  {
    name: "cms_set_primary_domain",
    siteArgument: true,
    description:
      "Atomic canonical-primary switch for a domain binding; sitemap/canonical pick it up immediately (no restart). Requires domains.manage.",
    permission: "domains.manage",
    mutation: true,
    inputSchema: objectSchema({ hostname: { type: "string" }, site: { type: "string" } }, [
      "hostname",
    ]),
    async run(operations, ctx, args) {
      return operations.setPrimarySiteDomain(
        ctx,
        args["site"] as string | undefined,
        args["hostname"] as string,
      );
    },
  },
  {
    name: "cms_remove_site_domain",
    siteArgument: true,
    description:
      "Remove a domain binding (the last one is undeletable; removing the primary promotes the first remaining). Requires domains.manage.",
    permission: "domains.manage",
    mutation: true,
    inputSchema: objectSchema({ hostname: { type: "string" }, site: { type: "string" } }, [
      "hostname",
    ]),
    async run(operations, ctx, args) {
      return operations.removeSiteDomain(
        ctx,
        args["site"] as string | undefined,
        args["hostname"] as string,
      );
    },
  },
  {
    name: "cms_reidentify_entry_locale",
    description:
      "Identity repair: move an entry and its working revisions to a policy-allowed identity locale in one transaction. Entry id, routes, publication pointers, payloads and edit generations untouched; sealed history immutable. Refuses locales outside the site policy and translation-group members. Requires content.edit.",
    permission: "content.edit",
    mutation: true,
    inputSchema: objectSchema({ entry_id: { type: "string" }, locale: { type: "string" } }, [
      "entry_id",
      "locale",
    ]),
    async run(operations, ctx, args) {
      return operations.reidentifyEntryLocale(ctx, {
        entry_id: args["entry_id"] as string,
        locale: args["locale"] as string,
      });
    },
  },
  {
    name: "cms_list_registry_releases",
    description:
      "Engine releases the registry serves (latest first), with sha256 and notes. Requires extensions.manage.",
    permission: "extensions.manage",
    mutation: false,
    inputSchema: objectSchema({}),
    async run(operations) {
      const index = (await operations.registryReleases()) as {
        releases: readonly { version: string; sha256: string; notes: string }[];
      };
      return index.releases;
    },
  },
  {
    name: "cms_registry_apply_update",
    description:
      "Apply a registry release through the standard orchestrator (version must be strictly newer than the running one; backup → install → migrate → restart → doctor). Requires extensions.manage. If the connection drops mid-apply the server-side run continues.",
    permission: "extensions.manage",
    mutation: true,
    inputSchema: objectSchema({ version: { type: "string" } }, ["version"]),
    async run(operations, ctx, args) {
      return operations.applyRegistryUpdate(ctx, args["version"] as string);
    },
  },
];

export function toolsListPayload(extra?: readonly McpTool[]): Record<string, unknown>[] {
  const all = [...TOOLS, ...(extra ?? [])];
  // Collision detection is fail-closed: a derived extension tool that
  // shadowed a core tool (or another extension's) must never reach an agent.
  const seen = new Set<string>();
  for (const tool of all) {
    if (seen.has(tool.name)) {
      throw new Error(`duplicate MCP tool name "${tool.name}"`);
    }
    seen.add(tool.name);
  }
  return all.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: !tool.mutation,
      ...(tool.permission === undefined ? {} : { permission: tool.permission }),
    },
  }));
}

export function findTool(name: string, extra?: readonly McpTool[]): McpTool | null {
  return (
    TOOLS.find((tool) => tool.name === name) ?? extra?.find((tool) => tool.name === name) ?? null
  );
}
