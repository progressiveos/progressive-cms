// Search composition (PCMS-SEARCH-T009/T017; Search spec §0/§4/§24).
//
// The composition root is the ONLY place allowed to join subsystems: this
// module derives SearchDocuments from live authoritative state
// (publications × revisions × entries × routes × SEO policy) and implements
// the authorized Admin search mode. @pcms/search itself stays a pure L1
// bounded context — everything arrives here as plain data and SQL over
// already-owned tables follows the api composition precedent.

import {
  type DeployedExtensionArtifact,
  type ExtensionSearchSourceRegistration,
  resolveHandler,
} from "@pcms/extensions/internal";
import { localizedRoutePath } from "@pcms/routing";
import {
  extractSearchText,
  MAX_QUERY_LENGTH,
  normalizeQueryText,
  parseSearchQuery,
  type SearchDocument,
  type SearchDocumentSource,
  SearchError,
  type SearchProvider,
  type SearchQueryResult,
  type SearchSourceIdPage,
} from "@pcms/search";
import { environmentAllowsIndexing, parseSeoDocument, type SeoDocument } from "@pcms/seo";
import { extensionCanonicalPath, isExtensionPublicPage } from "./extension-http.js";

interface SourceRow extends Record<string, unknown> {
  readonly entity_id: string;
  readonly revision_id: string;
  readonly generation: number;
  readonly published_at: Date;
  readonly modified_at: Date;
  readonly content_type_id: string | null;
  readonly archived_at: Date | null;
  readonly locale: string;
  readonly pub_context: string;
  readonly payload: unknown;
  readonly sidecar: unknown;
  readonly site_key: string | null;
  readonly route_path: string | null;
  readonly route_locale: string | null;
  readonly seo_payload: unknown;
}

/**
 * One deterministic SQL page over the public projection inputs. The LATERAL
 * prefers the explicit homepage binding for the default publication context,
 * then the entry's active canonical route; eligibility
 * (archived/unrouted/noindex) is applied in TS so every rule has one
 * provenance point.
 */
const SOURCE_COLUMNS = `
  SELECT p.entity_id, p.generation, p.published_at, p.modified_at, p.context AS pub_context,
         e.content_type_id, e.archived_at,
         rev.id AS revision_id, rev.locale, rev.payload, rev.sidecar,
         s.key AS site_key, rt.path AS route_path, rt.locale AS route_locale,
         seo.payload AS seo_payload
  FROM publications p
  JOIN revisions rev ON rev.id = p.current_revision_id
  LEFT JOIN entries e ON e.id = p.entity_id
  LEFT JOIN LATERAL (
    SELECT candidate.site_id, candidate.path, candidate.locale
    FROM (
      SELECT home.id AS site_id, '/'::text AS path, 'x-default'::text AS locale, 0 AS priority
      FROM sites home
      WHERE home.home_entry_id = p.entity_id AND p.context = 'default'
      UNION ALL
      SELECT site_id, path, locale, 1 AS priority FROM routes
      WHERE target_type = 'entry' AND target_id = p.entity_id::text
        AND retired_at IS NULL AND is_canonical
    ) candidate
    ORDER BY candidate.priority, candidate.site_id, candidate.path
    LIMIT 1
  ) rt ON true
  LEFT JOIN sites s ON s.id = rt.site_id
  LEFT JOIN seo_documents seo ON seo.entry_id = p.entity_id`;

const SOURCE_PAGE_SQL = `${SOURCE_COLUMNS}
  WHERE p.entity_type = 'entry' AND p.state = 'PUBLISHED'
    AND ($1::text IS NULL OR p.entity_id::text > $1)
  ORDER BY p.entity_id
  LIMIT $2`;

const SOURCE_ONE_SQL = `${SOURCE_COLUMNS}
  WHERE p.entity_type = 'entry' AND p.state = 'PUBLISHED' AND p.context = $1
    AND p.entity_id = $2::uuid`;

interface SearchCompositionDeps {
  readonly pool: {
    query<Row extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: Row[] }>;
  };
  /** Content type registry (in-memory) for schema hints + body policies. */
  readonly contentTypes: {
    getLatestContentType(key: string): {
      fieldSchema: { fields: Record<string, unknown> };
      bodyPolicy: "none" | "rich_text" | "block_document";
    } | null;
  };
  /** SEO indexing environment (fail-secure default: development). */
  readonly seoEnvironment: string;
  readonly getDefaultLocale: () => Promise<string>;
}

function indexableUnderSeo(row: Pick<SourceRow, "seo_payload">, environment: string): boolean {
  if (!environmentAllowsIndexing(environment as never)) return false;
  if (row.seo_payload === null || row.seo_payload === undefined) return true; // no override → indexable
  let document: SeoDocument;
  try {
    document = parseSeoDocument(row.seo_payload);
  } catch {
    return false; // unparseable SEO state must never leak into the public index
  }
  return document.robots_policy?.index !== false;
}

function documentFromRow(
  row: SourceRow,
  deps: SearchCompositionDeps,
  defaultLocale: string,
): SearchDocument | null {
  if (row.archived_at !== null) return null;
  if (row.site_key === null || row.route_path === null) return null;
  if (!indexableUnderSeo(row, deps.seoEnvironment)) return null;
  const loaded =
    row.content_type_id === null
      ? null
      : deps.contentTypes.getLatestContentType(row.content_type_id);
  if (loaded === null) {
    // Fail-secure: an unregistered content type makes the document
    // undecidable — never silently drop it from the index; the caller's
    // retry cycle surfaces it (Search spec §0: derived, never lossy by
    // configuration).
    throw new SearchError(
      "SEARCH_INDEX_UNAVAILABLE",
      `content type "${String(row.content_type_id)}" is not registered on this indexer`,
    );
  }
  const body = (row.payload ?? {}) as { fields?: unknown; blocks?: unknown };
  const extracted = extractSearchText({
    fields: (body.fields ?? {}) as Record<string, unknown>,
    fieldSchema: loaded.fieldSchema as never,
    bodyPolicy: loaded.bodyPolicy,
    blocks: body.blocks ?? null,
  });
  return {
    entity_type: "entry",
    entity_id: row.entity_id,
    // The publication context IS the document locale scope ("default"
    // sentinel for the default locale, BCP-47 code for translations).
    context: row.pub_context,
    site_id: row.site_key,
    locale: row.locale === "default" ? defaultLocale : row.locale,
    content_type: row.content_type_id,
    revision_id: row.revision_id,
    generation: row.generation,
    title: extracted.title,
    summary: extracted.summary,
    structured_text: extracted.structuredText,
    body_text: extracted.bodyText,
    aux_text: extracted.auxText,
    route:
      row.route_locale === null
        ? (row.route_path ?? null)
        : localizedRoutePath({ locale: row.route_locale, path: row.route_path ?? "" }),
    published_at: row.published_at,
    modified_at: row.modified_at,
  };
}

/** Composition-built SearchDocumentSource (PCMS-SEARCH-T009/T010): the
 * "entry" enumeration phase of the public snapshot. Extension-owned phases
 * compose on top via createExtensionAwareSearchSource (PREPUBLIC §2). */
export function createSearchDocumentSource(deps: SearchCompositionDeps): SearchDocumentSource {
  return {
    async buildDocument(entityType, entityId, context = "default") {
      if (entityType !== "entry") return null; // entries only at this layer
      const { rows } = await deps.pool.query<SourceRow>(SOURCE_ONE_SQL, [context, entityId]);
      const row = rows[0];
      if (row === undefined) return null;
      return documentFromRow(row, deps, await deps.getDefaultLocale());
    },
    async listPhases() {
      return ["entry"];
    },
    async countPhase(phase) {
      if (phase !== "entry") {
        throw new SearchError("SEARCH_SOURCE_UNKNOWN", `unknown search source phase "${phase}"`);
      }
      // Every locale context (single-language sites only have "default").
      const { rows } = await deps.pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM publications
         WHERE entity_type = 'entry' AND state = 'PUBLISHED'`,
      );
      return Number(rows[0]?.count ?? 0);
    },
    async listPhaseIds(phase, after, limit) {
      if (phase !== "entry") {
        throw new SearchError("SEARCH_SOURCE_UNKNOWN", `unknown search source phase "${phase}"`);
      }
      const bounded = Math.max(1, Math.min(limit, 5000));
      const { rows } = await deps.pool.query<SourceRow>(SOURCE_PAGE_SQL, [after, bounded]);
      return {
        ids: rows.map((row) => row.entity_id),
        // Cursor semantics survive concurrent publish/unpublish mid-rebuild,
        // unlike raw offsets; TS-side eligibility filtering (below) never
        // affects the enumeration cursor.
        cursor: rows.length === bounded ? (rows[rows.length - 1]?.entity_id ?? null) : null,
      };
    },
  };
}

/** Composition seam for extension search sources (Extension Contract 2.0;
 * ADR-0018; PREPUBLIC §2): wraps the entry-only source with one
 * "<extensionId>/<source_id>" enumeration phase per enabled extension search
 * source and routes "<ext>/<source>" buildDocument calls to the extension
 * handler. Phases re-derive from live enabled ids — a disabled extension
 * drops out of enumeration and its documents purge at finalize. */
export interface ExtensionSearchSourceDeps {
  readonly base: SearchDocumentSource;
  /** Structural catalog subset (composition may pass a lazy proxy). */
  readonly catalog: {
    get(extensionId: string): DeployedExtensionArtifact | undefined;
    list(): readonly DeployedExtensionArtifact[];
  };
  readonly enabledIds: () => Promise<readonly string[]>;
  /** Composition source context builder; null = extension surface absent. */
  readonly sourceContext: (extensionId: string) => unknown;
  /** Active canonical mount path of the extension (null = technical /x/ space). */
  readonly activeMountPath: (extensionId: string) => Promise<string | null>;
  readonly getLocalization?: () => Promise<{
    readonly defaultLocale: string;
    readonly enabledLocales: readonly string[];
  }>;
}

/** page_ids batch clamp and count-walk ceiling: a source walking more than
 * 1000 pages at count time is mis-sized (500 ids/page → 500k per source). */
const PAGE_IDS_BATCH_MAX = 500;
const PAGE_IDS_COUNT_PAGES_MAX = 1000;

export function createExtensionAwareSearchSource(
  deps: ExtensionSearchSourceDeps,
): SearchDocumentSource {
  const resolvedSource = async (
    phase: string,
  ): Promise<{
    extensionId: string;
    artifact: DeployedExtensionArtifact;
    registration: ExtensionSearchSourceRegistration;
  } | null> => {
    if (!phase.includes("/")) return null;
    const slash = phase.indexOf("/");
    const extensionId = phase.slice(0, slash);
    const enabled = await deps.enabledIds();
    if (!enabled.includes(extensionId)) return null;
    const artifact = deps.catalog.get(extensionId);
    if (artifact === undefined) return null;
    const registration = artifact.manifest.registrations.search_sources.find(
      (candidate) => candidate.source_id === phase.slice(slash + 1),
    );
    if (registration === undefined) return null;
    return { extensionId, artifact, registration };
  };

  const pageIdsPage = async (
    phase: string,
    after: string | null,
    limit: number,
  ): Promise<SearchSourceIdPage> => {
    const resolved = await resolvedSource(phase);
    // A phase that vanished mid-rebuild (extension disabled/uninstalled or
    // source removed) exhausts gracefully — finalize purges its documents.
    if (resolved === null) return { ids: [], cursor: null };
    const context = await deps.sourceContext(resolved.extensionId);
    if (context === null) return { ids: [], cursor: null };
    const handler = resolveHandler(resolved.artifact, resolved.registration.page_ids_handler) as (
      ctx: unknown,
      cursor: string | null,
      limit: number,
    ) => Promise<unknown>;
    const page = await handler(context, after, Math.max(1, Math.min(limit, PAGE_IDS_BATCH_MAX)));
    const ids = (page as { ids?: unknown } | null)?.ids;
    const cursor = (page as { cursor?: unknown } | null)?.cursor;
    if (!Array.isArray(ids) || (cursor !== null && typeof cursor !== "string")) {
      throw new SearchError(
        "SEARCH_SOURCE_UNAVAILABLE",
        `search source "${phase}" returned a malformed page_ids result`,
        { details: { phase } },
      );
    }
    return { ids: ids.filter((id): id is string => typeof id === "string"), cursor };
  };

  return {
    async buildDocument(entityType, entityId, context = "default") {
      if (entityType === "entry" || !entityType.includes("/")) {
        return deps.base.buildDocument(entityType, entityId, context);
      }
      const resolved = await resolvedSource(entityType);
      if (resolved === null) return null;
      const extensionContext = await deps.sourceContext(resolved.extensionId);
      if (extensionContext === null) return null;
      const handler = resolveHandler(resolved.artifact, resolved.registration.handler) as (
        ctx: unknown,
        id: string,
      ) => Promise<unknown>;
      const document = await handler(extensionContext, entityId);
      if (document === null || typeof document !== "object") return null;
      // Canonical URL policy (CORE-SHOP-SEO-01, PREPUBLIC §3): the document
      // route is derived through the ONE extensionCanonicalPath builder —
      // byte-identical to the HTTP canonical (trailing-slash policy, mount
      // prefix, locale-ready subtag rule). Sources supply a mount-relative
      // path and the document locale.
      const mountPath = await deps.activeMountPath(resolved.extensionId);
      const rawRoute = (document as { route?: unknown }).route;
      const rawLocale = (document as { locale?: unknown }).locale;
      const localization = await deps.getLocalization?.();
      const documentLocale = typeof rawLocale === "string" ? rawLocale : context;
      const locale =
        documentLocale === "default" || documentLocale === "x-default"
          ? (localization?.defaultLocale ?? documentLocale)
          : documentLocale;
      if (
        mountPath === null ||
        typeof rawRoute !== "string" ||
        !isExtensionPublicPage(resolved.artifact, rawRoute) ||
        (localization !== undefined && !localization.enabledLocales.includes(locale))
      )
        return null;
      const canonicalRoute = extensionCanonicalPath({
        mountPath,
        extensionId: resolved.extensionId,
        path: rawRoute,
        locale,
        ...(localization === undefined ? {} : { defaultLocale: localization.defaultLocale }),
      });
      return {
        ...(document as Record<string, unknown>),
        entity_type: entityType,
        entity_id: entityId,
        route: canonicalRoute,
        extension_path: extensionCanonicalPath({
          mountPath: "/",
          extensionId: resolved.extensionId,
          path: rawRoute,
        }),
        locale,
      } as never;
    },
    async listPhases() {
      const enabled = await deps.enabledIds();
      const phases: string[] = ["entry"];
      for (const artifact of deps.catalog.list()) {
        if (!enabled.includes(artifact.manifest.id)) continue;
        for (const source of artifact.manifest.registrations.search_sources) {
          phases.push(`${artifact.manifest.id}/${source.source_id}`);
        }
      }
      return phases;
    },
    async countPhase(phase) {
      if (phase === "entry" || !phase.includes("/")) return deps.base.countPhase(phase);
      let total = 0;
      let cursor: string | null = null;
      for (let guard = 0; guard < PAGE_IDS_COUNT_PAGES_MAX; guard += 1) {
        const page = await pageIdsPage(phase, cursor, PAGE_IDS_BATCH_MAX);
        total += page.ids.length;
        if (page.cursor === null) return total;
        cursor = page.cursor;
      }
      throw new SearchError(
        "SEARCH_SOURCE_UNAVAILABLE",
        `search source "${phase}" exceeded the page_ids count ceiling`,
        { details: { phase, pages: PAGE_IDS_COUNT_PAGES_MAX } },
      );
    },
    async listPhaseIds(phase, after, limit) {
      if (phase === "entry" || !phase.includes("/")) {
        return deps.base.listPhaseIds(phase, after, limit);
      }
      return pageIdsPage(phase, after, limit);
    },
  };
}

export interface AdminSearchResult {
  readonly query: string;
  readonly published: {
    readonly items: {
      readonly entity_id: string;
      readonly content_type: string | null;
      readonly title: string;
      readonly path: string | null;
      readonly locale: string;
      readonly published_at: string | null;
      readonly snippet: readonly { readonly text: string; readonly match: boolean }[] | null;
    }[];
    readonly total: number;
  };
  readonly drafts: readonly {
    readonly entity_id: string;
    readonly content_type: string | null;
    readonly title: string | null;
    readonly locale: string;
    readonly updated_at: Date;
  }[];
  readonly media: readonly {
    readonly asset_id: string;
    readonly filename: string;
    readonly kind: string;
  }[];
  readonly navigation_labels: readonly {
    readonly item_id: string;
    readonly set_key: string;
    readonly label: string | null;
  }[];
}

interface DraftRow extends Record<string, unknown> {
  readonly entity_id: string;
  readonly content_type_id: string | null;
  readonly title: string | null;
  readonly locale: string;
  readonly updated_at: Date;
}

interface NavRow extends Record<string, unknown> {
  readonly item_id: string;
  readonly set_key: string;
  readonly label: string | null;
}

/**
 * Admin authorized search mode (PCMS-SEARCH-T017; Search spec §24): the
 * shared engine over the public projection plus authorized sources
 * (draft titles, media metadata, navigation labels). Permission gating and
 * bounds live with the operation; drafts can never enter the public index
 * because the source only derives from published pointers.
 */
export function createAdminSearch(deps: {
  readonly pool: {
    query<Row extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: Row[] }>;
  };
  readonly defaultSiteKey: string;
  readonly getDefaultLocale: () => Promise<string>;
  readonly provider: SearchProvider;
  readonly mediaSearch?: (
    text: string,
    limit: number,
  ) => Promise<readonly { asset_id: string; filename: string; kind: string }[]>;
}): (input: {
  readonly q: string;
  readonly site: string;
  readonly locale: string;
  readonly limit?: number;
}) => Promise<AdminSearchResult> {
  return async (input) => {
    const q = normalizeQueryText(input.q);
    if (q === "") {
      return {
        query: "",
        published: { items: [], total: 0 },
        drafts: [],
        media: [],
        navigation_labels: [],
      };
    }
    if (q.length > MAX_QUERY_LENGTH) {
      throw new SearchError("SEARCH_QUERY_INVALID", `query exceeds ${MAX_QUERY_LENGTH} characters`);
    }
    const limit = Math.max(1, Math.min(input.limit ?? 10, 20));
    const locale = input.locale === "default" ? await deps.getDefaultLocale() : input.locale;
    const parsed = parseSearchQuery({
      q,
      site: input.site ?? deps.defaultSiteKey,
      locale,
      limit,
    });
    const published = await deps.provider.query(parsed);

    const prefix = `${q.replace(/[%_]/g, "")}%`;
    const drafts = await deps.pool.query<DraftRow>(
      `SELECT r.entity_id, e.content_type_id,
              r.payload->'fields'->>'title' AS title, r.locale, r.updated_at
       FROM revisions r
       LEFT JOIN entries e ON e.id = r.entity_id
       WHERE r.entity_type = 'entry' AND r.state = 'WORKING'
         AND r.payload->'fields'->>'title' ILIKE $1
       ORDER BY r.updated_at DESC, r.entity_id
       LIMIT $2`,
      [prefix, limit],
    );
    const navigationLabels = await deps.pool.query<NavRow>(
      `SELECT i.id AS item_id, s.key AS set_key, i.label
       FROM navigation_items i
       JOIN navigation_sets s ON s.id = i.set_id AND s.archived_at IS NULL
       WHERE i.label ILIKE $1
       ORDER BY s.key, i.label
       LIMIT $2`,
      [prefix, limit],
    );
    const media = deps.mediaSearch === undefined ? [] : await deps.mediaSearch(q, limit);

    return {
      query: q,
      published: {
        items: published.items.map((item) => ({
          entity_id: item.entity_id,
          content_type: item.content_type,
          title: item.title,
          path: item.path,
          locale,
          published_at: item.published_at === null ? null : item.published_at.toISOString(),
          snippet: item.snippet?.segments ?? null,
        })),
        total: published.total,
      },
      drafts: drafts.rows.map((row) => ({
        entity_id: row.entity_id,
        content_type: row.content_type_id,
        title: row.title,
        locale: row.locale,
        updated_at: row.updated_at,
      })),
      media,
      navigation_labels: navigationLabels.rows.map((row) => ({
        item_id: row.item_id,
        set_key: row.set_key,
        label: row.label,
      })),
    };
  };
}

/** Public search application operation (Search spec §23): parse + query. */
export function createPublicSearchOperation(deps: {
  readonly provider: SearchProvider;
  readonly defaultSiteKey: string;
  readonly getDefaultLocale: () => Promise<string>;
}): (input: {
  readonly q: string;
  readonly site?: string;
  readonly locale: string;
  readonly content_type?: string;
  readonly date_from?: string;
  readonly date_to?: string;
  readonly sort?: string;
  readonly limit?: number;
  readonly cursor?: string;
}) => Promise<SearchQueryResult> {
  return async (input) => {
    const parsed = parseSearchQuery({
      q: input.q,
      site: input.site ?? deps.defaultSiteKey,
      locale: input.locale === "default" ? await deps.getDefaultLocale() : input.locale,
      ...(input.content_type === undefined ? {} : { content_type: input.content_type }),
      ...(input.date_from === undefined ? {} : { date_from: input.date_from }),
      ...(input.date_to === undefined ? {} : { date_to: input.date_to }),
      ...(input.sort === undefined ? {} : { sort: input.sort }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    return deps.provider.query(parsed);
  };
}

/** Server-side theme data only: do not serialize this through anonymous REST.
 * Fetch one bounded page of still-public revisions; never a working revision
 * or revision sidecar. Presentation fields are independent of searchable hints.
 */
export function createSearchResultMetadata(deps: SearchCompositionDeps) {
  return async (
    items: readonly { readonly revision_id: string }[],
  ): Promise<
    Record<
      string,
      {
        fields: Record<string, unknown>;
        seo: unknown;
      }
    >
  > => {
    if (items.length > 50)
      throw new SearchError("SEARCH_QUERY_INVALID", "metadata page exceeds 50");
    if (items.length === 0) return {};
    const { rows } = await deps.pool.query<{
      revision_id: string;
      fields: Record<string, unknown>;
      seo_payload: unknown;
    }>(
      `SELECT rev.id AS revision_id, rev.payload->'fields' AS fields, seo.payload AS seo_payload
      FROM revisions rev
      JOIN publications p ON p.entity_type = rev.entity_type AND p.entity_id = rev.entity_id
        AND p.current_revision_id = rev.id AND p.state = 'PUBLISHED'
      JOIN entries e ON e.id = rev.entity_id AND e.archived_at IS NULL
      LEFT JOIN seo_documents seo ON seo.entry_id = e.id
      WHERE rev.entity_type = 'entry' AND rev.id = ANY($1::uuid[])
        AND EXISTS (SELECT 1 FROM routes r WHERE r.target_type = 'entry'
          AND r.target_id = e.id::text AND r.retired_at IS NULL AND r.is_canonical)`,
      [items.map((item) => item.revision_id)],
    );
    const result: Record<string, { fields: Record<string, unknown>; seo: unknown }> = {};
    for (const row of rows) {
      if (!indexableUnderSeo(row, deps.seoEnvironment)) continue;
      result[row.revision_id] = { fields: row.fields ?? {}, seo: row.seo_payload ?? null };
    }
    return result;
  };
}
