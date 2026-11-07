// Entrypoint of the existing privileged install unit's extension branch.
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDbConnectionInfo,
  createDbPool,
  loadConfig,
  loadSecrets,
  resolveLocalHttpUrl,
  systemClock,
} from "@pcms/core";
import {
  INSTALLATIONS_TABLE,
  latestUpdateRecord,
  recordFailedUpdateAttempt,
  releaseUpdateLease,
} from "@pcms/extensions/internal";
import { resolveReleaseIdentity } from "@pcms/operations";
import {
  type IndependentUpdateIntent,
  runIndependentExtensionUpdate,
} from "./independent-update-controller.js";

async function main(): Promise<void> {
  if (process.getuid?.() !== 0)
    throw new Error("extension activation requires the privileged installer");
  const release = resolveReleaseIdentity(fileURLToPath(import.meta.url));
  if (release.mode !== "release")
    throw new Error("extension activation requires an installed Core release");
  const configFile = process.argv[2] ?? "/etc/progressive-cms/pcms.json";
  const incomingDir = process.argv[3] ?? "/opt/progressive-cms/incoming";
  const intentPath = join(incomingDir, "extension-update.json");
  const intentStat = lstatSync(intentPath);
  if (!intentStat.isFile() || intentStat.isSymbolicLink() || intentStat.size > 64 * 1024)
    throw new Error("invalid or oversized extension update intent");
  const intent = JSON.parse(readFileSync(intentPath, "utf8")) as IndependentUpdateIntent;
  const config = loadConfig({ file: configFile, env: process.env, cwd: release.root });
  const deployment = config.registry?.independentExtensions;
  if (!deployment) throw new Error("independent extension deployment is not configured");
  const pool = createDbPool({
    connectionInfo: buildDbConnectionInfo(config.db, loadSecrets(config.secrets, process.env)),
    max: 4,
  });
  try {
    await runIndependentExtensionUpdate({
      pool,
      currentRoot: release.root,
      currentSymlink: "/opt/progressive-cms/current",
      incomingDir,
      storeDir: deployment.rootDir,
      trustFile: deployment.trustFile,
      configFile,
      healthUrl: resolveLocalHttpUrl(config.http.host, config.http.port),
      intent,
      ...(config.nodeEnv === "production" ? {} : { allowDev: true }),
    });
  } catch (error) {
    const latest = await latestUpdateRecord(pool, { requestId: intent.leaseId });
    if (latest?.validationSummary.update_lease_id !== intent.leaseId)
      await recordFailedUpdateAttempt(pool, systemClock, {
        from_version:
          (
            await pool.query<{ version: string }>(
              `SELECT version FROM ${INSTALLATIONS_TABLE} WHERE extension_id = $1`,
              [intent.extensionId],
            )
          ).rows[0]?.version ?? "0.0.0",
        to_version: intent.version,
        actor: intent.actor ?? { type: "system" },
        failure_code: "UPDATE_POSTFLIGHT_FAILED",
        validation_summary: {
          product: {
            kind: "extension",
            id: intent.extensionId,
            coreVersion: release.identity.version,
          },
          update_lease_id: intent.leaseId,
        },
      });
    throw error;
  } finally {
    await releaseUpdateLease(pool, intent.leaseId);
    try {
      if (
        (JSON.parse(readFileSync(intentPath, "utf8")) as IndependentUpdateIntent).leaseId ===
        intent.leaseId
      )
        unlinkSync(intentPath);
    } catch {
      /* only consume our own intent */
    }
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(
    "extension activation failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
