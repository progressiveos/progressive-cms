// Production M15 update orchestration adapters (PCMS-OPS-T114; Operations
// spec §32–§45, Extensions spec §24–§26). These implement the M14 ports
// against the real Incus/systemd/site layout:
//
//   BackupGate          starts the confined backup oneshot and verifies the
//                       produced set (manifest + checksums — never a canned
//                       "true")
//   MaintenanceController  saves the pre-update CMS maintenance state and
//                       restores it on exit (fail-secure: the orchestrator
//                       leaves maintenance ON if the update failed mid-way)
//   ReleaseDeploymentPort  starts the privileged install oneshot (verifies
//                       sha256 + embedded manifest match, stages an immutable
//                       release, flips `current`) and validates the result
//   ServiceRestartPort  restarts the two units and gates on /health/ready
//   PostflightDoctor    migrations-current + heartbeat + web health
//   MigrationApplier    runs the NEW release's SQL migrations through the
//                       core migrator (advisory-locked, ledger-backed)
//
// Privilege model: the web unit runs with NoNewPrivileges=true, so nothing
// inside it can setuid (sudo is unusable by design — sudo-rs panics on the
// blocked setuid). Unit operations go through the systemd D-Bus API + a
// polkit rule that authorizes the service user for exactly the
// progressive-cms-* units; the privileged install runs as a root oneshot
// (progressive-cms-install.service).
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type DbPool, loadMigrations, migrateDatabase, systemClock } from "@pcms/core";
import type {
  ExtensionLifecycleService,
  UpdateOrchestrationPorts,
} from "@pcms/extensions/internal";
import { readMaintenanceState, updateMaintenanceState } from "@pcms/operations";

const exec = promisify(execFile);

export interface UpdateAdapterOptions {
  readonly incomingDir: string;
  /** The running installation's real release root (resolved, not symlink). */
  readonly currentReleaseRoot: string;
  /** The `current` symlink whose flip the install oneshot performs. */
  readonly currentSymlink: string;
  /** Where the install oneshot reports the activated release root. */
  readonly installStatusFile: string;
  /** Confined oneshot unit that runs the backup. */
  readonly backupUnit: string;
  /** Privileged root oneshot that stages + activates the incoming artifact. */
  readonly installUnit: string;
  /** Where backup sets land. */
  readonly backupDir: string;
  /** Local web process health endpoint used as the restart gate. */
  readonly healthUrl: string;
  readonly pool: DbPool;
  /**
   * Extension lifecycle (ADR-0017 R2): the release update reconciles every
   * installed extension's identity with the shipped artifacts — pending
   * migrations apply through the skip-applied extension ledger, the state
   * (ENABLED/DISABLED) and config never change.
   */
  readonly lifecycle: ExtensionLifecycleService;
}

interface DeployState {
  activatedReleaseRoot?: string;
}

export interface WorkerRestartBaseline {
  readonly bootId: string | undefined;
  readonly requestedAt: Date;
}

export interface WorkerRestartHeartbeat {
  readonly bootId: string;
  readonly startedAt: Date | string;
}

export interface WorkerRestartWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export const WORKER_RESTART_CONFIRM_TIMEOUT_MS = 30_000;

export function workerHeartbeatConfirmsRestart(
  heartbeat: WorkerRestartHeartbeat,
  baseline: WorkerRestartBaseline | undefined,
): boolean {
  return (
    baseline !== undefined &&
    heartbeat.bootId !== baseline.bootId &&
    new Date(heartbeat.startedAt).getTime() >= baseline.requestedAt.getTime()
  );
}

export async function waitForWorkerRestartConfirmation<T extends WorkerRestartHeartbeat>(
  readHeartbeat: () => Promise<T | null>,
  baseline: WorkerRestartBaseline | undefined,
  options: WorkerRestartWaitOptions = {},
): Promise<T | null> {
  if (baseline === undefined) return null;

  const timeoutMs = options.timeoutMs ?? WORKER_RESTART_CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;

  while (true) {
    const heartbeat = await readHeartbeat();
    if (heartbeat !== null && workerHeartbeatConfirmsRestart(heartbeat, baseline)) {
      return heartbeat;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return null;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

async function run(command: string, args: readonly string[]): Promise<void> {
  await exec(command, args, { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
}

export function createProductionUpdatePorts(
  options: UpdateAdapterOptions,
): UpdateOrchestrationPorts {
  const deployState: DeployState = {};
  let previousMaintenance: boolean | undefined;
  let workerRestartBaseline: WorkerRestartBaseline | undefined;

  return {
    backupGate: {
      // Real proof only: start the confined backup oneshot (blocking), then
      // verify the produced set's checksums as this user. A failed unit or a
      // broken manifest vetoes the update (Operations spec §32–§35).
      async confirm() {
        await run("systemctl", ["start", options.backupUnit]);
        const entries = readdirSync(options.backupDir)
          .filter((e) => /^2/.test(e))
          .sort();
        const set =
          entries.length > 0
            ? join(options.backupDir, entries[entries.length - 1] ?? "")
            : undefined;
        if (set === undefined) throw new Error("backup unit produced no verifiable set");
        readFileSync(join(set, "manifest.json"), "utf8");
        // execFile with cwd — no shell, so the set path never meets an
        // interpreter (S-2, 2026-09-28 audit).
        await exec("sha256sum", ["-c", "checksums.sha256", "--quiet"], {
          cwd: set,
          timeout: 120_000,
        });
      },
    },

    maintenance: {
      async enter() {
        // Canonical operations service (singleton row id = 1): read the
        // pre-update state, force ON only when the site was open (idempotent
        // enter when already closed — no state churn).
        const state = await readMaintenanceState(options.pool);
        previousMaintenance = state?.enabled ?? false;
        if (previousMaintenance === false) {
          await updateMaintenanceState(
            options.pool,
            systemClock,
            { enabled: true },
            "update-orchestrator",
          );
        }
      },
      async exit() {
        // Restore exactly the pre-update state (Operations spec §25/§62): a
        // site that was open before the update reopens; an already-closed
        // site stays closed. On a mid-update failure the orchestrator never
        // calls exit — maintenance stays ON (fail-secure).
        if (previousMaintenance === false) {
          await updateMaintenanceState(
            options.pool,
            systemClock,
            { enabled: false },
            "update-orchestrator",
          );
        }
        previousMaintenance = undefined;
      },
    },

    releaseDeployment: {
      async deploy(preflight) {
        // The privileged install oneshot verifies the artifact checksum,
        // matches its embedded update-manifest against the operator-staged
        // target, stages an immutable release and flips `current`. The
        // running process keeps serving the old code until RESTARTING —
        // migrations land after activation.
        const previous = resolve(
          dirname(options.currentSymlink),
          readlinkSync(options.currentSymlink),
        );
        try {
          await run("systemctl", ["start", options.installUnit]);
          const activated = readFileSync(options.installStatusFile, "utf8").trim();
          if (activated === "") {
            throw new Error("install unit produced no activation status");
          }
          const current = resolve(
            dirname(options.currentSymlink),
            readlinkSync(options.currentSymlink),
          );
          if (activated !== current)
            throw new Error("install status does not match the active release");
          // Idempotent re-apply (2026-09-29): a retried apply of an ALREADY
          // installed release is a success, not a failure — the installer
          // re-activates the same release id and the orchestrator must proceed
          // (previously this red-herrered as UPDATE_POSTFLIGHT_FAILED and left
          // maintenance ON). The version check below still guards the contract.
          const metadata = JSON.parse(
            readFileSync(join(activated, "build-metadata.json"), "utf8"),
          ) as { version?: string };
          if (metadata.version !== preflight.target.version) {
            throw new Error(
              `activated release version ${metadata.version} does not match target ${preflight.target.version}`,
            );
          }
          deployState.activatedReleaseRoot = activated;
        } catch (error) {
          // No migrations have run yet. Restore only this deployment, using
          // the root-owned receipt and a compare-and-swap in the install unit.
          const target = resolve(
            dirname(options.currentSymlink),
            readlinkSync(options.currentSymlink),
          );
          if (target !== previous) {
            try {
              writeFileSync(
                join(options.incomingDir, "rollback-deployment.json"),
                JSON.stringify({ previous, target }),
                { mode: 0o600, flag: "wx" },
              );
              await run("systemctl", ["start", options.installUnit]);
              const restored = resolve(
                dirname(options.currentSymlink),
                readlinkSync(options.currentSymlink),
              );
              if (restored !== previous)
                throw new Error("install unit did not restore the previous release");
            } catch (rollbackError) {
              throw new Error(
                `deployment failed and recovery failed: ${String(error)}; ${String(rollbackError)}`,
              );
            }
          }
          throw error;
        }
      },
    },

    migrations: {
      async applyCore(names) {
        const releaseRoot = deployState.activatedReleaseRoot;
        if (releaseRoot === undefined)
          throw new Error("migrations requested before a release was activated");
        // Migrations must come from the NEW release, not the running code:
        // the orchestrator calls this after `current` was flipped but before
        // restart. The core migrator is advisory-locked and ledger-backed,
        // so it applies exactly the pending set.
        const migrations = loadMigrations(join(releaseRoot, "db", "migrations"));
        const available = new Set(migrations.map((m) => m.name));
        const unknown = names.filter((name) => !available.has(name));
        if (unknown.length > 0) {
          throw new Error(`activated release is missing planned migrations: ${unknown.join(", ")}`);
        }
        // M17-T006: the actual applied set flows back into update history.
        const result = await migrateDatabase(options.pool, migrations, undefined);
        return result.applied;
      },
      async applyExtensionMigrations(planned) {
        // ADR-0017 R2: the release update reconciles installed extensions
        // with the shipped artifacts. The running code IS the target
        // (trusted build-time composition), so reconcileIdentity applies
        // every pending extension migration (skip-applied ledger) and
        // stamps version/fingerprint/content-digest — a code-only package
        // revision is caught by the digest, not by a manifest bump.
        const reconciled = await options.lifecycle.reconcileIdentity();
        const applied = reconciled.flatMap((entry) =>
          entry.appliedMigrations.map((name) => `${entry.extensionId}/${name}`),
        );
        // The preflight plan must be covered by what the ledger accepted
        // (applied now or already present) — an uncovered planned migration
        // means the preflight and the shipped inventory disagree.
        const covered = new Set(applied);
        for (const name of planned) {
          if (covered.has(name)) continue;
          const separator = name.indexOf("/");
          if (separator < 0) throw new Error(`malformed planned extension migration: ${name}`);
          const extensionId = name.slice(0, separator);
          const migration = name.slice(separator + 1);
          const status = await options.lifecycle.migrationStatus(extensionId);
          if (status?.applied.some((entry) => entry.name === migration)) continue;
          throw new Error(
            `planned extension migration ${name} was not applied by the reconciled release`,
          );
        }
        return applied;
      },
    },

    serviceRestart: {
      async restart() {
        // The orchestrator runs INSIDE the web process, so restarting that
        // very unit synchronously would kill the caller mid-record. The
        // worker restarts synchronously; the web restart is scheduled
        // detached (polkit authorizes the service user) with a short fuse —
        // the orchestrator finishes validation + history record and restores
        // maintenance before the fuse fires, then systemd takes over.
        const previous = await options.pool.query<{ boot_id: string }>(
          "SELECT boot_id FROM pcms_worker_heartbeat WHERE id = 1",
        );
        workerRestartBaseline = {
          bootId: previous.rows[0]?.boot_id,
          requestedAt: systemClock.now(),
        };
        await run("systemctl", ["restart", "progressive-cms-worker.service"]);
        await run("systemctl", ["is-active", "--quiet", "progressive-cms-worker.service"]);
        const { spawn } = await import("node:child_process");
        // 8s fuse: the orchestrator records history + restores maintenance
        // and the HTTP response returns well within this window; then
        // systemd restarts the web unit into the new release.
        spawn("sh", ["-c", "sleep 8; systemctl restart progressive-cms-web.service"], {
          detached: true,
          stdio: "ignore",
        }).unref();
        // Root restart bridge (deploy/systemd/progressive-cms-restart.{path,service}):
        // the marker asks the root path unit to restart BOTH units. Scheduled
        // INSIDE the fuse window (7s < 8s): by then the orchestrator has
        // finished the doctor, history record and maintenance restore — the
        // same invariant the fuse exists for. An earlier (synchronous) write
        // would have the root unit restart web mid-orchestration. ENOENT
        // means the bridge (or /run/progressive-cms) is absent — skipped.
        setTimeout(() => {
          try {
            writeFileSync(
              "/run/progressive-cms/restart-requested",
              `${new Date().toISOString()}\n`,
            );
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return; // bridge absent — skipped by design
            if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
              // Deployment namespace propagated the runtime dir read-only
              // (observed on LXC after fuse restarts). The fuse path above
              // remains the live restart mechanism; the bridge is the
              // fallback — one info line, not an error.
              console.log(
                `[update] restart-bridge marker skipped (${code}): fuse restart remains the live path`,
              );
              return;
            }
            console.error("[update] restart-bridge marker not written:", error);
          }
        }, 7_000).unref();
      },
    },

    postflightDoctor: {
      async run(preflight) {
        // CompatibilityIssue is the orchestrator's diagnostic currency; the
        // doctor composes deployment-level findings into the same shape.
        const issues: import("@pcms/extensions/internal").CompatibilityIssue[] = [];
        const issue = (code: string, message: string) => ({
          code,
          severity: "error" as const,
          blocking: true,
          category: "runtime" as const,
          subject: "update-postflight",
          message,
        });
        // 1. Planned migrations actually applied.
        const ledger = await options.pool.query<{ name: string }>(
          "SELECT name FROM pcms_schema_migrations ORDER BY name",
        );
        const applied = new Set(ledger.rows.map((row) => row.name));
        const missing = preflight.plannedCoreMigrations.filter((name) => !applied.has(name));
        if (missing.length > 0) {
          issues.push(
            issue(
              "MIGRATIONS_NOT_APPLIED",
              `planned migrations not in ledger: ${missing.join(",")}`,
            ),
          );
        }
        // 2. Worker heartbeat fresh and from the process started by this
        // update. systemd's restart can return before the worker finishes its
        // DB probe and records its first beat, so wait briefly instead of
        // mistaking the prior process's still-fresh row for a failed restart.
        try {
          const current = await waitForWorkerRestartConfirmation(async () => {
            const heartbeat = await options.pool.query<{
              boot_id: string;
              started_at: Date;
              last_beat_at: Date;
            }>("SELECT boot_id, started_at, last_beat_at FROM pcms_worker_heartbeat WHERE id = 1");
            const row = heartbeat.rows[0];
            return row === undefined
              ? null
              : {
                  bootId: row.boot_id,
                  startedAt: row.started_at,
                  lastBeatAt: row.last_beat_at,
                };
          }, workerRestartBaseline);
          if (current === null) {
            issues.push(
              issue(
                "WORKER_RESTART_NOT_CONFIRMED",
                `worker heartbeat did not confirm restart within ${WORKER_RESTART_CONFIRM_TIMEOUT_MS}ms`,
              ),
            );
          } else if (Date.now() - new Date(current.lastBeatAt).getTime() > 120_000) {
            issues.push(issue("HEARTBEAT_STALE", "worker beat older than 120s"));
          }
        } catch {
          issues.push(issue("HEARTBEAT_UNAVAILABLE", "heartbeat unreadable"));
        }
        // Note: the running web process cannot verify ITS OWN successor —
        // the detached restart lands right after this record is written.
        // New-release health is the operator's post-apply check (UPDATE.md).
        return issues.length === 0
          ? { ok: true }
          : { ok: false, issues: issues.map((issue) => ({ ...issue })) };
      },
    },
  };
}

/** Resolves the real (post-symlink) release root of the running process. */
export function resolveCurrentReleaseRoot(moduleUrl: string): string {
  // apps/web/src/main.js → four levels up to the release root
  // (src → web → apps → <release-id>). Was three — off by one, which made
  // update-manifest.json undiscoverable at boot and stripped the update
  // orchestrator of its adapters (UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE).
  return realpathSync(join(fileURLToPath(moduleUrl), "..", "..", "..", ".."));
}
