// Public site renderer (composition capability).
//
// The web app historically served only API/admin/preview/search/MCP — this
// module closes the remaining M04-era seam ("real public rendering … in
// apps/web"): Routing resolution → published revision → Theme Contract render.
// It is generic on purpose: no site-specific templates, no Core patches —
// everything flows through the public view-model contracts (@pcms/themes,
// @pcms/routing, @pcms/publication, @pcms/media).
//
// Scope provided to block renderers: `media` (preset derivatives), `forms`
// (M12 FormViewModel by definition id), `quizzes` (empty in v1) and
// `related_cards` (manual-mode related_content cards keyed by block id).
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ApiError,
  type ApplicationServices,
  authenticateRequest,
  COLLECTION_DEFAULT_PAGE_SIZE,
  extensionCanonicalPath,
  mapEntryRichText,
  type OperationContext,
  queryCollectionFeed,
  queryPublishedCardRows,
  readBindingFeedOptions,
  readRelatedFeedOptions,
  readThemeLifecycleState,
  recoverThemeLifecycle,
} from "@pcms/api";
import { validateBlockDocument } from "@pcms/blocks";
import { collectRichTextMediaIds, type FieldSchema, resolveNavigationEntries } from "@pcms/content";
import { isStableId } from "@pcms/core";
import {
  createMediaPresetRegistry as createAssetPresetRegistry,
  createMediaViewModelProvider,
  getAssetsByIds,
  listVariantsForAssets,
  variantPublicUrl,
} from "@pcms/media";
import type { NavigationItemNode } from "@pcms/navigation";
import { createNavigationDiscovery, deriveBreadcrumbs } from "@pcms/navigation";
import { PREVIEW_RESPONSE_HEADERS, publishedEntryIds } from "@pcms/publication";
import { localizedRoutePath, resolveNavigationPaths } from "@pcms/routing";
import { serializeJsonLd } from "@pcms/seo";
import {
  applyTokenOverrides,
  assembleHeadHtml,
  type BreadcrumbsViewModel,
  buildImageModel,
  createBlockRendererRegistry,
  createComponentRegistry,
  createMediaPresetRegistry,
  createNavigationPlacementRegistry,
  createRenderService,
  createTemplateRegistry,
  createThemeDiscovery,
  createThemeEngine,
  type ImageModel,
  type MediaAssetViewModel,
  type NavigationItemViewModel,
  parseTokensSource,
  readThemeManifestPresets,
  renderRichText,
  resolveInstalledThemeDirectory,
  resolveSettingsValues,
  type SafeHtml,
  safeHtml,
  type ThemeManifest,
  type ThemeManifestCollection,
  themeRevisionDirectory,
  tokenOverridesFromSettings,
  tokensToCss,
  validateThemeManifest,
} from "@pcms/themes";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  blockNodesOf,
  buildFeedCards,
  collectFieldMediaIds,
  type FeedCard,
  plainText,
  STABLE_ID_RE,
} from "./feed-cards.js";
import { publicSecurityHeaders } from "./public-headers.js";
import { registerRichTextAssets, withRichTextStyles } from "./richtext-assets.js";
import { createSearchPageHandler, registerSearchPageRoute, wrapSearchPage } from "./search-page.js";
import {
  type AnalyticsPageSurface,
  analyticsPageInjection,
  applySystemSlots,
} from "./system-slots.js";
import { pinThemeAssetUrls } from "./theme-asset-urls.js";
import { loadThemePlacements } from "./theme-placements.js";

export interface SiteRouteOptions {
  readonly application: ApplicationServices;
}

export function paginationPageLabel(locale: string, page: number): string {
  return `${/^ru(?:-|$)/i.test(locale) ? "Страница" : "Page"} ${page}`;
}

interface RelatedCard {
  readonly kind: "service" | "project" | "blog" | "card";
  readonly entry_id: string;
  readonly href: string;
  readonly title: string;
  readonly description: string | null;
  readonly note: string | null;
  readonly tag: string | null;
  readonly tags: readonly string[];
  readonly date: string | null;
  readonly image: string | null;
  readonly image_alt: string | null;
  readonly fields: Record<string, unknown>;
}

/** Feed item view model (Theme Contract §43): the published-collection card
 * handed to templates as `collections.<key>.items[*]`. */
interface CollectionFeedItem {
  readonly entry_id: string;
  readonly href: string;
  readonly title: string;
  readonly description: string | null;
  readonly teaser: string | null;
  /** ISO instant of the publication; themes format it for display. */
  readonly date: string;
  readonly tags: readonly string[];
  readonly image: string | null;
  readonly image_alt: string | null;
  readonly fields: Record<string, unknown>;
}

export { collectFieldMediaIds, selectCardImage } from "./feed-cards.js";

/** Collects declared media references from a block tree (Content spec §60). */
export function collectBlockMediaIds(blocks: unknown, app: ApplicationServices, into: Set<string>) {
  const visit = (block: Record<string, unknown>): void => {
    const type = typeof block.type === "string" ? block.type : null;
    const version = typeof block.schemaVersion === "number" ? block.schemaVersion : null;
    const props = (block.props ?? {}) as Record<string, unknown>;
    if (type !== null && version !== null) {
      const registered = app.blocks.getBlockType(type, version);
      for (const reference of registered?.references ?? []) {
        if (reference.kind === "media") collectRef(props, reference.prop, into);
      }
    }
    for (const child of (block.children ?? []) as Record<string, unknown>[]) visit(child);
  };
  const collectRef = (node: unknown, path: string, ids: Set<string>): void => {
    // Dotted path with one array hop per segment: "items[].media_id" walks
    // props.items[*].media_id; plain "media_id" reads props.media_id.
    const segments = path.split(".");
    const walk = (current: unknown, index: number): void => {
      if (index === segments.length) {
        if (typeof current === "string" && STABLE_ID_RE.test(current)) ids.add(current);
        return;
      }
      if (typeof current !== "object" || current === null) return;
      let key = segments[index]!;
      if (key.endsWith("[]")) {
        key = key.slice(0, -2);
        const list = (current as Record<string, unknown>)[key];
        if (!Array.isArray(list)) return;
        for (const item of list) walk(item, index + 1);
        return;
      }
      walk((current as Record<string, unknown>)[key], index + 1);
    };
    walk(node, 0);
  };
  if (!Array.isArray(blocks)) return;
  for (const block of blocks as Record<string, unknown>[]) visit(block);
}

/**
 * Core-owned head section as one trusted fragment (R14, 2026-10-02 site
 * developer report): the engine escapes plain strings unconditionally, so a
 * theme cannot output `head.json_ld` strings as JSON — `&quot;` inside a
 * script tag is not JSON. `assembleHeadHtml` is the Core-protected head
 * boundary (title/meta/canonical/alternates/robots/icons/JSON-LD/theme
 * slots, `</script>`-safe JSON-LD); exposing it as SafeHtml gives themes a
 * documented safe channel instead of re-opening raw output.
 */
function headHtmlScope(head: Parameters<typeof assembleHeadHtml>[0]): SafeHtml {
  return safeHtml(assembleHeadHtml(head));
}

/** One theme's render machinery: registries + boot settings + tokens pipeline.
 * The ACTIVE theme's stack is built at boot; candidate themes (preview) build
 * identical stacks lazily from their own directories — defaults for settings,
 * no activation side effects. */
interface ThemeStack {
  readonly manifest: ThemeManifest;
  readonly renderService: ReturnType<typeof createRenderService>;
  readonly templates: ReturnType<typeof createTemplateRegistry>;
  readonly components: ReturnType<typeof createComponentRegistry>;
  readonly blocks: ReturnType<typeof createBlockRendererRegistry>;
  readonly placements: ReturnType<typeof createNavigationPlacementRegistry>;
  readonly themePresets: ReturnType<typeof createMediaPresetRegistry>;
  readonly themeSettings: Record<string, boolean | string | number | null>;
  readonly tokensCss: () => string;
  readonly tokensStyleHash: () => string;
}

function buildThemeStack(
  themeDir: string,
  application: ApplicationServices,
  settings: Record<string, boolean | string | number | null>,
): ThemeStack {
  const manifestResult = validateThemeManifest(
    JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8")) as unknown,
  );
  if (!manifestResult.ok) {
    throw new Error(
      `theme manifest invalid (${themeDir}): ${JSON.stringify(manifestResult.issues)}`,
    );
  }
  const manifest: ThemeManifest = manifestResult.value;

  const snapshot: Record<string, string> = {};
  const collect = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(join(themeDir, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) collect(join(dir, entry.name), `${prefix}${entry.name}/`);
      else
        snapshot[`${prefix}${entry.name}`] = readFileSync(join(themeDir, dir, entry.name), "utf8");
    }
  };
  for (const dir of ["templates", "components", "blocks", "tokens"])
    if (dir === "templates" || existsSync(join(themeDir, dir))) collect(dir, `${dir}/`);

  const renderService = createRenderService({ manifest, snapshot, devMode: false });
  const templates = createTemplateRegistry(manifest);
  const components = createComponentRegistry(manifest, renderService);
  const blocks = createBlockRendererRegistry(manifest, renderService, {
    // Typed Actions in block props resolve against live routes (§47): the
    // theme receives `resolved.href` and never renders internal entries as
    // `href="#"`. Unrouted/unresolvable actions resolve to null — the theme
    // drops the link instead.
    resolveAction: async (action) => {
      const kind = String(action.type ?? "");
      if (kind === "" || kind === "none") return null;
      const resolved = await application.actionUrls.resolveAction({
        kind,
        entry_id: typeof action.entry_id === "string" ? action.entry_id : null,
        url: typeof action.url === "string" ? action.url : "",
        anchor: typeof action.anchor === "string" ? action.anchor : "",
        phone: typeof action.phone === "string" ? action.phone : "",
        email: typeof action.email === "string" ? action.email : "",
      } as never);
      if (resolved.kind === "none" || resolved.kind === "unresolved") return null;
      return { href: resolved.href, external: kind === "external_url" };
    },
  });
  const placements = createNavigationPlacementRegistry(manifest);
  const themePresets = createMediaPresetRegistry(manifest);

  const resolvedSettings = resolveSettingsValues(manifest.settings_schema, settings);
  if (!resolvedSettings.ok) {
    throw new Error(`theme settings invalid (${themeDir}): ${resolvedSettings.issues[0]?.message}`);
  }
  const themeSettings = resolvedSettings.values;

  // Tokens: the theme templates embed them through the contract's own inline
  // injection point `<style>{{ tokens_css }}</style>` (reference-theme head
  // composition). Deterministic per theme, so the CSP header can allow
  // exactly it by content hash — computed from Core's own renderer output,
  // never from theme-declared policy (Theme Contract §34 keeps `unsafe-*`
  // out of theme hands).
  let tokensCssCache: string | null = null;
  const tokensCss = (): string => {
    if (tokensCssCache !== null) return tokensCssCache;
    let tokens = {};
    for (const name of Object.keys(snapshot)
      .filter((n) => n.startsWith("tokens/") && n.endsWith(".json"))
      .sort()) {
      const parsed = parseTokensSource(snapshot[name] ?? "");
      if (parsed.ok) tokens = { ...tokens, ...parsed.tokens };
    }
    const overrides = tokenOverridesFromSettings(manifest.settings_schema, themeSettings);
    tokensCssCache = tokensToCss(applyTokenOverrides(tokens, overrides));
    return tokensCssCache;
  };
  let tokensStyleHashCache: string | null = null;
  const tokensStyleHash = (): string => {
    if (tokensStyleHashCache === null) {
      tokensStyleHashCache = `'sha256-${createHash("sha256").update(tokensCss()).digest("base64")}'`;
    }
    return tokensStyleHashCache;
  };

  return {
    manifest,
    renderService,
    templates,
    components,
    blocks,
    placements,
    themePresets,
    themeSettings,
    tokensCss,
    tokensStyleHash,
  };
}

/** Cheap mount-prefix probe with a 5s TTL cache: avoids per-request SQL on
 * sites without any extension mount while keeping mount activation latency
 * bounded. (ADR-0018 §2.2) */
let mountPrefixCache: {
  readonly paths: readonly string[];
  readonly redirectPaths: readonly string[];
  readonly expiresAt: number;
} | null = null;
async function extensionMountPrefixHit(
  application: ApplicationServices,
  path: string,
): Promise<boolean> {
  const now = Date.now();
  if (mountPrefixCache === null || mountPrefixCache.expiresAt <= now) {
    const mounts = await application.extensionRouteMounts.listActive().catch(() => []);
    const redirects = await application.extensionRouteMounts
      .listRedirects()
      .catch(() => [] as readonly { extensionId: string; fromPath: string }[]);
    mountPrefixCache = {
      paths: mounts.map((mount) => mount.mountPath),
      redirectPaths: redirects.map((redirect) => redirect.fromPath),
      expiresAt: now + 5_000,
    };
  }
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  return mountPrefixCache.paths.some(under) || mountPrefixCache.redirectPaths.some(under);
}

/** Resolve a path that hits a RETIRED mount: one permanent 308 hop to the
 * extension's ACTIVE mount (CORE-SHOP-SEO-01). Null = not a redirect. */
async function extensionMountRedirect(
  application: ApplicationServices,
  path: string,
  locale?: string,
): Promise<{ readonly location: string; readonly status: 308 } | null> {
  try {
    const resolved = await application.extensionRouteMounts.resolveRedirect(path);
    if (resolved === null) return null;
    return {
      location: extensionCanonicalPath({
        mountPath: resolved.mount,
        extensionId: resolved.extensionId,
        path: resolved.rest,
        ...(locale === undefined ? {} : { locale }),
      }),
      status: 308,
    };
  } catch {
    return null;
  }
}

export async function registerSiteRoute(
  fastify: FastifyInstance,
  options: SiteRouteOptions,
): Promise<void> {
  const { application } = options;
  registerRichTextAssets(fastify);
  const themeDir = application.themeDir;
  if (themeDir === undefined) {
    registerSearchPageRoute(fastify, { application });
    return; // API-only deployment: search has built-in markup
  }

  const configuredThemeId = application.themeDiscovery?.getManifest().id;
  const discoveryOptions = {
    cmsVersion: application.extensions.contractVersions.get("cms")!.version,
  };
  // The configured path supplies the catalog root; persisted activation wins on restart.
  await recoverThemeLifecycle({
    pool: application.pool,
    configuredDir: themeDir,
    siteKey: application.defaultSiteKey,
  });
  let initialState = await readThemeState();
  if (!initialState?.theme_key) {
    const seedManifest = validateThemeManifest(
      JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8")) as unknown,
    );
    if (!seedManifest.ok)
      throw new Error(`site theme manifest invalid: ${JSON.stringify(seedManifest.issues)}`);
    await application.pool.query(
      `INSERT INTO admin_theme_state (site_key, theme_key, theme_version, updated_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT (site_key) DO UPDATE
       SET theme_key = EXCLUDED.theme_key, theme_version = EXCLUDED.theme_version
       WHERE admin_theme_state.theme_key IS NULL`,
      [application.defaultSiteKey, seedManifest.value.id, seedManifest.value.version],
    );
    initialState = await readThemeState();
  }
  let activeThemeDir = initialState?.active_revision_id
    ? await revisionDir(initialState.active_revision_id)
    : initialState?.theme_key && initialState.theme_key !== configuredThemeId
      ? resolveInstalledThemeDirectory(
          themeDir,
          initialState.theme_key,
          discoveryOptions.cmsVersion,
        )
      : themeDir;
  let appliedThemeGeneration = Number(initialState?.theme_generation ?? 0);
  let appliedRevisionId = initialState?.active_revision_id ?? null;
  const requestTheme = new AsyncLocalStorage<{
    stack: ThemeStack;
    revisionId: string | null;
    generation: number;
    directory: string;
    pinAssets: boolean;
    media: Map<string, import("@pcms/media").MediaAssetPublicViewModel | null>;
    feedMedia: Map<string, import("@pcms/media").MediaAssetPublicViewModel | null>;
  }>();
  application.themeDir = activeThemeDir;
  application.themeDiscovery = createThemeDiscovery(activeThemeDir, discoveryOptions);
  application.navigationDiscovery = createNavigationDiscovery(
    application.pool,
    loadThemePlacements(activeThemeDir),
  );
  application.mediaPresets = createAssetPresetRegistry(readThemeManifestPresets(activeThemeDir));
  let appliedSettingsGeneration = initialState?.settings_generation ?? 0;
  // The active stack rebuilds itself when the theme directory changes
  // (2026-10-02 site-developer request: active-theme package replacement no
  // longer requires a web restart — candidate previews already refreshed by
  // the same fingerprint idea). The check is one stat() per request; the
  // rebuild is async and the previous stack keeps serving until it lands.
  let activeStack = buildThemeStack(activeThemeDir, application, initialState?.settings ?? {});
  let activeFingerprint = activeStackFingerprint(activeThemeDir);
  let activeGeneration = 0;
  application.themeRuntime.served = () => ({
    id: activeStack.manifest.id,
    version: activeStack.manifest.version,
    settings_generation: appliedSettingsGeneration,
    revision_id: appliedRevisionId,
    theme_generation: appliedThemeGeneration,
  });
  application.themeRuntime.confirmed = (revisionId, generation) => {
    appliedRevisionId = revisionId;
    appliedThemeGeneration = generation;
  };
  application.themeRuntime.requestSnapshot = () => {
    const value = requestTheme.getStore();
    return value
      ? {
          theme_key: value.stack.manifest.id,
          revision_id: value.revisionId,
          directory: value.directory,
          generation: value.generation,
        }
      : undefined;
  };
  fastify.addHook("onSend", async (_request, reply, payload) => {
    const snapshot = requestTheme.getStore();
    if (
      !snapshot?.revisionId ||
      !snapshot.pinAssets ||
      typeof payload !== "string" ||
      !String(reply.getHeader("content-type") ?? "").startsWith("text/html")
    )
      return payload;
    const prefix = `/themes/${snapshot.stack.manifest.id}/assets/`;
    if (!payload.includes(prefix)) return payload;
    const hasAbsolute = new RegExp(`https?://[^\\s"']+${prefix.replaceAll("/", "\\/")}`).test(
      payload,
    );
    const origin = hasAbsolute ? await application.primaryOrigin() : null;
    const next = pinThemeAssetUrls(payload, {
      themeId: snapshot.stack.manifest.id,
      revisionId: snapshot.revisionId,
      origin,
    });
    if (next !== payload) reply.removeHeader("content-length");
    return next;
  });
  application.themeRuntime.prepareState = async (dir, values, generation) => {
    const stack = buildThemeStack(dir, application, values);
    const discovery = createThemeDiscovery(dir, discoveryOptions);
    const navigation = createNavigationDiscovery(application.pool, loadThemePlacements(dir));
    const presets = createAssetPresetRegistry(readThemeManifestPresets(dir));
    return () => {
      appliedThemeGeneration = -1;
      activeGeneration += 1;
      activeThemeDir = dir;
      application.themeDir = dir;
      application.themeDiscovery = discovery;
      application.navigationDiscovery = navigation;
      application.mediaPresets = presets;
      activeStack = stack;
      appliedSettingsGeneration = generation;
      activeFingerprint = activeStackFingerprint(dir);
    };
  };
  fastify.addHook("onRequest", (request, _reply, done) => {
    if (/^\/health\//.test(request.url)) {
      done();
      return;
    }
    void application.themeRuntime
      .withChange(async () => {
        let state = await readThemeState();
        const recovered = Boolean(state?.pending_operation_id);
        if (state?.pending_operation_id) {
          await recoverThemeLifecycle({
            pool: application.pool,
            configuredDir: themeDir,
            siteKey: application.defaultSiteKey,
          });
          state = await readThemeState();
        }
        if (
          state?.theme_key &&
          (recovered ||
            state.active_revision_id !== appliedRevisionId ||
            Number(state.theme_generation) !== appliedThemeGeneration ||
            state.theme_key !== activeStack.manifest.id ||
            state.settings_generation !== appliedSettingsGeneration)
        ) {
          const dir = state.active_revision_id
            ? await revisionDir(state.active_revision_id)
            : state.theme_key === configuredThemeId
              ? themeDir
              : resolveInstalledThemeDirectory(
                  themeDir,
                  state.theme_key,
                  discoveryOptions.cmsVersion,
                );
          const apply = await application.themeRuntime.prepareState!(
            dir,
            state.settings ?? {},
            state.settings_generation,
          );
          apply();
          appliedThemeGeneration = Number(state.theme_generation);
          appliedRevisionId = state.active_revision_id;
        }
        return {
          stack: activeStack,
          revisionId: appliedRevisionId,
          generation: appliedThemeGeneration,
          directory: activeThemeDir,
          pinAssets: true,
          media: new Map(),
          feedMedia: new Map(),
        };
      })
      .then(
        (snapshot) => requestTheme.run(snapshot, done),
        (error) =>
          done(
            error instanceof ApiError && error.code === "THEME_CHANGE_BUSY"
              ? new ApiError("THEME_CHANGE_BUSY", "theme publication is in progress", {
                  status: 503,
                  retryable: true,
                  details: error.details,
                })
              : error,
          ),
      );
  });
  application.themeRuntime.prepareUpdate = async (stagedDir) => {
    const stack = buildThemeStack(stagedDir, application, await readSettings());
    return () => {
      appliedThemeGeneration = -1;
      activeGeneration += 1;
      activeStack = stack;
      activeFingerprint = activeStackFingerprint(activeThemeDir);
    };
  };
  function activeStackFingerprint(dir: string): string | null {
    try {
      const stat = statSync(join(dir, "theme.json"));
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      return null;
    }
  }
  function currentActiveStack(): ThemeStack {
    const pinned = requestTheme.getStore();
    if (pinned) return pinned.stack;
    const fingerprint = activeStackFingerprint(activeThemeDir);
    if (fingerprint !== null && fingerprint !== activeFingerprint) {
      const generation = ++activeGeneration;
      activeFingerprint = fingerprint;
      void readSettings()
        .then((settings) => buildThemeStack(activeThemeDir, application, settings))
        .then((stack) => {
          if (generation !== activeGeneration) return;
          activeStack = stack;
          fastify.log.info({ theme: stack.manifest.id }, "theme.active_stack_refreshed");
        })
        .catch((error) => {
          // Rebuild failed — keep serving the previous stack, but say why:
          // a silent swallow looks exactly like "the update did not apply".
          fastify.log.error(error, "theme.active_stack_refresh_failed");
        });
    }
    return activeStack;
  }

  async function readThemeState() {
    return readThemeLifecycleState(application.pool, application.defaultSiteKey);
  }
  async function revisionDir(id: string) {
    const result = await application.pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM theme_revisions WHERE site_key=$1 AND id=$2",
      [application.defaultSiteKey, id],
    );
    if (!result.rows[0]) throw new Error("confirmed theme revision missing");
    return themeRevisionDirectory(
      themeDir!,
      result.rows[0].storage_key,
      discoveryOptions.cmsVersion,
    );
  }
  async function readSettings(): Promise<Record<string, boolean | string | number | null>> {
    return (await readThemeState())?.settings ?? {};
  }

  /** Theme stacks for /preview candidate renders (signed token carries the
   * theme id): built lazily, cached, strictly read-only — activation,
   * settings pointers and renderDir are never touched (2026-10-01 site
   * developer request). Cache validity is keyed on the installed theme.json
   * fingerprint: a package reinstall (or any theme.json rewrite) rebuilds
   * the stack on the next preview, so old and new tokens both render the
   * CURRENTLY installed version — never a mix (2026-10-01 follow-up). */
  const candidateStacks = new Map<string, { fingerprint: string; stack: ThemeStack }>();
  function candidateStack(themeId: string): ThemeStack | null {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(themeId)) return null;
    if (themeId === activeStack.manifest.id) return activeStack;
    const dir = join(dirname(themeDir!), themeId);
    if (!existsSync(join(dir, "theme.json"))) {
      candidateStacks.delete(themeId); // uninstalled since last preview
      return null;
    }
    let fingerprint: string;
    try {
      const stat = statSync(join(dir, "theme.json"));
      fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      return null;
    }
    const cached = candidateStacks.get(themeId);
    if (cached !== undefined && cached.fingerprint === fingerprint) return cached.stack;
    try {
      const stack = buildThemeStack(dir, application, {});
      candidateStacks.set(themeId, { fingerprint, stack });
      return stack;
    } catch {
      candidateStacks.delete(themeId);
      return null; // invalid candidate manifest → typed preview 404
    }
  }

  const mediaProvider = createMediaViewModelProvider({
    pool: application.pool,
    registry: application.mediaPresets,
  });

  async function requestMedia(ids: readonly string[], includeArchived: boolean) {
    const snapshot = requestTheme.getStore();
    const cache = includeArchived ? snapshot?.media : snapshot?.feedMedia;
    const unique = [...new Set(ids)];
    const missing = unique.filter((id) => !cache?.has(id));
    const loaded = await mediaProvider.getAssetViewModels(missing, { includeArchived });
    for (const id of missing) cache?.set(id, loaded[id] ?? null);
    return Object.fromEntries(unique.map((id) => [id, cache?.get(id) ?? loaded[id] ?? null]));
  }

  async function buildMediaScope(
    stack: ThemeStack,
    ids: ReadonlySet<string>,
  ): Promise<
    Record<
      string,
      {
        alt: string;
        download: { href: string; versionedHref: string } | null;
        presets: Record<string, ImageModel | null>;
      }
    >
  > {
    const scope: Record<
      string,
      {
        alt: string;
        download: { href: string; versionedHref: string } | null;
        presets: Record<string, ImageModel | null>;
      }
    > = {};
    const assets = await requestMedia([...ids], true);
    for (const id of ids) {
      const asset = assets[id];
      if (asset == null) continue;
      const viewModel: MediaAssetViewModel = asset;
      const presets: Record<string, ImageModel | null> = {};
      for (const preset of stack.themePresets.listPresets()) {
        try {
          presets[preset.id] = buildImageModel(
            viewModel,
            preset.id,
            stack.manifest.media_presets.find((m) => m.id === preset.id),
          );
        } catch {
          presets[preset.id] = null;
        }
      }
      scope[id] = { alt: asset.alt, download: asset.download, presets };
    }
    return scope;
  }

  function collectThemeMediaIds(stack: ThemeStack, ids: Set<string>): void {
    for (const setting of stack.manifest.settings_schema) {
      const value = stack.themeSettings[setting.key];
      if (setting.type === "media" && typeof value === "string" && STABLE_ID_RE.test(value))
        ids.add(value);
    }
  }

  async function serviceSiteScope(stack: ThemeStack, locale: string) {
    const site = await application.routes.ensureSite(application.defaultSiteKey);
    const identity = await application.seoDiscovery.getSiteIdentity().catch(() => null);
    const localization = await application.localization.get();
    const context = await application.localization.contextFor(locale);
    return {
      site: { site_name: identity?.site_name ?? site.title, logo: null, contact: {}, social: [] },
      nav: await navigationScope(stack, context, site.homeEntryId),
      i18n: {
        active_locale: locale,
        default_locale: localization.defaultLocale,
        locales: [...localization.locales],
        alternates: [],
      },
    };
  }

  async function navigationScope(
    stack: ThemeStack,
    contextLocale: string,
    homeEntryId: string | null,
  ): Promise<Record<string, { items: NavigationItemViewModel[] }>> {
    const bindings = await application.placements.listBindings();
    const trees = new Map<string, readonly NavigationItemNode[]>();
    for (const binding of bindings) {
      if (!trees.has(binding.navigationSetId))
        trees.set(
          binding.navigationSetId,
          await application.navigation.materializeTree(binding.navigationSetId),
        );
    }
    const ids = new Set<string>();
    const collect = (nodes: readonly NavigationItemNode[]) => {
      for (const node of nodes) {
        if (node.type === "internal_entry") {
          const id = readTargetString(node.target, "entry_id");
          if (id !== null && isStableId(id)) {
            ids.add(id);
            collect(node.children);
          }
        } else if (node.type === "group") {
          collect(node.children);
        }
      }
    };
    for (const tree of trees.values()) collect(tree);
    const targets = await resolveNavigationEntries(application.pool, [...ids], contextLocale);
    const targetIds = [...new Set(targets.values())];
    const published = await publishedEntryIds(application.pool, targetIds, contextLocale);
    const paths = await resolveNavigationPaths(application.pool, targetIds, {
      locale: contextLocale === "default" ? "x-default" : contextLocale,
    }).catch(() => new Map<string, string>());
    const resolvedTrees = new Map<string, NavigationItemViewModel[]>();
    const assignments: { placement: string; items: NavigationItemViewModel[] }[] = [];
    for (const binding of bindings) {
      let items = resolvedTrees.get(binding.navigationSetId);
      if (items === undefined) {
        items = await toViewModels(
          trees.get(binding.navigationSetId)!,
          contextLocale,
          homeEntryId,
          { targets, published, paths },
        );
        resolvedTrees.set(binding.navigationSetId, items);
      }
      assignments.push({ placement: binding.placementKey, items });
    }
    const scope: Record<string, { items: NavigationItemViewModel[] }> = {};
    for (const contract of stack.placements.listPlacements()) {
      const items = stack.placements.resolveItems(assignments, contract.id);
      if (items !== null) scope[contract.id] = { items: [...items] };
    }
    return scope;
  }

  /** "/en" style prefix for a secondary BCP-47 locale; "" for a bare "en". */
  const localePrefix = (locale: string): string => {
    const dash = locale.indexOf("-");
    return `/${(dash === -1 ? locale : locale.slice(0, dash)).toLowerCase()}`;
  };

  async function homeHref(locale: string): Promise<{ kind: "url"; href: string } | null> {
    const localization = await application.localization.get().catch(() => null);
    if (localization === null) return null;
    const prefix =
      locale === "default" || locale === localization.defaultLocale ? "" : localePrefix(locale);
    return { kind: "url", href: `${prefix}/` };
  }

  /**
   * Reciprocal language alternates for a logical page (opt-in multilingual):
   * published locale versions only — drafts never leak into hreflang.
   * Single-language sites get an empty list (no hreflang emitted).
   */
  async function localeAlternates(
    entryId: string,
    siteId: string,
    localization: { defaultLocale: string; locales: readonly string[] },
  ): Promise<{ locale: string; url: string }[]> {
    const members = await application.entries.listTranslations(entryId as never).catch(() => []);
    const site = await application.routes.ensureSite(application.defaultSiteKey);
    const origin = await application.canonical.primaryOrigin(siteId).catch(() => null);
    const result: { locale: string; url: string }[] = [];
    for (const member of members) {
      const context =
        member.locale === "default" || member.locale === localization.defaultLocale
          ? "default"
          : member.locale;
      const published = await application.pool.withTransaction((tx) =>
        application.publications.getPublishedRevision(tx, "entry", member.id as never, context),
      );
      if (published === null) continue;
      const code = member.locale === "default" ? localization.defaultLocale : member.locale;
      // Home-group translations have no route row — their locale URL is
      // prefix + "/". Everything else resolves through the canonical route
      // (absolute when a primary domain binding exists; deployments without
      // one degrade to relative hrefs rather than dropping alternates).
      if (site.homeEntryId !== null && members.some((m) => m.id === site.homeEntryId)) {
        const prefix = code === localization.defaultLocale ? "" : localePrefix(code);
        result.push({ locale: code, url: `${origin ?? ""}${prefix}/` });
        continue;
      }
      // Direct route lookup: the canonical service requires a primary
      // domain binding; alternates must survive deployments without one
      // (href degrades to relative, production has the binding).
      const routeLocale = member.locale === "default" ? "x-default" : member.locale;
      const route = await application.pool
        .query<{ path: string; locale: string }>(
          `SELECT path, locale FROM routes
           WHERE target_type = 'entry' AND target_id = $1
             AND locale = $2 AND retired_at IS NULL AND is_canonical
           ORDER BY created_at DESC LIMIT 1`,
          [member.id, routeLocale],
        )
        .catch(() => ({ rows: [] as Array<{ path: string; locale: string }> }));
      const row = route.rows[0];
      if (row === undefined) continue;
      const path = localizedRoutePath({ locale: row.locale, path: row.path });
      result.push({ locale: code, url: `${origin ?? ""}${path}` });
    }
    return result;
  }

  const readTargetString = (target: unknown, key: string): string | null => {
    if (typeof target !== "object" || target === null) return null;
    const value = (target as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  };

  /**
   * Breadcrumb trail for one public entry, produced by the existing
   * `deriveBreadcrumbs` mechanism (Navigation spec §50–§52) with the Content
   * Tree as the hierarchy source — the strategy for a public page whose
   * parentage is informational, not a menu (the two models stay independent:
   * no navigation set is consulted, no "first trail" is guessed).
   *
   * The lookups bridge the composition layer: ancestors from
   * `contentTree.getAncestors` (the package walks the parent chain itself via
   * `getParentEntryId`), titles and hrefs from the PUBLISHED revision in the
   * request locale. An ancestor that is unpublished, unrouted or missing its
   * translation yields null and is dropped from the trail rather than leaking
   * a draft title. Fail-soft: any failure degrades to no breadcrumbs, never a
   * failed page.
   */
  async function breadcrumbsScope(
    entryId: string,
    locale: string,
  ): Promise<BreadcrumbsViewModel | null> {
    const crumbs = await deriveBreadcrumbs(
      { type: "content-tree" },
      { entryId },
      {
        getParentEntryId: (id) => getContentParent(id),
        // "" (not null) for an unavailable title: the package falls back to the
        // entry ID for a null label, which would leak an internal UUID into
        // public HTML. An empty label is dropped by the filter below instead.
        getTitle: (id) => publishedField(id, locale, "title").then((title) => title ?? ""),
        getEntryHref: async (id) =>
          application.actionUrls
            .resolveAction(
              { kind: "internal_entry", entry_id: id },
              { locale: locale === "default" ? "x-default" : locale },
            )
            .then((resolved) => (resolved.kind === "url" ? resolved.href : null))
            .catch(() => null),
        getNavigationTree: async () => [],
      },
    ).catch(() => null);
    if (crumbs === null) return null;
    const items = crumbs
      .map((crumb) => ({ title: crumb.label, href: crumb.href ?? "" }))
      .filter((item) => item.title !== "");
    // A single crumb (the page itself) is not a trail — render nothing.
    return items.length > 1 ? { items } : null;
  }

  /** Content Tree parent of an entry (null at the root). */
  async function getContentParent(entryId: string): Promise<string | null> {
    const entry = await application.entries.findEntry(entryId as never).catch(() => null);
    return entry?.parentEntryId ?? null;
  }

  /** A PUBLISHED string field of an entry in `locale`; null when unavailable. */
  async function publishedField(
    entryId: string,
    locale: string,
    field: string,
  ): Promise<string | null> {
    let targetId = entryId;
    if (locale !== "default") {
      const translation = await application.entries
        .findTranslation(entryId as never, locale)
        .catch(() => null);
      if (translation === null) return null;
      targetId = translation.id;
    }
    const revision = await application.pool
      .withTransaction((tx) =>
        application.publications.getPublishedRevision(tx, "entry", targetId as never, locale),
      )
      .catch(() => null);
    if (revision === null) return null;
    const fields = (((revision.payload ?? {}) as { fields?: unknown }).fields ?? {}) as Record<
      string,
      unknown
    >;
    return plainText(fields[field]) || null;
  }

  async function toViewModels(
    nodes: readonly NavigationItemNode[],
    contextLocale: string,
    homeEntryId: string | null,
    resolved: { targets: Map<string, string>; published: Set<string>; paths: Map<string, string> },
  ): Promise<NavigationItemViewModel[]> {
    const results: NavigationItemViewModel[] = [];
    for (const node of nodes) {
      const title = node.label ?? "";
      switch (node.type) {
        case "separator":
          results.push({ type: "separator" });
          break;
        case "group":
          results.push({
            type: "group",
            title,
            items: await toViewModels(node.children, contextLocale, homeEntryId, resolved),
          });
          break;
        case "internal_entry": {
          const entryId = readTargetString(node.target, "entry_id");
          if (entryId === null) break;
          // Locale resolution (opt-in multilingual): a menu item always
          // targets the logical entity — render the translation of the
          // request locale when one exists. No translation → the item drops
          // instead of silently linking to another language (validation
          // reports the same gap in the Admin).
          if (!isStableId(entryId) && contextLocale === "default")
            await application.entries.findEntry(entryId as never);
          const targetId = resolved.targets.get(entryId);
          if (targetId === undefined || !resolved.published.has(targetId)) break;
          // The home binding is site-level; its translations have no route
          // row — their locale-scoped home URL is prefix + "/".
          const homeTranslation = homeEntryId !== null && targetId === homeEntryId;
          // Unrouted entries drop out loudly in placement validation; the
          // renderer must not fail a whole page for one broken menu item.
          const hrefResult =
            homeTranslation && homeEntryId !== null
              ? await homeHref(contextLocale).catch(() => null)
              : resolved.paths.has(targetId)
                ? { kind: "url" as const, href: resolved.paths.get(targetId)! }
                : null;
          if (hrefResult === null) break;
          results.push({
            type: "internal_entry",
            entry_id: targetId,
            title,
            href: hrefResult.href,
            items: await toViewModels(node.children, contextLocale, homeEntryId, resolved),
          });
          break;
        }
        case "external_url": {
          const url = readTargetString(node.target, "url");
          if (url === null) break;
          results.push({ type: "external_url", title, href: url, items: [] });
          break;
        }
        case "anchor": {
          const anchor = readTargetString(node.target, "anchor");
          if (anchor === null) break;
          results.push({ type: "anchor", title, anchor, items: [] });
          break;
        }
        default:
          break;
      }
    }
    return results;
  }

  /** Quiz view models for quiz@1 blocks (Forms spec §26): the theme client
   * starts a run against start_url and answers against the run-scoped
   * endpoints; {quiz_run_id} in answer/complete URLs is substituted by the
   * theme client with the started run's id. */
  async function quizzesScope(blocksInDocument: unknown): Promise<Record<string, unknown>> {
    const scope: Record<string, unknown> = {};
    if (!Array.isArray(blocksInDocument)) return scope;
    for (const block of blocksInDocument as Record<string, unknown>[]) {
      if (block.type !== "quiz") continue;
      const id = (block.props as Record<string, unknown> | undefined)?.quiz_definition_id;
      if (typeof id !== "string" || !STABLE_ID_RE.test(id)) continue;
      try {
        const definition = await application.formsSource.domain.quizzes.getDefinition(id);
        if (definition.status !== "ACTIVE") continue;
        scope[id] = {
          quiz_definition_id: definition.id,
          quiz_schema_version: definition.schema_version,
          title: definition.title,
          start_url: `/api/v1/public/quizzes/${definition.id}/start`,
          answer_url: "/api/v1/public/quizzes/runs/{quiz_run_id}/answer",
          complete_url: "/api/v1/public/quizzes/runs/{quiz_run_id}/complete",
          start_label: "Start quiz",
        };
      } catch {
        // Unknown/archived definition: the theme renders its documented
        // unavailable placeholder, never a broken page.
      }
    }
    return scope;
  }

  /** Feed-card dependencies shared by related blocks and collections: the
   * block registry, content-type lookup, the batched media port and the
   * rendering theme's presets. */
  function cardDeps(stack: ThemeStack) {
    return {
      blocks: application.blocks,
      contentType: (key: string) => application.contentTypes.getLatestContentType(key),
      assets: (ids: readonly string[]) => requestMedia(ids, false),
      presets: stack.manifest.media_presets,
    };
  }

  async function cardsOf(
    rows: readonly import("@pcms/api").CollectionFeedItemRow[],
    options: {
      readonly fields: readonly string[];
      readonly imageField: string;
      readonly imagePreset: string;
      readonly tagField: string;
    },
    stack: ThemeStack,
  ): Promise<readonly FeedCard[]> {
    if (!stack.manifest.media_presets.some((preset) => preset.id === options.imagePreset)) {
      // Known-at-seal preset that the CURRENT theme no longer declares: cards
      // degrade to no image; GET never seals, migrates or transforms.
      fastify.log.warn({ preset: options.imagePreset }, "render.feed_image_preset_unknown");
    }
    return buildFeedCards(rows, options, cardDeps(stack));
  }

  async function relatedCards(
    blocksInDocument: unknown,
    contextLocale: string,
    selfEntryId: string,
    stack: ThemeStack,
  ): Promise<Record<string, RelatedCard[]>> {
    const cardsByBlock: Record<string, RelatedCard[]> = {};
    if (!Array.isArray(blocksInDocument)) return cardsByBlock;
    const site = await application.routes.ensureSite(application.defaultSiteKey);
    const deps = {
      pool: application.pool,
      isKnownContentType: (key: string) =>
        application.contentTypes.getLatestContentType(key) !== null,
    };
    // Related blocks can be NESTED inside container blocks (the seal walker
    // already accepts them there); the card map is keyed by block id, so the
    // whole renderable tree must be visited.
    const relatedBlocks: Record<string, unknown>[] = [];
    const collect = (list: unknown): void => {
      if (!Array.isArray(list)) return;
      for (const value of list) {
        if (typeof value !== "object" || value === null) continue;
        const node = value as Record<string, unknown>;
        if (node.type === "related_content") relatedBlocks.push(node);
        collect(node.children);
      }
    };
    collect(blocksInDocument);
    for (const block of relatedBlocks) {
      const props = (block.props ?? {}) as Record<string, unknown>;
      const blockId = typeof block.id === "string" ? block.id : "";
      const mode = typeof props.mode === "string" ? props.mode : "manual";
      const binding =
        typeof props.collection_key === "string"
          ? stack.manifest.collections?.[props.collection_key]
          : undefined;
      // R2: the block inherits its collection binding's order when it declares
      // none, so REST, template collections and related blocks agree.
      const options = readRelatedFeedOptions(props, binding);
      const excluded = new Set(options.excludeEntryIds);
      const pinned = (Array.isArray(props.entry_ids) ? props.entry_ids : []).filter(
        (value): value is string => typeof value === "string" && !excluded.has(value),
      );
      const limit =
        typeof props.limit === "number" && Number.isInteger(props.limit) && props.limit >= 1
          ? props.limit
          : null;
      const contentTypes = options.contentTypes ?? binding?.content_types ?? [];
      const tagField = binding?.tag_field ?? "tags";
      // Collection/hybrid modes resolve `collection_key` against the
      // RENDERING theme's declared collections (Theme Contract §43). An
      // unknown key degrades to an empty card list with a loud typed log
      // (REST answers COLLECTION_UNKNOWN for the same key).
      let fill: readonly import("@pcms/api").CollectionFeedItemRow[] = [];
      const wantsFill = mode === "collection" || mode === "hybrid";
      if (wantsFill && typeof props.collection_key === "string") {
        if (binding === undefined) {
          fastify.log.warn(
            { collection_key: props.collection_key, code: "COLLECTION_UNKNOWN" },
            "render.collection_unknown",
          );
        } else {
          try {
            const feed = await queryCollectionFeed(deps, {
              context: contextLocale,
              contentTypes,
              sectionEntryId: options.scope === "site" ? null : selfEntryId,
              scope: options.scope,
              order: options.order,
              excludeEntryIds: options.excludeEntryIds,
              siteId: site.id,
              tagField,
              tag: null,
              page: 1,
              pageSize: limit ?? binding.page_size ?? COLLECTION_DEFAULT_PAGE_SIZE,
            });
            fill = feed.items;
          } catch (error) {
            fastify.log.warn(
              { err: error, collection_key: props.collection_key },
              "render.collection_unresolved",
            );
          }
        }
      }
      // Pinned ids keep their declared order; one batch statement for all of
      // them (never one publication/route read per card).
      const pinnedRows =
        pinned.length === 0
          ? []
          : await queryPublishedCardRows(deps, {
              context: contextLocale,
              entryIds: pinned,
              siteId: site.id,
            });
      // `limit` bounds the OUTPUT, pinned ids included: only resolvable,
      // published, non-excluded pins take a slot (removed pins never do).
      const cap = limit ?? 100;
      let rows: readonly import("@pcms/api").CollectionFeedItemRow[];
      if (mode === "collection") rows = fill;
      else if (mode === "hybrid") {
        const merged = pinnedRows.slice(0, cap);
        const seen = new Set(merged.map((row) => row.entry_id));
        for (const row of fill) {
          if (merged.length >= cap) break;
          if (seen.has(row.entry_id)) continue;
          seen.add(row.entry_id);
          merged.push(row);
        }
        rows = merged;
      } else rows = limit === null ? pinnedRows : pinnedRows.slice(0, limit);

      const cards = await cardsOf(
        rows,
        {
          fields: options.fields,
          imageField: options.imageField,
          imagePreset: options.imagePreset,
          // Related cards keep their historical `tags` surface; the binding's
          // tag_field governs filtering, not what the card exposes.
          tagField: "tags",
        },
        stack,
      );
      cardsByBlock[blockId] = cards.map((card, index) => {
        const row = rows[index];
        return {
          kind:
            card.content_type === "article" || card.content_type === "news"
              ? "blog"
              : card.content_type === "service"
                ? "service"
                : "project",
          entry_id: card.entry_id,
          href: localizedRoutePath({
            locale: row?.route_locale ?? "x-default",
            path: row?.route_path ?? "/",
          }),
          title: card.title,
          description: card.description,
          // Legacy related-card alias chains stay exactly as they were.
          note: card.note,
          tag: card.tag,
          tags: card.tags,
          date:
            card.date_field === null ? null : new Date(card.date_field).toLocaleDateString("ru-RU"),
          image: card.image,
          image_alt: card.image_alt,
          fields: card.fields,
        };
      });
    }
    return cardsByBlock;
  }

  /** Collection feed machinery (Theme Contract §43): one declared collection
   * resolved for the CURRENT page. The section is "self" — the rendered
   * entry's Content Tree children; tag/page ride the request query. URLs are
   * pre-baked server-side (themes never see raw query params). */

  function feedUrl(path: string, page: number, tag: string | null): string {
    const params = new URLSearchParams();
    if (tag !== null) params.set("tag", tag);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return qs === "" ? path : `${path}?${qs}`;
  }

  function paginatedHead(
    head: EntryHeadInput,
    collections: Readonly<Record<string, unknown>>,
    locale: string,
  ): EntryHeadInput {
    const feeds = Object.values(collections).filter(
      (value): value is { page: number; page_count: number; tag: string | null } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as Record<string, unknown>).page === "number" &&
        typeof (value as Record<string, unknown>).page_count === "number",
    );
    const feed = feeds[0];
    if (feed === undefined) return head;

    const page = feed.page;
    const pageCount = Math.max(...feeds.map((feed) => feed.page_count));
    const tag = feed.tag;
    const outOfRange = page > pageCount;
    const filtered = tag !== null;
    const titleSuffix = paginationPageLabel(locale, page);
    const title =
      page > 1 && !outOfRange && head.title !== null
        ? `${head.title} — ${titleSuffix}`
        : head.title;

    let canonical = head.canonical;
    if (head.canonicalSource === "canonical_route" && canonical !== null) {
      try {
        const url = new URL(canonical);
        url.search = "";
        if (tag !== null) url.searchParams.set("tag", tag);
        if (page > 1) url.searchParams.set("page", String(page));
        canonical = url.toString();
      } catch {
        // Preserve a routing value that is not an absolute URL rather than
        // deriving a canonical from the request host.
      }
    }

    const appendSuffix = (value: string): string => `${value} — ${titleSuffix}`;
    const core_meta = head.core_meta.map((meta) => {
      if (meta.property === "og:url" && canonical !== null) return { ...meta, content: canonical };
      if (page <= 1 || outOfRange) return meta;
      if (meta.name === "description" || meta.name === "twitter:description") {
        return { ...meta, content: appendSuffix(meta.content) };
      }
      if (meta.property === "og:description")
        return { ...meta, content: appendSuffix(meta.content) };
      if (meta.property === "og:title" || meta.name === "twitter:title") {
        return { ...meta, content: appendSuffix(meta.content) };
      }
      return meta;
    });

    const json_ld =
      page <= 1 || outOfRange || canonical === null || title === null
        ? head.json_ld
        : head.json_ld.map((serialized) => {
            try {
              const document = JSON.parse(serialized) as Record<string, unknown>;
              if (!Array.isArray(document["@graph"])) return serialized;
              const graph = (document["@graph"] as unknown[]).map((node) => {
                if (typeof node !== "object" || node === null) return node;
                const value = node as Record<string, unknown>;
                return value["@type"] === "WebPage"
                  ? { ...value, "@id": `${canonical}#webpage`, name: title, url: canonical }
                  : value;
              });
              return serializeJsonLd({ ...document, "@graph": graph });
            } catch {
              return serialized;
            }
          });

    const robots =
      filtered || outOfRange
        ? [
            "noindex",
            ...new Set(
              (head.robots ?? "follow")
                .split(",")
                .map((directive) => directive.trim())
                .filter(
                  (directive) =>
                    directive !== "" && directive !== "index" && directive !== "noindex",
                ),
            ),
          ].join(", ")
        : head.robots;

    return { ...head, title, core_meta, canonical, json_ld, robots };
  }

  async function resolveCollectionFeedScope(
    key: string,
    binding: ThemeManifestCollection,
    stack: ThemeStack,
    context: {
      readonly selfEntryId: string;
      readonly contextLocale: string;
      readonly requestPath: string;
      readonly query: Record<string, unknown>;
    },
  ): Promise<unknown> {
    const options = readBindingFeedOptions(binding);
    const site = await application.routes.ensureSite(application.defaultSiteKey);
    // Browsable URLs degrade leniently (page=abc → 1); the REST surface is
    // the strict one and answers 400 for the same input.
    const rawTag = context.query.tag;
    const tag = typeof rawTag === "string" && rawTag !== "" ? rawTag.slice(0, 64) : null;
    const pageSize = binding.page_size ?? COLLECTION_DEFAULT_PAGE_SIZE;
    const rawPage = context.query.page;
    const page =
      typeof rawPage === "string" && /^[1-9]\d*$/.test(rawPage)
        ? Math.min(Number(rawPage), Math.floor(Number.MAX_SAFE_INTEGER / pageSize))
        : 1;
    const tagField = binding.tag_field ?? "tags";
    try {
      const feed = await queryCollectionFeed(
        {
          pool: application.pool,
          isKnownContentType: (key) => application.contentTypes.getLatestContentType(key) !== null,
        },
        {
          context: context.contextLocale,
          contentTypes: binding.content_types,
          sectionEntryId: options.scope === "site" ? null : context.selfEntryId,
          scope: options.scope,
          order: options.order,
          // The rendered page is not excluded implicitly: "site" is the whole
          // site, and a page that wants itself out names itself explicitly.
          siteId: site.id,
          tagField,
          tag,
          page,
          pageSize,
        },
      );
      // One batched projection for the whole page (no per-item reads).
      const cards = await cardsOf(
        feed.items,
        {
          fields: [],
          imageField: "hero_image",
          imagePreset: "card",
          tagField,
        },
        stack,
      );
      const items: CollectionFeedItem[] = cards.map((card, index) => {
        const row = feed.items[index];
        return {
          entry_id: card.entry_id,
          href: localizedRoutePath({
            locale: row?.route_locale ?? "x-default",
            path: row?.route_path ?? "/",
          }),
          title: card.title,
          description: card.description,
          teaser: card.note,
          date: card.published_at,
          tags: card.tags,
          image: card.image,
          image_alt: card.image_alt,
          fields: card.fields,
        };
      });
      return {
        key,
        items,
        total: feed.total,
        page: feed.page,
        page_size: feed.pageSize,
        page_count: feed.pageCount,
        tag,
        tags: feed.tags.map((facet) => ({
          ...facet,
          url: feedUrl(context.requestPath, 1, facet.tag),
          active: facet.tag === tag,
        })),
        tag_clear_url: feedUrl(context.requestPath, 1, null),
        prev_url: feed.page > 1 ? feedUrl(context.requestPath, feed.page - 1, tag) : null,
        next_url:
          feed.page < feed.pageCount ? feedUrl(context.requestPath, feed.page + 1, tag) : null,
        has_next: feed.page < feed.pageCount,
        has_prev: feed.page > 1,
      };
    } catch (error) {
      // A broken binding (unknown content type, transient DB issue) must not
      // take the page down; the REST surface answers the typed error for the
      // same key, and the log names the code.
      fastify.log.warn({ err: error, collection: key }, "render.collection_unresolved");
      return {
        key,
        items: [],
        total: 0,
        page,
        page_size: pageSize,
        page_count: 1,
        tag,
        tags: [],
        tag_clear_url: feedUrl(context.requestPath, 1, null),
        prev_url: null,
        next_url: null,
        has_next: false,
        has_prev: false,
      };
    }
  }

  async function collectionsScope(
    stack: ThemeStack,
    templateId: string,
    selfEntryId: string,
    contextLocale: string,
    requestPath: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const scope: Record<string, unknown> = {};
    for (const [key, binding] of Object.entries(stack.manifest.collections ?? {})) {
      if (!(binding.templates ?? []).includes(templateId)) continue;
      scope[key] = await resolveCollectionFeedScope(key, binding, stack, {
        selfEntryId,
        contextLocale,
        requestPath,
        query,
      });
    }
    return scope;
  }

  async function formsScope(
    blocksInDocument: unknown,
    activeLocale: string,
    additionalDefinitionIds: readonly string[] = [],
  ): Promise<Record<string, unknown>> {
    const scope: Record<string, unknown> = {};
    const definitionIds = new Set(additionalDefinitionIds.filter((id) => STABLE_ID_RE.test(id)));
    if (Array.isArray(blocksInDocument)) {
      for (const block of blocksInDocument as Record<string, unknown>[]) {
        if (block.type !== "form") continue;
        const id = (block.props as Record<string, unknown> | undefined)?.form_definition_id;
        if (typeof id === "string" && STABLE_ID_RE.test(id)) definitionIds.add(id);
      }
    }
    for (const id of definitionIds) {
      try {
        const definition = await application.formsSource.domain.definitions.getDefinition(id);
        if (definition.status !== "ACTIVE") continue;
        // Locale context (opt-in multilingual): definition.settings.localized
        // maps locale code → {title?, submit_label?, fields?{key→{label,help,placeholder}}}.
        // Base labels are the fallback; submissions still record the locale.
        const localized = (
          (definition.settings as Record<string, unknown> | undefined)?.localized as
            | Record<
                string,
                {
                  title?: string;
                  submit_label?: string;
                  fields?: Record<string, { label?: string; help?: string; placeholder?: string }>;
                }
              >
            | undefined
        )?.[activeLocale];
        const localizedField = (key: string) => localized?.fields?.[key] ?? {};
        scope[id] = {
          form_definition_id: definition.id,
          form_schema_version: definition.schema_version,
          title: localized?.title ?? definition.title,
          fields: definition.fields.map((field) => ({
            key: field.key,
            type: field.type,
            label: localizedField(field.key).label ?? field.label,
            required: field.required ?? false,
            ...(field.help === undefined && localizedField(field.key).help === undefined
              ? {}
              : { help: localizedField(field.key).help ?? field.help }),
            ...(field.max_length === undefined ? {} : { max_length: field.max_length }),
            ...(field.min === undefined ? {} : { min: field.min }),
            ...(field.max === undefined ? {} : { max: field.max }),
            ...((field.options === undefined
              ? {}
              : {
                  options: field.options.map((option) => ({
                    value: option.value,
                    label: option.label,
                  })),
                }) as object),
            ...(field.type === "hidden_controlled" ? { value: field.expected_value ?? "" } : {}),
          })),
          submission_url: `/api/v1/public/forms/${definition.id}/submit`,
          submit_label: localized?.submit_label ?? "Submit",
          ...(definition.settings.spam_policy?.honeypot_field === undefined
            ? {}
            : { honeypot_field: definition.settings.spam_policy.honeypot_field }),
        };
      } catch {
        // Unknown/archived definition → block renders its unavailable state.
      }
    }
    return scope;
  }

  function acceptsContentType(
    templateId: string,
    contentTypeKey: string,
    version: number,
  ): boolean {
    const manifestTemplate = activeStack.manifest.templates.find(
      (t: { id: string; accepts_content_types?: readonly string[] }) => t.id === templateId,
    );
    return (
      manifestTemplate?.accepts_content_types.some((supported) => {
        const [key, versionPart] = supported.split("@");
        return (
          key === contentTypeKey && (versionPart === undefined || Number(versionPart) === version)
        );
      }) ?? false
    );
  }

  function resolveTemplate(
    stack: ThemeStack,
    contentTypeKey: string,
    version: number,
    isHome: boolean,
    explicitKey: string | null = null,
  ): string | null {
    // Theme Contract §12: an explicit entry assignment is the source of truth
    // (compatibility is re-validated by the caller — no silent fallback).
    if (explicitKey !== null) return explicitKey;
    const accepts = (templateId: string): boolean =>
      acceptsContentType(templateId, contentTypeKey, version);
    // The homepage binding renders through the theme's `home` template when
    // the theme declares one; everything else takes the first accepting
    // template in manifest order (legacy entries without an assignment).
    if (isHome && accepts("home")) return "home";
    const accepting = stack.manifest.templates.filter((t) => accepts(t.id));
    return accepting[0]?.id ?? null;
  }

  /** Head fields a page render consumes. The live route resolves them from
   * the SEO subsystem; the preview render forces noindex and no canonical. */
  interface EntryHeadInput {
    readonly title: string | null;
    readonly core_meta: readonly {
      readonly name?: string;
      readonly property?: string;
      readonly content: string;
    }[];
    readonly canonical: string | null;
    readonly canonicalSource?: "canonical_override" | "canonical_route" | null;
    readonly alternates: readonly { readonly hreflang: string; readonly href: string }[];
    readonly robots: string | null;
    readonly json_ld: readonly string[];
    /** Resolved Site Identity favicon icons (Core149 favicon port). */
    readonly icons?: readonly {
      readonly rel: string;
      readonly href: string;
      readonly type?: string;
      readonly sizes?: string;
    }[];
  }

  interface EntryHtmlInput {
    readonly entry: {
      readonly id: string;
      readonly contentTypeId: string;
      readonly templateKey: string | null;
    };
    readonly contentType: { readonly version: number; readonly bodyPolicy: string };
    readonly revision: {
      readonly payload: unknown;
      readonly sidecar: unknown;
      readonly mediaVersions?: Readonly<Record<string, number>> | null;
    };
    readonly isHome: boolean;
    readonly requestPath: string;
    /** Raw request query — collection feeds read tag/page from it (§43). */
    readonly query: Record<string, unknown>;
    readonly publicationContext: string;
    readonly effectiveLocale: string;
    readonly localization: {
      readonly defaultLocale: string;
      readonly locales: readonly string[];
    };
    readonly head: EntryHeadInput;
  }

  /** Template resolution → block/body render → full page HTML. Shared by the
   * live route (published revision) and /preview/page (sealed draft revision
   * through a signed token) so the two surfaces cannot drift. Returns null
   * when no theme template accepts the entry — callers map that to their own
   * 404 shape (Theme Contract §12/§18: never a silent fallback template).
   * `stack` selects the rendering theme: active by default, a candidate
   * stack for theme previews (2026-10-01 site-developer request). */
  async function renderEntryHtml(
    input: EntryHtmlInput,
    stackOverride?: ThemeStack,
  ): Promise<string | null> {
    // No explicit override = the live ACTIVE surface: resolve the current
    // one (fingerprint-checked) instead of a boot-time snapshot.
    const stack = stackOverride ?? currentActiveStack();
    const requestSnapshot = requestTheme.getStore();
    if (requestSnapshot && stack.manifest.id !== requestSnapshot.stack.manifest.id)
      requestSnapshot.pinAssets = false;
    const { entry, contentType, revision } = input;
    // Shadow EVERY theme-scoped name from the CHOSEN stack — the outer
    // destructured consts belong to the ACTIVE theme and would leak its
    // tokens into candidate previews (0.1.130 regression).
    const { templates, blocks, renderService, themeSettings, tokensCss } = stack;
    // Effective template: the sealed snapshot (publication-safe — later
    // reassignments do not touch the live page), else the current assignment.
    const sidecarTemplate =
      typeof (revision.sidecar as Record<string, unknown> | null)?.template_key === "string"
        ? ((revision.sidecar as Record<string, unknown>).template_key as string)
        : null;
    const explicitTemplate = sidecarTemplate ?? entry.templateKey;
    const templateId = resolveTemplate(
      stack,
      entry.contentTypeId,
      contentType.version,
      input.isHome,
      explicitTemplate,
    );
    if (templateId === null) {
      // Rec 1 (152fz recommendations): a site-wide 404 outage with zero
      // diagnostics is unacceptable — warn once per process with the
      // identifying tuple so `journalctl` points at the version/theme drift.
      fastify.log.warn(
        {
          entry_id: entry.id,
          content_type: `${entry.contentTypeId}@${contentType.version}`,
          theme_id: stack.manifest.id ?? null,
        },
        "render.template_unresolved: no template in the active theme accepts this content type — public render will 404",
      );
      return null;
    }
    const acceptance = templates.checkAcceptance({
      templateId,
      contentTypeKey: entry.contentTypeId,
      contentTypeVersion: contentType.version,
      presentFields: Object.keys(
        (((revision.payload ?? {}) as { fields?: unknown }).fields as object) ?? {},
      ),
    });
    if (!acceptance.ok) return null;

    const payload = (revision.payload ?? {}) as {
      fields?: Record<string, unknown>;
      blocks?: unknown;
      body?: unknown;
    };
    const fields = payload.fields ?? {};
    const blockNodes = blockNodesOf(payload.blocks, application.blocks, (issues) =>
      fastify.log.warn({ issues }, "render.blocks_dropped"),
    );
    const forms = await formsScope(
      blockNodes,
      input.effectiveLocale,
      typeof themeSettings.lead_form_id === "string" ? [themeSettings.lead_form_id] : [],
    );

    const mediaIds = new Set<string>();
    collectBlockMediaIds(blockNodes, application, mediaIds);
    const fieldSchema = application.contentTypes.getLatestContentType(entry.contentTypeId)
      ?.fieldSchema.fields;
    if (fieldSchema !== undefined) collectFieldMediaIds(fields, fieldSchema, mediaIds);
    // Media-typed THEME SETTINGS are page media too (the long-noted schema
    // gap): hero-slide/collage/logo settings hold media ids that templates
    // resolve through media[<id>], so they join the media scope. Asset-path
    // values ("assets/img/…") are bundled theme files — not resolvable here.
    collectThemeMediaIds(stack, mediaIds);
    const media = await buildMediaScope(stack, mediaIds);

    // Registry admission (validation) is cross-theme; RENDER support is
    // per-theme. Skip top-level blocks this theme cannot render — one
    // candidate-variant block must not take the whole page down (2026-10-01
    // site-developer report: it 500'd into a masked 404).
    const renderable = blockNodes.filter(
      (node) => blocks.checkBlockSupport(node as never) === null,
    );
    if (renderable.length !== blockNodes.length) {
      fastify.log.warn(
        { dropped: blockNodes.length - renderable.length },
        "render.blocks_unsupported_by_theme",
      );
    }
    const imageSources = new Map<string, string>();
    const richTextIds = new Set<string>();
    mapEntryRichText(
      revision.payload,
      application.contentTypes.getLatestContentType(entry.contentTypeId)!,
      application.blocks,
      (document) => {
        for (const id of collectRichTextMediaIds(document)) richTextIds.add(id);
        return document;
      },
    );
    const richIds = [...richTextIds];
    for (let offset = 0; offset < richIds.length; offset += 500) {
      const assets = (
        await getAssetsByIds(application.pool, richIds.slice(offset, offset + 500))
      ).filter((asset) => asset.archivedAt === null && asset.kind === "image");
      const variants = await listVariantsForAssets(
        application.pool,
        assets.map((asset) => ({
          assetId: asset.id,
          versionNo: revision.mediaVersions?.[asset.id] ?? asset.currentVersionNo,
        })),
      );
      for (const image of variants) {
        if (image.presetId !== "richtext-v1" || imageSources.has(image.assetId)) continue;
        imageSources.set(
          image.assetId,
          variantPublicUrl({
            assetId: image.assetId,
            versionNo: image.versionNo,
            presetId: image.presetId,
            variantKey: image.variantKey,
            format: image.format,
          }),
        );
      }
    }
    const richTextOptions = { imageSource: (id: string) => imageSources.get(id) ?? null };
    const blocksHtml =
      contentType.bodyPolicy === "block_document"
        ? await blocks.renderBlockDocument(
            renderable as never,
            {
              media,
              richtext_image_sources: Object.fromEntries(imageSources),
              forms,
              quizzes: await quizzesScope(blockNodes),
              related_cards: await relatedCards(
                blockNodes,
                input.publicationContext,
                entry.id,
                stack,
              ),
            },
            {},
          )
        : "";
    // A body reaches the RichText renderer ONLY when it actually IS a RichText
    // document (CORE-RC19-BLOCKER-01). A `block_document` Content Type declares
    // `body` with FIELD TYPE `block_document` — legal content that the block
    // renderer above already handled — and a `{blocks: [], schema_version: 1}`
    // value there used to be pushed into renderRichText unconditionally, which
    // threw THEME_RICHTEXT_INVALID and turned the whole page into HTTP 500 on
    // RC18 (a RC9-era payload). The old comment claimed a top-level payload.body
    // needed "tolerance", but the tolerance must be shape-based, never
    // policy-blind: Block Document and RichText AST are independent formats and
    // neither may be decoded as the other.
    const richTextBody =
      contentType.bodyPolicy === "block_document" ? undefined : (payload.body ?? fields.body);
    // Pass the SafeHtml wrapper itself (not `.html`): the render engine keeps
    // autoescape on for plain strings, which would double-escape the fragment.
    // An absent/empty body is a valid state and renders as nothing — but a
    // PRESENT, non-empty body on a rich_text type still goes through the strict
    // renderer, so a document without `schema_version: 2` fails loudly exactly
    // as before rather than silently rendering an empty page.
    const bodyHtml =
      richTextBody === undefined || richTextBody === null || richTextBody === ""
        ? ""
        : renderRichText(richTextBody as never, richTextOptions);
    // EVERY declared rich_text field gets a `<field>_html` SafeHtml twin
    // (2026-09-29 site-developer report: non-body rich text printed the raw
    // AST — e.g. `solution` on cases). Templates read
    // `{{ entry.fields.solution_html }}` like body_html. The FIELD TYPE is the
    // contract here, so a declared `block_document` field is never handed to
    // the RichText renderer even when it sits on a rich_text-policy type.
    const richTextFieldHtml: Record<string, ReturnType<typeof renderRichText>> = {};
    const fieldSchemas = application.contentTypes.getLatestContentType(entry.contentTypeId)
      ?.fieldSchema.fields;
    for (const [fieldKey, field] of Object.entries(fieldSchemas ?? {})) {
      if (field.type !== "rich_text") continue;
      const value = fields[fieldKey];
      if (value === undefined || value === null || value === "") continue;
      // The SafeHtml OBJECT, not `.html`: stringifyOutput unescapes only
      // SafeHtml instances — a plain string would double-escape on output
      // (2026-09-29 prod bug: solution_html rendered as visible &lt;p&gt;).
      richTextFieldHtml[`${fieldKey}_html`] = renderRichText(value as never, richTextOptions);
    }

    const collections = await collectionsScope(
      stack,
      templateId,
      entry.id,
      input.publicationContext,
      input.requestPath,
      input.query,
    );
    const resolvedHead = paginatedHead(input.head, collections, input.effectiveLocale);
    const entryHeadView = {
      title: resolvedHead.title,
      core_meta: resolvedHead.core_meta,
      canonical: resolvedHead.canonical,
      alternates: resolvedHead.alternates,
      robots: resolvedHead.robots,
      json_ld: resolvedHead.json_ld,
      ...(input.head.icons === undefined ? {} : { icons: input.head.icons }),
      theme_slots: [],
    };
    const site = await application.routes.ensureSite(application.defaultSiteKey);
    const nav = await navigationScope(stack, input.publicationContext, site.homeEntryId);
    const breadcrumbs = await breadcrumbsScope(entry.id, input.publicationContext);
    const siteIdentity = await application.seoDiscovery.getSiteIdentity().catch(() => null);
    const html = await renderService.renderTemplate(
      templateId,
      {
        media,
        i18n: {
          active_locale: input.effectiveLocale,
          default_locale: input.localization.defaultLocale,
          locales: [...input.localization.locales],
          alternates: input.head.alternates,
        },
        site: {
          site_name: siteIdentity?.site_name ?? site.title,
          logo: null,
          contact: {},
          social: [],
        },
        entry: {
          id: entry.id,
          content_type_key: entry.contentTypeId,
          content_type_version: contentType.version,
          template_key: templateId,
          title: typeof fields.title === "string" ? fields.title : entry.id,
          fields: { ...fields, ...richTextFieldHtml },
          blocks: [],
        },
        blocks_html: blocksHtml,
        body_html: bodyHtml,
        breadcrumbs,
        nav,
        forms,
        collections,
        head: entryHeadView,
        head_html: headHtmlScope(entryHeadView),
        // SafeHtml: engine-generated trusted CSS. Plain-string autoescape
        // corrupts quoted font stacks (&#39;) and then no longer matches the
        // tokensStyleHash the CSP header allows.
        tokens_css: safeHtml(tokensCss()),
        theme_settings: themeSettings,
        request: { locale: input.effectiveLocale, path: input.requestPath },
      },
      {},
    );
    return withRichTextStyles(html);
  }

  async function renderReply(
    reply: FastifyReply,
    requestedEntryId: string,
    isHome: boolean,
    requestPath: string,
    requestLocale: string | null = null,
    requestQuery: Record<string, unknown> = {},
  ): Promise<FastifyReply> {
    // Opt-in multilingual: the request locale rides the existing publication
    // context axis (legacy "default" sentinel for the default locale). A
    // missing language version 404s — content is never served in a wrong
    // language under a locale URL. Single-language sites keep the exact
    // baseline flow (locale null → "default" context).
    const localization = await application.localization.get().catch(() => null);
    if (localization === null) return renderNotFound(reply, requestLocale ?? undefined);
    let entryId = requestedEntryId;
    if (isHome && requestLocale !== null && requestLocale !== localization.defaultLocale) {
      // The home binding is site-level (default locale); a locale-scoped
      // home request renders that locale's translation of the same logical
      // page — or 404s when it does not exist yet.
      const translation = await application.entries.findTranslation(
        entryId as never,
        requestLocale,
      );
      if (translation === null) return renderNotFound(reply, requestLocale);
      entryId = translation.id;
    }
    const publicationContext = await application.localization
      .contextFor(requestLocale)
      .catch(() => null);
    if (publicationContext === null) return renderNotFound(reply, requestLocale ?? undefined);
    const effectiveLocale = requestLocale ?? localization.defaultLocale;
    const revision = await application.pool.withTransaction((tx) =>
      application.publications.getPublishedRevision(
        tx,
        "entry",
        entryId as never,
        publicationContext,
      ),
    );
    if (revision === null) return renderNotFound(reply, requestLocale ?? undefined);
    const entry = await application.entries.findEntry(entryId as never);
    if (entry === null) return renderNotFound(reply, requestLocale ?? undefined);
    const contentType = application.contentTypes.getLatestContentType(entry.contentTypeId);
    if (contentType === null) return renderNotFound(reply, requestLocale ?? undefined);

    const liveFields = (((revision.payload ?? {}) as { fields?: unknown }).fields ?? {}) as Record<
      string,
      unknown
    >;
    const intro = plainText(liveFields.intro);
    // SEO head (M17 §43): title/description/canonical/robots/social compose
    // through the SEO subsystem's resolution chain instead of the pre-M17
    // stub (which emitted no canonical and no social tags). The preview
    // surface resolves the social image URL through the same ports the Admin
    // preview uses; environment guards still apply (dev → noindex).
    const seoPreview = await application.seoDiscovery
      .previewSeoFor(entry.id, {
        revisionId: revision.revisionId,
        openGraph: true,
        twitterCard: true,
        locale: effectiveLocale,
        // Public pages materialize the RESOLVED social image (explicit →
        // hero → site default) so og-v1 exists without a prior Admin visit.
        materializeSocial: true,
      })
      .catch(() => null);
    const site = await application.routes.ensureSite(application.defaultSiteKey);
    const alternates = await localeAlternates(entry.id, site.id, localization);
    // Ownership verification (2026-10-18 task B): provider meta tags ride the
    // core-protected head section of the PUBLIC HOME PAGE only — independent
    // of theme, analytics and consent; themes cannot fabricate or remove them.
    const verificationMeta =
      isHome === true
        ? await application.seoDiscovery.getSiteVerificationMeta().catch(() => [])
        : [];
    const html = await renderEntryHtml({
      entry,
      contentType,
      revision,
      isHome,
      requestPath,
      query: requestQuery,
      publicationContext,
      effectiveLocale,
      localization,
      head: {
        title:
          seoPreview?.head.title ??
          (typeof liveFields.title === "string" ? liveFields.title : null),
        core_meta: [
          ...(seoPreview?.head.core_meta ??
            (intro === "" ? [] : [{ name: "description", content: intro.slice(0, 300) }])),
          ...verificationMeta,
        ],
        canonical: seoPreview?.head.canonical ?? null,
        canonicalSource: seoPreview?.canonical.source ?? null,
        alternates: alternates.map((alternate) => ({
          hreflang: alternate.locale,
          href: alternate.url,
        })),
        icons: seoPreview?.head.icons ?? [],
        robots:
          seoPreview?.head.robots ??
          (application.seoEnvironment === "production" ? null : "noindex, nofollow"),
        json_ld: seoPreview?.head.json_ld ?? [],
      },
    });
    if (html === null) return renderNotFound(reply, requestLocale ?? undefined);
    // System document slots (ADR-0016): analytics rides public pages only.
    const injection = analyticsPageInjection(application, {
      pageId: entry.id,
      pageType: entry.contentTypeId,
      locale: effectiveLocale,
    });
    const pageHtml = applySystemSlots(html, injection);
    void reply.header("content-type", "text/html; charset=utf-8");
    void reply.header("cache-control", "no-cache");
    // Public-page security baseline (PCMS-OPS-T106): CSP composed from the
    // theme's validated assets.csp declaration (M17 §55 — the header was
    // defined but never applied to public HTML before M17), plus the hash of
    // the contract's own tokens injection point (see tokensStyleHash).
    for (const [header, value] of Object.entries(
      publicSecurityHeaders(
        currentActiveStack().manifest.assets?.csp,
        [currentActiveStack().tokensStyleHash()],
        injection === null
          ? undefined
          : {
              origins: injection.origins,
              scriptHashes: injection.scriptHashes,
              blobFrame: injection.blobFrame,
            },
      ),
    )) {
      void reply.header(header, value);
    }
    return reply.send(pageHtml);
  }

  async function renderNotFound(
    reply: FastifyReply,
    locale?: string,
    stack = activeStack,
    preview = false,
  ): Promise<FastifyReply> {
    const { manifest, renderService, themeSettings, tokensCss, tokensStyleHash } = stack;
    try {
      const templateId = manifest.templates.some((t) => t.id === "error-404") ? "error-404" : null;
      if (templateId === null) throw new Error("no error template");
      const effectiveLocale = locale ?? (await application.localization.get()).defaultLocale;
      const siteScope = await serviceSiteScope(stack, effectiveLocale);
      const mediaIds = new Set<string>();
      collectThemeMediaIds(stack, mediaIds);
      const injection = preview
        ? null
        : analyticsPageInjection(application, {
            pageId: "",
            pageType: "not_found",
            locale: effectiveLocale,
            isNotFound: true,
          } satisfies AnalyticsPageSurface);
      const notFoundHeadView = {
        title: "Page not found",
        core_meta: [],
        canonical: null,
        robots: preview ? "noindex, nofollow" : "noindex",
        json_ld: [],
        // Core-rendered surfaces without an entry still carry the Site
        // Identity favicon (owner tail 2026-10-03).
        icons: await application.seoDiscovery.siteFaviconIcons().catch(() => []),
        theme_slots: [],
      };
      const html = await renderService.renderTemplate(
        templateId,
        {
          ...siteScope,
          media: await buildMediaScope(stack, mediaIds),
          entry: {
            id: "",
            content_type_key: "page",
            content_type_version: 1,
            template_key: templateId,
            title: "Page not found",
            fields: { title: "Page not found" },
            blocks: [],
          },
          blocks_html: "",
          body_html: "",
          head: notFoundHeadView,
          head_html: headHtmlScope(notFoundHeadView),
          tokens_css: safeHtml(tokensCss()),
          theme_settings: themeSettings,
          request: { locale: effectiveLocale, path: "/" },
        },
        {},
      );
      void reply.header("content-type", "text/html; charset=utf-8");
      for (const [header, value] of Object.entries(
        publicSecurityHeaders(
          manifest.assets?.csp,
          [tokensStyleHash()],
          injection === null
            ? undefined
            : {
                origins: injection.origins,
                scriptHashes: injection.scriptHashes,
                blobFrame: injection.blobFrame,
              },
        ),
      )) {
        void reply.header(header, value);
      }
      if (preview)
        for (const [name, value] of Object.entries(PREVIEW_RESPONSE_HEADERS))
          void reply.header(name, value);
      // Public 404 carries analytics; the preview shape never does (§2).
      const sendHtml = preview || injection === null ? html : applySystemSlots(html, injection);
      return reply.status(404).send(sendHtml);
    } catch {
      void reply.header("content-type", "text/plain; charset=utf-8");
      return reply.status(404).send("404");
    }
  }

  function searchTheme(stack: ThemeStack, preview = false) {
    const { manifest, renderService, themeSettings, tokensCss, tokensStyleHash } = stack;
    return {
      headers: publicSecurityHeaders(manifest.assets?.csp, [tokensStyleHash()]),
      async render(search: import("@pcms/themes").SearchResultPageViewModel) {
        const component = manifest.components.find((c) => c.id === "search-result");
        if (!renderService.hasTemplate("search") && component === undefined) return null;
        const metadata = await application.searchResultMetadata(search.items);
        const items = search.items.flatMap((item) => {
          const data = metadata[item.revision_id];
          return data === undefined ? [] : [{ ...item, ...data }];
        });
        const mediaIds = new Set<string>();
        for (const item of items) {
          const schema =
            item.content_type === null
              ? undefined
              : application.contentTypes.getLatestContentType(item.content_type)?.fieldSchema
                  .fields;
          if (schema !== undefined) collectFieldMediaIds(item.fields, schema, mediaIds);
        }
        collectThemeMediaIds(stack, mediaIds);
        const media = await buildMediaScope(stack, mediaIds);
        const siteScope = await serviceSiteScope(stack, search.locale);
        const searchHeadView = {
          title: "Search",
          core_meta: [],
          canonical: null,
          alternates: [],
          robots: preview ? "noindex, nofollow" : "noindex, follow",
          json_ld: [],
          // The system route is a core-rendered surface without an entry —
          // the Site Identity favicon belongs here exactly like on pages.
          icons: await application.seoDiscovery.siteFaviconIcons().catch(() => []),
          theme_slots: [],
        };
        const scope = {
          search: { ...search, items },
          media,
          ...siteScope,
          forms: await formsScope(
            [],
            search.locale,
            typeof themeSettings.lead_form_id === "string" ? [themeSettings.lead_form_id] : [],
          ),
          quizzes: {},
          blocks_html: "",
          body_html: "",
          entry: { id: "", title: "Search", fields: {}, blocks: [] },
          head: searchHeadView,
          head_html: headHtmlScope(searchHeadView),
          tokens_css: safeHtml(tokensCss()),
          theme_settings: themeSettings,
          request: { locale: search.locale, path: "/search/" },
        };
        if (renderService.hasTemplate("search"))
          return renderService.renderTemplate("search", scope);
        return component === undefined
          ? null
          : wrapSearchPage(
              await renderService.renderComponent(component.file, scope),
              preview,
              searchHeadView.icons,
            );
      },
    };
  }
  // Search rides the CURRENT active stack too (the wrapper re-resolves per
  // request, so a refreshed theme applies to search without a restart).
  registerSearchPageRoute(fastify, {
    application,
    theme: {
      get headers() {
        return searchTheme(currentActiveStack()).headers;
      },
      render: async (search: import("@pcms/themes").SearchResultPageViewModel) =>
        searchTheme(currentActiveStack()).render(search),
    },
  });

  // Preview page render (API spec §47/§48): the signed token IS the
  // credential; GET /preview stays the JSON state transport, this surface
  // renders the SEALED draft revision through the site theme so Admin's
  // "preview" shows the page, not the state document. Never a public route,
  // never indexable (PREVIEW_RESPONSE_HEADERS + forced robots noindex).
  fastify.get("/preview/page", async (request: FastifyRequest, reply: FastifyReply) => {
    for (const [name, value] of Object.entries(PREVIEW_RESPONSE_HEADERS)) {
      void reply.header(name, value);
    }
    const fail = (status: number, code: string, message: string) => {
      void reply.status(status).send({ error: { code, message } });
      return reply;
    };
    if (application.previewTokens === null) {
      return fail(503, "PREVIEW_SECRET_MISSING", "preview signing is not configured");
    }
    const query = request.query as { token?: unknown };
    if (typeof query.token !== "string" || query.token.length === 0) {
      return fail(400, "PREVIEW_TOKEN_INVALID", "preview token is required");
    }
    const verified = application.previewTokens.verify(query.token);
    if (!verified.ok) {
      return fail(404, verified.reason, "preview token rejected");
    }
    if (
      verified.ref.kind !== "service" &&
      (verified.ref.kind !== "revision" || verified.ref.entityType !== "entry")
    ) {
      return fail(
        400,
        "PREVIEW_RENDER_UNSUPPORTED",
        "only a sealed entry revision has a page preview (changeset previews expose /preview state JSON)",
      );
    }
    try {
      // Draft tokens (allow_draft at issue time) render WORKING revisions —
      // the edit→look→edit loop (2026-09-29 site-developer report: the JSON
      // state honored drafts but the page render still demanded SEALED).
      // Candidate theme render (2026-10-01 site-developer request): the
      // signed token names an installed theme; its stack builds lazily and
      // read-only — active theme, settings, renderDir and publications are
      // never touched, no restart involved.
      let stack = currentActiveStack();
      if (verified.theme !== undefined && verified.theme !== currentActiveStack().manifest.id) {
        const candidate = candidateStack(verified.theme);
        if (candidate === null) {
          return fail(404, "PREVIEW_THEME_INVALID", "preview theme is not installed or invalid");
        }
        stack = candidate;
      }
      if (verified.ref.kind === "service") {
        const locale = verified.ref.locale ?? (await application.localization.get()).defaultLocale;
        await application.localization.contextFor(locale);
        if (verified.ref.template === "error-404") {
          if (!stack.renderService.hasTemplate("error-404"))
            return fail(409, "PREVIEW_RENDER_UNAVAILABLE", "theme has no error-404 template");
          return renderNotFound(reply, locale, stack, true);
        }
        if (verified.ref.template !== "search")
          return fail(400, "PREVIEW_RENDER_UNSUPPORTED", "unknown service template");
        if (
          !stack.renderService.hasTemplate("search") &&
          !stack.manifest.components.some((component) => component.id === "search-result")
        )
          return fail(409, "PREVIEW_RENDER_UNAVAILABLE", "theme has no search template");
        await createSearchPageHandler({
          application,
          theme: searchTheme(stack, true),
          preview: true,
          locale,
        })(request, reply);
        return reply;
      }
      const state = await application.pool.withTransaction((executor) =>
        application.previewState.resolve(executor, verified.ref, { draft: verified.draft }),
      );
      const entity = state.entities.find(
        (candidate) => candidate.entityType === "entry" && candidate.revision !== null,
      );
      if (entity === undefined || entity.revision === null) {
        return fail(
          409,
          verified.draft ? "PREVIEW_TARGET_MISSING" : "REVISION_NOT_SEALED",
          verified.draft ? "preview target does not exist" : "preview target is not sealed",
        );
      }
      const entry = await application.entries.findEntry(entity.entityId as never);
      if (entry === null)
        return fail(404, "PREVIEW_TOKEN_INVALID", "preview target does not exist");
      const contentType = application.contentTypes.getLatestContentType(entry.contentTypeId);
      if (contentType === null) {
        return fail(404, "PREVIEW_TOKEN_INVALID", "preview target does not exist");
      }
      const localization = await application.localization.get().catch(() => null);
      if (localization === null) {
        return fail(404, "PREVIEW_TOKEN_INVALID", "preview target does not exist");
      }
      const publicationContext =
        entity.context === "default"
          ? "default"
          : await application.localization.contextFor(entity.context);
      const effectiveLocale =
        entity.context === "default" ? localization.defaultLocale : entity.context;
      const fields = (((entity.revision.payload ?? {}) as { fields?: unknown }).fields ??
        {}) as Record<string, unknown>;
      const intro = plainText(fields.intro);
      const site = await application.routes.ensureSite(application.defaultSiteKey);
      const seoPreview = await application.seoDiscovery.previewSeoFor(entry.id, {
        revisionId: entity.revision.revisionId,
        locale: effectiveLocale,
        openGraph: true,
        twitterCard: true,
        materializeSocial: true,
      });
      const html = await renderEntryHtml(
        {
          entry,
          contentType,
          revision: entity.revision,
          isHome: site.homeEntryId === entry.id,
          requestPath: "/",
          query: request.query as Record<string, unknown>,
          publicationContext,
          effectiveLocale,
          localization,
          head: {
            title:
              seoPreview?.head.title ?? (typeof fields.title === "string" ? fields.title : null),
            core_meta:
              seoPreview?.head.core_meta ??
              (intro === "" ? [] : [{ name: "description", content: intro.slice(0, 300) }]),
            canonical: null,
            alternates: [],
            icons: seoPreview?.head.icons ?? [],
            robots: "noindex, nofollow",
            json_ld: seoPreview?.head.json_ld ?? [],
          },
        },
        stack,
      );
      if (html === null) {
        return fail(409, "PREVIEW_RENDER_UNAVAILABLE", "no theme template accepts this entry");
      }
      void reply.header("content-type", "text/html; charset=utf-8");
      // CSP follows the RENDERING theme: a candidate preview carries the
      // candidate's policy and its own tokens style hash.
      for (const [header, value] of Object.entries(
        publicSecurityHeaders(stack.manifest.assets?.csp, [stack.tokensStyleHash()]),
      )) {
        void reply.header(header, value);
      }
      for (const [name, value] of Object.entries(PREVIEW_RESPONSE_HEADERS))
        void reply.header(name, value);
      return reply.send(html);
    } catch (error) {
      // The masked 404 hid real render causes from the site developer
      // (2026-10-01 report): keep the response contract, log the cause.
      fastify.log.error(error, "preview.render_failed");
      const code = (error as { code?: string }).code;
      if (code === "REVISION_NOT_SEALED" || code === "CHANGESET_INVALID") {
        return fail(409, code, error instanceof Error ? error.message : "preview state invalid");
      }
      return fail(404, "PREVIEW_TOKEN_INVALID", "preview target does not exist");
    }
  });

  // ---- Extension HTTP dispatch (CORE-SHOP-01 P0-b/P0-c; ADR-0018) --------
  // Core Routing owns extension public URLs: the operator-assigned mount
  // (+ the /x/<id> technical mirror). Views render through the Theme
  // renderer only: theme override -> package base template -> named 503
  // (never a handler-supplied HTML, never a fake 404).
  async function renderExtensionView(
    result: Extract<
      Awaited<ReturnType<ApplicationServices["extensionHttp"]["dispatch"]>>,
      { kind: "view" }
    >,
    reply: FastifyReply,
    request: FastifyRequest,
  ): Promise<FastifyReply> {
    try {
      return await renderExtensionViewInner(result, reply, request);
    } catch (error) {
      fastify.log.error(
        { err: error, view: result.response.view_id },
        "render.extension_view_failed",
      );
      void reply.header("content-type", "application/json; charset=utf-8");
      return reply.status(500).send({
        error: {
          code: "EXTENSION_VIEW_RENDER_FAILED",
          message:
            process.env.NODE_ENV === "production"
              ? "extension view render failed"
              : `extension view render failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }

  async function renderExtensionViewInner(
    result: Extract<
      Awaited<ReturnType<ApplicationServices["extensionHttp"]["dispatch"]>>,
      { kind: "view" }
    >,
    reply: FastifyReply,
    request: FastifyRequest,
  ): Promise<FastifyReply> {
    const stack = currentActiveStack();
    const major = result.view.schemaVersion.split(".")[0] ?? "1";
    const viewKey = `${result.response.view_id}@${major}`;
    // The route resolver supplies a secondary locale or the site's default.
    const siteRecord = await application.routes
      .ensureSite(application.defaultSiteKey)
      .catch(() => null);
    const localizationSettings = await application.localization.get().catch(() => null);
    const viewLocale =
      result.view.locale ??
      localizationSettings?.defaultLocale ??
      siteRecord?.defaultLocale ??
      "x-default";
    const mediaScope = await buildMediaScope(stack, new Set(result.response.media_ids ?? []));
    // Site scope is best-effort: a stale or disabled locale degrades to the
    // minimal default scope rather than failing the public page.
    let siteScope: Record<string, unknown>;
    try {
      siteScope = await serviceSiteScope(stack, viewLocale);
    } catch {
      siteScope = {
        site: { title: siteRecord?.title ?? "", default_locale: viewLocale },
        localization: null,
      };
    }
    // Canonical URL policy (CORE-SHOP-SEO-01): the canonical URL comes from
    // Core Routing (active mount + route path + primary origin) — the
    // handler cannot supply a diverging canonical.
    const canonicalUrl = result.view.canonicalUrl ?? result.view.canonicalPath;
    const headView = {
      title: result.response.head.title ?? null,
      core_meta: [] as { name: string; content: string }[],
      canonical: canonicalUrl,
      alternates: [] as never[],
      robots: result.response.head.robots ?? null,
      json_ld: (result.response.head.json_ld ?? []) as never[],
      icons: await application.seoDiscovery.siteFaviconIcons().catch(() => []),
      theme_slots: [],
    };
    const scope = {
      view: result.response.model,
      head: headView,
      head_html: headHtmlScope(headView),
      media: mediaScope,
      ...siteScope,
      tokens_css: safeHtml(stack.tokensCss()),
      theme_settings: stack.themeSettings,
      request: { locale: viewLocale, path: new URL(request.url, "http://local").pathname },
    };
    let contentHtml: string;
    // (1) theme override
    const themeTemplate = stack.manifest.templates.find((candidate) =>
      (candidate.accepts_views ?? []).includes(viewKey),
    );
    if (themeTemplate !== undefined && stack.renderService.hasTemplate(themeTemplate.id)) {
      contentHtml = await stack.renderService.renderTemplate(themeTemplate.id, scope, {
        componentId: viewKey,
      });
    } else {
      // (2) package base template — the SAME hardened engine. Like a theme
      // override, it produces content only; the active theme owns the page
      // layout so extension views never duplicate site chrome.
      try {
        const source = readFileSync(
          join(process.cwd(), result.view.extensionsDir, result.view.baseTemplate),
          "utf8",
        );
        const engine = createThemeEngine({ templates: { __extension_view__: source } });
        contentHtml = await engine.renderFile("__extension_view__", scope);
      } catch (error) {
        // (3) named diagnostic — NEVER a fake 404 (R2)
        fastify.log.warn(
          {
            extension_id: result.extensionId,
            view: viewKey,
            theme_id: stack.manifest.id ?? null,
            err: error,
          },
          "render.extension_view_template_missing",
        );
        const body = `<!doctype html><html><body><h1>503</h1><p>Extension view template is unavailable: ${viewKey}</p></body></html>`;
        void reply.header("content-type", "text/html; charset=utf-8");
        void reply.header("cache-control", "no-store");
        for (const [header, value] of Object.entries(
          publicSecurityHeaders(stack.manifest.assets?.csp, [stack.tokensStyleHash()]),
        )) {
          void reply.header(header, value);
        }
        return reply.status(503).send(body);
      }
    }
    const layoutId = stack.manifest.layout?.default;
    const html =
      layoutId !== undefined
        ? await stack.components.renderComponent(
            layoutId,
            { ...scope, content_html: safeHtml(contentHtml) },
            { componentId: viewKey },
          )
        : `<!doctype html><html><head>${headHtmlScope(headView).html}</head>` +
          `<body><main id="main">${contentHtml}</main></body></html>`;
    const injection = analyticsPageInjection(application, {
      pageId: viewKey,
      pageType: "extension_view",
      locale: viewLocale,
    });
    const pageHtml = applySystemSlots(html, injection);
    void reply.header("content-type", "text/html; charset=utf-8");
    void reply.header("cache-control", "no-cache");
    for (const [header, value] of Object.entries(
      publicSecurityHeaders(stack.manifest.assets?.csp, [stack.tokensStyleHash()]),
    )) {
      void reply.header(header, value);
    }
    return reply.status(200).send(pageHtml);
  }

  async function tryExtensionDispatch(
    request: FastifyRequest,
    reply: FastifyReply,
    scope?: { readonly path: string; readonly locale?: string },
  ): Promise<boolean> {
    const path = scope?.path ?? new URL(request.url, "http://local").pathname;
    const cookieSecure = application.environmentClassification === "production";
    const auth = await authenticateRequest(application, request, { cookieSecure }).catch(
      () => null,
    );
    const ctx: OperationContext | null =
      auth === null
        ? null
        : {
            actor: auth.actor,
            transport: "rest",
            requestId: request.id === undefined ? "req_web" : String(request.id),
          };
    // PREPUBLIC §5: transport facts for public mutations and the server-issued guest cookie.
    const rawHeaders = request.headers;
    const header = (name: string): string | undefined => {
      const value = rawHeaders[name];
      return typeof value === "string" ? value : undefined;
    };
    const result = await application.extensionHttp.dispatch(
      application,
      {
        path,
        method: request.method,
        query: (request.query ?? {}) as Record<string, string | string[]>,
        ...(scope?.locale === undefined ? {} : { locale: scope.locale }),
        body: request.body,
        mutation: {
          host: header("host") ?? "",
          ip: request.ip ?? "0.0.0.0",
          headers: {
            origin: header("origin"),
            referer: header("referer"),
            cookie: header("cookie"),
            "idempotency-key": header("idempotency-key"),
          },
        },
      },
      ctx,
    );
    if (result.kind !== "miss" && result.setCookie !== undefined) {
      void reply.header("set-cookie", result.setCookie);
    }
    switch (result.kind) {
      case "miss":
        return false;
      case "view":
        await renderExtensionView(result, reply, request);
        return true;
      case "json":
        void reply.header("content-type", "application/json; charset=utf-8");
        void reply.header("cache-control", "no-cache");
        await reply.status(result.status).send(result.body);
        return true;
      case "redirect":
        await reply.redirect(result.location, result.status);
        return true;
      case "failure":
        void reply.header("content-type", "application/json; charset=utf-8");
        await reply
          .status(result.status)
          .send({ error: { code: result.code, message: result.message } });
        return true;
    }
  }

  fastify.get("/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = new URL(request.url, "http://local").pathname;
    const localePrefix = await application.localization.peelPrefix(path).catch(() => null);
    const extensionScope: { readonly path: string; readonly locale?: string } =
      localePrefix === null ? { path } : localePrefix;
    const extensionPath = extensionScope.path;
    // Extension dispatch (ADR-0018): technical /x/<id> space and active
    // mounts; a miss falls through to normal site routing below.
    if (
      extensionPath.startsWith("/x/") ||
      (await extensionMountPrefixHit(application, extensionPath))
    ) {
      const mountRedirect = await extensionMountRedirect(
        application,
        extensionPath,
        extensionScope.locale,
      ).catch(() => null);
      if (mountRedirect !== null && mountRedirect.location !== path) {
        void reply.header("cache-control", "public, max-age=3600");
        return reply.redirect(mountRedirect.location, mountRedirect.status);
      }
      try {
        if (await tryExtensionDispatch(request, reply, extensionScope)) return reply;
      } catch (error) {
        request.log.error({ err: error }, "extension.dispatch_failed");
        void reply.header("content-type", "application/json; charset=utf-8");
        return reply.status(500).send({
          error: { code: "EXTENSION_DISPATCH_FAILED", message: "extension dispatch failed" },
        });
      }
    }
    // IndexNow verification key (spec §5.3): system route, checked before
    // content routing; only the EXACT active key of an ENABLED site answers.
    // Everything else (any other *.txt) falls through to normal routing.
    const keyMatch = /^\/([0-9a-f]{64})\.txt$/.exec(path);
    if (keyMatch !== null) {
      const { enabled, key } = await application.indexNow.cachedEnabledKey();
      if (enabled && key !== null && keyMatch[1] === key) {
        void reply.header("content-type", "text/plain; charset=utf-8");
        void reply.header("x-content-type-options", "nosniff");
        void reply.header("cache-control", "no-store");
        return reply.send(`${key}\n`);
      }
    }
    // Ownership-verification root files (2026-10-18 task B): exact provider
    // filenames stored in site identity answer anonymously with their exact
    // validated body — no theme/analytics wrapper, no slash/locale/canonical
    // redirect. Anything else at .html falls through to normal routing (404).
    const proofMatch = /^\/([a-z0-9_]+\.html)$/.exec(path);
    if (proofMatch !== null) {
      const proofs = await application.seoDiscovery.getOwnershipProofFiles().catch(() => []);
      const proof = proofs.find((candidate) => candidate.filename === proofMatch[1]);
      if (proof !== undefined) {
        void reply.header("content-type", "text/html; charset=utf-8");
        void reply.header("x-content-type-options", "nosniff");
        void reply.header("cache-control", "no-store");
        return reply.send(proof.body);
      }
    }
    try {
      const resolution = await application.requestResolver.resolve({ path });
      switch (resolution.kind) {
        case "home":
          return await renderReply(
            reply,
            resolution.entryId,
            true,
            path,
            resolution.locale ?? null,
            request.query as Record<string, unknown>,
          );
        case "route":
          if (resolution.route.targetType !== "entry") break;
          return await renderReply(
            reply,
            resolution.route.targetId,
            false,
            path,
            resolution.locale ?? null,
            request.query as Record<string, unknown>,
          );
        case "redirect":
          return reply.redirect(resolution.location, resolution.statusCode);
        default:
          break;
      }
      const locale = (await application.localization.peelPrefix(path))?.locale;
      return await renderNotFound(reply, locale);
    } catch (error) {
      request.log.error({ err: error }, "site.render_failed");
      void reply.header("content-type", "text/plain; charset=utf-8");
      return reply.status(500).send("site render failed");
    }
  });

  // Non-GET extension routes (session/admin mutations): dispatch-only.
  for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
    fastify.route({
      method,
      url: "/*",
      async handler(request: FastifyRequest, reply: FastifyReply) {
        const path = new URL(request.url, "http://local").pathname;
        const localePrefix = await application.localization.peelPrefix(path).catch(() => null);
        const extensionScope: { readonly path: string; readonly locale?: string } =
          localePrefix === null ? { path } : localePrefix;
        if (await tryExtensionDispatch(request, reply, extensionScope)) return reply;
        void reply.header("content-type", "application/json; charset=utf-8");
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "no such route" } });
      },
    });
  }
}
