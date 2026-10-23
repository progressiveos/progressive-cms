// Production release artifact model (PCMS-OPS-T101, Operations spec §6/§7/§44).
//
// The release layout contract: code, config and mutable state are separated;
// a release directory is immutable after deployment. scripts/build-release.mjs
// stages the artifact on a build machine; the pure helpers here own the
// naming, metadata and package-exports rewrite contracts so the builder, the
// deployed runtime (doctor reads build-metadata.json) and the tests share a
// single definition.
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface SelectedReleaseStatus {
  readonly version: string | null;
  readonly release_id: string | null;
  readonly matches_running: boolean | null;
  readonly read_error: "EACCES" | "ENOENT" | "INVALID_METADATA" | "UNAVAILABLE" | null;
}

/** Read disk selection independently of the immutable identity captured at boot. */
export function readSelectedReleaseStatus(input: {
  currentSymlink: string;
  runningRoot: string;
  runningReleaseId: string;
}): SelectedReleaseStatus {
  let sameDirectory: boolean | null = null;
  try {
    const selectedRoot = resolve(dirname(input.currentSymlink), readlinkSync(input.currentSymlink));
    sameDirectory = selectedRoot === input.runningRoot;
    const metadata = JSON.parse(readFileSync(join(selectedRoot, "build-metadata.json"), "utf8"));
    if (
      metadata?.schema !== "pcms-release-build/1" ||
      typeof metadata.version !== "string" ||
      !metadata.version ||
      typeof metadata.releaseId !== "string" ||
      !metadata.releaseId
    ) {
      return {
        version: null,
        release_id: null,
        matches_running: sameDirectory ? null : false,
        read_error: "INVALID_METADATA",
      };
    }
    return {
      version: metadata.version,
      release_id: metadata.releaseId,
      matches_running: sameDirectory && metadata.releaseId === input.runningReleaseId,
      read_error: null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      version: null,
      release_id: null,
      matches_running: sameDirectory === false ? false : null,
      read_error:
        error instanceof SyntaxError
          ? "INVALID_METADATA"
          : code === "EACCES" || code === "EPERM"
            ? "EACCES"
            : code === "ENOENT"
              ? "ENOENT"
              : "UNAVAILABLE",
    };
  }
}

/**
 * A workspace package.json as shipped in the repository. Development exports
 * point at TypeScript sources (`./src/index.ts`); a release artifact must
 * point at the compiled JavaScript twins.
 */
export interface WorkspacePackageDocument {
  readonly name: string;
  readonly version?: string;
  readonly exports?: unknown;
  readonly [key: string]: unknown;
}

/** Rewrites every TypeScript export target (`.ts`) to its compiled (`.js`) twin. */
export function toCompiledExports(exportsField: unknown): unknown {
  if (typeof exportsField === "string") return rewriteTarget(exportsField);
  if (Array.isArray(exportsField)) return exportsField.map(toCompiledExports);
  if (exportsField !== null && typeof exportsField === "object") {
    return Object.fromEntries(
      Object.entries(exportsField).map(([key, value]) => [key, toCompiledExports(value)]),
    );
  }
  return exportsField;
}

function rewriteTarget(target: string): string {
  return target.endsWith(".ts") ? `${target.slice(0, -3)}.js` : target;
}

/**
 * Builds the package.json a workspace package ships inside a release
 * artifact: identical identity/dependencies (npm ci validates them against
 * the committed lockfile), exports rewritten to the compiled output.
 */
export function toReleasePackageDocument(
  source: WorkspacePackageDocument,
): WorkspacePackageDocument {
  return {
    ...source,
    ...(source.exports === undefined ? {} : { exports: toCompiledExports(source.exports) }),
  };
}

/**
 * Stable, sortable release identifier used as the release directory name:
 * `v<version>-<UTC build timestamp>-<short commit>`.
 */
export function createReleaseId(input: { version: string; builtAt: Date; commit: string }): string {
  const stamp = `${input.builtAt.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
  return `v${input.version}-${stamp}-${input.commit.slice(0, 7)}`;
}

/** Paths inside a release artifact, relative to the release root. */
export const RELEASE_LAYOUT = {
  buildMetadata: "build-metadata.json",
  rootPackageJson: "package.json",
  rootLockfile: "package-lock.json",
  migrationsDir: "db/migrations",
  adminDistDir: "apps/admin/dist",
  configExample: "config/pcms.example.json",
  themesDir: "themes",
  /** M16 (PCMS-SKILL-T018): installed first-party Agent Skills root. */
  skillsDir: "skills",
  webEntry: "apps/web/src/main.js",
  workerEntry: "apps/worker/src/main.js",
  cliEntry: "packages/cli/src/bin/cms.js",
  /** M14 update target manifest generated alongside the build metadata. */
  updateManifest: "update-manifest.json",
  /**
   * M17 (PCMS-OPS-T101/T002): canonical release manifest. Single location the
   * builder emits and the runtime (doctor, update preflight, agent bootstrap)
   * reads for deployed identity: version, commit, release id, build time,
   * migration inventory with checksums, contract versions.
   */
  releaseManifest: "release-manifest.json",
} as const;

export interface ContractVersionFact {
  readonly key: string;
  readonly version: string | number;
  readonly source: string;
}

/** build-metadata.json — traceability record embedded in every artifact. */
export interface ReleaseBuildMetadata {
  readonly schema: "pcms-release-build/1";
  readonly releaseId: string;
  readonly version: string;
  readonly gitCommit: string;
  readonly gitDirty: boolean;
  readonly builtAtUtc: string;
  readonly nodeVersion: string;
  readonly entrypoints: { readonly web: string; readonly worker: string; readonly cli: string };
  readonly contractVersions: readonly ContractVersionFact[];
}

export function createReleaseBuildMetadata(input: {
  releaseId: string;
  version: string;
  gitCommit: string;
  gitDirty: boolean;
  builtAt: Date;
  nodeVersion: string;
  contractVersions: readonly ContractVersionFact[];
}): ReleaseBuildMetadata {
  const sorted = [...input.contractVersions].sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    schema: "pcms-release-build/1",
    releaseId: input.releaseId,
    version: input.version,
    gitCommit: input.gitCommit,
    gitDirty: input.gitDirty,
    builtAtUtc: input.builtAt.toISOString(),
    nodeVersion: input.nodeVersion,
    entrypoints: {
      web: RELEASE_LAYOUT.webEntry,
      worker: RELEASE_LAYOUT.workerEntry,
      cli: RELEASE_LAYOUT.cliEntry,
    },
    contractVersions: sorted,
  };
}

/** release-manifest.json — the deployed identity read back by the runtime. */
export interface ReleaseManifestIdentity {
  readonly schema: "pcms-release/1";
  readonly releaseId: string;
  readonly version: string;
  readonly gitCommit: string;
  readonly gitDirty: boolean;
  readonly builtAtUtc: string;
  readonly migrationHead: string | null;
  readonly coreDbMigrations: readonly { readonly name: string; readonly checksum: string }[];
}

/**
 * Truthful deployment classification (M17-T003): a process either runs from
 * an immutable release layout (build metadata at the release root) or from a
 * development tree (nearest workspace root has a package.json but no build
 * metadata). Walking up from the running module keeps the answer independent
 * of the operator's cwd — the pre-M17 doctor misclassified deployments as
 * "development tree" for exactly that reason.
 */
export function resolveReleaseIdentity(
  moduleFilePath: string,
):
  | { readonly mode: "release"; readonly root: string; readonly identity: ReleaseBuildMetadata }
  | { readonly mode: "development"; readonly root: string } {
  let current = dirname(moduleFilePath);
  let developmentRoot: string | undefined;
  for (let guard = 0; guard < 32; guard += 1) {
    if (existsSync(join(current, RELEASE_LAYOUT.buildMetadata))) {
      const identity = JSON.parse(
        readFileSync(join(current, RELEASE_LAYOUT.buildMetadata), "utf8"),
      ) as ReleaseBuildMetadata;
      return { mode: "release", root: current, identity };
    }
    // First package.json below a build-metadata hit is a workspace member;
    // the topmost package.json without build metadata is the dev tree root.
    if (existsSync(join(current, "package.json"))) developmentRoot = current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {
    mode: "development",
    root: developmentRoot ?? dirname(moduleFilePath),
  };
}

/**
 * Shape of the M14 update target manifest (`UPDATE_MANIFEST_V1_SCHEMA`) that
 * the builder emits for each release so `cms update apply --manifest` can
 * consume it without hand-authoring. The field set mirrors the schema in
 * `@pcms/extensions`; structural validation is the builder's final gate.
 */
export interface ReleaseUpdateManifestDraft {
  readonly manifest_version: "1";
  readonly version: string;
  readonly required_runtime: { readonly node: string; readonly postgres: string };
  readonly core_db_migrations: readonly string[];
  readonly supports_extension_contracts: readonly string[];
  readonly contract_versions: Readonly<Record<string, string>>;
  readonly deprecations: readonly never[];
  readonly security_notes: readonly string[];
  readonly manual_steps: readonly string[];
  readonly backup_required: boolean;
  readonly rollback_policy: "rollback_safe" | "restore_required" | "forward_fix_only";
  readonly config_changes: readonly never[];
}
