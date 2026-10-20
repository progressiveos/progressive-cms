// Operator diagnostics (PCMS-API-T025; API spec §59).
//   cms doctor        — environment checks: config, DB + migrations, media
//                       storage, theme source, contract versions
//   cms info          — configuration summary (never secret values)
//   cms capabilities  — the platform's own capability registry (static)
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecretBox, PERMISSION_REGISTRY } from "@pcms/auth";
import { BLOCK_DOCUMENT_SCHEMA_VERSION, MAX_BLOCKS_PER_DOCUMENT } from "@pcms/blocks";
import {
  buildDbConnectionInfo,
  createDbPool,
  type DbPool,
  loadConfig,
  loadMigrations,
  loadSecrets,
  migrationStatus,
  systemClock,
} from "@pcms/core";
import {
  heartbeatAgeMilliseconds,
  heartbeatIsFresh,
  RELEASE_LAYOUT,
  readWorkerHeartbeat,
  resolveReleaseIdentity,
} from "@pcms/operations";
import { SEARCH_INDEX_VERSION } from "@pcms/search";
import { resolveInstalledThemeDirectory, THEME_CONTRACT_VERSION } from "@pcms/themes";
import {
  type CliCommandResult,
  configLoadOptions,
  failureResult,
  type GlobalOptions,
  jsonPayload,
} from "../framework.js";

/** Running CMS version for theme compatibility checks — the same source
 * `readCmsVersionFromRelease` uses in the API/web composition: the running
 * code's own release root, never the operator's cwd. Without it an installed
 * theme's `cms_compatibility` cannot be validated ("site reports unknown"). */
function doctorCmsVersion(): string {
  const resolved = resolveReleaseIdentity(fileURLToPath(import.meta.url));
  if (resolved.mode === "release") return resolved.identity.version;
  try {
    const document = JSON.parse(readFileSync(join(resolved.root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof document.version === "string" ? document.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface DiagnosticsInvocation {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function resolveConfig(env: NodeJS.ProcessEnv, cwd: string, options: GlobalOptions) {
  return loadConfig(configLoadOptions(options, env, cwd));
}

/** Live content-type versions from the deployment typesFile (top-level
 * array of definitions carrying `key` and `version`); anything unreadable
 * contributes nothing — overrides and the version-1 fallback cover it, and
 * the content-types check reports the file problem itself. */
const typesFileVersionMap = (typesFile: string | undefined): Record<string, number> => {
  const versions: Record<string, number> = {};
  if (typesFile === undefined || !existsSync(typesFile)) return versions;
  try {
    const parsed = JSON.parse(readFileSync(typesFile, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      for (const definition of parsed) {
        if (typeof definition !== "object" || definition === null) continue;
        const { key, version } = definition as { key?: unknown; version?: unknown };
        if (typeof key === "string" && typeof version === "number" && Number.isFinite(version)) {
          versions[key] = version;
        }
      }
    }
  } catch {
    // coverage degrades to override/version-1 instead of failing doctor here
  }
  return versions;
};

/** Published content types (live, never-retired routes) that NO template of
 * the active theme accepts — the silent site-wide 404 (Rec 1, 152fz). The
 * live version of a type is its typesFile version unless an API-applied
 * override bumped it (pcms_content_type_overrides carries the newest).
 * Exported for tests.
 * @internal
 */
export const __publishedOrphanTypes = async (
  pool: DbPool,
  templates: readonly { readonly accepts_content_types?: readonly string[] }[],
  typesFileVersions: Readonly<Record<string, number>>,
): Promise<string[]> => {
  const accepts = (key: string, version: number): boolean =>
    templates.some((template) =>
      (template.accepts_content_types ?? []).some((accepted) => {
        const [acceptedKey, acceptedVersion] = accepted.split("@");
        return (
          acceptedKey === key &&
          (acceptedVersion === undefined || Number(acceptedVersion) === version)
        );
      }),
    );
  // entries.content_type_id IS the stable type key (text, migration 0002) —
  // there is no content_types table to join; routes.target_id is the generic
  // text target reference, so the uuid side casts to text.
  const published = await pool.query<{ key: string; count: string }>(
    `SELECT e.content_type_id AS key, count(*)::text AS count
     FROM routes r
     JOIN entries e ON e.id::text = r.target_id
     WHERE r.retired_at IS NULL AND r.target_type = 'entry'
     GROUP BY e.content_type_id ORDER BY 1`,
  );
  const overrides = await pool.query<{ key: string; version: number }>(
    "SELECT content_type_id AS key, max(version) AS version FROM pcms_content_type_overrides GROUP BY 1",
  );
  const liveVersion = new Map<string, number>(Object.entries(typesFileVersions));
  for (const row of overrides.rows) liveVersion.set(row.key, Number(row.version));
  return published.rows
    .filter((row) => !accepts(row.key, liveVersion.get(row.key) ?? 1))
    .map((row) => {
      const version = liveVersion.get(row.key);
      return `${row.key}${version === undefined ? "" : `@${version}`} (published: ${row.count})`;
    });
};

async function withPool<R>(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: GlobalOptions,
  run: (pool: DbPool) => Promise<R>,
): Promise<R> {
  const config = resolveConfig(env, cwd, options);
  const secrets = loadSecrets(config.secrets, env);
  const pool = createDbPool({
    connectionInfo: buildDbConnectionInfo(config.db, secrets),
    max: 1,
    connectionTimeoutMilliseconds: 3000,
    statementTimeoutMilliseconds: 5000,
  });
  try {
    return await run(pool);
  } finally {
    void pool.end();
  }
}

export async function doctorCommand(invocation: DiagnosticsInvocation): Promise<CliCommandResult> {
  const { options, env, cwd } = invocation;
  const checks: CheckResult[] = [];
  try {
    // 1. Configuration.
    let config: ReturnType<typeof resolveConfig>;
    try {
      config = resolveConfig(env, cwd, options);
      checks.push({ name: "config", ok: true, detail: `nodeEnv=${config.nodeEnv}` });
    } catch (error) {
      checks.push({
        name: "config",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return render(options, checks);
    }

    // 2. Database reachability + migration state.
    try {
      const status = await withPool(env, cwd, options, async (pool) => {
        await pool.query("SELECT 1");
        return migrationStatus(pool, loadMigrations(config.db.migrationsDir));
      });
      checks.push({
        name: "database",
        ok: status.current !== null && status.pending.length === 0 && status.drifted.length === 0,
        detail:
          status.current === null
            ? "reachable but never migrated"
            : `current ${status.current}; ${status.pending.length} pending, ${status.drifted.length} drifted`,
      });
      // 2b. Extension lifecycle summary (M14, read-only): enabled/installed
      // counts and migration drift — doctor is not a second updater.
      try {
        const rows = await withPool(env, cwd, options, async (pool) => {
          const installations = await pool.query<{ state: string }>(
            "SELECT state FROM pcms_extension_installations",
          );
          return installations.rows;
        });
        const enabled = rows.filter((row) => row.state === "ENABLED").length;
        checks.push({
          name: "extensions",
          ok: true,
          detail: `${rows.length} installed, ${enabled} enabled`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Pre-M14 databases have no extension tables yet — informational.
        checks.push({
          name: "extensions",
          ok: message.includes("does not exist"),
          detail: message.includes("does not exist")
            ? "extension state tables absent (pre-M14)"
            : message,
        });
      }
      // 2c. Web Research (ADR-0015): optional subsystem — degraded, never
      // fatal. Capability-bound (ADR-0017 S4): whichever installed extension
      // contributes the research.search operation capability is the research
      // provider — no extension id is named here. Search needs provider
      // credentials; fetch needs no config; browser render is the soft spot.
      try {
        const researchExtensionId = researchExtensionIdFromCatalog(cwd);
        const research =
          researchExtensionId === undefined
            ? undefined
            : await withPool(env, cwd, options, async (pool) => {
                const rows = await pool.query<{ state: string; config: unknown }>(
                  "SELECT state, config FROM pcms_extension_installations WHERE extension_id = $1",
                  [researchExtensionId],
                );
                return rows.rows[0];
              });
        if (research === undefined) {
          checks.push({
            name: "web-research",
            ok: true,
            detail: "not installed (optional; no research.search capability deployed)",
          });
        } else {
          const researchConfig = (research.config ?? {}) as Record<string, unknown>;
          const enabled = research.state === "ENABLED";
          const searchReady =
            typeof researchConfig["xmlstock.user_id"] === "string" &&
            (researchConfig["xmlstock.user_id"] as string) !== "" &&
            researchConfig["xmlstock.api_key"] !== undefined;
          const networkMode =
            typeof (researchConfig["network"] as Record<string, unknown> | undefined)?.mode ===
            "string"
              ? ((researchConfig["network"] as Record<string, unknown>)["mode"] as string)
              : "direct";
          let browser: string;
          try {
            // The web service gets PLAYWRIGHT_BROWSERS_PATH from its systemd
            // drop-in; a bare `cms doctor` needs the same default hint.
            if (
              process.env.PLAYWRIGHT_BROWSERS_PATH === undefined &&
              existsSync("/var/lib/progressive-cms/playwright")
            ) {
              process.env.PLAYWRIGHT_BROWSERS_PATH = "/var/lib/progressive-cms/playwright";
            }
            const playwright = (await import("playwright-core")) as {
              chromium: { executablePath(): string };
            };
            const executable = playwright.chromium.executablePath();
            browser = executable !== "" && existsSync(executable) ? "ready" : "unavailable";
          } catch {
            browser = "unavailable";
          }
          checks.push({
            name: `web-research (${researchExtensionId})`,
            ok: true,
            detail: `${enabled ? "enabled" : research.state.toLowerCase()} · search ${searchReady ? "configured" : "missing credentials"} · fetch ready · browser ${browser} · network ${networkMode}`,
          });
        }
      } catch {
        checks.push({
          name: "web-research",
          ok: true,
          detail: "state unavailable (optional subsystem)",
        });
      }
    } catch (error) {
      checks.push({
        name: "database",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // 3. Media storage directories (when the deployment uses media).
    // Existence alone is not enough (PCMS-OPS-T108): the check writes and
    // removes a probe file, proving the runtime user can actually persist
    // media outside the release directory — the update/rollback invariant.
    if (config.media !== undefined) {
      const dirsPresent =
        existsSync(config.media.storageDir) && existsSync(config.media.quarantineDir);
      let writable = false;
      if (dirsPresent) {
        const probePath = join(config.media.storageDir, `.doctor-write-probe-${process.pid}`);
        try {
          writeFileSync(probePath, "probe", { mode: 0o640 });
          unlinkSync(probePath);
          writable = true;
        } catch {
          writable = false;
        }
      }
      checks.push({
        name: "media-storage",
        ok: dirsPresent && writable,
        detail:
          dirsPresent && writable
            ? `${config.media.storageDir} + quarantine present, writable`
            : dirsPresent
              ? "directories present but NOT writable by the runtime user"
              : "storage or quarantine directory missing",
      });
    } else {
      checks.push({ name: "media-storage", ok: true, detail: "not configured (media disabled)" });
    }

    // 4. Theme source (when configured).
    if (config.themes?.renderDir !== undefined) {
      const configuredDir = config.themes.renderDir;
      // `themes.renderDir` is the BOOT seed, not the active theme: persisted
      // activation (`admin_theme_state.theme_key`) wins on restart, exactly as
      // the web renderer resolves it (site.ts, resolveInstalledThemeDirectory).
      // Reading the manifest straight from renderDir made doctor report a
      // template-coverage failure for a theme that is not the one serving.
      let activeDir = configuredDir;
      let activeThemeNote = "";
      try {
        const activeKey = await withPool(env, cwd, options, async (pool) => {
          const result = await pool.query<{ theme_key: string | null }>(
            "SELECT theme_key FROM admin_theme_state WHERE site_key = $1",
            ["default"],
          );
          return result.rows[0]?.theme_key ?? null;
        });
        const configuredId = JSON.parse(
          readFileSync(join(configuredDir, "theme.json"), "utf8"),
        ) as { id?: string };
        if (typeof activeKey === "string" && activeKey !== "" && activeKey !== configuredId.id) {
          // cmsVersion is not optional in practice: an installed theme declares
          // `cms_compatibility`, and without the running version the resolver
          // rejects it as THEME_PACKAGE_INVALID ("site reports unknown"). The
          // web runtime passes it; doctor must too, or activation never
          // resolves and the coverage check silently falls back to the seed.
          activeDir = resolveInstalledThemeDirectory(configuredDir, activeKey, doctorCmsVersion());
          activeThemeNote = ` (active: ${activeKey}; renderDir is the boot seed)`;
        }
      } catch {
        // Unresolvable activation (theme removed, bad receipt) keeps doctor on
        // the boot theme — the theme-source check below still reports reality.
      }
      const manifest = `${activeDir}/theme.json`;
      const themeOk = existsSync(manifest);
      checks.push({
        name: "theme-source",
        ok: themeOk,
        detail: themeOk ? `${manifest} present${activeThemeNote}` : `${manifest} missing`,
      });
      // Rec 1 (152fz recommendations): a published entry whose content type
      // is accepted by NO template in the active theme renders 404 site-wide
      // while doctor stays green — surface the drift here.
      if (themeOk) {
        try {
          const themeManifest = JSON.parse(readFileSync(manifest, "utf8")) as {
            templates?: readonly {
              readonly id: string;
              readonly accepts_content_types?: readonly string[];
            }[];
          };
          const orphans = await withPool(env, cwd, options, (pool) =>
            __publishedOrphanTypes(
              pool,
              themeManifest.templates ?? [],
              typesFileVersionMap(config.content?.typesFile),
            ),
          );
          checks.push({
            name: "published-template-coverage",
            ok: orphans.length === 0,
            detail:
              orphans.length === 0
                ? "every published content type has an accepting template"
                : `NO template accepts: ${orphans.join(", ")} — those pages render 404`,
          });
        } catch (error) {
          checks.push({
            name: "published-template-coverage",
            ok: true,
            detail: `skipped: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      // CORE-SHOP-01 P0-c (ADR-0018): every ENABLED extension view route
      // must have a reachable template — the active theme's accepts_views
      // override OR the package's base template file. Neither = the route
      // answers EXTENSION_VIEW_TEMPLATE_MISSING (503): surface it here.
      try {
        const mountRows = await withPool(env, cwd, options, (pool) =>
          pool.query<{ extension_id: string }>(
            "SELECT extension_id FROM pcms_extension_route_mounts WHERE retired_at IS NULL",
          ),
        );
        const mounts = mountRows.rows.map((row) => row.extension_id);
        if (mounts.length > 0 && existsSync(join(process.cwd(), "extensions", "catalog.js"))) {
          const catalogModule = (await import(
            `file://${join(process.cwd(), "extensions", "catalog.js")}`
          )) as {
            createFirstPartyExtensionCatalog?: (input: unknown) => {
              list: () => readonly {
                manifest: {
                  id: string;
                  registrations: {
                    views: readonly {
                      view_id: string;
                      base_template: string;
                      view_model_schema_version: string;
                    }[];
                    http_routes: readonly { view?: string }[];
                  };
                };
              }[];
            };
          };
          const activeTheme = JSON.parse(readFileSync(manifest, "utf8")) as {
            templates?: readonly { accepts_views?: readonly string[] }[];
          };
          const themeManifestViews = new Set(
            (activeTheme.templates ?? []).flatMap((template) => template.accepts_views ?? []),
          );
          const missing: string[] = [];
          const catalog = catalogModule.createFirstPartyExtensionCatalog?.(undefined);
          for (const extensionId of mounts) {
            const artifact = catalog?.list().find((entry) => entry.manifest.id === extensionId);
            if (artifact === undefined) continue;
            for (const route of artifact.manifest.registrations.http_routes) {
              if (route.view === undefined) continue;
              const view = artifact.manifest.registrations.views.find(
                (candidate) => candidate.view_id === route.view,
              );
              if (view === undefined) continue;
              const major = view.view_model_schema_version.split(".")[0] ?? "1";
              const overridden = themeManifestViews.has(`${extensionId}/${view.view_id}@${major}`);
              const basePresent = existsSync(
                join(process.cwd(), "extensions", extensionId, view.base_template),
              );
              if (!overridden && !basePresent) {
                missing.push(`${extensionId}/${view.view_id}@${major}`);
              }
            }
          }
          checks.push({
            name: "extension-views-coverage",
            ok: missing.length === 0,
            detail:
              missing.length === 0
                ? "every mounted extension view has a reachable template"
                : `NO template reachable: ${missing.join(", ")} — those routes answer 503`,
          });
        }
      } catch {
        // pre-1723 database or no catalog — not a doctor failure
      }
    } else {
      checks.push({
        name: "theme-source",
        ok: true,
        detail: "not configured (no server-side render)",
      });
    }

    // 5. Content types file.
    if (config.content?.typesFile !== undefined) {
      const present = existsSync(config.content.typesFile);
      let detail = `${config.content.typesFile} present`;
      if (present) {
        try {
          const parsed = JSON.parse(readFileSync(config.content.typesFile, "utf8")) as unknown[];
          detail = `${config.content.typesFile} (${parsed.length} content types)`;
        } catch {
          detail = `${config.content.typesFile} is not valid JSON`;
          checks.push({ name: "content-types", ok: false, detail });
          return render(options, checks);
        }
      }
      checks.push({ name: "content-types", ok: present, detail });
    } else {
      checks.push({ name: "content-types", ok: true, detail: "not configured (empty registry)" });
    }

    // 6. Search index state (M11; Search spec §20/§26). Search is a derived
    // subsystem: its failure degrades search, never core operations, so a
    // mismatch reports degraded (exit 1) without failing earlier checks.
    try {
      const search = await withPool(env, cwd, options, async (pool) => {
        const state = await pool.query<{
          index_version: number;
          active_epoch: string | number;
          last_reindex_at: Date | null;
          last_error: string | null;
        }>(
          "SELECT index_version, active_epoch, last_reindex_at, last_error FROM search_index_state WHERE id = 1",
        );
        const count = await pool.query<{ count: string }>(
          "SELECT count(*) AS count FROM search_documents WHERE epoch = (SELECT active_epoch FROM search_index_state WHERE id = 1)",
        );
        const trgm = await pool.query<{ trgm: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS trgm",
        );
        return {
          state: state.rows[0],
          count: Number(count.rows[0]?.count ?? 0),
          trgm: trgm.rows[0]?.trgm === true,
        };
      });
      if (search.state === undefined) {
        checks.push({
          name: "search-index",
          ok: false,
          detail: "index state row missing (run migrations)",
        });
      } else {
        const version = Number(search.state.index_version);
        const details = [
          `version ${version}/${SEARCH_INDEX_VERSION}`,
          `${search.count} documents (epoch ${String(search.state.active_epoch)})`,
          `last reindex ${search.state.last_reindex_at?.toISOString() ?? "never"}`,
          `pg_trgm ${search.trgm ? "available" : "absent"}`,
        ];
        if (search.state.last_error !== null)
          details.push(`last error: ${search.state.last_error.slice(0, 120)}`);
        // A fresh never-reindexed index (version 0, empty) is a normal
        // operational state, not degradation — search readiness never gates
        // the CMS. Real drift (version mismatch WITH documents) or a recorded
        // error degrades the check.
        const drifted =
          (version !== SEARCH_INDEX_VERSION && search.count > 0) ||
          search.state.last_error !== null;
        checks.push({
          name: "search-index",
          ok: !drifted,
          detail: drifted
            ? `${details.join("; ")} — reindex required`
            : version === SEARCH_INDEX_VERSION
              ? details.join("; ")
              : `${details.join("; ")} — reindex recommended (empty index)`,
        });
      }
    } catch (error) {
      checks.push({
        name: "search-index",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // 7. Worker heartbeat (PCMS-OPS-T109; Operations spec §50). "systemd
    // active" is not a progress signal: doctor distinguishes a live worker
    // loop (fresh beat) from a wedged/absent one. Pre-M15 databases have no
    // heartbeat table — honest note, not a failure.
    try {
      await withPool(env, cwd, options, async (pool) => {
        const snapshot = await readWorkerHeartbeat(pool);
        if (snapshot === null) {
          checks.push({
            name: "worker-heartbeat",
            ok: true,
            detail: "no heartbeat recorded yet (worker has not beaten, or pre-M15 database)",
          });
          return;
        }
        const ageMs = heartbeatAgeMilliseconds(snapshot, systemClock);
        const fresh = heartbeatIsFresh(snapshot, systemClock);
        checks.push({
          name: "worker-heartbeat",
          ok: fresh,
          detail: fresh
            ? `last beat ${Math.round(ageMs / 1000)}s ago (loop ${snapshot.loopCount}, boot ${snapshot.bootId.slice(0, 8)})`
            : `STALE: last beat ${Math.round(ageMs / 1000)}s ago (loop ${snapshot.loopCount}, boot ${snapshot.bootId.slice(0, 8)}) — worker not progressing`,
        });
      });
    } catch (error) {
      checks.push({
        name: "worker-heartbeat",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // 8b. Runtime Secret Store (owner task §36): READY / NOT CONFIGURED /
    // ERROR, without ever printing the key value. NOT CONFIGURED is honest —
    // the store is optional infrastructure until a connector secret is set.
    try {
      const ref = config.integrations?.runtimeSecretsEncryptionKeySecretRef;
      if (ref === undefined) {
        checks.push({
          // Informational, not DEGRADED: the store is optional until a
          // connector secret is stored, and doctor must not block unrelated
          // operations (update gates) over an unprovisioned optional feature.
          name: "runtime-secret-store",
          ok: true,
          detail:
            "NOT CONFIGURED: integrations.runtimeSecretsEncryptionKeySecretRef is not set — run `cms integrations secrets init` (connector passwords unavailable until then)",
        });
      } else {
        const key = loadSecrets(config.secrets, env).get(ref);
        if (key === undefined) {
          checks.push({
            name: "runtime-secret-store",
            ok: false,
            detail: `ERROR: secret "${ref}" cannot be loaded — restore the secret file (regenerating would lose encrypted values)`,
          });
        } else {
          createSecretBox(key); // validates the 32-byte decode; prints nothing
          checks.push({
            name: "runtime-secret-store",
            ok: true,
            detail: `READY (key "${ref}" resolves and decodes to 32 bytes)`,
          });
        }
      }
    } catch (error) {
      checks.push({
        name: "runtime-secret-store",
        ok: false,
        detail: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    // 9. Deployed release identity (PCMS-OPS-T101/T109; M17-T003): classified
    // from the RUNNING CODE's location, not the operator's cwd — a release
    // process reports deployment_mode=release with its version/commit even
    // when doctor is invoked from $HOME. A development tree is a normal state.
    {
      const resolved = resolveReleaseIdentity(fileURLToPath(import.meta.url));
      if (resolved.mode === "release") {
        const { identity, root } = resolved;
        // Canonical manifest (M17-T002): migration head comes from
        // release-manifest.json; its absence predates M17 (honest "?" only).
        let migrationHead = "?";
        try {
          const manifest = JSON.parse(
            readFileSync(join(root, RELEASE_LAYOUT.releaseManifest), "utf8"),
          ) as { migration_head?: string };
          migrationHead = manifest.migration_head ?? "none";
        } catch {
          // pre-M17 release without the canonical manifest
        }
        checks.push({
          name: "current-release",
          ok: true,
          detail: `deployment_mode=release; ${identity.releaseId} (version ${identity.version}, commit ${identity.gitCommit.slice(0, 7)}); migration head ${migrationHead}; path ${root}`,
        });
      } else {
        checks.push({
          name: "current-release",
          ok: true,
          detail: `deployment_mode=development; path ${resolved.root}`,
        });
      }
    }

    return render(options, checks);
  } catch (error) {
    return failureResult(error, options);
  }
}

function render(options: GlobalOptions, checks: readonly CheckResult[]): CliCommandResult {
  const ok = checks.every((check) => check.ok);
  if (options.json) {
    return {
      exitCode: ok ? 0 : 1,
      stdout: jsonPayload({ ok, checks }),
      stderr: "",
    };
  }
  return {
    exitCode: ok ? 0 : 1,
    stdout: `${[
      `doctor: ${ok ? "HEALTHY" : "DEGRADED"}`,
      ...checks.map((check) => `  [${check.ok ? "ok" : "FAIL"}] ${check.name}: ${check.detail}`),
      "",
    ].join("\n")}`,
    stderr: "",
  };
}

export function infoCommand(invocation: DiagnosticsInvocation): CliCommandResult {
  const { options, env, cwd } = invocation;
  try {
    const config = resolveConfig(env, cwd, options);
    const summary = {
      name: "progressive-cms",
      node_env: config.nodeEnv,
      db: {
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        ssl_mode: config.db.sslMode,
      },
      http: { host: config.http.host, port: config.http.port },
      media_configured: config.media !== undefined,
      theme_configured: config.themes?.renderDir !== undefined,
      content_types_configured: config.content?.typesFile !== undefined,
      contract_versions: {
        theme: THEME_CONTRACT_VERSION,
        block_document: BLOCK_DOCUMENT_SCHEMA_VERSION,
        bundle: 1,
      },
    };
    if (options.json)
      return { exitCode: 0, stdout: jsonPayload({ ok: true, ...summary }), stderr: "" };
    return {
      exitCode: 0,
      stdout: `${[
        `progressive-cms (${config.nodeEnv})`,
        `db: ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database} ssl=${config.db.sslMode}`,
        `http: ${config.http.host}:${config.http.port}`,
        `media: ${config.media === undefined ? "disabled" : "configured"}`,
        `theme: ${config.themes?.renderDir ?? "not configured"}`,
        "",
      ].join("\n")}`,
      stderr: "",
    };
  } catch (error) {
    return failureResult(error, options);
  }
}

export function capabilitiesCommand(invocation: DiagnosticsInvocation): CliCommandResult {
  const { options } = invocation;
  const payload = {
    ok: true,
    contract_versions: {
      theme: THEME_CONTRACT_VERSION,
      block_document: BLOCK_DOCUMENT_SCHEMA_VERSION,
      bundle: 1,
    },
    limits: { blocks_per_document: MAX_BLOCKS_PER_DOCUMENT },
    permissions: PERMISSION_REGISTRY.map((definition) => ({
      key: definition.key,
      summary: definition.summary,
    })),
  };
  if (options.json) return { exitCode: 0, stdout: jsonPayload(payload), stderr: "" };
  return {
    exitCode: 0,
    stdout: `${[
      `capabilities (theme ${THEME_CONTRACT_VERSION}, block document ${BLOCK_DOCUMENT_SCHEMA_VERSION}):`,
      ...PERMISSION_REGISTRY.map((definition) => `  ${definition.key} — ${definition.summary}`),
      "",
    ].join("\n")}`,
    stderr: "",
  };
}

/**
 * Capability binding (ADR-0017 S4): resolve the installed extension that
 * contributes the `research.search` operation capability by reading the
 * deployed manifests — no extension id is hardcoded in the CLI.
 */
function researchExtensionIdFromCatalog(cwd: string): string | undefined {
  const root = join(cwd, "extensions");
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const manifestPath = join(root, entry.name, "manifest.json");
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        id?: string;
        registrations?: {
          operations?: readonly { capability?: string }[];
        };
      };
      const contributes = (manifest.registrations?.operations ?? []).some(
        (operation) => operation.capability === "research.search",
      );
      if (contributes && manifest.id !== undefined) return manifest.id;
    } catch {
      // unreadable manifest — not the research provider, keep scanning
    }
  }
  return undefined;
}
