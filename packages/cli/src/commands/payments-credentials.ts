// `cms payments credentials [status|import] [--json] [--instance <id>]`
// (CORE-PAYMENTS-ADMIN-CONFIG-01 §10.1).
//
// The legacy credential import is an OPERATOR step because it touches the
// process secret channel of this installation: it resolves the old
// payment_provider_instance.secret_refs in memory and encrypts the values into
// the per-connection store with the deployment master key. It never prints a
// value, never writes or deletes operator secret files, and is idempotent.
//
// Exit codes: 0 done/nothing to do, 1 blocked (a reference cannot be
// resolved), 2 usage, 3 the master key is missing.
import {
  buildDbConnectionInfo,
  createDbPool,
  createLogger,
  loadConfig,
  loadSecrets,
} from "@pcms/core";
import { createSecretBox, recordSecurityEvent } from "@pcms/auth";
import { createLegacyCredentialImport } from "@pcms/payments";
import type { CliCommandResult } from "../framework.js";

const USAGE = `usage: cms payments credentials <status|import> [--json] [--instance <id>]
  status   inventory of legacy credential references (no values)
  import   encrypt resolvable references into the per-connection store
`;

export async function paymentsCredentialsCommand(invocation: {
  readonly args: readonly string[];
  readonly file?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args } = invocation;
  const subcommand = args[0];
  if (subcommand !== "status" && subcommand !== "import") {
    return { exitCode: 2, stdout: "", stderr: USAGE };
  }
  const json = args.includes("--json");
  const instanceFlag = args.indexOf("--instance");
  const instanceId = instanceFlag >= 0 ? args[instanceFlag + 1] : undefined;
  const env = invocation.env ?? process.env;
  const cwd = invocation.cwd ?? process.cwd();
  const log = createLogger({
    level: "info",
    base: { process: "cms" },
    ...(json ? { sink: (line: string) => process.stderr.write(line) } : {}),
  });

  try {
    const config =
      invocation.file === undefined
        ? loadConfig({ env, cwd })
        : loadConfig({ file: invocation.file, env, cwd });
    const secrets = loadSecrets(config.secrets, env);
    const pool = createDbPool({
      connectionInfo: buildDbConnectionInfo(config.db, secrets),
      max: 1,
      connectionTimeoutMilliseconds: config.db.pool.connectionTimeoutMilliseconds,
    });
    try {
      const keyRef = config.integrations?.runtimeSecretsEncryptionKeySecretRef;
      const key = keyRef === undefined ? undefined : secrets.get(keyRef);
      const importer = createLegacyCredentialImport({
        pool,
        clock: { now: () => new Date() },
        box: () => (key === undefined ? undefined : createSecretBox(key)),
        legacyResolver: (name) => secrets.get(name),
        // The audited record of an operator import, in the same transaction.
        audit: async (tx, info) => {
          await recordSecurityEvent(tx, null, {
            type: "PAYMENT_CREDENTIAL_IMPORTED",
            actorType: "OPERATOR",
            actorId: "cli",
            subjectType: "payment_provider_instance",
            subjectId: info.instanceId,
            transport: "cli",
            metadata: { slots: info.slots, retired: info.retired, source: "cli" },
          });
        },
      });
      if (subcommand === "status") {
        const plan = await importer.preflight();
        if (json) return { exitCode: 0, stdout: `${JSON.stringify(plan, null, 2)}\n`, stderr: "" };
        return {
          exitCode: 0,
          stdout: [
            "result: LEGACY CREDENTIAL INVENTORY",
            `  master key: ${plan.encryption_key_available ? "present" : "MISSING"}`,
            `  importable: ${plan.importable}  blocked: ${plan.blocked}  skipped: ${plan.skipped}`,
            ...plan.instances.map(
              (entry) =>
                `  - ${entry.name} (${entry.provider_type}): ${entry.action}${
                  entry.reason === null ? "" : ` — ${entry.reason}`
                }`,
            ),
            ...(plan.stale_refs.length === 0
              ? []
              : [`  refs that become unused after import: ${plan.stale_refs.join(", ")}`]),
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      const result = await importer.run(
        instanceId === undefined ? {} : { instanceIds: [instanceId] },
      );
      if (json) return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "" };
      return {
        exitCode: 0,
        stdout: [
          "result: IMPORTED",
          `  instances imported: ${result.imported_instances.length}`,
          `  skipped: ${result.skipped_instances.length}`,
          ...(result.stale_refs.length === 0
            ? []
            : [
                `  operator action: these process secrets are no longer read by Payments — ${result.stale_refs.join(", ")}`,
                "  (verify nothing else uses them before removing them from the deployment secrets)",
              ]),
          "",
        ].join("\n"),
        stderr: "",
      };
    } finally {
      await pool.end();
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      return {
        exitCode: code === "PAYMENT_CREDENTIALS_KEY_MISSING" ? 3 : 1,
        stdout: `${JSON.stringify({ ok: false, code: code ?? null, message }, null, 2)}\n`,
        stderr: "",
      };
    }
    log.error("payments.credentials.failed", { code: code ?? null, message });
    return {
      exitCode: code === "PAYMENT_CREDENTIALS_KEY_MISSING" ? 3 : 1,
      stdout: "",
      stderr: `${code ?? "ERROR"}: ${message}\n`,
    };
  }
}
