// Discovery routes (PCMS-API-T008..T012; API spec §19–§26).
// "Agent queries contract; agent does not guess": every subsystem's existing
// discovery service is exposed verbatim — the API duplicates no registry.
// Reads are side-effect-free; permission keys are the M08 domain reads.

import { BLOCK_DOCUMENT_SCHEMA_VERSION, MAX_BLOCKS_PER_DOCUMENT } from "@pcms/blocks";
import { ICON_CATALOG_V1, RICHTEXT_AST_VERSIONS, RICHTEXT_NODE_TYPES } from "@pcms/content";
import {
  createMediaPresetRegistry,
  generateVariantsForAsset,
  getAsset,
  getBlobByHash,
  getVariant,
  listVersions,
  readVariantBytes,
  validatePresetInput,
  variantKeyFor,
} from "@pcms/media";
import {
  BUNDLE_CONTRACT,
  CONTENT_CONTRACT,
  PCMD_VERSION,
  PCPUB_ACCEPTED_ASSET_MIME,
  PCPUB_VERSION,
} from "@pcms/publication";
import { THEME_CONTRACT_VERSION, THEME_MANIFEST_JSON_SCHEMA } from "@pcms/themes";
import type { ApplicationServices } from "../../context.js";
import {
  addSiteDomainOp,
  listSiteDomainsOp,
  removeSiteDomainOp,
  setPrimarySiteDomainOp,
} from "../../domains-ops.js";
import { ApiError } from "../../errors.js";
import {
  getEntryRoute,
  getEntrySeo,
  getMediaUsageOp,
  getSiteIdentityOp,
  getSystemMetricsOp,
  getSystemStatusOp,
  getThemeState,
  listCompatibleTemplatesOp,
  listContentTree,
  searchMediaOp,
  validateEntrySeoOp,
} from "../../operations.js";
import { listPendingPublicationsOp, listPublicationHistoryOp } from "../../publication-ux-ops.js";
import { decodeOffsetCursor, pageOf, parsePageRequest } from "../pagination.js";
import type { ApiRoute } from "../registry.js";
import { pcpubLimitsFrom, stableId } from "./helpers.js";

const adminThumbnailPreset = validatePresetInput({
  id: "admin_thumbnail",
  width: 384,
  height: 384,
  fit: "inside",
  formats: ["webp"],
  quality: 75,
});
const adminThumbnailRegistry = createMediaPresetRegistry([adminThumbnailPreset]);

function requireTheme(app: ApplicationServices) {
  if (app.themeDiscovery === null) {
    throw new ApiError(
      "API_NOT_FOUND",
      "no theme source is configured on this server (themes.renderDir)",
      { status: 404 },
    );
  }
  return app.themeDiscovery;
}

/** ?site= key (default site when absent) for the domain binding routes. */
function siteKeyOf(carrier: Record<string, unknown> | undefined, defaultKey: string): string {
  const site = carrier?.site;
  return typeof site === "string" && site.length > 0 ? site : defaultKey;
}

export function makeDiscoveryRoutes(): ApiRoute[] {
  const routes: ApiRoute[] = [
    // --- T008: general discovery (spec §20). ---
    {
      spec: {
        method: "GET",
        url: "/capabilities",
        operationId: "get_capabilities",
        summary: "Actor-visible subsystem capabilities + contract versions (permission-filtered)",
        tag: "discovery",
        auth: "authenticated",
      },
      async handle(app, ctx) {
        const has = (permission: string, installed = true) =>
          installed && ctx.actor.permissions.has(permission);
        return {
          status: 200,
          body: {
            contract_versions: {
              api: "1.0.0",
              theme: THEME_CONTRACT_VERSION,
              block_document: BLOCK_DOCUMENT_SCHEMA_VERSION,
              bundle: 1,
              pcpub: 1,
              pcmd: 1,
            },
            content: {
              installed: true,
              read: has("content.read"),
              create: has("content.create"),
              edit: has("content.edit"),
              archive: has("content.archive"),
              schema_read: has("content_schema.read"),
              rich_text: {
                readable_versions: RICHTEXT_AST_VERSIONS,
                write_version: 2,
                node_types: RICHTEXT_NODE_TYPES,
              },
            },
            blocks: {
              installed: true,
              document_limit: MAX_BLOCKS_PER_DOCUMENT,
              read: has("content.read"),
            },
            themes: {
              installed: app.themeDiscovery !== null,
              read: has("theme.read"),
              validate: has("theme.validate"),
              preview: has("theme.preview"),
              activate: has("theme.activate"),
              // M10 shipped the active-theme store (migration 1000);
              // activation is available whenever a theme source is configured.
              activation_available: app.themeDiscovery !== null,
            },
            navigation: { installed: true, read: has("navigation.read") },
            media: {
              installed: app.mediaStorage !== null,
              read: has("media.read"),
              write: has("media.write"),
              import: has("media.import"),
            },
            seo: {
              installed: true,
              scopes: app.seoDiscovery.scopes,
              read: has("seo.read"),
            },
            publication: {
              installed: true,
              read: has("publication.read"),
              plan: has("publication.plan"),
              schedule: has("publication.schedule"),
              publish: has("publication.publish"),
            },
            // Search is fully shipped (M11): the index, the public query and
            // the authorized Admin search all live behind /search/*. The
            // Admin search screen is gated by search.admin; index operations
            // by search.diagnostics / search.reindex.
            search: {
              installed: true,
              read: has("search.admin"),
              diagnostics: has("search.diagnostics"),
              reindex: has("search.reindex"),
            },
            interactions: {
              installed: true,
              forms: { read: has("forms.read_definition"), manage: has("forms.manage_definition") },
              quizzes: {
                read: has("quizzes.read_definition"),
                manage: has("quizzes.manage_definition"),
              },
              interactions: {
                read: has("interactions.read"),
                manage: has("interactions.manage"),
                export: has("interactions.export"),
              },
              leads: {
                read: has("leads.read"),
                manage: has("leads.manage"),
                export: has("leads.export"),
              },
            },
            integrations: { installed: true, read: has("integrations.read") },
            payments: { installed: true, read: has("payments.read") },
            // .pcpub ingest (ADR-0014, API spec §81.2): the physical format
            // versions, the contracts bundles may require, block versions the
            // target accepts and the ingest limits — packers preflight here,
            // the server re-checks authoritatively at ingest.
            pcpub: {
              installed: true,
              read: has("content.read"),
              submit: has("content.create"),
              pcpub_versions: [PCPUB_VERSION, 2],
              external_entries: {
                supported: true,
                pcpub_version: 2,
                required_scope: "content.read",
              },
              pcmd_versions: [PCMD_VERSION],
              bundle_contract: BUNDLE_CONTRACT,
              content_contract: CONTENT_CONTRACT,
              supported_block_versions: app.blocks.listBlockTypeVersions(),
              bundle_limits: pcpubLimitsFrom(app),
              accepted_asset_mime: PCPUB_ACCEPTED_ASSET_MIME,
            },
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/site",
        operationId: "get_site_info",
        summary: "Baseline site identity, route policy, home binding and domains",
        tag: "discovery",
        auth: "authenticated",
      },
      async handle(app, _ctx, request) {
        const query = request.query as { site?: unknown };
        const siteKey =
          typeof query.site === "string" && query.site.length > 0 ? query.site : app.defaultSiteKey;
        const site = await app.routes.findSiteByKey(siteKey);
        if (site === null) {
          throw new ApiError("SITE_NOT_FOUND", `site "${siteKey}" does not exist`, { status: 404 });
        }
        const [policy, domains] = await Promise.all([
          app.routes.getPolicy(site.id),
          app.domains.listDomainBindings(site.id),
        ]);
        return {
          status: 200,
          body: {
            site: { id: site.id, key: site.key, title: site.title },
            route_policy: policy,
            domains: domains.map((binding) => ({
              hostname: binding.hostname,
              is_primary: binding.isPrimary,
              locale: binding.locale,
            })),
          },
        };
      },
    },

    // --- Domain bindings REST (owner 2026-10-06: the domains.manage
    // permission existed in agent presets with no API surface — a site agent
    // could not switch the primary domain, so sitemap/canonical kept
    // generating the old hostname). The DomainService already owns the
    // invariants (hostname normalization, single primary, first-binding
    // default); these routes are its thin HTTP skin. Sitemap/canonical read
    // the bindings per request — no restart needed after a switch. ---
    {
      spec: {
        method: "GET",
        url: "/site/domains",
        operationId: "list_site_domains",
        summary: "Domain bindings of a site (?site= key, default site). Permission: domains.manage",
        tag: "discovery",
        auth: "authenticated",
        permission: "domains.manage",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: { site: { type: "string", minLength: 1 } },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "domains.manage");
        const query = request.query as { site?: unknown };
        return {
          status: 200,
          body: await listSiteDomainsOp(app, siteKeyOf(query, app.defaultSiteKey)),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/site/domains",
        operationId: "add_site_domain",
        summary:
          "Add a domain binding (hostname normalized/validated; first binding of a site becomes primary; atomic single-primary invariant). Permission: domains.manage",
        tag: "discovery",
        auth: "authenticated",
        permission: "domains.manage",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["hostname"],
          properties: {
            hostname: { type: "string", minLength: 3, maxLength: 253 },
            is_primary: { type: "boolean" },
            scheme_policy: { enum: ["https", "http"] },
            canonical_redirect_policy: { enum: ["redirect", "serve"] },
            locale: { type: ["string", "null"], maxLength: 16 },
          },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "domains.manage");
        const body = (request.body ?? {}) as Record<string, unknown>;
        return {
          status: 201,
          body: await addSiteDomainOp(app, siteKeyOf(body, app.defaultSiteKey), {
            hostname: String(body.hostname),
            ...(body.is_primary === undefined ? {} : { is_primary: body.is_primary === true }),
            ...(typeof body.scheme_policy === "string"
              ? { scheme_policy: body.scheme_policy as "https" | "http" }
              : {}),
            ...(typeof body.canonical_redirect_policy === "string"
              ? {
                  canonical_redirect_policy: body.canonical_redirect_policy as "redirect" | "serve",
                }
              : {}),
            ...(body.locale === undefined ? {} : { locale: body.locale as string | null }),
          }),
        };
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/site/domains/:hostname",
        operationId: "patch_site_domain",
        summary:
          "Patch a binding: is_primary=true switches the canonical primary atomically. Permission: domains.manage",
        tag: "discovery",
        auth: "authenticated",
        permission: "domains.manage",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            is_primary: { type: "boolean" },
          },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "domains.manage");
        const params = request.params as { hostname?: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (body.is_primary !== true) {
          throw new ApiError(
            "API_REQUEST_INVALID",
            "supported patch: {is_primary: true} (atomic primary switch)",
            { status: 422 },
          );
        }
        return {
          status: 200,
          body: await setPrimarySiteDomainOp(
            app,
            siteKeyOf(body, app.defaultSiteKey),
            String(params.hostname ?? ""),
          ),
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/site/domains/:hostname",
        operationId: "remove_site_domain",
        summary:
          "Remove a binding. The last remaining binding is undeletable (a site without a canonical origin cannot generate absolute URLs); removing the primary promotes the first remaining. Permission: domains.manage",
        tag: "discovery",
        auth: "authenticated",
        permission: "domains.manage",
        csrf: true,
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: { site: { type: "string", minLength: 1 } },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "domains.manage");
        const query = request.query as { site?: unknown };
        const params = request.params as { hostname?: string };
        return {
          status: 200,
          body: await removeSiteDomainOp(
            app,
            siteKeyOf(query, app.defaultSiteKey),
            String(params.hostname ?? ""),
          ),
        };
      },
    },

    // --- T009: content/block discovery (spec §21). ---
    {
      spec: {
        method: "GET",
        url: "/discovery/content/types",
        operationId: "list_content_types",
        summary: "Registered content types (deterministic order)",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "content.read");
        return { status: 200, body: { items: app.contentDiscovery.listContentTypes() } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/content/types/:key",
        operationId: "get_content_type_schema",
        summary: "Full content type schema (round-trippable)",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "content.read");
        const params = request.params as { key: string };
        const query = request.query as { version?: unknown };
        const schema =
          typeof query.version === "string" && /^\d+$/.test(query.version)
            ? app.contentDiscovery.getContentTypeSchema(params.key, Number(query.version))
            : app.contentDiscovery.getLatestContentTypeSchema(params.key);
        if (schema === null) {
          throw new ApiError("API_NOT_FOUND", `content type "${params.key}" is not registered`, {
            status: 404,
          });
        }
        return { status: 200, body: schema };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/content/field-types",
        operationId: "list_field_types",
        summary: "Registered field types",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "content.read");
        return { status: 200, body: { items: app.contentDiscovery.listFieldTypes() } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/content/icons",
        operationId: "list_icon_catalog",
        summary:
          "Curated icon catalog for `icon` fields (advisory; values are format-validated, membership is not enforced).",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "content.read");
        return { status: 200, body: { items: ICON_CATALOG_V1 } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/content/tree",
        operationId: "list_content_tree",
        summary:
          "Content Tree rows with kind (content|folder), title/working/publication indicators (PCMS-ADMIN-T002)",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            include_archived: { type: "string", enum: ["true", "false"] },
            limit: { type: "string", pattern: "^[0-9]+$" },
            cursor: { type: "string" },
          },
        },
      },
      async handle(app, ctx, request) {
        const query = request.query as {
          include_archived?: unknown;
          limit?: string;
          cursor?: string;
        };
        return {
          status: 200,
          body: await listContentTree(app, ctx, {
            include_archived: query.include_archived === "true",
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/content/templates",
        operationId: "list_compatible_templates",
        summary: "Active-theme templates compatible with a content type (query: content_type)",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          required: ["content_type"],
          properties: { content_type: { type: "string", maxLength: 64 } },
        },
      },
      async handle(app, ctx, request) {
        const query = request.query as { content_type?: string };
        return {
          status: 200,
          body: await listCompatibleTemplatesOp(
            app,
            ctx,
            typeof query.content_type === "string" ? query.content_type : "",
          ),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/content/collection-capabilities",
        operationId: "get_collection_capabilities",
        summary: "Collection DSL capabilities (typed allowlist, spec §14)",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "content.read");
        return { status: 200, body: app.contentDiscovery.getCollectionCapabilities() };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/blocks",
        operationId: "list_block_types",
        summary: "Registered block types",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "content.read");
        return { status: 200, body: { items: app.blockDiscovery.listBlockTypes() } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/blocks/:typeId",
        operationId: "get_block_schema",
        summary: "Full block schema (props, children policy, references)",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "content.read");
        const params = request.params as { typeId: string };
        const query = request.query as { version?: unknown };
        const version =
          typeof query.version === "string" && /^\d+$/.test(query.version)
            ? Number(query.version)
            : undefined;
        const latestVersion = app.blockDiscovery
          .listBlockTypes()
          .find((summary) => summary.typeId === params.typeId)
          ?.versions.at(-1);
        const effectiveVersion = version ?? latestVersion;
        const schema =
          effectiveVersion === undefined
            ? null
            : app.blockDiscovery.getBlockSchema(params.typeId, effectiveVersion);
        if (schema === null) {
          throw new ApiError("API_NOT_FOUND", `block type "${params.typeId}" is not registered`, {
            status: 404,
          });
        }
        return { status: 200, body: schema };
      },
    },

    // --- T010: theme discovery (spec §22). ---
    {
      spec: {
        method: "GET",
        url: "/discovery/theme",
        operationId: "get_theme_contract",
        summary: "Active theme contract snapshot (manifest, templates, placements)",
        tag: "discovery",
        auth: "authenticated",
        permission: "theme.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "theme.read");
        const theme = requireTheme(app);
        return {
          status: 200,
          body: {
            available: true,
            contract_version: theme.getThemeContractVersion(),
            theme_id: theme.getThemeId(),
            manifest_json_schema: THEME_MANIFEST_JSON_SCHEMA,
            ...theme.describeTheme(),
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/theme/templates",
        operationId: "list_templates",
        summary: "Theme templates with accepted content types",
        tag: "discovery",
        auth: "authenticated",
        permission: "theme.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "theme.read");
        return { status: 200, body: { items: requireTheme(app).listTemplates() } };
      },
    },

    // --- T011: navigation/routing discovery (spec §23). ---
    {
      spec: {
        method: "GET",
        url: "/discovery/navigation/sets",
        operationId: "list_navigation_sets",
        summary: "Navigation sets",
        tag: "discovery",
        auth: "authenticated",
        permission: "navigation.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "navigation.read");
        return { status: 200, body: { items: await app.navigationDiscovery.listNavigationSets() } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/navigation/trees/:setRef",
        operationId: "get_navigation_tree",
        summary: "Materialized navigation tree by set id or key",
        tag: "discovery",
        auth: "authenticated",
        permission: "navigation.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "navigation.read");
        const params = request.params as { setRef: string };
        return {
          status: 200,
          body: { items: await app.navigationDiscovery.getNavigationTree(params.setRef) },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/navigation/placements",
        operationId: "list_placement_bindings",
        summary: "Theme-declared placements + current bindings",
        tag: "discovery",
        auth: "authenticated",
        permission: "navigation.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "navigation.read");
        return {
          status: 200,
          body: {
            placements: app.navigationDiscovery.listPlacements(),
            bindings: await app.navigationDiscovery.getPlacementBindings(),
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/routing/policy",
        operationId: "get_route_policy",
        summary: "Route path policy for a site",
        tag: "discovery",
        auth: "authenticated",
        permission: "navigation.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "navigation.read");
        const query = request.query as { site?: unknown };
        const siteRef = typeof query.site === "string" ? query.site : app.defaultSiteKey;
        return { status: 200, body: await app.routingDiscovery.getRoutePolicy(siteRef) };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/routing/check",
        operationId: "check_route_available",
        summary: "Route availability check (typed issues, no reservation)",
        tag: "discovery",
        auth: "authenticated",
        permission: "site.validate",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "site.validate");
        const query = request.query as { path?: unknown; site?: unknown };
        if (typeof query.path !== "string" || query.path.length === 0) {
          throw new ApiError("API_REQUEST_INVALID", "path query parameter is required", {
            status: 400,
          });
        }
        const siteRef = typeof query.site === "string" ? query.site : app.defaultSiteKey;
        return {
          status: 200,
          body: await app.routingDiscovery.checkRouteAvailable(query.path, siteRef),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/routing/resolve-entry",
        operationId: "resolve_entry_url",
        summary: "Canonical absolute URL for an entry (null when unrouted)",
        tag: "discovery",
        auth: "authenticated",
        permission: "navigation.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "navigation.read");
        const query = request.query as { entry_id?: unknown };
        const entryId = stableId(query.entry_id, "entry_id");
        return {
          status: 200,
          body: { url: await app.routingDiscovery.resolveEntryUrl(entryId) },
        };
      },
    },

    // --- T011: media discovery (spec §24). ---
    {
      spec: {
        method: "GET",
        url: "/media",
        operationId: "search_media",
        summary: "Bounded, paginated media search (typed filters only)",
        tag: "media",
        auth: "authenticated",
        permission: "media.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", maxLength: 200 },
            kind: { type: "string" },
            mime_type: { type: "string", maxLength: 100 },
            folder_id: { type: "string", maxLength: 64 },
            origin: { type: "string", enum: ["upload", "import", "stock", "generated"] },
            include_archived: { type: "string", enum: ["true", "false"] },
            limit: { type: "string", pattern: "^[0-9]+$" },
            cursor: { type: "string" },
          },
        },
      },
      async handle(app, ctx, request) {
        app.authorization.authorizeSite(ctx.actor, app.defaultSiteKey);
        return {
          status: 200,
          body: await searchMediaOp(app, ctx, request.query as Record<string, unknown>),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/media/:mediaId",
        operationId: "get_media",
        summary: "Full media diagnostic view (asset + versions + variants)",
        tag: "media",
        auth: "authenticated",
        permission: "media.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "media.read");
        app.authorization.authorizeSite(ctx.actor, app.defaultSiteKey);
        const params = request.params as { mediaId: string };
        const inspected = await app.mediaDiscovery.inspectAsset(
          stableId(params.mediaId, "mediaId"),
        );
        return { status: 200, body: inspected };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/media/by-hash/:sha256",
        operationId: "search_media_by_hash",
        summary:
          "Exact-bytes lookup (§45 dedupe): every asset whose current content hash matches — explains library duplicates",
        tag: "media",
        auth: "authenticated",
        permission: "media.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "media.read");
        app.authorization.authorizeSite(ctx.actor, app.defaultSiteKey);
        const params = request.params as { sha256: string };
        const sha256 = params.sha256.toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
          throw new ApiError("API_REQUEST_INVALID", "sha256 must be a 64-character hex digest", {
            status: 400,
          });
        }
        const items = await app.mediaDiscovery.findAssetsByHash(sha256);
        return { status: 200, body: { items } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/media/:mediaId/file",
        operationId: "get_media_file",
        summary: "Current-version file bytes for Admin previews (media.read; private cache)",
        tag: "media",
        auth: "authenticated",
        permission: "media.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "media.read");
        app.authorization.authorizeSite(ctx.actor, app.defaultSiteKey);
        const params = request.params as { mediaId: string };
        const assetId = stableId(params.mediaId, "mediaId");
        const asset = await getAsset(app.pool, assetId as never);
        if (asset === null) {
          throw new ApiError("API_NOT_FOUND", "media asset not found", { status: 404 });
        }
        const query = request.query as { preview?: string };
        if (query.preview !== undefined && query.preview !== "thumbnail") {
          throw new ApiError("API_REQUEST_INVALID", "unknown media preview", { status: 400 });
        }
        if (
          query.preview === "thumbnail" &&
          asset.kind === "image" &&
          asset.mimeType !== "image/svg+xml"
        ) {
          if (app.mediaStorage === null) {
            throw new ApiError("MEDIA_STORAGE_UNAVAILABLE", "media storage is not available", {
              status: 503,
            });
          }
          const deps = {
            pool: app.pool,
            storage: app.mediaStorage,
            maxSourceBytes: 128 * 1024 * 1024,
          };
          const key = variantKeyFor({
            sourceSha256: asset.sha256,
            versionNo: asset.currentVersionNo,
            presetId: adminThumbnailPreset.id,
            ...adminThumbnailPreset,
            focalX: asset.focalX,
            focalY: asset.focalY,
            format: "webp",
          });
          // Cached requests read only the small derivative, never the original.
          const variant =
            (await getVariant(app.pool, asset.id, asset.currentVersionNo, key)) ??
            (await generateVariantsForAsset(deps, asset, adminThumbnailRegistry))[0];
          if (variant === undefined) {
            throw new ApiError("API_NOT_FOUND", "media thumbnail is unavailable", { status: 404 });
          }
          return {
            status: 200,
            headers: {
              "content-type": "image/webp",
              "cache-control": "private, max-age=3600",
              "x-content-type-options": "nosniff",
            },
            body: await readVariantBytes(deps, variant),
          };
        }
        const versions = await listVersions(app.pool, assetId as never);
        const current =
          versions.find((version) => version.versionNo === asset.currentVersionNo) ?? versions[0];
        if (current === undefined) {
          throw new ApiError("API_NOT_FOUND", "media asset has no versions", { status: 404 });
        }
        const blob = await getBlobByHash(app.pool, current.sha256);
        if (blob === null || app.mediaStorage === null) {
          throw new ApiError("MEDIA_STORAGE_UNAVAILABLE", "media storage is not available", {
            status: 503,
          });
        }
        const stream = await app.mediaStorage.getStream(blob.storageKey);
        return {
          status: 200,
          headers: {
            "content-type": current.mimeType,
            "cache-control": "private, max-age=3600",
            "x-content-type-options": "nosniff",
            "content-disposition": `inline; filename="${encodeURIComponent(current.filenameOriginal)}"`,
          },
          body: stream,
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/media/:mediaId/usage",
        operationId: "get_media_usage",
        summary: "Inbound references for the asset",
        tag: "media",
        auth: "authenticated",
        permission: "media.read",
      },
      async handle(app, ctx, request) {
        app.authorization.authorizeSite(ctx.actor, app.defaultSiteKey);
        return {
          status: 200,
          body: await getMediaUsageOp(
            app,
            ctx,
            stableId((request.params as { mediaId: string }).mediaId, "mediaId"),
          ),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/media/presets",
        operationId: "list_media_presets",
        summary: "Registered media presets",
        tag: "media",
        auth: "authenticated",
        permission: "media.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "media.read");
        return { status: 200, body: { items: app.mediaPresets.listPresets() } };
      },
    },

    // --- T011: SEO discovery (spec §25). ---
    {
      spec: {
        method: "GET",
        url: "/discovery/seo/schema",
        operationId: "get_seo_schema",
        summary: "SEO document schema descriptor + diagnostics codes",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.read",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "seo.read");
        return { status: 200, body: app.seoDiscovery.getSeoSchema() };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/seo/metadata/:entryId",
        operationId: "resolve_seo_metadata",
        summary: "Effective SEO metadata (document → field fallback chain)",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "seo.read");
        const params = request.params as { entryId: string };
        const resolved = await app.seoDiscovery.resolveSeoMetadataFor(
          stableId(params.entryId, "entryId"),
        );
        if (resolved === null) {
          throw new ApiError("API_NOT_FOUND", "entry does not exist", { status: 404 });
        }
        return { status: 200, body: resolved };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/seo/preview",
        operationId: "preview_seo",
        summary: "SERV preview (title/description/robots/social) for an entry",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "seo.read");
        const query = request.query as { entry_id?: unknown };
        const entryId = stableId(query.entry_id, "entry_id");
        // Social preview is a materialization point (OG contract §3): the
        // og-v1/favicon-v1 derivatives are generated here so the preview
        // shows the real result, same as publication validate/publish.
        const preview = await app.seoDiscovery.previewSeoFor(entryId, {
          openGraph: true,
          materializeSocial: true,
        });
        if (preview === null) {
          throw new ApiError("API_NOT_FOUND", "entry does not exist", { status: 404 });
        }
        return { status: 200, body: preview };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/seo/structured-data",
        operationId: "preview_structured_data",
        summary: "Composed JSON-LD preview for an entry",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "seo.read");
        const query = request.query as { entry_id?: unknown };
        const entryId = stableId(query.entry_id, "entry_id");
        const preview = await app.seoDiscovery.previewSeoFor(entryId);
        if (preview === null) {
          throw new ApiError("API_NOT_FOUND", "entry does not exist", { status: 404 });
        }
        return { status: 200, body: { structured_data: preview.structured_data } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/discovery/seo/validate",
        operationId: "validate_seo",
        summary: "Publish-level SEO validation report for an entry",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.validate",
      },
      async handle(app, ctx, request) {
        return {
          status: 200,
          body: await validateEntrySeoOp(
            app,
            ctx,
            stableId((request.query as { entry_id?: unknown }).entry_id, "entry_id"),
          ),
        };
      },
    },

    // --- T012: revision/publication discovery (spec §26). ---
    {
      spec: {
        method: "GET",
        url: "/entries/:entryId/route",
        operationId: "get_entry_route",
        summary: "Canonical route view: current path, history, proposal (PCMS-ADMIN-T011)",
        tag: "discovery",
        auth: "authenticated",
        permission: "navigation.read",
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        return {
          status: 200,
          body: await getEntryRoute(app, ctx, { entry_id: stableId(params.entryId, "entryId") }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/settings/site-identity",
        operationId: "get_site_identity",
        summary: "Typed site identity (SEO+Theme defaults; seo.read)",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await getSiteIdentityOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/system/status",
        operationId: "get_system_status",
        summary:
          "Doctor-style snapshot: site, migration head, queue, storage, theme (site.validate; no secrets)",
        tag: "discovery",
        auth: "authenticated",
        permission: "site.validate",
      },
      async handle(app, ctx) {
        return { status: 200, body: await getSystemStatusOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/system/metrics",
        operationId: "get_system_metrics",
        summary: "Recent runtime metric samples (CPU / memory / queue window)",
        tag: "discovery",
        auth: "authenticated",
        permission: "site.validate",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: { hours: { type: "string", pattern: "^[0-9]+$" } },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "site.validate");
        const query = request.query as { hours?: string };
        return {
          status: 200,
          body: await getSystemMetricsOp(app, ctx, {
            ...(query.hours === undefined ? {} : { hours: Number.parseInt(query.hours, 10) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/theme/state",
        operationId: "get_theme_state",
        summary: "Active theme + working settings + manifest settings (PCMS-ADMIN-T019)",
        tag: "discovery",
        auth: "authenticated",
        permission: "theme.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await getThemeState(app, ctx) };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/entries/:entryId/seo",
        operationId: "get_entry_seo",
        summary: "Stored SEO document for an entry (or null; PCMS-ADMIN-T010)",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.read",
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        return {
          status: 200,
          body: await getEntrySeo(app, ctx, { entry_id: stableId(params.entryId, "entryId") }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/entries/:entryId/revisions",
        operationId: "list_revisions",
        summary: "Revision history of an entry (bounded page)",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "publication.read");
        const params = request.params as { entryId: string };
        app.authorization.authorizeSite(ctx.actor, app.defaultSiteKey);
        const entryId = stableId(params.entryId, "entryId");
        const page = parsePageRequest(request.query as Record<string, unknown>);
        const fetched = await app.revisions.listRevisions(app.pool, "entry", entryId as never, {
          limit: page.limit + 1,
          offset: page.cursor === null ? 0 : decodeOffsetCursor(page.cursor),
        });
        const body = pageOf(fetched, page.limit, (revision) => [revision.revisionNo]);
        return {
          status: 200,
          body: {
            ...body,
            items: body.items.map((revision) => ({
              id: revision.id,
              revision_no: revision.revisionNo,
              state: revision.state,
              locale: revision.locale,
              schema_version: revision.schemaVersion,
              edit_generation: revision.editGeneration,
              created_at: revision.createdAt.toISOString(),
              sealed_at: revision.sealedAt?.toISOString() ?? null,
            })),
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/revisions/:revisionId",
        operationId: "get_revision",
        summary: "Full revision record (payload included)",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "publication.read");
        app.authorization.authorizeSite(ctx.actor, app.defaultSiteKey);
        const params = request.params as { revisionId: string };
        const revision = await app.revisions.getRevision(
          app.pool,
          stableId(params.revisionId, "revisionId") as never,
        );
        if (revision === null) {
          throw new ApiError("REVISION_NOT_FOUND", "revision does not exist", { status: 404 });
        }
        return { status: 200, body: serializeRevision(revision) };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/revisions/:fromId/diff/:toId",
        operationId: "diff_revisions",
        summary: "Semantic diff between two revisions",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "publication.read");
        app.authorization.authorizeSite(ctx.actor, app.defaultSiteKey);
        const params = request.params as { fromId: string; toId: string };
        const from = await app.revisions.getRevision(
          app.pool,
          stableId(params.fromId, "fromId") as never,
        );
        const to = await app.revisions.getRevision(
          app.pool,
          stableId(params.toId, "toId") as never,
        );
        if (from === null || to === null) {
          throw new ApiError("REVISION_NOT_FOUND", "both revisions must exist", { status: 404 });
        }
        const { diffPayloads } = await import("@pcms/revisions");
        return { status: 200, body: { diff: diffPayloads(from.payload, to.payload) } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/publications/:entityType/:entityId",
        operationId: "get_publication",
        summary: "Current publication pointer for an entity",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "publication.read");
        app.authorization.authorizeSite(ctx.actor, app.defaultSiteKey);
        const params = request.params as { entityType: string; entityId: string };
        const publication = await app.publications.getPublication(
          app.pool,
          params.entityType,
          stableId(params.entityId, "entityId") as never,
        );
        if (publication === null) {
          throw new ApiError("PUBLICATION_NOT_FOUND", "entity is not published", { status: 404 });
        }
        return {
          status: 200,
          body: {
            entity_type: publication.entityType,
            entity_id: publication.entityId,
            current_revision_id: publication.currentRevisionId,
            generation: publication.generation,
            published_at: publication.publishedAt?.toISOString() ?? null,
            state: publication.state,
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/publication/pending",
        operationId: "list_pending_publications",
        summary: "Entries with unpublished work (human pending-publication view)",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "string", pattern: "^[0-9]+$" } },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "publication.read");
        const query = request.query as { limit?: string };
        return {
          status: 200,
          body: await listPendingPublicationsOp(app, ctx, {
            ...(query.limit === undefined ? {} : { limit: Number.parseInt(query.limit, 10) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/publication/history",
        operationId: "list_publication_history",
        summary: "Human publication history (named operations, actors, results)",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "string", pattern: "^[0-9]+$" } },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "publication.read");
        const query = request.query as { limit?: string };
        return {
          status: 200,
          body: await listPublicationHistoryOp(app, ctx, {
            ...(query.limit === undefined ? {} : { limit: Number.parseInt(query.limit, 10) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/changesets",
        operationId: "list_changesets",
        summary: "ChangeSets (bounded page, optional state filter)",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            state: { type: "string", enum: ["DRAFT", "READY", "APPLIED", "CANCELLED"] },
            limit: { type: "string", pattern: "^[0-9]+$" },
            cursor: { type: "string" },
          },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "publication.read");
        const query = request.query as { state?: unknown };
        const page = parsePageRequest(request.query as Record<string, unknown>);
        const fetched = await app.changesets.listChangesets({
          limit: page.limit + 1,
          offset: page.cursor === null ? 0 : decodeOffsetCursor(page.cursor),
          ...(typeof query.state === "string" ? { state: query.state as never } : {}),
        });
        const body = pageOf(fetched, page.limit, (changeset) => [changeset.createdAt.getTime()]);
        return {
          status: 200,
          body: {
            ...body,
            items: body.items.map((changeset) => ({
              id: changeset.id,
              title: changeset.title,
              state: changeset.state,
              created_at: changeset.createdAt.toISOString(),
            })),
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/changesets/:changesetId",
        operationId: "get_changeset",
        summary: "ChangeSet with items",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.read",
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "publication.read");
        const params = request.params as { changesetId: string };
        const changeset = await app.changesets.getChangeset(
          stableId(params.changesetId, "changesetId") as never,
        );
        const items = await app.changesets.listItems(changeset.id as never);
        return { status: 200, body: { changeset, items } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/publication/calendar",
        operationId: "list_publication_calendar",
        summary: "Publication calendar window (bounded)",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            limit: { type: "string", pattern: "^[0-9]+$" },
            cursor: { type: "string" },
          },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "publication.read");
        const query = request.query as { from?: unknown; to?: unknown };
        const page = parsePageRequest(request.query as Record<string, unknown>);
        const calendarEntries = await app.calendar.listCalendar({
          ...(typeof query.from === "string" ? { from: new Date(query.from) } : {}),
          ...(typeof query.to === "string" ? { to: new Date(query.to) } : {}),
          limit: page.limit,
          offset: page.cursor === null ? 0 : decodeOffsetCursor(page.cursor),
        });
        return {
          status: 200,
          body: {
            items: calendarEntries.map((entry) => ({
              ...entry,
              instant: entry.instant === null ? null : entry.instant.toISOString(),
            })),
            has_more: calendarEntries.length === page.limit,
          },
        };
      },
    },
  ];
  return routes;
}

function serializeRevision(revision: {
  id: string;
  entityType: string;
  entityId: string;
  parentRevisionId: string | null;
  revisionNo: number;
  state: string;
  payload: unknown;
  schemaVersion: string;
  locale: string;
  editGeneration: number;
  createdAt: Date;
  sealedAt: Date | null;
  payloadHash: string | null;
}) {
  return {
    id: revision.id,
    entity_type: revision.entityType,
    entity_id: revision.entityId,
    parent_revision_id: revision.parentRevisionId,
    revision_no: revision.revisionNo,
    state: revision.state,
    payload: revision.payload,
    schema_version: revision.schemaVersion,
    locale: revision.locale,
    edit_generation: revision.editGeneration,
    created_at: revision.createdAt.toISOString(),
    sealed_at: revision.sealedAt?.toISOString() ?? null,
    payload_hash: revision.payloadHash,
  };
}
