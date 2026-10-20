// Domain binding operations (owner 2026-10-06): shared by the REST routes
// (/site/domains) and the MCP surface — one implementation, two transports.
// The DomainService (packages/routing) owns the invariants; this layer adds
// the site resolution and the last-binding/primary-promotion guards.

import type { ApplicationServices } from "./context.js";
import { ApiError } from "./errors.js";

export interface SiteDomainView {
  readonly hostname: string;
  readonly is_primary: boolean;
  readonly locale: string | null;
  readonly scheme_policy: string;
  readonly canonical_redirect_policy: string;
}

export async function requireSiteByKey(
  app: ApplicationServices,
  siteKey: string,
): Promise<{ id: string; key: string }> {
  const site = await app.routes.findSiteByKey(siteKey);
  if (site === null) {
    throw new ApiError("SITE_NOT_FOUND", `site "${siteKey}" does not exist`, { status: 404 });
  }
  return { id: site.id, key: site.key };
}

export async function listSiteDomainsOp(
  app: ApplicationServices,
  siteKey: string,
): Promise<{ site: { id: string; key: string }; domains: readonly SiteDomainView[] }> {
  const site = await requireSiteByKey(app, siteKey);
  const bindings = await app.domains.listDomainBindings(site.id);
  return {
    site: { id: site.id, key: site.key },
    domains: bindings.map((binding) => ({
      hostname: binding.hostname,
      is_primary: binding.isPrimary,
      locale: binding.locale,
      scheme_policy: binding.schemePolicy,
      canonical_redirect_policy: binding.canonicalRedirectPolicy,
    })),
  };
}

export async function addSiteDomainOp(
  app: ApplicationServices,
  siteKey: string,
  input: {
    readonly hostname: string;
    readonly is_primary?: boolean;
    readonly locale?: string | null;
    readonly scheme_policy?: "https" | "http";
    readonly canonical_redirect_policy?: "redirect" | "serve";
  },
): Promise<{ domain: SiteDomainView }> {
  const site = await requireSiteByKey(app, siteKey);
  const binding = await app.domains.addDomainBinding({
    siteId: site.id,
    hostname: input.hostname,
    ...(input.scheme_policy === undefined ? {} : { schemePolicy: input.scheme_policy }),
    ...(input.canonical_redirect_policy === undefined
      ? {}
      : { canonicalRedirectPolicy: input.canonical_redirect_policy }),
    ...(input.is_primary === undefined ? {} : { isPrimary: input.is_primary }),
    ...(input.locale === undefined ? {} : { locale: input.locale }),
  });
  return {
    domain: {
      hostname: binding.hostname,
      is_primary: binding.isPrimary,
      locale: binding.locale,
      scheme_policy: binding.schemePolicy,
      canonical_redirect_policy: binding.canonicalRedirectPolicy,
    },
  };
}

export async function setPrimarySiteDomainOp(
  app: ApplicationServices,
  siteKey: string,
  hostname: string,
): Promise<{ domain: SiteDomainView; effects: Record<string, string> }> {
  const site = await requireSiteByKey(app, siteKey);
  const binding = await app.domains.findDomainByHostname(hostname);
  if (binding === null || binding.siteId !== site.id) {
    throw new ApiError("SITE_DOMAIN_NOT_FOUND", "domain binding not found", { status: 404 });
  }
  const updated = await app.domains.setPrimaryDomain(binding.id);
  return {
    domain: {
      hostname: updated.hostname,
      is_primary: updated.isPrimary,
      locale: updated.locale,
      scheme_policy: updated.schemePolicy,
      canonical_redirect_policy: updated.canonicalRedirectPolicy,
    },
    effects: { sitemap_and_canonical: "immediate — no restart needed" },
  };
}

export async function removeSiteDomainOp(
  app: ApplicationServices,
  siteKey: string,
  hostname: string,
): Promise<{ removed: string }> {
  const site = await requireSiteByKey(app, siteKey);
  const binding = await app.domains.findDomainByHostname(hostname);
  if (binding === null || binding.siteId !== site.id) {
    throw new ApiError("SITE_DOMAIN_NOT_FOUND", "domain binding not found", { status: 404 });
  }
  const bindings = await app.domains.listDomainBindings(site.id);
  if (bindings.length <= 1) {
    throw new ApiError(
      "SITE_DOMAIN_LAST_BINDING",
      "cannot remove the only domain binding of a site",
      { status: 409 },
    );
  }
  await app.domains.removeDomainBinding(binding.id);
  if (binding.isPrimary) {
    const rest = await app.domains.listDomainBindings(site.id);
    await app.domains.setPrimaryDomain(rest[0]!.id);
  }
  return { removed: binding.hostname };
}
