// Config loading pipeline (Operations spec §8, §10):
//   JSON file  →  whitelisted environment overrides  →  schema validation
//   →  semantic validation  →  documented defaults
// Any problem raises issues instead of falling back to a (possibly insecure)
// value; nothing is silently dropped.
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import Ajv from "ajv";
import {
  type AppConfig,
  CONFIG_SCHEMA,
  type DbSslMode,
  type LogLevel,
  type NodeEnv,
} from "./schema.js";

export interface ConfigIssue {
  /** Dotted path inside the config document, e.g. "db.port". */
  path: string;
  message: string;
}

export class ConfigError extends Error {
  /** Stable machine-readable family: CONFIG_NOT_FOUND | CONFIG_INVALID. */
  readonly code: "CONFIG_NOT_FOUND" | "CONFIG_INVALID";
  readonly issues: readonly ConfigIssue[];

  constructor(
    code: "CONFIG_NOT_FOUND" | "CONFIG_INVALID",
    message: string,
    issues: readonly ConfigIssue[],
  ) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.issues = issues;
  }
}

export type ConfigValidation =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

const ajv = new Ajv({ allErrors: true });
const validateSchema = ajv.compile<Record<string, unknown>>(CONFIG_SCHEMA);

/**
 * Explicit environment override whitelist. An environment variable starting
 * with PCMS_ that is not listed here (and is not a secret value or the file
 * selector) aborts startup — a typo must never disable a security-critical
 * setting silently.
 */
const ENV_OVERRIDES: ReadonlyMap<
  string,
  { readonly path: readonly string[]; readonly kind: "string" | "int" }
> = new Map([
  ["PCMS_NODE_ENV", { path: ["nodeEnv"], kind: "string" }],
  ["PCMS_HTTP_HOST", { path: ["http", "host"], kind: "string" }],
  ["PCMS_HTTP_PORT", { path: ["http", "port"], kind: "int" }],
  ["PCMS_DB_HOST", { path: ["db", "host"], kind: "string" }],
  ["PCMS_DB_PORT", { path: ["db", "port"], kind: "int" }],
  ["PCMS_DB_NAME", { path: ["db", "database"], kind: "string" }],
  ["PCMS_DB_USER", { path: ["db", "user"], kind: "string" }],
  ["PCMS_DB_SSLMODE", { path: ["db", "sslMode"], kind: "string" }],
  ["PCMS_MIGRATIONS_DIR", { path: ["db", "migrationsDir"], kind: "string" }],
  ["PCMS_LOG_LEVEL", { path: ["log", "level"], kind: "string" }],
]);

function applyEnvOverrides(
  doc: Record<string, unknown>,
  env: Record<string, string | undefined>,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(env)) {
    const value = env[key];
    // Only PCMS_-prefixed variables participate in override machinery;
    // PCMS_SECRET_* values belong to the secret channel (T009) and
    // PCMS_CONFIG_FILE selects the config file itself. The CLI client
    // transport vars (ADR-0014 §10) are consumed by the remote client and
    // must not fail offline commands that also load the deployment config.
    if (value === undefined || !key.startsWith("PCMS_")) continue;
    if (key === "PCMS_CONFIG_FILE" || key.startsWith("PCMS_SECRET_")) continue;
    if (
      key === "PCMS_API_URL" ||
      key === "PCMS_API_TOKEN" ||
      key === "PCMS_SITE_KEY" ||
      key === "PCMS_ENVIRONMENT" ||
      key === "PCMS_TEST_DATABASE_URL" ||
      // Runtime composition flag of the web process (Extension Contract 2.0
      // harness, ADR-0018): a process env, not a config override.
      key === "PCMS_ADMIN_UI_TEST"
    ) {
      continue;
    }
    const override = ENV_OVERRIDES.get(key);
    if (!override) {
      issues.push({
        path: `(env) ${key}`,
        message: `unknown PCMS_ environment variable; known overrides: ${[...ENV_OVERRIDES.keys()].join(", ")}`,
      });
      continue;
    }
    let parsed: string | number = value;
    if (override.kind === "int") {
      if (!/^\d+$/.test(value)) {
        issues.push({
          path: `(env) ${key}`,
          message: `expected a non-negative integer, got "${value}"`,
        });
        continue;
      }
      parsed = Number.parseInt(value, 10);
    }
    let target: Record<string, unknown> = doc;
    const segments = override.path;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      const existing = target[segment];
      if (typeof existing !== "object" || existing === null) {
        const next: Record<string, unknown> = {};
        target[segment] = next;
        target = next;
      } else {
        target = existing as Record<string, unknown>;
      }
    }
    target[segments[segments.length - 1] as string] = parsed;
  }
  return issues;
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function setDefault(target: Record<string, unknown>, key: string, value: unknown): void {
  if (target[key] === undefined) target[key] = value;
}

function applyDefaults(doc: Record<string, unknown>): void {
  const http = objectAt(doc, "http");
  setDefault(http, "host", "127.0.0.1");
  setDefault(http, "port", 3000);
  setDefault(http, "shutdownTimeoutMilliseconds", 10000);
  // Trust nobody by default (M15, Operations spec §20): X-Forwarded-* headers
  // from untrusted peers are ignored until the operator names the proxies.
  if (!Array.isArray(http.trustedProxies)) http.trustedProxies = [];
  // API rate budget (audit F-21): on by default in production-like nodes;
  // test nodes opt out unless they set an explicit value.
  setDefault(http, "apiRateLimitPerMinute", doc.nodeEnv === "test" ? 0 : 1200);
  const db = objectAt(doc, "db");
  setDefault(db, "migrationsDir", "db/migrations");
  const pool = objectAt(db, "pool");
  setDefault(pool, "webMax", 10);
  setDefault(pool, "workerMax", 5);
  setDefault(pool, "connectionTimeoutMilliseconds", 5000);
  setDefault(pool, "idleTimeoutMilliseconds", 30000);
  const log = objectAt(doc, "log");
  setDefault(log, "level", "info");
  // Media limits (M05): restrictive defaults — the directories have no
  // default on purpose (user content never lands in a guessed location).
  if (typeof doc.media === "object" && doc.media !== null) {
    const media = objectAt(doc, "media");
    setDefault(media, "maxUploadBytes", 26214400);
    setDefault(media, "maxVideoUploadBytes", 268435456);
    setDefault(media, "maxAudioUploadBytes", 268435456);
    setDefault(media, "maxImagePixels", 64000000);
    setDefault(media, "maxImageDimension", 16384);
  }
  if (typeof doc.jobs === "object" && doc.jobs !== null) {
    const jobs = objectAt(doc, "jobs");
    setDefault(jobs, "pollIntervalMs", 5000);
    setDefault(jobs, "claimBatchMax", 10);
    setDefault(jobs, "leaseMilliseconds", 300000);
    setDefault(jobs, "maxAttempts", 5);
    setDefault(jobs, "backoffBaseMilliseconds", 2000);
  }
  if (typeof doc.publication === "object" && doc.publication !== null) {
    const publication = objectAt(doc, "publication");
    setDefault(publication, "previewTokenTtlMinutes", 120);
  }
  objectAt(doc, "secrets");
}

function semanticIssues(doc: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const secrets = doc.secrets as Record<string, unknown> | undefined;
  const checkRef = (path: string, ref: unknown): void => {
    if (secrets !== undefined && typeof ref === "string" && !(ref in secrets)) {
      issues.push({
        path,
        message: `references secret "${ref}" which is not defined in secrets`,
      });
    }
  };
  const db = doc.db as Record<string, unknown> | undefined;
  if (db !== undefined) checkRef("db.passwordSecretRef", db.passwordSecretRef);
  // Publication preview key + mail credentials (PCMS-OPS-T110/T114): every
  // secret reference must resolve or the process would crash-loop at boot.
  const publication = doc.publication as Record<string, unknown> | undefined;
  if (publication !== undefined)
    checkRef("publication.previewSecretRef", publication.previewSecretRef);
  const mail = doc.mail as Record<string, unknown> | undefined;
  if (mail !== undefined) {
    checkRef("mail.usernameSecretRef", mail.usernameSecretRef);
    checkRef("mail.passwordSecretRef", mail.passwordSecretRef);
  }
  // Runtime secret store key (PCMS-OPS-T131).
  const integrations = doc.integrations as Record<string, unknown> | undefined;
  if (integrations !== undefined) {
    checkRef(
      "integrations.runtimeSecretsEncryptionKeySecretRef",
      integrations.runtimeSecretsEncryptionKeySecretRef,
    );
  }
  return issues;
}

function toTypedConfig(doc: Record<string, unknown>): AppConfig {
  // Shape was enforced by the schema + defaults; this cast materializes the
  // typed view (conditional fields are copied only when present to satisfy
  // exactOptionalPropertyTypes).
  const db = doc.db as Record<string, unknown>;
  const http = doc.http as Record<string, unknown>;
  const pool = db.pool as Record<string, unknown>;
  const log = doc.log as Record<string, unknown>;
  const passwordSecretRef = db.passwordSecretRef as string | undefined;
  const sslCaFile = db.sslCaFile as string | undefined;
  const result: AppConfig = {
    nodeEnv: doc.nodeEnv as NodeEnv,
    http: {
      host: http.host as string,
      port: http.port as number,
      shutdownTimeoutMilliseconds: http.shutdownTimeoutMilliseconds as number,
      trustedProxies: (http.trustedProxies as string[]) ?? [],
      apiRateLimitPerMinute: http.apiRateLimitPerMinute as number,
      // Audit 2026-09-27 lesson: normalized fields are carried EXPLICITLY —
      // an omitted key silently falls back to the nodeEnv default downstream.
      ...(http.cookieSecure === undefined ? {} : { cookieSecure: http.cookieSecure as boolean }),
    },
    db: {
      host: db.host as string,
      port: db.port as number,
      database: db.database as string,
      user: db.user as string,
      sslMode: db.sslMode as DbSslMode,
      migrationsDir: db.migrationsDir as string,
      pool: {
        webMax: pool.webMax as number,
        workerMax: pool.workerMax as number,
        connectionTimeoutMilliseconds: pool.connectionTimeoutMilliseconds as number,
        idleTimeoutMilliseconds: pool.idleTimeoutMilliseconds as number,
      },
      ...(passwordSecretRef === undefined ? {} : { passwordSecretRef }),
      ...(sslCaFile === undefined ? {} : { sslCaFile }),
    },
    log: { level: log.level as LogLevel },
    secrets: doc.secrets as AppConfig["secrets"],
  };
  const media = doc.media as Record<string, unknown> | undefined;
  const withMedia =
    media === undefined
      ? result
      : {
          ...result,
          media: {
            storageDir: media.storageDir as string,
            quarantineDir: media.quarantineDir as string,
            maxUploadBytes: media.maxUploadBytes as number,
            maxVideoUploadBytes: media.maxVideoUploadBytes as number,
            maxAudioUploadBytes: media.maxAudioUploadBytes as number,
            ...(media.disabledTypes === undefined
              ? {}
              : { disabledTypes: media.disabledTypes as string[] }),
            maxImagePixels: media.maxImagePixels as number,
            maxImageDimension: media.maxImageDimension as number,
          },
        };
  const jobs = doc.jobs as Record<string, unknown> | undefined;
  const withJobs =
    jobs === undefined
      ? withMedia
      : {
          ...withMedia,
          jobs: {
            pollIntervalMs: jobs.pollIntervalMs as number,
            claimBatchMax: jobs.claimBatchMax as number,
            leaseMilliseconds: jobs.leaseMilliseconds as number,
            maxAttempts: jobs.maxAttempts as number,
            backoffBaseMilliseconds: jobs.backoffBaseMilliseconds as number,
          },
        };
  const publication = doc.publication as Record<string, unknown> | undefined;
  const withPublication =
    publication === undefined
      ? withJobs
      : (() => {
          const previewSecretRef = publication.previewSecretRef as string | undefined;
          return {
            ...withJobs,
            publication: {
              previewTokenTtlMinutes: publication.previewTokenTtlMinutes as number,
              ...(previewSecretRef === undefined ? {} : { previewSecretRef }),
            },
          };
        })();
  // M09 sections (PCMS-API-T003): deployment-owned schema/theme sources.
  const content = doc.content as Record<string, unknown> | undefined;
  const typesFile = content?.typesFile as string | undefined;
  const withContent =
    content === undefined
      ? withPublication
      : {
          ...withPublication,
          content: {
            ...(typesFile === undefined ? {} : { typesFile }),
          },
        };
  const themes = doc.themes as Record<string, unknown> | undefined;
  const renderDir = themes?.renderDir as string | undefined;
  const withThemes =
    themes === undefined
      ? withContent
      : {
          ...withContent,
          themes: {
            ...(renderDir === undefined ? {} : { renderDir }),
          },
        };
  // M15 reconciliation: `admin` was declared in CONFIG_SCHEMA (M10) but never
  // copied to the typed config, and `seo` existed only on the TS type — a
  // config file declaring it failed validation. Both sections materialize now.
  const admin = doc.admin as Record<string, unknown> | undefined;
  const distDir = admin?.distDir as string | undefined;
  const withAdmin =
    admin === undefined
      ? withThemes
      : {
          ...withThemes,
          admin: {
            ...(distDir === undefined ? {} : { distDir }),
          },
        };
  const seo = doc.seo as Record<string, unknown> | undefined;
  const environment = seo?.environment as "production" | "staging" | "development" | undefined;
  const withSeo =
    seo === undefined
      ? withAdmin
      : {
          ...withAdmin,
          seo: {
            ...(environment === undefined ? {} : { environment }),
          },
        };
  // Integration Hub runtime secret store key (PCMS-OPS-T131). Materialized
  // BEFORE the mail block: that block has early returns for deployments
  // without mail.from, which used to silently drop a configured
  // integrations key (owner defect §31 — store "not provisioned" even with
  // the key present in the config file).
  // Community skills + artifact registry (Community Skills/Registry plans).
  // Declared in CONFIG_SCHEMA; materialized here — same lost-fields class as
  // the admin/seo note above.
  const skillsDoc = doc.skills as Record<string, unknown> | undefined;
  const communityEnabled = skillsDoc?.communityEnabled as boolean | undefined;
  const communityDir = skillsDoc?.communityDir as string | undefined;
  const withSkills =
    skillsDoc === undefined
      ? withSeo
      : {
          ...withSeo,
          skills: {
            ...(communityEnabled === undefined ? {} : { communityEnabled }),
            ...(communityDir === undefined ? {} : { communityDir }),
          },
        };
  const registryDoc = doc.registry as Record<string, unknown> | undefined;
  const registryBaseUrl = registryDoc?.baseUrl as string | undefined;
  const registryReportUpdates = registryDoc?.reportUpdates as boolean | undefined;
  const withRegistry =
    registryDoc === undefined
      ? withSkills
      : {
          ...withSkills,
          registry: {
            ...(registryBaseUrl === undefined ? {} : { baseUrl: registryBaseUrl }),
            ...(registryReportUpdates === undefined
              ? {}
              : { reportUpdates: registryReportUpdates }),
          },
        };
  const integrationsDoc = doc.integrations as Record<string, unknown> | undefined;
  const runtimeSecretsKeyRef = integrationsDoc?.runtimeSecretsEncryptionKeySecretRef as
    | string
    | undefined;
  const withIntegrations =
    runtimeSecretsKeyRef === undefined
      ? withRegistry
      : {
          ...withRegistry,
          integrations: {
            runtimeSecretsEncryptionKeySecretRef: runtimeSecretsKeyRef,
          },
        };
  // .pcpub ingest tuning (ADR-0014). Materialized BEFORE the mail block:
  // that block has early returns for deployments without mail.from, which
  // would silently drop a configured pcpub section (same defect class as the
  // integrations block above).
  const pcpubDoc = doc.pcpub as Record<string, unknown> | undefined;
  const withPcpub =
    pcpubDoc === undefined
      ? withIntegrations
      : (() => {
          const quarantineDir = pcpubDoc.quarantineDir as string | undefined;
          const limitsDoc = pcpubDoc.limits as Record<string, unknown> | undefined;
          const limits =
            limitsDoc === undefined
              ? undefined
              : (() => {
                  const maxCompressedBytes = limitsDoc.maxCompressedBytes as number | undefined;
                  const maxUncompressedBytes = limitsDoc.maxUncompressedBytes as number | undefined;
                  const maxDocuments = limitsDoc.maxDocuments as number | undefined;
                  const maxAssets = limitsDoc.maxAssets as number | undefined;
                  const maxAssetBytes = limitsDoc.maxAssetBytes as number | undefined;
                  return {
                    ...(maxCompressedBytes === undefined ? {} : { maxCompressedBytes }),
                    ...(maxUncompressedBytes === undefined ? {} : { maxUncompressedBytes }),
                    ...(maxDocuments === undefined ? {} : { maxDocuments }),
                    ...(maxAssets === undefined ? {} : { maxAssets }),
                    ...(maxAssetBytes === undefined ? {} : { maxAssetBytes }),
                  };
                })();
          return {
            ...withIntegrations,
            pcpub: {
              ...(quarantineDir === undefined ? {} : { quarantineDir }),
              ...(limits === undefined || Object.keys(limits).length === 0 ? {} : { limits }),
            },
          };
        })();
  // Outbound mail (PCMS-OPS-T110). Only refs and endpoints are copied — the
  // resolved credentials live in the secrets channel.
  const mail = doc.mail as Record<string, unknown> | undefined;
  if (mail === undefined) return withPcpub;
  const mailTransport = mail.transport as "smtp" | "console" | undefined;
  const mailFrom = mail.from as string | undefined;
  if (mailFrom === undefined) return withPcpub;
  const mailHost = mail.host as string | undefined;
  const mailPort = mail.port as number | undefined;
  const mailMode = mail.mode as "smtps" | "starttls" | "plain" | undefined;
  const mailUsernameSecretRef = mail.usernameSecretRef as string | undefined;
  const mailPasswordSecretRef = mail.passwordSecretRef as string | undefined;
  const mailConnectTimeoutMs = mail.connectTimeoutMs as number | undefined;
  return {
    ...withPcpub,
    mail: {
      ...(mailTransport === undefined ? {} : { transport: mailTransport }),
      from: mailFrom,
      ...(mailHost === undefined ? {} : { host: mailHost }),
      ...(mailPort === undefined ? {} : { port: mailPort }),
      ...(mailMode === undefined ? {} : { mode: mailMode }),
      ...(mailUsernameSecretRef === undefined ? {} : { usernameSecretRef: mailUsernameSecretRef }),
      ...(mailPasswordSecretRef === undefined ? {} : { passwordSecretRef: mailPasswordSecretRef }),
      ...(mailConnectTimeoutMs === undefined ? {} : { connectTimeoutMs: mailConnectTimeoutMs }),
    },
  };
}

/**
 * Validates a raw configuration document (already merged from its sources).
 * Returns every problem found instead of the first one, so an operator sees
 * the full picture in a single pass.
 */
export function validateConfigDocument(input: unknown): ConfigValidation {
  const issues: ConfigIssue[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{ path: "", message: "config must be a JSON object" }],
    };
  }
  const doc = input as Record<string, unknown>;
  if (!validateSchema(doc)) {
    for (const error of validateSchema.errors ?? []) {
      const parent = error.instancePath.replace(/^\//, "").replaceAll("/", ".");
      // "required" errors point at the parent object; attach the missing
      // property so operators get a precise path (db.sslMode, not db).
      const missing =
        error.keyword === "required"
          ? (error.params as { missingProperty?: string }).missingProperty
          : undefined;
      const path = missing ? `${parent ? `${parent}.` : ""}${missing}` : parent || "(root)";
      issues.push({ path, message: error.message ?? "invalid value" });
    }
  }
  issues.push(...semanticIssues(doc));
  if (issues.length > 0) return { ok: false, issues };
  applyDefaults(doc);
  return { ok: true, config: toTypedConfig(doc) };
}

export interface LoadConfigOptions {
  /** Explicit config file path; overrides PCMS_CONFIG_FILE and the default. */
  file?: string;
  /** Environment to consult; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Base directory for relative file paths; defaults to process.cwd(). */
  cwd?: string;
}

/** Resolves the config file location: explicit → PCMS_CONFIG_FILE → ./config/pcms.json. */
export function resolveConfigFile(options: LoadConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const rawFile = options.file ?? env.PCMS_CONFIG_FILE;
  return rawFile
    ? isAbsolute(rawFile)
      ? rawFile
      : resolve(cwd, rawFile)
    : join(cwd, "config", "pcms.json");
}

/** Loads and validates application configuration; throws ConfigError when invalid. */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const file = resolveConfigFile(options);

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError(
      "CONFIG_NOT_FOUND",
      `config file not found: "${file}" — pass --config <path>, set PCMS_CONFIG_FILE, or run from a directory containing ./config/pcms.json`,
      [{ path: "(file)", message: error instanceof Error ? error.message : String(error) }],
    );
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new ConfigError("CONFIG_INVALID", `config file "${file}" is not valid JSON`, [
      { path: "(file)", message: error instanceof Error ? error.message : String(error) },
    ]);
  }

  const overrides = applyEnvOverrides(doc as Record<string, unknown>, env);
  if (overrides.length > 0) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `invalid configuration environment overrides (file: ${file})`,
      overrides,
    );
  }

  const validation = validateConfigDocument(doc);
  if (!validation.ok) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `invalid configuration (file: ${file})`,
      validation.issues,
    );
  }
  return validation.config;
}
