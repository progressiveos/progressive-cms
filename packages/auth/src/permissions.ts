// Permission registry + built-in role bundles (PCMS-AUTH-T015/T016;
// Auth spec §38–§47, Forms spec §34, Integrations spec §41, ADR-0005).
//
// Permissions are stable, versioned machine keys. Authorization always
// resolves through this registry: a key that is not registered can never be
// granted or checked (default deny, fail-secure). Minor releases may ADD
// keys; existing custom roles never gain a new key implicitly — they keep
// their stored explicit set (spec §47).
//
// M08 registers permission semantics only. The business operations behind
// content/media/forms/integrations/payments belong to their owning
// milestones; this registry is the contract their enforcement will call.

export interface PermissionDefinition {
  readonly key: string;
  /** Release that introduced the key (semver string). */
  readonly since: "1.0";
  readonly summary: string;
}

function def(key: string, summary: string): PermissionDefinition {
  return { key, since: "1.0", summary };
}

/**
 * The authoritative v1 registry. Grouped by subsystem; keys are sorted
 * alphabetically inside each group for reviewability. Adding a key is a
 * registry append + tests; renaming/removing one is a breaking change and
 * requires an ADR (spec §47).
 */
export const PERMISSION_REGISTRY: readonly PermissionDefinition[] = [
  // Content
  def("content.read", "Read content entries and drafts"),
  def("content.create", "Create content entries"),
  def("content.edit", "Edit content entries"),
  def("content.archive", "Archive content entries"),
  def("preview.create", "Create previews of unpublished content"),
  def("content_schema.read", "Read content type definitions"),
  def("content_schema.propose", "Propose content type schema changes"),
  def("content_schema.apply", "Apply content type schema changes"),

  // Media
  def("media.read", "Read media assets"),
  def("media.write", "Upload and edit media assets"),
  def("media.replace", "Replace media asset binaries"),
  def("media.archive", "Archive media assets"),
  def("media.import", "Import media from external sources"),
  // Media acquisition providers (ADR-0013): credential management is
  // deliberately separate from the agent-reachable acquisition operations.
  def("media.providers.manage", "Configure and test media acquisition providers"),
  def("media.stock.search", "Search stock media providers"),
  def("media.stock.import", "Import stock media candidates into the library"),
  def("media.generate", "Run image generation and accept candidates"),

  // Web Research (ADR-0015): external SERP discovery + safe public-Web fetch
  // for clean LLM agents. Deliberately a separate bounded context from the
  // internal site Search; provider/network configuration stays with humans.
  def("research.search", "Search the external Web through the configured research provider"),
  def("research.fetch", "Fetch public Web pages through the safe research fetcher"),
  def("research.manage", "Configure the Web Research provider, network policy and limits"),

  // Navigation
  def("navigation.read", "Read navigation sets"),
  def("navigation.edit", "Edit navigation sets"),
  def("navigation.publish", "Publish navigation sets"),

  // Routing / site migrations: bulk legacy-URL redirect imports carry SEO
  // consequences site-wide (spec §33/§60) — deliberately its own scope, not
  // folded into content or domains.
  def("routing.redirects.import", "Bulk-import legacy URL redirects for site migrations"),

  // Community skills lifecycle (install/disable/uninstall .pcskill
  // packages) — operator domain, OWNER-only by default: installing a skill
  // changes what agents read as instructions.
  def("skills.manage", "Install, enable/disable and remove community skill packages"),

  // Analytics & tagging (ADR-0016): network scope is separate because it
  // changes which third-party origins the site may load (spec §7).
  def("analytics.read", "Read analytics & tagging settings and doctor reports"),
  def("analytics.manage", "Configure analytics providers (providers are typed; no code surfaces)"),
  def("analytics.network.manage", "Edit external tag network origin permissions"),

  // SEO
  def("seo.read", "Read SEO metadata"),
  def("seo.edit", "Edit SEO metadata"),
  def("seo.validate", "Run SEO validation"),
  def("seo.canonical_override", "Override canonical URLs"),
  def("seo.site_settings", "Manage site-wide SEO settings"),

  // Publication / Revisions
  def("publication.read", "Read revisions and publication state"),
  def("revision.seal", "Seal revisions"),
  def("publication.plan", "Create publication plans/ChangeSets"),
  def("publication.schedule", "Schedule publications"),
  def("publication.publish", "Publish revisions to the live site"),
  def("publication.unpublish", "Unpublish live content"),
  def("publication.rollback", "Roll back publications"),

  // Themes
  def("theme.read", "Read theme sources and configuration"),
  def("theme.write", "Edit theme sources and configuration"),
  def("theme.validate", "Validate themes"),
  def("theme.preview", "Render theme previews"),
  def("theme.activate", "Activate a theme for the site"),

  // Users, roles, tokens
  def("users.read", "List and inspect admin users"),
  def("users.manage", "Create, invite, disable and reset users"),
  def("roles.read", "List roles and their permissions"),
  def("roles.manage", "Assign roles and manage custom roles"),
  def("tokens.manage", "Manage service accounts and access tokens"),

  // Extensions & site
  def("extensions.manage", "Install, update and remove extensions"),
  def("site.configure", "Change site settings"),
  def("site.validate", "Run site-wide validation"),
  // Site maintenance (M15, task brief §19–§34): toggle is separate from the
  // bypass — seeing the closed site is a deliberately narrower grant than
  // switching it off.
  def("site.maintenance", "Toggle maintenance mode and edit its settings"),
  def("site.maintenance.bypass", "View the real site while maintenance mode is enabled"),
  def("domains.manage", "Manage site domains"),
  def("embed.trusted", "Embed trusted external content"),

  // Audit
  def("audit.read", "Read audit and security events"),

  // Search (M11; Search spec §25)
  def("search.admin", "Use authorized admin search across content, media and navigation"),
  def("search.reindex", "Start and resume full search index rebuilds"),
  def("search.diagnostics", "Read search index status and diagnostics"),

  // Forms & Quizzes (definitions only for editors/agents; M12 owns the ops)
  def("forms.read_definition", "Read form definitions"),
  def("forms.manage_definition", "Create and edit form definitions"),
  def("quizzes.read_definition", "Read quiz definitions"),
  def("quizzes.manage_definition", "Create and edit quiz definitions"),

  // Interactions & Leads (PII boundary, ADR-0005)
  def("interactions.read", "Read interaction events"),
  def("interactions.manage", "Manage interaction records"),
  def("interactions.export", "Export interaction data"),
  def("privacy.manage", "Preview and execute addressed personal-data operations"),
  def("leads.read", "Read lead records (PII)"),
  def("leads.manage", "Manage lead records"),
  def("leads.export", "Export lead data (PII)"),

  // Integrations (ADR-0005)
  def("integrations.read", "Read integration catalog and status"),
  def("integrations.configure", "Configure integrations"),
  def("integrations.test", "Run integration test deliveries"),
  def("integrations.deliveries.read", "Read integration delivery logs"),
  def("integrations.retry", "Retry failed deliveries"),
  def("integrations.inbound.read", "Read inbound integration payloads"),
  def("integrations.secrets.manage", "Manage connector secrets"),

  // Payments (ADR-0005)
  def("payments.read", "Read payments"),
  def("payments.create", "Create payments"),
  def("payments.configure", "Configure payment providers"),
  def("payments.cancel", "Cancel payments"),
  def("payments.refund", "Refund payments"),
  def("payments.events.read", "Read payment events"),
];

const REGISTERED: ReadonlyMap<string, PermissionDefinition> = new Map(
  PERMISSION_REGISTRY.map((definition) => [definition.key, definition]),
);

/** True when the key is part of the versioned registry. */
export function isRegisteredPermission(key: string): boolean {
  return REGISTERED.has(key) || EXTENSION_REGISTERED.has(key);
}

export function permissionDefinition(key: string): PermissionDefinition | undefined {
  return REGISTERED.get(key) ?? EXTENSION_REGISTERED.get(key);
}

/**
 * Extension-declared permission keys (ADR-0017 R1). A trusted first-party
 * package with `permission_namespace` in its manifest may bring its OWN
 * `<namespace>.*` keys: composition registers them here after the namespace/
 * collision validation, so enforcement, token grants and agent scopes see
 * one registry. Platform keys stay in PERMISSION_REGISTRY only; existing
 * roles/service accounts NEVER gain extension keys implicitly — granting is
 * an explicit operator action against a now-registered key.
 */
const EXTENSION_REGISTERED = new Map<string, PermissionDefinition>();

/**
 * Registers extension-declared keys (composition-time; every process runs it
 * before boot completes, so the map is deterministic per composition).
 * Fails closed on duplicates and on platform-registry collisions.
 */
export function registerExtensionPermissions(
  entries: readonly { readonly key: string; readonly summary: string }[],
): void {
  for (const entry of entries) {
    if (REGISTERED.has(entry.key)) {
      throw new Error(`extension permission "${entry.key}" collides with a platform registry key`);
    }
    if (EXTENSION_REGISTERED.has(entry.key)) {
      throw new Error(`extension permission "${entry.key}" declared by more than one package`);
    }
    if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(entry.key)) {
      throw new Error(`extension permission key "${entry.key}" is malformed`);
    }
    EXTENSION_REGISTERED.set(entry.key, { key: entry.key, since: "1.0", summary: entry.summary });
  }
}

/** Test seam: drop every extension-declared key (platform keys untouched). */
export function resetExtensionPermissionsForTests(): void {
  EXTENSION_REGISTERED.clear();
}

/** v1 built-in roles (spec §39). Bundles are code-defined immutable templates. */
export const BUILTIN_ROLE_KEYS = ["OWNER", "ADMIN", "DEVELOPER", "EDITOR", "AUTHOR"] as const;
export type BuiltinRoleKey = (typeof BUILTIN_ROLE_KEYS)[number];

function bundle(...keys: string[]): readonly string[] {
  for (const key of keys) {
    if (!REGISTERED.has(key)) {
      // Fail-secure: a typo in a built-in bundle must fail loudly in tests,
      // not silently grant an unregistered key.
      throw new Error(`built-in role bundle references unregistered permission "${key}"`);
    }
  }
  return keys;
}

/**
 * Built-in role bundles (spec §40–§44). Sorted per role for reviewability.
 * Owner holds every registered permission by construction — including keys
 * added in future minor releases (the OWNER bundle is "all registered",
 * evaluated at resolution time, not stored).
 */
export const BUILTIN_ROLE_BUNDLES: Readonly<
  Record<Exclude<BuiltinRoleKey, "OWNER">, readonly string[]>
> & { readonly OWNER: "ALL" } = {
  OWNER: "ALL",

  ADMIN: bundle(
    "analytics.manage",
    "analytics.read",
    "audit.read",
    "search.admin",
    "search.diagnostics",
    "search.reindex",
    "content.archive",
    "content.create",
    "content.edit",
    "content.read",
    "content_schema.apply",
    "content_schema.propose",
    "content_schema.read",
    "domains.manage",
    "forms.manage_definition",
    "forms.read_definition",
    "integrations.read",
    "media.archive",
    "media.generate",
    "media.import",
    "media.providers.manage",
    "media.read",
    "media.replace",
    "media.stock.import",
    "media.stock.search",
    "media.write",
    "navigation.edit",
    "navigation.publish",
    "navigation.read",
    "payments.read",
    "preview.create",
    "publication.plan",
    "publication.publish",
    "publication.read",
    "publication.rollback",
    "publication.schedule",
    "publication.unpublish",
    "quizzes.manage_definition",
    "quizzes.read_definition",
    "research.fetch",
    "research.manage",
    "research.search",
    "revision.seal",
    "roles.manage",
    "roles.read",
    "seo.canonical_override",
    "seo.edit",
    "seo.read",
    "seo.site_settings",
    "seo.validate",
    "site.configure",
    "site.maintenance",
    "site.maintenance.bypass",
    "site.validate",
    "tokens.manage",
    "users.manage",
    "users.read",
  ),

  // Spec §42: theme operation, schema lifecycle, extensions/integrations,
  // diagnostics. No users/roles/PII/payments; connector secrets stay with
  // OWNER (custom roles may delegate deliberately).
  DEVELOPER: bundle(
    "analytics.manage",
    "analytics.network.manage",
    "analytics.read",
    "content.read",
    "search.diagnostics",
    "content_schema.apply",
    "content_schema.propose",
    "content_schema.read",
    "extensions.manage",
    "integrations.configure",
    "integrations.deliveries.read",
    "integrations.inbound.read",
    "integrations.read",
    "integrations.retry",
    "integrations.test",
    "media.providers.manage",
    "media.read",
    "navigation.read",
    "preview.create",
    "routing.redirects.import",
    "seo.read",
    "site.maintenance",
    "site.maintenance.bypass",
    "site.validate",
    "theme.activate",
    "theme.preview",
    "theme.read",
    "theme.validate",
    "theme.write",
  ),

  EDITOR: bundle(
    "content.archive",
    "content.create",
    "content.edit",
    "content.read",
    "forms.read_definition",
    "media.archive",
    "media.read",
    "media.replace",
    "media.stock.import",
    "media.stock.search",
    "media.write",
    "navigation.edit",
    "navigation.publish",
    "navigation.read",
    "preview.create",
    "publication.plan",
    "publication.publish",
    "publication.read",
    "publication.rollback",
    "publication.schedule",
    "publication.unpublish",
    "quizzes.read_definition",
    "revision.seal",
    "seo.canonical_override",
    "seo.edit",
    "seo.read",
    "seo.validate",
    // Editorial staff must see the real site while the public Internet sees
    // the maintenance page (task brief §21/§23); toggling stays ADMIN/OWNER.
    "site.maintenance.bypass",
  ),

  AUTHOR: bundle(
    "content.create",
    "content.edit",
    "content.read",
    "forms.read_definition",
    "media.read",
    "media.write",
    "preview.create",
    "publication.read",
    "quizzes.read_definition",
  ),
};

/** Effective permission keys for a built-in role (registry-current). */
export function builtinRolePermissions(role: BuiltinRoleKey): readonly string[] {
  // R1 (ADR-0017 v2 §10, pinned by tests/api/extensions-surface.test.ts):
  // extension namespace keys are NEVER granted implicitly — not even to
  // built-in roles. An operator grants them explicitly through a custom
  // role (assertAllRegistered admits registered extension keys) or a
  // service-account token scope.
  if (role === "OWNER") return PERMISSION_REGISTRY.map((definition) => definition.key);
  return BUILTIN_ROLE_BUNDLES[role];
}

/**
 * Keys a custom role may grant: everything registered. Explicitly checked at
 * custom-role save time (fail-secure against typos/forged keys).
 */
export function assertAllRegistered(keys: readonly string[]): void {
  for (const key of keys) {
    // Registered = platform registry OR an extension namespace key (ADR-0018
    // R1: extension keys are grantable once registered — explicitly, never
    // implicitly).
    if (!REGISTERED.has(key) && !EXTENSION_REGISTERED.has(key)) {
      throw new Error(`unregistered permission key "${key}" cannot be granted`);
    }
  }
}
