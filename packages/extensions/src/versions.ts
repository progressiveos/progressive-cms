// CMS / config / contract version registries (PCMS-EXT-T010, Extensions
// spec §15). Contracts version independently — there is no single global
// schema version. The registry here is the deterministic discovery surface:
// the doctor, machine discovery and the update preflight read from it.
// Values are supplied by the composition layer from each subsystem's own
// canonical constant, so no copy of truth is created here.
import { valid as semverValid } from "semver";
import { ExtensionError } from "./errors.js";

/** Production runtime policy (Operations spec §43; release manifest gates). */
export const SUPPORTED_NODE_RANGE = ">=24.21 <25";
// M15 (PCMS-OPS-T107): the range explicitly pins the supported PostgreSQL
// majors per CMS release. 14–16 were proven through M14; 17–18 are proven on
// the M15 production contour (PostgreSQL 18.6 on the Ubuntu 26.04 pilot;
// PostgreSQL 16 remains the dev/integration baseline). The gate CHECKS,
// never upgrades — major upgrades stay an operator procedure (M14 handoff
// §31.8).
export const SUPPORTED_POSTGRES_RANGE = ">=14 <19";

/** Stable contract keys (append-only). */
export const CONTRACT_VERSION_KEYS = [
  "cms",
  "config_schema",
  "extension_contract",
  "rest_api",
  "mcp",
  "theme_contract",
  "block_document",
  "search_index",
  "bundle",
  "pcpub",
  "pcmd",
] as const;
export type ContractVersionKey = (typeof CONTRACT_VERSION_KEYS)[number];

export interface ContractVersionEntry {
  readonly key: ContractVersionKey;
  readonly version: string;
  /** Canonical source of the value, e.g. "cms:themes". */
  readonly source: string;
}

export interface ContractVersionRegistry {
  register(entry: { key: ContractVersionKey; version: string | number; source: string }): void;
  get(key: ContractVersionKey): ContractVersionEntry | undefined;
  /** Deterministic discovery: sorted by key. */
  list(): readonly ContractVersionEntry[];
}

export function createContractVersionRegistry(): ContractVersionRegistry {
  const byKey = new Map<ContractVersionKey, ContractVersionEntry>();
  return {
    register(entry) {
      const version = String(entry.version);
      if (byKey.has(entry.key)) {
        throw new ExtensionError(
          "EXTENSION_REGISTRATION_CONFLICT",
          `contract version "${entry.key}" already registered`,
          { details: { key: entry.key } },
        );
      }
      byKey.set(entry.key, { key: entry.key, version, source: entry.source });
    },
    get(key) {
      return byKey.get(key);
    },
    list() {
      return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    },
  };
}

export interface SystemContractVersions {
  /** Product version from the deployed release (package.json), e.g. "0.0.0". */
  readonly cmsVersion: string;
  readonly configSchemaVersion: string | number;
  readonly restApiVersion: string | number;
  readonly mcpProtocolVersion: string;
  readonly themeContractVersion: string;
  readonly blockDocumentSchemaVersion: string | number;
  readonly searchIndexVersion: string | number;
  readonly bundleVersion: string | number;
  readonly pcpubVersion: string | number;
  readonly pcmdVersion: string | number;
  /** Extension contract implemented by this build (from manifest.ts). */
  readonly extensionContractVersion: string;
}

/**
 * Assembles the full system registry from canonical values. Composition
 * (api context, CLI doctor, worker) calls this with its own imports, so the
 * registry always mirrors the built code — never a duplicated copy.
 */
export function createSystemContractVersionRegistry(
  input: SystemContractVersions,
): ContractVersionRegistry {
  const registry = createContractVersionRegistry();
  const entries: readonly {
    key: ContractVersionKey;
    version: string | number;
    source: string;
  }[] = [
    { key: "cms", version: input.cmsVersion, source: "cms:release" },
    { key: "config_schema", version: input.configSchemaVersion, source: "cms:core" },
    {
      key: "extension_contract",
      version: input.extensionContractVersion,
      source: "cms:extensions",
    },
    { key: "rest_api", version: input.restApiVersion, source: "cms:api" },
    { key: "mcp", version: input.mcpProtocolVersion, source: "cms:mcp" },
    { key: "theme_contract", version: input.themeContractVersion, source: "cms:themes" },
    { key: "block_document", version: input.blockDocumentSchemaVersion, source: "cms:blocks" },
    { key: "search_index", version: input.searchIndexVersion, source: "cms:search" },
    { key: "bundle", version: input.bundleVersion, source: "cms:api" },
    { key: "pcpub", version: input.pcpubVersion, source: "cms:publication" },
    { key: "pcmd", version: input.pcmdVersion, source: "cms:publication" },
  ];
  for (const entry of entries) registry.register(entry);
  return registry;
}

/**
 * Reads the CMS version out of the deployed release manifest (the root
 * package.json document). The version must be valid SemVer; the repo is
 * "0.0.0" pre-v1 and that is fine — synthetic/zero versions are a documented
 * state until the owner declares the first release.
 */
export function discoverCmsVersion(releaseDocument: unknown): string {
  if (
    typeof releaseDocument === "object" &&
    releaseDocument !== null &&
    "version" in releaseDocument
  ) {
    const version = (releaseDocument as { version: unknown }).version;
    if (typeof version === "string" && semverValid(version)) return version;
  }
  throw new ExtensionError(
    "EXTENSION_MANIFEST_INVALID",
    "release manifest has no valid SemVer version field",
    { details: { field: "version" } },
  );
}
