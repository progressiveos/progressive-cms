// Local operator recovery commands (PCMS-AUTH-T026; Auth spec §10/§26/§62/
// §63).
//
// `cms user …`, `cms session revoke-all`, `cms token revoke` — break-glass
// capabilities requiring LOCAL operator access to the deployment's config,
// secrets and database. Not a universal backdoor: no hidden HTTP endpoint,
// no master password; the operator can only do what the machine's admin
// could already do, and every action writes a security audit event with the
// OPERATOR actor. Passwords arrive via stdin (never argv — process listings
// are readable by every local user).
import { readFileSync } from "node:fs";
import {
  createMachineIdentityService,
  createPasswordCredentialService,
  createPasswordPolicy,
  createProvisioningService,
  createRoleService,
  createSessionService,
  createThrottleService,
  createTotpService,
  createUserIdentityService,
  recordSecurityEvent,
} from "@pcms/auth";
import {
  buildDbConnectionInfo,
  createDbPool,
  type DbPool,
  loadConfig,
  loadSecrets,
} from "@pcms/core";

export interface UserAdminInvocation {
  readonly args: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  /** Test injection: replaces reading stdin for password prompts. */
  readonly stdin?: string;
}

export interface UserAdminResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export async function userAdmin(invocation: UserAdminInvocation): Promise<UserAdminResult> {
  const [subcommand, ...rest] = invocation.args;
  switch (subcommand) {
    case "create-owner":
      return runWithPool(invocation, rest, (services, flags) =>
        createOwner(services, flags, invocation.stdin),
      );
    case "reset-password":
      return runWithPool(invocation, rest, (services, flags) =>
        resetPassword(services, flags, invocation.stdin),
      );
    case "disable":
      return runWithPool(invocation, rest, (services, flags) => disableUser(services, flags));
    case "disable-mfa":
      return runWithPool(invocation, rest, (services, flags) => disableMfa(services, flags));
    default:
      return usage();
  }
}

export async function sessionAdmin(invocation: UserAdminInvocation): Promise<UserAdminResult> {
  const [subcommand, ...rest] = invocation.args;
  if (subcommand !== "revoke-all") return sessionUsage();
  return runWithPool(invocation, rest, async (services, flags) => {
    const user = await lookupUser(services, flags);
    const revoked = await services.sessions.revokeAllForUser(
      user.id,
      "operator:session revoke-all",
    );
    return ok({ revoked }, flags.json === true);
  });
}

export async function tokenAdmin(invocation: UserAdminInvocation): Promise<UserAdminResult> {
  const [subcommand, ...rest] = invocation.args;
  if (subcommand !== "revoke") return tokenUsage();
  return runWithPool(invocation, rest, async (services, flags) => {
    const tokenId = flags["token-id"];
    if (tokenId === undefined) throw new Error("--token-id is required");
    await services.machines.revokeAccessToken(tokenId, "operator:token revoke");
    return ok({ revoked: tokenId }, flags.json === true);
  });
}

interface Services {
  pool: DbPool;
  env: Record<string, string | undefined>;
  cwd: string;
  users: ReturnType<typeof createUserIdentityService>;
  sessions: ReturnType<typeof createSessionService>;
  machines: ReturnType<typeof createMachineIdentityService>;
}

type FlagMap = Record<string, string | undefined> & { json?: boolean };

async function runWithPool(
  invocation: UserAdminInvocation,
  args: readonly string[],
  work: (services: Services, flags: FlagMap) => Promise<UserAdminResult>,
): Promise<UserAdminResult> {
  let flags: FlagMap;
  try {
    flags = parseFlags(args);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `error: ${(error as Error).message}\n` };
  }
  const env = invocation.env ?? process.env;
  const cwd = invocation.cwd ?? process.cwd();
  let pool: DbPool | null = null;
  try {
    const config = loadConfig(
      flags.config === undefined ? { env, cwd } : { file: flags.config, env, cwd },
    );
    const secrets = loadSecrets(config.secrets, env);
    pool = createDbPool({ connectionInfo: buildDbConnectionInfo(config.db, secrets), max: 1 });
    const services: Services = {
      pool,
      env,
      cwd,
      users: createUserIdentityService(pool),
      sessions: createSessionService(pool, {
        securitySink: null,
      }),
      machines: createMachineIdentityService(pool),
    };
    return await work(services, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.json === true) {
      return {
        exitCode: 1,
        stdout: `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`,
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `error: ${message}\n` };
  } finally {
    if (pool !== null) await pool.end();
  }
}

async function lookupUser(services: Services, flags: FlagMap) {
  const email = flags.email;
  if (email === undefined) throw new Error("--email is required");
  const found = await services.users.findUserByEmail(email);
  if (found === null) throw new Error(`no user with email ${email}`);
  return found.user;
}

async function createOwner(
  services: Services,
  flags: FlagMap,
  stdin: string | undefined,
): Promise<UserAdminResult> {
  const email = flags.email;
  const name = flags.name;
  if (email === undefined || name === undefined) {
    throw new Error("--email and --name are required");
  }
  const password = readPassword(stdin, "owner password");

  const provisioning = createProvisioningService(services.pool, {
    users: services.users,
    passwords: createPasswordCredentialService(services.pool),
    policy: createPasswordPolicy(),
    roles: createRoleService(services.pool),
  });
  const owner = await provisioning.bootstrapOwner({ displayName: name, email, password });
  return ok({ "owner id": owner.id, email }, flags.json === true);
}

async function resetPassword(
  services: Services,
  flags: FlagMap,
  stdin: string | undefined,
): Promise<UserAdminResult> {
  const user = await lookupUser(services, flags);
  const password = readPassword(stdin, "new password");
  const passwords = createPasswordCredentialService(services.pool);
  const policy = createPasswordPolicy();
  await policy.validate(password);
  const verifier = await passwords.hashPassword(password);
  await passwords.setPassword(user.id, verifier);
  await services.sessions.revokeAllForUser(user.id, "operator:password reset");
  await recordSecurityEvent(services.pool, null, {
    type: "PASSWORD_RESET",
    actorType: "OPERATOR",
    actorId: "operator:cli",
    subjectType: "user",
    subjectId: user.id,
    transport: "operator",
    metadata: { reason: "local_operator_recovery" },
  });
  return ok({ "password reset": user.id, "sessions revoked": "all" }, flags.json === true);
}

async function disableUser(services: Services, flags: FlagMap): Promise<UserAdminResult> {
  const user = await lookupUser(services, flags);
  await services.users.disableUser(user.id); // last-OWNER invariant enforced inside
  await services.sessions.revokeAllForUser(user.id, "operator:user disable");
  await recordSecurityEvent(services.pool, null, {
    type: "USER_DISABLED",
    actorType: "OPERATOR",
    actorId: "operator:cli",
    subjectType: "user",
    subjectId: user.id,
    transport: "operator",
  });
  return ok({ disabled: user.id }, flags.json === true);
}

async function disableMfa(services: Services, flags: FlagMap): Promise<UserAdminResult> {
  const user = await lookupUser(services, flags);
  const config = loadConfig(
    flags.config === undefined
      ? { env: services.env, cwd: services.cwd }
      : { file: flags.config, env: services.env, cwd: services.cwd },
  );
  const secrets = loadSecrets(config.secrets, services.env);
  // The TOTP encryption key is only needed to ENROLL/verify; disabling rows
  // works without it, so a deployment that never enabled TOTP still works.
  const totpKey = secrets.get("auth.totpEncryptionKey");
  const totp = createTotpService(services.pool, {
    ...(totpKey === undefined ? {} : { encryptionKey: totpKey }),
    throttle: createThrottleService(services.pool),
  });
  await totp.disableTotp(user.id, "operator:cli");
  await services.sessions.revokeAllForUser(user.id, "operator:mfa reset");
  return ok({ "mfa disabled": user.id, "sessions revoked": "all" }, flags.json === true);
}

function parseFlags(args: readonly string[]): FlagMap {
  const flags: FlagMap = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === "--json") flags.json = true;
    else if (arg === "--email" || arg === "--name" || arg === "--config" || arg === "--token-id") {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      flags[arg.slice(2)] = value;
      i += 1;
    } else throw new Error(`unexpected argument "${arg}"`);
  }
  return flags;
}

function readPassword(stdin: string | undefined, prompt: string): string {
  const raw = stdin !== undefined ? stdin : readFileSync(0, "utf8");
  const password = raw.replace(/\r?\n$/, "");
  if (password.length === 0) {
    throw new Error(`${prompt} was not provided on stdin`);
  }
  return password;
}

function ok(payload: Record<string, unknown>, json: boolean): UserAdminResult {
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

function usage(): UserAdminResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: [
      "usage: cms user <subcommand> [flags]",
      "",
      "Local operator recovery (Auth spec §62; every action is audited):",
      "  user create-owner --email <e> --name <n> [--config <p>] [--json]",
      "      bootstrap the first OWNER; password read from stdin",
      "  user reset-password --email <e> [--config <p>] [--json]",
      "      set a new password (stdin); revokes all of the user's sessions",
      "  user disable --email <e> [--config <p>] [--json]",
      "      disable the account and revoke its sessions",
      "  user disable-mfa --email <e> [--config <p>] [--json]",
      "      operator MFA reset: disable TOTP and revoke sessions",
      "",
    ].join("\n"),
  };
}

function sessionUsage(): UserAdminResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: "usage: cms session revoke-all --email <e> [--config <p>] [--json]\n",
  };
}

function tokenUsage(): UserAdminResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: "usage: cms token revoke --token-id <uuid> [--config <p>] [--json]\n",
  };
}
