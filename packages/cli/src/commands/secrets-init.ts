// Local operator provisioning for the Integration Hub runtime secret store
// (owner task §33/§34): `cms integrations secrets init`.
//
// Idempotent: generates and persists a cryptographically secure 32-byte
// AES-256-GCM key through the canonical server secret channel (0600 file
// under /etc/progressive-cms/secrets on a standard deployment) and wires
// `integrations.runtimeSecretsEncryptionKeySecretRef` in the config file.
// When the ref is already configured the command VERIFIES and no-ops — it
// never regenerates an existing key, because that would destroy every
// encrypted connector secret. The key value is never printed, never sent
// over HTTP, and never logged.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSecretBox } from "@pcms/auth";
import {
  type AppConfig,
  loadConfig,
  loadSecrets,
  resolveConfigFile,
  type SecretRef,
} from "@pcms/core";
import { type CliCommandResult, failureResult, type GlobalOptions } from "../framework.js";

const USAGE = `usage: cms integrations secrets init [--config <path>] [--secret-dir <dir>] [--json]
  Generates the runtime-secrets encryption key on first run (idempotent no-op
  when already configured). Local operation: reads/writes the deployment
  config + secret files directly, no API token needed.
`;

/** Canonical secret ref name — matches the clean-install config template. */
const SECRET_REF = "integrations.runtimeSecretsEncryptionKey";

export async function integrationsSecretsInit(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  try {
    const flags = parseFlags(args);
    const json = options.json === true || flags.json === true;
    const configPath = resolveConfigFile({
      ...(options.config === undefined ? {} : { file: options.config }),
      env,
      cwd: process.cwd(),
    });
    const config = loadConfig({ file: configPath, env });
    const ref = config.integrations?.runtimeSecretsEncryptionKeySecretRef;
    if (ref !== undefined) {
      const existing = loadSecrets(config.secrets, env).get(ref);
      if (existing === undefined) {
        throw new Error(
          `secret "${ref}" is referenced but cannot be loaded; restore the secret file ` +
            "instead of regenerating — a new key would lose every encrypted value",
        );
      }
      createSecretBox(existing); // validates the 32-byte decode, prints nothing
      return report(json, {
        status: "READY",
        action: "none (already configured)",
        ref,
        config: configPath,
      });
    }

    const secretDir =
      flags.secretDir ?? inferSecretDir(config) ?? join(dirname(configPath), "secrets");
    mkdirSync(secretDir, { recursive: true });
    const secretPath = join(secretDir, SECRET_REF);
    if (existsSync(secretPath)) {
      throw new Error(
        `${secretPath} already exists but is not referenced by the config; reference it ` +
          "manually instead of regenerating (a new key would lose encrypted values)",
      );
    }
    const key = randomBytes(32).toString("base64");
    writeFileSync(secretPath, `${key}\n`, { mode: 0o600 });
    chmodSync(secretPath, 0o600);

    // Wire the canonical config keys (idempotent merge, 2-space JSON).
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const secretsMap = (raw["secrets"] ?? {}) as Record<string, unknown>;
    secretsMap[SECRET_REF] = { file: secretPath };
    raw["secrets"] = secretsMap;
    const integrationsMap = (raw["integrations"] ?? {}) as Record<string, unknown>;
    integrationsMap["runtimeSecretsEncryptionKeySecretRef"] = SECRET_REF;
    raw["integrations"] = integrationsMap;
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);

    // Validate end-to-end: a fresh load must produce a working box.
    const reloaded = loadConfig({ file: configPath, env });
    const keySecret = loadSecrets(reloaded.secrets, env).get(SECRET_REF);
    if (keySecret === undefined) throw new Error("generated key failed to load — aborting");
    const box = createSecretBox(keySecret);
    const probe = box.encrypt("probe");
    if (box.decrypt(probe) !== "probe")
      throw new Error("generated key failed the round-trip check");
    return report(json, {
      status: "READY",
      action: "generated",
      ref: SECRET_REF,
      secret_file: secretPath,
      config: configPath,
      note: "restart web and worker so both processes pick up the new key",
    });
  } catch (error) {
    return failureResult(error, options);
  }
}

function inferSecretDir(config: AppConfig): string | null {
  for (const ref of Object.values(config.secrets) as readonly SecretRef[]) {
    if (typeof ref?.file === "string") return dirname(ref.file);
  }
  return null;
}

interface Flags {
  readonly secretDir?: string;
  readonly json?: boolean;
}

function parseFlags(args: readonly string[]): Flags {
  const flags: { secretDir?: string; json?: boolean } = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === "--json") flags.json = true;
    else if (arg === "--secret-dir") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("missing value for --secret-dir");
      flags.secretDir = value;
      i += 1;
    } else throw new Error(`unexpected argument "${arg}"`);
  }
  return flags;
}

function report(json: boolean, payload: Record<string, unknown>): CliCommandResult {
  if (json) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true, ...payload }, null, 2)}\n`,
      stderr: "",
    };
  }
  const lines = Object.entries(payload).map(([key, value]) => `${key}: ${String(value)}`);
  return { exitCode: 0, stdout: `${["ok", ...lines].join("\n")}\n`, stderr: "" };
}

export { USAGE as secretsInitUsage };
