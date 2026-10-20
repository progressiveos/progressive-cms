// `cms nav inspect|check` and `cms route inspect|check` (PCMS-NAV-T028;
// Navigation spec §63/§64 discovery through the CLI transport). Deterministic
// `--json` output; check commands exit 1 on validation issues. Exit codes:
// 0 ok, 1 validation/DB failure, 2 usage.

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { buildDbConnectionInfo, createDbPool, loadConfig, loadSecrets } from "@pcms/core";
import {
  createNavigationDiscovery,
  createNavigationService,
  createPlacementBindingService,
} from "@pcms/navigation";
import { createRoutingDiscovery, DEFAULT_ROUTE_POLICY, RoutingError } from "@pcms/routing";
import { parseThemeManifest, type ThemeManifest } from "@pcms/themes";
import type { CliResult } from "../main.js";

export interface NavRouteInvocation {
  readonly args: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
}

async function siteExists(
  pool: import("@pcms/core").DbPool,
  siteRef: string | undefined,
): Promise<boolean> {
  const routes = createRoutingDiscovery(pool);
  try {
    await routes.getRoutePolicy(siteRef);
    return true;
  } catch (err) {
    if (err instanceof RoutingError && err.code === "SITE_NOT_FOUND") return false;
    throw err;
  }
}

function parseArgs(args: readonly string[]): {
  json: boolean;
  theme?: string;
  config?: string;
  site?: string;
} | null {
  const parsed: { json: boolean; theme?: string; config?: string; site?: string } = {
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--theme" || arg === "--config" || arg === "--site") {
      const value = args[index + 1];
      if (value === undefined) return null;
      const key = arg.slice(2) as "theme" | "config" | "site";
      parsed[key] = value;
      index += 1;
    } else return null;
  }
  return parsed;
}

async function withPool<T>(
  invocation: NavRouteInvocation,
  run: (pool: import("@pcms/core").DbPool, cwd: string) => Promise<T>,
): Promise<T> {
  const env = invocation.env ?? process.env;
  const cwd = invocation.cwd ?? process.cwd();
  const parsed = parseArgs(invocation.args.slice(1));
  const config = loadConfig({
    env,
    cwd,
    ...(parsed?.config === undefined ? {} : { file: parsed.config }),
  });
  const secrets = loadSecrets(config.secrets, env);
  const pool = createDbPool({
    connectionInfo: buildDbConnectionInfo(config.db, secrets),
    max: 2,
    connectionTimeoutMilliseconds: config.db.pool.connectionTimeoutMilliseconds,
  });
  try {
    return await run(pool, cwd);
  } finally {
    await pool.end();
  }
}

function loadThemeDescriptors(
  themeDir: string | undefined,
  cwd: string,
): {
  descriptors: {
    id: string;
    label: string;
    description: string | null;
    required: boolean;
    maxDepth: number;
    supportedItemTypes: readonly string[];
    fallback: string | null;
  }[];
  manifest: ThemeManifest | null;
} {
  if (themeDir === undefined) return { descriptors: [], manifest: null };
  const dir = isAbsolute(themeDir) ? themeDir : join(cwd, themeDir);
  // parseThemeManifest accepts the raw file text (it parses + validates).
  const manifestResult = parseThemeManifest(readFileSync(join(dir, "theme.json"), "utf8"));
  if (!manifestResult.ok) {
    throw new Error(`invalid theme manifest in ${dir}`);
  }
  const manifest = manifestResult.value;
  return {
    manifest,
    descriptors: manifest.navigation_placements.map((p) => ({
      id: p.id,
      label: p.label ?? p.id,
      description: p.description ?? null,
      required: p.required ?? false,
      maxDepth: p.max_depth,
      supportedItemTypes: p.supported_item_types,
      fallback: p.fallback ?? null,
    })),
  };
}

function renderDirFromConfig(
  env: Record<string, string | undefined>,
  cwd: string,
  file?: string,
): string | undefined {
  try {
    return loadConfig({ env, cwd, ...(file === undefined ? {} : { file }) }).themes?.renderDir;
  } catch {
    return undefined;
  }
}

/** `cms nav inspect|check` — navigation sets, trees, bindings, validation. */
export async function navCommand(invocation: NavRouteInvocation): Promise<CliResult> {
  const [subcommand, ...rest] = invocation.args;
  const parsed = parseArgs(rest);
  if ((subcommand !== "inspect" && subcommand !== "check") || parsed === null) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "usage: cms nav inspect [--json] [--config <p>] [--theme <dir>]\n       cms nav check [--json] [--theme <dir>] [--config <p>]\n",
    };
  }
  if (parsed.site !== undefined) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "navigation is installation-scoped; --site is unsupported\n",
    };
  }
  try {
    return await withPool(invocation, async (pool, cwd) => {
      // No --theme → fall back to the deployed theme (themes.renderDir):
      // bare `cms nav inspect` on a server must see the REAL placements,
      // not report every binding as NAV_PLACEMENT_UNKNOWN against an empty
      // descriptor list (theme developer report 0.1.119→0.123).
      const themeDir =
        parsed.theme ?? renderDirFromConfig(invocation.env ?? process.env, cwd, parsed.config);
      const { descriptors } = loadThemeDescriptors(themeDir, cwd);
      const discovery = createNavigationDiscovery(pool, descriptors);
      const nav = createNavigationService(pool);
      const bindings = createPlacementBindingService(pool, nav);

      if (subcommand === "inspect") {
        const payload = {
          sets: await discovery.listNavigationSets(),
          bindings: await discovery.getPlacementBindings(),
          placements: discovery.listPlacements(),
          validation: await discovery.validateNavigation(),
        };
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(payload, null, parsed.json ? 0 : 2)}\n`,
          stderr: "",
        };
      }
      // check: binding validation + stale overrides per set.
      const staleRows: { set: string; overrideId: string; targetItemId: string }[] = [];
      for (const set of await nav.listSets()) {
        for (const stale of await nav.listStaleOverrides(set.id)) {
          staleRows.push({
            set: set.key,
            overrideId: stale.override_id,
            targetItemId: stale.target_item_id,
          });
        }
      }
      const issues = await bindings.validateBindings(descriptors);
      const ok = issues.length === 0 && staleRows.length === 0;
      const payload = { ok, issues, staleOverrides: staleRows };
      return {
        exitCode: ok ? 0 : 1,
        stdout: `${JSON.stringify(payload, null, parsed.json ? 0 : 2)}\n`,
        stderr: "",
      };
    });
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: `${(err as Error).message}\n` };
  }
}

/** `cms route inspect|check` — routes, redirects, domains, policy, graph. */
export async function routeCommand(invocation: NavRouteInvocation): Promise<CliResult> {
  const [subcommand, ...rest] = invocation.args;
  const parsed = parseArgs(rest);
  if ((subcommand !== "inspect" && subcommand !== "check") || parsed === null) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "usage: cms route inspect [--json] [--site <key>] [--config <p>]\n       cms route check [--json] [--site <key>] [--config <p>]\n",
    };
  }
  try {
    return await withPool(invocation, async (pool) => {
      const discovery = createRoutingDiscovery(pool);
      const siteRef = parsed.site;

      // A fresh install has no site yet — report empty state, not an error.
      const hasSite = await siteExists(pool, siteRef);
      if (!hasSite) {
        const empty = { routes: [], redirects: [], domains: [], policy: DEFAULT_ROUTE_POLICY };
        const check = { ok: true, graphIssues: [], policyOk: true };
        const payload = subcommand === "inspect" ? empty : check;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(payload, null, parsed.json ? 0 : 2)}\n`,
          stderr: "",
        };
      }
      if (subcommand === "inspect") {
        const payload = {
          routes: await discovery.listRoutes(siteRef),
          redirects: await discovery.listRedirects(siteRef),
          domains: await discovery.listDomainBindings(siteRef),
          policy: await discovery.getRoutePolicy(siteRef),
        };
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(payload, null, parsed.json ? 0 : 2)}\n`,
          stderr: "",
        };
      }
      // check: redirect graph safety + policy sanity for the site.
      const graphIssues = await discovery.validateRedirectGraph(siteRef);
      const policy = await discovery.getRoutePolicy(siteRef);
      const policyOk =
        typeof policy.trailingSlash === "boolean" &&
        Array.isArray(policy.allowedExtensions) &&
        policy.reservedPrefixes.length > 0;
      const ok = graphIssues.length === 0 && policyOk;
      const payload = { ok, graphIssues, policyOk };
      return {
        exitCode: ok ? 0 : 1,
        stdout: `${JSON.stringify(payload, null, parsed.json ? 0 : 2)}\n`,
        stderr: "",
      };
    });
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: `${(err as Error).message}\n` };
  }
}
