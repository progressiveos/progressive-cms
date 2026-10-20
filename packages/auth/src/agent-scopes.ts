// Operator-facing token/role presets (owner directive 2026-09-28,
// superseding the ADR-0005 agent-default fixtures removed with them):
// generous scenario starting points — an agent blocked by a missing scope
// costs more than an over-broad token. They remain explicit grants: nothing
// here is implied, every issue still goes through the audited token
// pipeline (listRolesOp serves AGENT_SCOPE_PRESETS to the Admin issuer UI).
// Exclusions are owner-policy, not registry-derived: identity/roles/tokens
// (self-escalation), lead/interaction PII and refund money movement stay
// with humans unless a preset below explicitly includes them ("all").

import { assertAllRegistered, PERMISSION_REGISTRY } from "./permissions.js";

/** Everything an agent needs to build a new site end-to-end. Excludes only
 * identity/roles/tokens (self-escalation), lead/interaction PII and refund
 * money movement. */
export const SITE_DEVELOPMENT_SCOPES: readonly string[] = [
  "analytics.manage",
  "analytics.read",
  "audit.read",
  "content.archive",
  "content.create",
  "content.edit",
  "content.read",
  "content_schema.apply",
  "content_schema.propose",
  "content_schema.read",
  "domains.manage",
  "embed.trusted",
  "extensions.manage",
  "forms.manage_definition",
  "forms.read_definition",
  "integrations.configure",
  "integrations.deliveries.read",
  "integrations.inbound.read",
  "integrations.read",
  "integrations.retry",
  "integrations.secrets.manage",
  "integrations.test",
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
  "payments.cancel",
  "payments.configure",
  "payments.create",
  "payments.events.read",
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
  "routing.redirects.import",
  "search.admin",
  "search.diagnostics",
  "search.reindex",
  "seo.canonical_override",
  "seo.edit",
  "seo.read",
  "seo.site_settings",
  "seo.validate",
  "site.configure",
  "site.maintenance",
  "site.maintenance.bypass",
  "site.validate",
  "theme.activate",
  "theme.preview",
  "theme.read",
  "theme.validate",
  "theme.write",
];

/** Editorial agent: entries, media (incl. AI generation/stock), navigation,
 * SEO, forms/quizzes, full publishing and research. No themes, no users. */
export const CONTENT_WORK_SCOPES: readonly string[] = [
  "content.archive",
  "content.create",
  "content.edit",
  "content.read",
  "content_schema.apply",
  "content_schema.propose",
  "content_schema.read",
  "analytics.manage",
  "analytics.read",
  "forms.manage_definition",
  "forms.read_definition",
  "integrations.deliveries.read",
  "media.archive",
  "media.generate",
  "media.import",
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
  "quizzes.manage_definition",
  "quizzes.read_definition",
  "research.fetch",
  "research.search",
  "revision.seal",
  "routing.redirects.import",
  "search.admin",
  "search.diagnostics",
  "search.reindex",
  "seo.canonical_override",
  "seo.edit",
  "seo.read",
  "seo.site_settings",
  "seo.validate",
  "site.maintenance.bypass",
  "site.validate",
];

/** Theme developer: theme lifecycle incl. activation, block schema, enough
 * content/media/navigation to verify layouts, and publishing the result. */
export const THEME_WORK_SCOPES: readonly string[] = [
  "content.edit",
  "content.read",
  "content_schema.apply",
  "content_schema.propose",
  "content_schema.read",
  "embed.trusted",
  "media.read",
  "media.replace",
  "media.stock.import",
  "media.stock.search",
  "media.write",
  "navigation.edit",
  "navigation.read",
  "preview.create",
  "publication.plan",
  "publication.publish",
  "publication.read",
  "search.diagnostics",
  "seo.read",
  "seo.validate",
  "site.maintenance.bypass",
  "site.validate",
  "theme.activate",
  "theme.preview",
  "theme.read",
  "theme.validate",
  "theme.write",
];

/** Integrations/notifications wiring: connectors, bindings, deliveries and
 * write-only connector secrets (values are never readable back). */
export const INTEGRATIONS_WORK_SCOPES: readonly string[] = [
  "audit.read",
  "content.read",
  "forms.read_definition",
  "integrations.configure",
  "integrations.deliveries.read",
  "integrations.inbound.read",
  "integrations.read",
  "integrations.retry",
  "integrations.secrets.manage",
  "integrations.test",
  "media.read",
  "payments.events.read",
  "payments.read",
  "quizzes.read_definition",
];

/** Read-only QA/monitoring: every read-shaped scope plus validators and the
 * maintenance bypass (seeing the real site is read-shaped too). */
export const READONLY_DIAGNOSTICS_SCOPES: readonly string[] = [
  "audit.read",
  "content.read",
  "content_schema.read",
  "forms.read_definition",
  "integrations.deliveries.read",
  "integrations.inbound.read",
  "integrations.read",
  "media.read",
  "navigation.read",
  "payments.events.read",
  "payments.read",
  "publication.read",
  "quizzes.read_definition",
  "roles.read",
  "search.admin",
  "search.diagnostics",
  "seo.read",
  "seo.validate",
  "site.maintenance.bypass",
  "site.validate",
  "theme.read",
  "users.read",
];

/** Registry-current "everything" — mirrors the OWNER bundle semantics. */
export const ALL_PERMISSION_SCOPES: readonly string[] = PERMISSION_REGISTRY.map(
  (definition) => definition.key,
);

for (const scopes of [
  SITE_DEVELOPMENT_SCOPES,
  CONTENT_WORK_SCOPES,
  THEME_WORK_SCOPES,
  INTEGRATIONS_WORK_SCOPES,
  READONLY_DIAGNOSTICS_SCOPES,
]) {
  // Fail loudly at boot/tests: a preset naming an unregistered key must be
  // a build break, never a silent partial grant.
  assertAllRegistered(scopes);
}

/** Ordered operator-facing presets (UI order = insertion order). */
export const AGENT_SCOPE_PRESETS: Readonly<Record<string, readonly string[]>> = {
  site_development: SITE_DEVELOPMENT_SCOPES,
  content_work: CONTENT_WORK_SCOPES,
  theme_work: THEME_WORK_SCOPES,
  integrations_work: INTEGRATIONS_WORK_SCOPES,
  readonly_diagnostics: READONLY_DIAGNOSTICS_SCOPES,
  all: ALL_PERMISSION_SCOPES,
};
