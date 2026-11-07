// Independent packages are executable deployment artifacts, never Admin uploads.
import { createHash, createPublicKey, verify } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { satisfies } from "semver";
import {
  createExtensionCatalog,
  defineExtensionArtifact,
  resolveHandler,
  type ExtensionCatalog,
} from "./catalog.js";
import {
  EXTENSION_CONTRACT_VERSION,
  type ExtensionManifest,
  validateExtensionManifest,
} from "./manifest.js";

export interface ExtensionPackageDescriptor {
  readonly schema: "pcms-extension-package/1";
  readonly id: string;
  readonly version: string;
  readonly channel: "stable" | "beta" | "dev";
  readonly source: {
    readonly commit: string;
    readonly supply_sha256: string;
    readonly content_sha256: string;
  };
  readonly manifest: unknown;
  readonly files: Readonly<Record<string, string>>;
  readonly signature: { readonly key_id: string; readonly value: string };
}

export interface ExtensionPackageTrust {
  readonly schema: "pcms-extension-trust/1";
  readonly keys: readonly {
    readonly id: string;
    readonly public_key: string;
    readonly extension_ids: readonly string[];
  }[];
}

export interface VerifiedExtensionPackage {
  readonly directory: string;
  readonly digest: string;
  readonly descriptor: ExtensionPackageDescriptor;
  readonly manifest: ExtensionManifest;
}

export function canonicalPackageJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPackageJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalPackageJson(child)}`)
      .join(",")}}`;
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value)))
    throw new Error("invalid signed package value");
  return JSON.stringify(value);
}

export function extensionFileSha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertExtensionAssetPath(path: string): void {
  if (
    !path.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)) ||
    path.split("/").includes("node_modules")
  )
    throw new Error("unsafe extension package path");
}

/** Root owns executable packages and every parent up to their configured store. */
export function assertExtensionStorePath(root: string, file: string, ownerUid = 0): void {
  if (!isAbsolute(root) || !isAbsolute(file))
    throw new Error("extension store and trust paths must be absolute");
  if (root !== resolve(root) || file !== resolve(file))
    throw new Error("extension trust paths must be canonical");
  const rel = relative(root, file);
  if (rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("package escapes extension store");
  let current = file;
  for (;;) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || ![0, ownerUid].includes(stat.uid) || stat.mode & 0o022)
      throw new Error(
        "extension trust path and every ancestor must be operator-owned, non-writable by others and without symlinks",
      );
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function verifyExtensionPackageDescriptor(input: {
  readonly descriptor: unknown;
  readonly trust: ExtensionPackageTrust;
  readonly coreVersion: string;
  readonly allowDev?: boolean;
}): Omit<VerifiedExtensionPackage, "directory"> {
  if (
    !input.descriptor ||
    typeof input.descriptor !== "object" ||
    Array.isArray(input.descriptor) ||
    JSON.stringify(input.descriptor).length > 256 * 1024
  )
    throw new Error("invalid extension descriptor");
  const descriptor = input.descriptor as ExtensionPackageDescriptor;
  const trust = input.trust;
  if (
    Object.keys(descriptor).some(
      (key) =>
        ![
          "schema",
          "id",
          "version",
          "channel",
          "source",
          "manifest",
          "files",
          "signature",
        ].includes(key),
    )
  )
    throw new Error("unknown extension descriptor field");
  if (
    descriptor.schema !== "pcms-extension-package/1" ||
    !["stable", "beta", ...(input.allowDev ? ["dev"] : [])].includes(descriptor.channel) ||
    !descriptor.source ||
    !/^[a-f0-9]{40}$/.test(descriptor.source.commit) ||
    !/^[a-f0-9]{64}$/.test(descriptor.source.supply_sha256) ||
    !/^[a-f0-9]{64}$/.test(descriptor.source.content_sha256)
  )
    throw new Error("invalid extension package identity or channel");
  const key =
    trust.schema === "pcms-extension-trust/1"
      ? trust.keys.find(
          (entry) =>
            entry.id === descriptor.signature?.key_id &&
            entry.extension_ids.includes(descriptor.id),
        )
      : undefined;
  const { signature, ...signed } = descriptor;
  if (!key || !signature || !/^[A-Za-z0-9+/]{86}==$/.test(signature.value))
    throw new Error("untrusted extension package signer");
  const publicKey = createPublicKey(key.public_key);
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      Buffer.from(canonicalPackageJson(signed)),
      publicKey,
      Buffer.from(signature.value, "base64"),
    )
  )
    throw new Error("invalid extension package signature");
  if (
    !descriptor.files ||
    Array.isArray(descriptor.files) ||
    Object.keys(descriptor.files).length > 4096
  )
    throw new Error("invalid extension package inventory");
  const parsed = validateExtensionManifest(descriptor.manifest);
  if (!parsed.ok) throw new Error("invalid deployed extension manifest");
  const manifest = parsed.manifest;
  if (
    manifest.id !== descriptor.id ||
    manifest.version !== descriptor.version ||
    manifest.extension_contract !== EXTENSION_CONTRACT_VERSION ||
    !manifest.cms_compatibility ||
    !satisfies(input.coreVersion, manifest.cms_compatibility, { includePrerelease: true })
  )
    throw new Error("extension package is incompatible with this Core");
  for (const path of [
    "src/index.js",
    "LICENSE",
    "NOTICE",
    ...(manifest.admin_contributions ? ["admin/index.js"] : []),
    ...manifest.registrations.views.map((view) => view.base_template),
  ]) {
    assertExtensionAssetPath(path);
    if (!descriptor.files[path])
      throw new Error(`extension package is missing runtime asset: ${path}`);
  }
  for (const [path, digest] of Object.entries(descriptor.files)) {
    assertExtensionAssetPath(path);
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid extension inventory digest");
  }
  if (manifest.migrations) {
    const prefix = `${manifest.migrations.dir}/`;
    for (const path of Object.keys(descriptor.files).filter((path) => path.startsWith(prefix))) {
      if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(path.slice(prefix.length)))
        throw new Error("extension migrations must be immediate NNNN_name.sql files");
    }
  }
  return { descriptor, manifest, digest: extensionFileSha256(canonicalPackageJson(signed)) };
}

/** Verify the complete inventory before importing any package code. */
export function verifyExtensionPackage(input: {
  readonly directory: string;
  readonly trust: ExtensionPackageTrust;
  readonly coreVersion: string;
  readonly allowDev?: boolean;
}): VerifiedExtensionPackage {
  const { directory, trust } = input;
  const descriptorBytes = readFileSync(join(directory, "extension-package.json"));
  if (descriptorBytes.length > 256 * 1024)
    throw new Error("extension package descriptor is too large");
  const descriptor = JSON.parse(descriptorBytes.toString("utf8")) as ExtensionPackageDescriptor;
  const { manifest, digest } = verifyExtensionPackageDescriptor({
    descriptor,
    trust,
    coreVersion: input.coreVersion,
    ...(input.allowDev === undefined ? {} : { allowDev: input.allowDev }),
  });
  const actual: string[] = [];
  let total = 0;
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(directory, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      assertExtensionAssetPath(path);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        if (path === "extension-package.json") continue;
        const stat = lstatSync(join(directory, path));
        total += stat.size;
        if (total > 64 * 1024 * 1024 || actual.length >= 4096)
          throw new Error("extension package exceeds size limits");
        actual.push(path);
        const expected = descriptor.files[path];
        if (
          !expected ||
          !/^[a-f0-9]{64}$/.test(expected) ||
          extensionFileSha256(readFileSync(join(directory, path))) !== expected
        )
          throw new Error(`extension package inventory mismatch: ${path}`);
      } else throw new Error("extension package links and special files are forbidden");
    }
  };
  walk("");
  if (actual.length !== Object.keys(descriptor.files).length)
    throw new Error("extension package has missing files");
  if (
    canonicalPackageJson(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))) !==
    canonicalPackageJson(descriptor.manifest)
  )
    throw new Error("manifest bytes disagree with signed package metadata");
  return {
    directory: realpathSync(directory),
    digest,
    descriptor,
    manifest,
  };
}

export function readIndependentExtensionPackages(input: {
  readonly storeDir: string;
  readonly trustFile: string;
  readonly coreVersion: string;
  readonly ownerUid?: number;
  readonly allowDev?: boolean;
}): readonly VerifiedExtensionPackage[] {
  assertExtensionStorePath(input.storeDir, join(input.storeDir, "active.json"), input.ownerUid);
  assertExtensionStorePath(input.trustFile, input.trustFile, input.ownerUid);
  const trust = JSON.parse(readFileSync(input.trustFile, "utf8")) as ExtensionPackageTrust;
  const active = JSON.parse(readFileSync(join(input.storeDir, "active.json"), "utf8")) as {
    schema: string;
    state?: string;
    packages: readonly { id: string; digest: string }[];
  };
  if (
    active.schema !== "pcms-active-extensions/1" ||
    (active.state !== undefined && active.state !== "active") ||
    !Array.isArray(active.packages) ||
    active.packages.length > 64 ||
    new Set(active.packages.map((pkg) => pkg.id)).size !== active.packages.length
  )
    throw new Error("invalid active extension generation");
  return active.packages.map((pkg) => {
    if (!/^[a-f0-9]{64}$/.test(pkg.digest)) throw new Error("invalid active package digest");
    const directory = join(input.storeDir, "packages", pkg.digest);
    assertExtensionStorePath(input.storeDir, directory, input.ownerUid);
    const result = verifyExtensionPackage({
      directory,
      trust,
      coreVersion: input.coreVersion,
      ...(input.allowDev === undefined ? {} : { allowDev: input.allowDev }),
    });
    if (result.descriptor.id !== pkg.id || result.digest !== pkg.digest)
      throw new Error("active package identity mismatch");
    for (const path of ["extension-package.json", ...Object.keys(result.descriptor.files)])
      assertExtensionStorePath(input.storeDir, join(directory, path), input.ownerUid);
    return result;
  });
}

export async function loadIndependentExtensionCatalog(input: {
  readonly base: ExtensionCatalog;
  readonly storeDir: string;
  readonly trustFile: string;
  readonly coreVersion: string;
  readonly factoryInput: { readonly pool: unknown };
  readonly ownerUid?: number;
  readonly allowDev?: boolean;
}): Promise<ExtensionCatalog> {
  const verified = readIndependentExtensionPackages(input);
  const catalog = createExtensionCatalog();
  for (const artifact of input.base.list()) {
    if (verified.some((pkg) => pkg.manifest.id === artifact.manifest.id))
      throw new Error("independent package conflicts with statically deployed extension");
    catalog.register(artifact);
  }
  for (const pkg of verified) {
    const imported = (await import(
      pathToFileURL(join(pkg.directory, "src/index.js")).href
    )) as Record<string, unknown>;
    const factory = pkg.manifest.entrypoint.factory;
    if (factory !== undefined && typeof imported[factory] !== "function")
      throw new Error(`extension factory ${factory} is not an exported function`);
    const module =
      factory === undefined
        ? imported
        : await (imported[factory] as (input: unknown) => Record<string, unknown>)(
            input.factoryInput,
          );
    const artifact = defineExtensionArtifact({
      manifest: pkg.manifest,
      module,
      extensionsDir: pkg.directory,
      ...(pkg.manifest.migrations === undefined
        ? {}
        : { migrationsDir: join(pkg.directory, pkg.manifest.migrations.dir) }),
      contentSha256: pkg.digest,
      independentPackage: {
        digest: pkg.digest,
        adminModule: pkg.manifest.admin_contributions
          ? join(pkg.directory, "admin/index.js")
          : undefined,
      },
    });
    for (const registrations of Object.values(pkg.manifest.registrations))
      for (const registration of registrations)
        for (const key of ["handler", "page_ids_handler", "count_handler"] as const) {
          const handler = (registration as unknown as Record<string, unknown>)[key];
          if (typeof handler === "string") resolveHandler(artifact, handler);
        }
    catalog.register(artifact);
  }
  return catalog;
}
