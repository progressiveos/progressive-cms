// Agent bootstrap/discovery surface (M16; task brief §18–§23, Agent Skills
// spec §7). One machine-readable answer to "where am I connected, who am I,
// what may I do, which contracts are available" — the M15 content-agent had
// to reconstruct all of this from source code (gap G1). REST
// GET /agent/bootstrap, MCP cms_get_agent_bootstrap and CLI
// `cms agent bootstrap` all call THIS operation; no transport-specific logic.
//
// Secret-free by construction: contract versions, capability booleans and
// availability flags only — never secret values or their refs.
import { join } from "node:path";
import { evaluateSkillCompatibility, loadCommunitySkills, loadInstalledSkills } from "@pcms/skills";
import type { ApplicationServices, OperationContext } from "./context.js";
import { buildCapabilities } from "./mcp-surface.js";

export async function getAgentBootstrapOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<unknown> {
  const site = await app.routes.findSiteByKey(app.defaultSiteKey);
  const domains = site === null ? [] : await app.domains.listDomainBindings(site.id);
  const contracts = Object.fromEntries(
    app.extensions.contractVersions.list().map((entry) => [entry.key, entry.version]),
  );
  const permissions = [...ctx.actor.permissions].sort();
  const snapshot = { contractVersions: contracts, capabilities: permissions };

  const skills = loadInstalledSkills(app.skillsDir);
  const skillReports = skills.skills.map(({ manifest }) => {
    const compatibility = evaluateSkillCompatibility(manifest, snapshot);
    return {
      id: manifest.id,
      version: manifest.version,
      description: manifest.description,
      manifest_path: join(manifest.id, "manifest.json"),
      origin: "first-party" as "first-party" | "community" | "disabled",
      compatibility: {
        result: compatibility.result,
        issues: compatibility.issues,
      },
    };
  });
  // Community skills (operator-installed, default OFF): visible with their
  // trust class; disabled ones are hidden entirely (the operator's
  // kill-switch, not an advisory).
  const skillProblems = [...skills.problems];
  if (app.communitySkillsEnabled) {
    const community = loadCommunitySkills(app.communitySkillsDir);
    skillProblems.push(...community.problems);
    for (const communitySkill of community.skills) {
      if (communitySkill.disabled) continue;
      const compatibility = evaluateSkillCompatibility(communitySkill.manifest, snapshot);
      skillReports.push({
        id: communitySkill.manifest.id,
        version: communitySkill.manifest.version,
        description: communitySkill.manifest.description,
        manifest_path: join("community", communitySkill.manifest.id, "manifest.json"),
        origin: "community" as "first-party" | "community" | "disabled",
        compatibility: {
          result: compatibility.result,
          issues: compatibility.issues,
        },
      });
    }
  }

  const previewConfigured = app.previewTokens !== null;
  const primary = domains.find((binding) => binding.isPrimary);
  // Localization discovery (machine interfaces must not guess a site's
  // language semantics from content): mode, default, enabled locales,
  // routing strategy.
  const localization = await app.localization.get();

  // The operator-facing name (owner 2026-10-08: the Admin sidebar must show
  // the site NAME, not "default"): SEO identity site_name — the same value
  // Настройки → «Название сайта» sets — wins over the routing row's title,
  // which single-site installs leave at the key.
  const identity = await app.seoDiscovery.getSiteIdentity();
  const siteTitle = identity?.site_name?.trim() || site?.title;

  return {
    site: site === null ? null : { id: site.id, key: site.key, title: siteTitle ?? site.key },
    environment: {
      // Fail-safe classification: an operator must explicitly declare
      // production; everything else is treated as development.
      classification: app.environmentClassification,
      actor_binding: ctx.actor.environment,
    },
    actor: {
      id: ctx.actor.id,
      type: ctx.actor.type,
      permissions,
    },
    server: {
      cms_version: contracts.cms ?? null,
      release_id: app.releaseId,
      server_time: app.clock.now().toISOString(),
    },
    contracts,
    capabilities: buildCapabilities(app, ctx),
    skills: {
      installed: skillReports,
      problems: skills.problems,
    },
    publication: {
      preview: {
        available: previewConfigured,
        ...(previewConfigured ? {} : { reason_code: "PREVIEW_NOT_CONFIGURED" }),
      },
      scheduling_available: true,
    },
    localization: {
      mode: localization.enabled ? "multilingual" : "single",
      default_locale: localization.defaultLocale,
      enabled_locales: [...localization.locales],
      routing_strategy: localization.routingStrategy,
    },
    routing: {
      primary_domain: primary?.hostname ?? null,
      domains: domains.map((binding) => ({
        hostname: binding.hostname,
        is_primary: binding.isPrimary,
      })),
    },
    media: {
      import_available: app.mediaStorage !== null,
    },
    safety: {
      environment: app.environmentClassification,
    },
  };
}
