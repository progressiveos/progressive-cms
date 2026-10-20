// Typed application configuration (Operations spec §8–§10).
//
// Fail-secure rules encoded here:
//   - every object sets additionalProperties:false — an unknown
//     security-critical option is rejected, never silently ignored;
//   - `db.sslMode` and `nodeEnv` have no defaults — the operator states them;
//   - secret values never live in this document, only named references into
//     the `secrets` map (values are resolved separately at startup).

export type NodeEnv = "development" | "production" | "test";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type DbSslMode = "disable" | "require" | "verify-full";

/** Points at a secret source; the value itself is never part of config. */
export interface SecretRef {
  env?: string;
  file?: string;
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  http: {
    host: string;
    port: number;
    shutdownTimeoutMilliseconds: number;
    /**
     * Proxy addresses (IP or CIDR) whose X-Forwarded-* headers are trusted
     * (M15, Operations spec §19/§20). Default: nobody — a direct peer cannot
     * spoof scheme/client IP. An invalid entry aborts startup at bind time
     * (fail-secure: Fastify's proxy resolver rejects malformed values).
     */
    trustedProxies: string[];
    /**
     * Anonymous-per-IP request budget for /api/v1/* (audit 2026-09-27 F-21).
     * A refill-bucket caps sustained abuse (scrapers, runaway pollers, stolen
     * credentials) while leaving admin/CLI traffic ample headroom. Default
     * 1200 req/min (~20 rps sustained). 0 disables the limiter (tests, or
     * explicit operator opt-out when an upstream proxy already limits).
     */
    apiRateLimitPerMinute?: number;
    /**
     * Session-cookie transport guard (owner directive 2026-09-30: LAN/demo
     * installs must be able to log in before TLS exists). Default: secure in
     * production (`__Host-pcms_session`, requires HTTPS — a browser refuses
     * it over plain HTTP, so admin login cannot stick), non-prefixed
     * `pcms_session` without Secure otherwise. Set false ONLY for
     * plain-HTTP LAN/demo access; a public deployment always terminates TLS
     * and keeps the default.
     */
    cookieSecure?: boolean;
  };
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    /** Name inside `secrets` holding the DB password, if the deployment uses one. */
    passwordSecretRef?: string;
    sslMode: DbSslMode;
    sslCaFile?: string;
    migrationsDir: string;
    pool: {
      webMax: number;
      workerMax: number;
      connectionTimeoutMilliseconds: number;
      idleTimeoutMilliseconds: number;
    };
  };
  log: { level: LogLevel };
  /**
   * Media subsystem configuration (M05, Operations §8). Optional: processes
   * that never touch media can run without it. Both directories are
   * deployment decisions — there is no silent default location for user
   * content; limits are restrictive defaults.
   */
  media?: {
    /** Root of the media blob storage volume (local adapter). */
    storageDir: string;
    /** Separate quarantine volume for unvalidated uploads. */
    quarantineDir: string;
    maxUploadBytes: number;
    /** Upload ceilings for the media-heavy kinds (ingest kind-checks them). */
    maxVideoUploadBytes: number;
    maxAudioUploadBytes: number;
    /** Baseline registry MIME types this site refuses; narrowing only. */
    disabledTypes?: string[];
    /** Decompression-bomb bounds (Media spec §26). */
    maxImagePixels: number;
    maxImageDimension: number;
  };
  secrets: Record<string, SecretRef>;
  /**
   * .pcpub ingest tuning (ADR-0014, Operations spec §70). Optional: the
   * product defaults live in @pcms/publication; these are operator knobs.
   */
  pcpub?: {
    quarantineDir?: string;
    limits?: {
      maxCompressedBytes?: number;
      maxUncompressedBytes?: number;
      maxDocuments?: number;
      maxAssets?: number;
      maxAssetBytes?: number;
    };
  };
  /**
   * Durable job queue tuning (M07). Optional: fail-secure restrictive
   * defaults live in the jobs package; these are the operator knobs.
   */
  jobs?: {
    pollIntervalMs: number;
    claimBatchMax: number;
    leaseMilliseconds: number;
    maxAttempts: number;
    backoffBaseMilliseconds: number;
  };
  /**
   * Publication subsystem knobs (M07). The preview signing key is a secret
   * reference — the key material itself never appears in config.
   */
  publication?: {
    previewTokenTtlMinutes: number;
    previewSecretRef?: string;
  };
  /**
   * Auth subsystem tuning (M08). Optional; the auth package enforces the
   * security floors — this schema only carries operator-raised costs.
   */
  auth?: {
    password?: {
      argon2?: {
        memoryKiB?: number;
        timeCost?: number;
        parallelism?: number;
      };
    };
    session?: {
      idleTimeoutMinutes?: number;
      absoluteTimeoutHours?: number;
    };
    mfa?: {
      policy?: "OPTIONAL" | "REQUIRED_PRIVILEGED" | "REQUIRED_ALL";
      stepUpWindowMinutes?: number;
      /**
       * Secret reference holding the TOTP encryption key (M08 spec §67).
       * Without it, enrollment/verification is fail-secure unavailable
       * (management-only flows keep working) — M10 wires it so the Admin
       * MFA surface can complete logins.
       */
      totpEncryptionKeySecretRef?: string;
    };
  };
  /**
   * Content schema source (M09). Content types are deployment-owned
   * descriptors loaded from a versioned JSON file — the server never invents
   * a business schema (Content spec §78).
   */
  content?: {
    typesFile?: string;
  };
  /**
   * Theme source for server-side rendering surfaces (M09 preview transport;
   * spec §38 — theme source stays a local/deployment path, never a remote
   * filesystem API).
   */
  themes?: {
    renderDir?: string;
  };
  /**
   * Admin Workspace static bundle (M10, ADR-0009). Optional: API-only
   * deployments run without it — the web process then serves no `/admin`.
   */
  admin?: {
    distDir?: string;
  };
  /**
   * Community skills (operator-installed .pcskill packages). Disabled by
   * default — enabling is an explicit operator decision; the community root
   * lives outside the release tree and survives `cms update apply`.
   */
  skills?: {
    communityEnabled?: boolean;
    communityDir?: string;
  };
  /**
   * Artifact repository (skills/extensions/engine releases). Optional:
   * without it the Registry tab shows an unconfigured notice. The account
   * token lives in the registry.token SECRET slot, never here.
   */
  registry?: {
    baseUrl?: string;
    /** Consent: upload agent reports after successful registry-sourced
     * updates. Default false. */
    reportUpdates?: boolean;
  };
  /**
   * SEO indexing environment (M06/M11). Fail-secure default: development —
   * public search/sitemap index nothing until a deployment declares its
   * real environment (SEO spec §13 guard, Search spec §4).
   */
  seo?: {
    environment?: "production" | "staging" | "development";
  };
  /**
   * Outbound mail (PCMS-OPS-T110, Operations spec §31/§69). Credentials are
   * secret refs only — the resolved values never appear in config, logs or
   * diagnostics. `transport: "console"` is the safe boundary that logs the
   * envelope and sends nothing (no-credential deployments, development).
   */
  /**
   * Integration Hub runtime secret store (PCMS-OPS-T131, migration 1602):
   * the AES-256-GCM key protecting Admin-managed connector secret values
   * (Telegram bot token, Nextcloud Talk credential, managed SMTP password,
   * …) at rest. Optional — without it the Admin cannot store secret values
   * and deployments keep using env/file secret refs.
   */
  integrations?: {
    runtimeSecretsEncryptionKeySecretRef?: string;
  };
  mail?: {
    transport?: "smtp" | "console";
    /** Default envelope sender / From for system mail. */
    from: string;
    host?: string;
    port?: number;
    mode?: "smtps" | "starttls" | "plain";
    usernameSecretRef?: string;
    passwordSecretRef?: string;
    connectTimeoutMs?: number;
  };
}

const SECRET_NAME = "^[a-z][a-zA-Z0-9_.]{0,63}$";
const SECRET_ENV_NAME = "^[A-Z][A-Z0-9_]{0,63}$";
const SECRET_REF = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["env"],
      properties: { env: { type: "string", pattern: SECRET_ENV_NAME } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["file"],
      properties: { file: { type: "string", minLength: 1 } },
    },
  ],
} as const;

/**
 * Version of the application config schema itself (M14 contract/version
 * registry, Extensions spec §15). Bump only on a breaking config shape
 * change; additive optional sections do not change it.
 */
export const CONFIG_SCHEMA_VERSION = 1;

export const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["nodeEnv", "db"],
  properties: {
    nodeEnv: { enum: ["development", "production", "test"] },
    http: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", minLength: 1 },
        // 0 is allowed for tests (OS-assigned ephemeral port).
        port: { type: "integer", minimum: 0, maximum: 65535 },
        shutdownTimeoutMilliseconds: { type: "integer", minimum: 100, maximum: 120000 },
        trustedProxies: {
          type: "array",
          items: { type: "string", minLength: 1 },
          maxItems: 32,
        },
        apiRateLimitPerMinute: { type: "integer", minimum: 0, maximum: 100000 },
        cookieSecure: { type: "boolean" },
      },
    },
    db: {
      type: "object",
      additionalProperties: false,
      required: ["host", "port", "database", "user", "sslMode"],
      properties: {
        host: { type: "string", minLength: 1 },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        database: { type: "string", minLength: 1 },
        user: { type: "string", minLength: 1 },
        passwordSecretRef: { type: "string", pattern: SECRET_NAME },
        sslMode: { enum: ["disable", "require", "verify-full"] },
        sslCaFile: { type: "string", minLength: 1 },
        migrationsDir: { type: "string", minLength: 1 },
        pool: {
          type: "object",
          additionalProperties: false,
          properties: {
            webMax: { type: "integer", minimum: 1, maximum: 100 },
            workerMax: { type: "integer", minimum: 1, maximum: 100 },
            connectionTimeoutMilliseconds: { type: "integer", minimum: 100, maximum: 600000 },
            idleTimeoutMilliseconds: { type: "integer", minimum: 0, maximum: 600000 },
          },
        },
      },
    },
    log: {
      type: "object",
      additionalProperties: false,
      properties: { level: { enum: ["debug", "info", "warn", "error"] } },
    },
    media: {
      type: "object",
      additionalProperties: false,
      required: ["storageDir", "quarantineDir"],
      properties: {
        storageDir: { type: "string", minLength: 1 },
        quarantineDir: { type: "string", minLength: 1 },
        maxUploadBytes: { type: "integer", minimum: 1024, maximum: 1073741824 },
        maxVideoUploadBytes: { type: "integer", minimum: 1024, maximum: 1073741824 },
        maxAudioUploadBytes: { type: "integer", minimum: 1024, maximum: 1073741824 },
        disabledTypes: {
          type: "array",
          items: { type: "string", pattern: "^[-\\w.+]+/[-\\w.+]+$" },
        },
        maxImagePixels: { type: "integer", minimum: 1000000, maximum: 4000000000 },
        maxImageDimension: { type: "integer", minimum: 256, maximum: 65536 },
      },
    },
    pcpub: {
      type: "object",
      additionalProperties: false,
      properties: {
        quarantineDir: { type: "string", minLength: 1 },
        limits: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxCompressedBytes: { type: "integer", minimum: 1, maximum: 1073741824 },
            maxUncompressedBytes: { type: "integer", minimum: 1, maximum: 4294967296 },
            maxDocuments: { type: "integer", minimum: 1, maximum: 100000 },
            maxAssets: { type: "integer", minimum: 1, maximum: 100000 },
            maxAssetBytes: { type: "integer", minimum: 1, maximum: 1073741824 },
          },
        },
      },
    },
    secrets: {
      type: "object",
      additionalProperties: SECRET_REF,
      propertyNames: { pattern: SECRET_NAME },
    },
    jobs: {
      type: "object",
      additionalProperties: false,
      properties: {
        pollIntervalMs: { type: "integer", minimum: 100, maximum: 600000 },
        claimBatchMax: { type: "integer", minimum: 1, maximum: 100 },
        leaseMilliseconds: { type: "integer", minimum: 1000, maximum: 3600000 },
        maxAttempts: { type: "integer", minimum: 1, maximum: 100 },
        backoffBaseMilliseconds: { type: "integer", minimum: 0, maximum: 600000 },
      },
    },
    publication: {
      type: "object",
      additionalProperties: false,
      properties: {
        previewTokenTtlMinutes: { type: "integer", minimum: 1, maximum: 10080 },
        previewSecretRef: { type: "string", pattern: SECRET_NAME },
      },
    },
    auth: {
      type: "object",
      additionalProperties: false,
      properties: {
        password: {
          type: "object",
          additionalProperties: false,
          properties: {
            argon2: {
              type: "object",
              additionalProperties: false,
              properties: {
                memoryKiB: { type: "integer", minimum: 8192, maximum: 2097152 },
                timeCost: { type: "integer", minimum: 1, maximum: 32 },
                parallelism: { type: "integer", minimum: 1, maximum: 16 },
              },
            },
          },
        },
        session: {
          type: "object",
          additionalProperties: false,
          properties: {
            idleTimeoutMinutes: { type: "integer", minimum: 5, maximum: 10080 },
            absoluteTimeoutHours: { type: "integer", minimum: 1, maximum: 720 },
          },
        },
        mfa: {
          type: "object",
          additionalProperties: false,
          properties: {
            policy: { enum: ["OPTIONAL", "REQUIRED_PRIVILEGED", "REQUIRED_ALL"] },
            stepUpWindowMinutes: { type: "integer", minimum: 1, maximum: 240 },
            totpEncryptionKeySecretRef: { type: "string", pattern: SECRET_NAME },
          },
        },
      },
    },
    content: {
      type: "object",
      additionalProperties: false,
      properties: {
        typesFile: { type: "string", minLength: 1 },
      },
    },
    themes: {
      type: "object",
      additionalProperties: false,
      properties: {
        renderDir: { type: "string", minLength: 1 },
      },
    },
    admin: {
      type: "object",
      additionalProperties: false,
      properties: {
        distDir: { type: "string", minLength: 1 },
      },
    },
    skills: {
      type: "object",
      additionalProperties: false,
      properties: {
        communityEnabled: { type: "boolean" },
        communityDir: { type: "string", minLength: 1 },
      },
    },
    registry: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseUrl: { type: "string", minLength: 1, maxLength: 500 },
        /** Consent: upload agent reports after successful registry-sourced
         * updates (see deploy/docs/CONFIGURATION.md). Default false. */
        reportUpdates: { type: "boolean" },
      },
    },
    seo: {
      type: "object",
      additionalProperties: false,
      properties: {
        // SEO indexing environment guard (M06): development/staging responses
        // are marked noindex regardless of published state.
        environment: { enum: ["production", "staging", "development"] },
      },
    },
    integrations: {
      type: "object",
      additionalProperties: false,
      properties: {
        runtimeSecretsEncryptionKeySecretRef: { type: "string", pattern: SECRET_NAME },
      },
    },
    mail: {
      type: "object",
      additionalProperties: false,
      required: ["from"],
      properties: {
        // console = safe boundary transport (logs the envelope, sends
        // nothing) — the documented no-credential test/dev mode.
        transport: { enum: ["smtp", "console"] },
        from: { type: "string", minLength: 3, maxLength: 320 },
        host: { type: "string", minLength: 1 },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        mode: { enum: ["smtps", "starttls", "plain"] },
        usernameSecretRef: { type: "string", pattern: SECRET_NAME },
        passwordSecretRef: { type: "string", pattern: SECRET_NAME },
        connectTimeoutMs: { type: "integer", minimum: 1000, maximum: 60000 },
      },
    },
  },
} as const;
