#!/usr/bin/env node
// Build-machine only: clients receive executable JS, never a compiler or source checkout.
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalPackageJson,
  extensionFileSha256,
  validateExtensionManifest,
} from "@pcms/extensions/internal";
import { build } from "esbuild";
import {
  assertPackagePath,
  packageContentDigest,
  packageFiles,
} from "./extension-package-assets.mjs";
import { packReleaseZip } from "./pack-release-zip.mjs";

export async function buildExtensionPackage(input) {
  const sourceDir = resolve(input.sourceDir);
  const sourceDigest = packageContentDigest(sourceDir);
  if (
    sourceDigest !== input.sourceContentSha256 ||
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(input.supplySha256)
  )
    throw new Error("extension source/supply identity mismatch");
  const parsed = validateExtensionManifest(
    JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8")),
  );
  if (!parsed.ok) throw new Error("invalid extension manifest");
  const manifest = parsed.manifest;
  if (
    !["stable", "beta", "dev"].includes(input.channel) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.keyId)
  )
    throw new Error("invalid package channel or signing key id");
  const key = createPrivateKey(readFileSync(input.signingKeyFile));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("extension signer must use Ed25519");
  const scratch = mkdtempSync(join(tmpdir(), "pcms-extension-build-"));
  const releaseId = `${manifest.id}-${manifest.version}`;
  const stage = join(scratch, releaseId);
  mkdirSync(join(stage, "src"), { recursive: true });
  try {
    await build({
      absWorkingDir: sourceDir,
      entryPoints: [join(sourceDir, "src/index.ts")],
      outfile: join(stage, "src/index.js"),
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      sourcemap: false,
      logLevel: "silent",
    });
    if (manifest.admin_contributions) {
      const entrypoint = ["admin/index.ts", "admin/index.tsx"].find((path) =>
        existsSync(join(sourceDir, path)),
      );
      if (!entrypoint || !input.assets.build_inputs.includes(entrypoint))
        throw new Error("Admin entrypoint must be a declared build input");
      const react = await import("react");
      const names = Object.keys(react).filter(
        (name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && name !== "default",
      );
      await build({
        absWorkingDir: sourceDir,
        entryPoints: [join(sourceDir, entrypoint)],
        outfile: join(stage, "admin/index.js"),
        bundle: true,
        platform: "browser",
        target: "es2022",
        format: "esm",
        // Match the production Admin host, including automatic JSX runtime imports.
        define: { "process.env.NODE_ENV": '"production"' },
        jsx: "transform",
        jsxFactory: "globalThis.__PCMS_EXTENSION_REACT__.createElement",
        jsxFragment: "globalThis.__PCMS_EXTENSION_REACT__.Fragment",
        sourcemap: false,
        logLevel: "silent",
        plugins: [
          {
            name: "pcms-host-react",
            setup(bundler) {
              bundler.onResolve({ filter: /^react$/ }, () => ({
                path: "react",
                namespace: "pcms-host",
              }));
              bundler.onLoad({ filter: /.*/, namespace: "pcms-host" }, () => ({
                contents: `const React=globalThis.__PCMS_EXTENSION_REACT__;if(!React)throw new Error("PCMS Admin React bridge unavailable");export default React;${names.map((name) => `export const ${name}=React.${name};`).join("")}`,
                loader: "js",
              }));
            },
          },
        ],
      });
    }
    const runtime = new Set(["manifest.json", "LICENSE", "NOTICE", ...input.assets.runtime]);
    for (const view of manifest.registrations.views)
      if (!runtime.has(view.base_template))
        throw new Error(`undeclared base template: ${view.base_template}`);
    if (manifest.migrations)
      for (const path of packageFiles(sourceDir).filter((path) =>
        path.startsWith(`${manifest.migrations.dir}/`),
      )) {
        if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(path.slice(manifest.migrations.dir.length + 1))) throw new Error(`unexpected migration asset: ${path}`);
        runtime.add(path);
      }
    for (const path of runtime) {
      assertPackagePath(path);
      if (
        /\.(?:tsx?|mts|cts)$/.test(path) ||
        ["src/index.js", "admin/index.js", "extension-package.json"].includes(path)
      )
        throw new Error("runtime asset would replace executable build output");
      mkdirSync(dirname(join(stage, path)), { recursive: true });
      writeFileSync(join(stage, path), readFileSync(join(sourceDir, path)), { mode: 0o644 });
    }
    writeFileSync(join(stage, "package.json"), '{"type":"module"}\n');
    const files = Object.fromEntries(
      packageFiles(stage).map((path) => [
        path,
        extensionFileSha256(readFileSync(join(stage, path))),
      ]),
    );
    const signed = {
      schema: "pcms-extension-package/1",
      id: manifest.id,
      version: manifest.version,
      channel: input.channel,
      source: {
        commit: input.sourceCommit,
        supply_sha256: input.supplySha256,
        content_sha256: sourceDigest,
      },
      manifest: JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8")),
      files,
    };
    const descriptor = {
      ...signed,
      signature: {
        key_id: input.keyId,
        value: sign(null, Buffer.from(canonicalPackageJson(signed)), key).toString("base64"),
      },
    };
    writeFileSync(
      join(stage, "extension-package.json"),
      `${JSON.stringify(descriptor, null, 2)}\n`,
    );
    const output = resolve(input.output);
    if (existsSync(output)) throw new Error("refusing to overwrite an existing extension artifact");
    mkdirSync(dirname(output), { recursive: true });
    await packReleaseZip(scratch, releaseId, output, new Date("2000-01-01T00:00:00Z"));
    const sha256 = extensionFileSha256(readFileSync(output));
    writeFileSync(`${output}.sha256`, `${sha256}  ${output.split("/").at(-1)}\n`);
    return {
      output,
      sha256,
      packageDigest: extensionFileSha256(canonicalPackageJson(signed)),
      descriptor,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3)
      throw new Error(
        "usage: node --import tsx scripts/build-extension-package.mjs <build-recipe.json>",
      );
    console.log(
      JSON.stringify(
        await buildExtensionPackage(JSON.parse(readFileSync(resolve(path), "utf8"))),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`extension-package: ${error.message}`);
    process.exitCode = 1;
  }
}
