import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(scriptPath), "..");
export const skillId = "progressive-cms-site-builder";
export const standaloneSkillIds = [skillId, "progressive-cms-152fz", "progressive-cms-seo"];
const skillPath = `skills/${skillId}`;
const currentFiles = ["index.md", "compatibility.md", `${skillPath}/references/release.md`];
const currentPattern = /<!-- cms-current:start -->[\s\S]*?<!-- cms-current:end -->/g;
const historyPattern = /<!-- cms-history:start -->[\s\S]*?<!-- cms-history:end -->/g;
const releasePattern = /\b(?:\d+\.\d+\.\d+-rc\.\d+[\w.+-]*|rc[ ._-]?\d+)\b/gi;
const textExtensions = /\.(md|json|txt|ya?ml|liquid|js|css)$/;
const apiPaths = [
  "/agent/bootstrap",
  "/capabilities",
  "/content/schema/validate",
  "/content/schema/apply",
  "/discovery/content/types",
  "/discovery/content/types/{key}",
  "/discovery/blocks",
  "/discovery/theme",
  "/discovery/theme/templates",
  "/discovery/navigation/placements",
  "/discovery/navigation/trees/{setRef}",
  "/discovery/seo/preview",
  "/discovery/seo/validate",
  "/forms",
  "/forms/field-types",
  "/entries",
  "/entries/{entryId}/draft",
  "/entries/{entryId}/home",
  "/entries/{entryId}/move",
  "/entries/{entryId}/route",
  "/entries/{entryId}/seo",
  "/revisions/{revisionId}",
  "/revisions/{revisionId}/validate",
  "/revisions/{revisionId}/seal",
  "/publications/{entityType}/{entityId}",
  "/publications/publish",
  "/navigation/sets",
  "/navigation/sets/{setId}/items",
  "/navigation/sets/{setId}/seal",
  "/navigation/placements/{placementKey}",
  "/navigation/validate",
  "/media",
  "/media/{mediaId}",
  "/media/{mediaId}/variants/regenerate",
  "/discovery/media/presets",
  "/previews",
  "/public/forms/{formId}/submit",
  "/settings/site-identity",
  "/themes/install",
  "/theme/activate",
  "/themes/active",
  "/themes/active/update",
  "/themes/source",
  "/themes/source/package",
  "/themes/packages",
  "/themes/packages/{ref}/validate",
  "/themes/installed",
  "/collections/{key}/items",
  "/search",
  "/search/status",
  "/themes/revisions",
  "/themes/rollback",
  "/themes/revisions/cleanup",
  "/changesets",
  "/changesets/{changesetId}/items",
  "/changesets/{changesetId}/preflight",
  "/changesets/{changesetId}/apply",
];
const skillApiPaths = {
  [skillId]: apiPaths,
  "progressive-cms-152fz": [
    "/entries",
    "/entries/{entryId}/draft",
    "/revisions/{revisionId}/validate",
    "/revisions/{revisionId}/seal",
    "/publications/publish",
    "/changesets",
    "/changesets/{changesetId}/items",
    "/changesets/{changesetId}/preflight",
    "/changesets/{changesetId}/apply",
    "/previews",
    "/discovery/content/types/{key}",
    "/discovery/content/types",
    "/revisions/{revisionId}",
    "/publications/{entityType}/{entityId}",
    "/agent/bootstrap",
    "/capabilities",
    "/forms",
    "/forms/{formId}",
    "/forms/field-types",
    "/quizzes",
    "/quizzes/{quizId}",
    "/public/forms/{formId}/submit",
    "/analytics/settings",
    "/analytics/doctor",
    "/analytics/providers",
    "/settings/site-identity",
    "/integrations/instances",
    "/themes/active",
    "/themes/active/update",
    "/themes/install",
    "/theme/activate",
    "/themes/revisions",
    "/themes/rollback",
    "/themes/revisions/cleanup",
    "/interactions/privacy/preview",
    "/interactions/privacy/apply",
    "/interactions/privacy/cases/{caseId}",
    "/interactions/privacy/cases/{caseId}/deliveries/{deliveryId}/acknowledge",
  ],
  "progressive-cms-seo": [
    "/entries",
    "/entries/{entryId}/draft",
    "/revisions/{revisionId}/validate",
    "/revisions/{revisionId}/seal",
    "/publications/publish",
    "/changesets",
    "/changesets/{changesetId}/items",
    "/changesets/{changesetId}/preflight",
    "/changesets/{changesetId}/apply",
    "/previews",
    "/discovery/content/types/{key}",
    "/themes/active/update",
    "/themes/install",
    "/theme/activate",
    "/media/{mediaId}",
    "/media/{mediaId}/variants/regenerate",
    "/discovery/media/presets",
    "/agent/bootstrap",
    "/capabilities",
    "/site",
    "/localization",
    "/discovery/content/tree",
    "/discovery/content/types",
    "/discovery/theme",
    "/entries/{entryId}/seo",
    "/entries/{entryId}/route",
    "/entries/{entryId}/route/change",
    "/publications/{entityType}/{entityId}",
    "/revisions/{revisionId}",
    "/discovery/seo/metadata/{entryId}",
    "/discovery/seo/preview",
    "/discovery/seo/structured-data",
    "/discovery/seo/validate",
    "/settings/site-identity",
    "/seo/indexnow",
    "/seo/indexnow/status",
    "/themes/active",
    "/themes/revisions",
    "/themes/rollback",
    "/themes/revisions/cleanup",
    "/routing/redirect-imports/validate",
    "/routing/redirect-imports/apply",
  ],
};

function fail(message) {
  throw new Error(message);
}
function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
export function files(root) {
  return readdirSync(root)
    .sort()
    .flatMap((name) => {
      const path = join(root, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`Symlinks are not public documentation: ${path}`);
      if (!stat.isDirectory() && !stat.isFile()) fail(`Not a regular public file: ${path}`);
      return stat.isDirectory() ? files(path) : [path];
    });
}
export function validateVersion(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(
      version,
    );
  if (!match || match[4]?.split(".").some((part) => /^\d+$/.test(part) && /^0\d/.test(part))) {
    fail(`Invalid product SemVer: ${version}`);
  }
  return version;
}
export function currentBlock(version) {
  validateVersion(version);
  const rc = /^\d+\.\d+\.\d+-rc\.(\d+)(?:\+.*)?$/.exec(version);
  const label = rc ? `RC${rc[1]}` : version;
  return `<!-- cms-current:start -->\nCurrent Progressive CMS release: **${label}** (\`${version}\`).\n<!-- cms-current:end -->`;
}
function renderCurrent(text, version, path) {
  if (
    (text.match(/<!-- cms-current:start -->/g) ?? []).length !== 1 ||
    (text.match(/<!-- cms-current:end -->/g) ?? []).length !== 1 ||
    (text.match(currentPattern) ?? []).length !== 1
  )
    fail(`Missing or duplicate current-release block: ${path}`);
  return text.replace(currentPattern, () => currentBlock(version));
}
function generatedResources(docs) {
  const resources = new Map();
  for (const name of ["examples", "theme-starter"]) {
    const source = join(docs, "reference", name);
    for (const path of files(source)) {
      resources.set(`${skillPath}/assets/${name}/${relative(source, path)}`, readFileSync(path));
    }
  }
  resources.set(`${skillPath}/assets/NOTICE.txt`, readFileSync(join(docs, "reference/NOTICE.txt")));
  resources.set(
    "skills/progressive-cms-152fz/references/personal-data-tools.md",
    readFileSync(join(docs, "personal-data-tools.md")),
  );
  const schema = json(join(docs, "reference/openapi-v1.json"));
  for (const [id, apiPaths] of Object.entries(skillApiPaths)) {
    const paths = Object.fromEntries(
      apiPaths.map((path) => {
        if (!schema.paths[path]) fail(`Skill API operation disappeared: ${id} ${path}`);
        return [path, schema.paths[path]];
      }),
    );
    const selected = { ...schema, paths };
    const checkRefs = (value) => {
      if (!value || typeof value !== "object") return;
      if (typeof value.$ref === "string") {
        if (!value.$ref.startsWith("#/"))
          fail(`External API reference in standalone Skill: ${value.$ref}`);
        const found = value.$ref
          .slice(2)
          .split("/")
          .reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], selected);
        if (found === undefined) fail(`Missing API reference in standalone Skill: ${value.$ref}`);
      }
      for (const child of Object.values(value)) checkRefs(child);
    };
    checkRefs(selected);
    resources.set(
      `skills/${id}/references/api-operations.json`,
      Buffer.from(`${JSON.stringify(selected, null, 2)}\n`),
    );
  }
  return resources;
}
export function syncDocs(docs, version) {
  validateVersion(version);
  for (const path of currentFiles) {
    const absolute = join(docs, path);
    write(absolute, renderCurrent(readFileSync(absolute, "utf8"), version, path));
  }
  write(join(docs, "release-version.txt"), `${version}\n`);
  for (const [path, content] of generatedResources(docs)) write(join(docs, path), content);
}
function compatibilityValue(path, pointer) {
  return (
    (/^skills\/progressive-cms-(site-builder|content-agent|152fz|seo)\/manifest\.json$/.test(
      path,
    ) &&
      pointer === "/requires/cms") ||
    (path === "skills/catalog.json" && /^\/skills\/\d+\/requiresCms$/.test(pointer)) ||
    ([
      "reference/theme-starter/theme.json",
      `${skillPath}/assets/theme-starter/theme.json`,
    ].includes(path) &&
      pointer === "/cms_compatibility")
  );
}
function scanJson(value, path, pointer = "") {
  if (typeof value === "string") {
    if (value.match(releasePattern) && !compatibilityValue(path, pointer))
      fail(`Unmanaged release reference: ${path}${pointer}`);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) scanJson(child, path, `${pointer}/${key}`);
  }
}
function scanText(text, path, version) {
  if (currentFiles.includes(path)) {
    if (renderCurrent(text, version, path) !== text)
      fail(`Stale current-release block: ${path}; run sync`);
    text = text.replace(currentPattern, "");
  } else if (text.includes("<!-- cms-current:")) fail(`Unexpected current-release marker: ${path}`);
  if (path === "compatibility.md") {
    if (
      (text.match(historyPattern) ?? []).length !== 1 ||
      (text.match(/<!-- cms-history:(?:start|end) -->/g) ?? []).length !== 2
    )
      fail("Historical provenance must have one bounded block");
    text = text.replace(historyPattern, "");
  } else if (text.includes("<!-- cms-history:"))
    fail(`History markers belong only in compatibility.md: ${path}`);
  const match = releasePattern.exec(text);
  releasePattern.lastIndex = 0;
  if (match)
    fail(
      `Unmanaged release reference "${match[0]}" in ${path}; use the current block or compatibility history`,
    );
}
export function checkLinks(root, boundary = root) {
  let count = 0;
  for (const path of files(root).filter((path) => path.endsWith(".md"))) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*)?\)/g)) {
      const target = match[1].replace(/^<|>$/g, "");
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
      const name = decodeURIComponent(target.split("#")[0].split("?")[0]);
      if (!name) continue;
      const resolved = resolve(dirname(path), name);
      if (!inside(boundary, resolved))
        fail(`Reference escapes its distribution: ${path} -> ${target}`);
      if (!existsSync(resolved)) fail(`Missing link target: ${path} -> ${target}`);
      count++;
    }
  }
  return count;
}
export function checkSkill(root) {
  const manifest = json(join(root, "manifest.json"));
  const entry = readFileSync(join(root, "SKILL.md"), "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(entry)?.[1];
  if (!frontmatter) fail("Standalone Skill must have Agent Skills YAML frontmatter");
  const name = /^name: (.+)$/m.exec(frontmatter)?.[1];
  const description = /^description: (.+)$/m.exec(frontmatter)?.[1];
  const version = /^  version: "([^"]+)"$/m.exec(frontmatter)?.[1];
  if (
    !standaloneSkillIds.includes(name) ||
    name !== manifest.id ||
    !description ||
    description.length > 1024 ||
    version !== manifest.version
  ) {
    fail("Standalone Skill name/description/version disagrees with its CMS manifest");
  }
  for (const name of manifest.references) {
    const path = resolve(root, name);
    if (!inside(root, path) || !existsSync(path))
      fail(`Missing or escaping Skill reference: ${name}`);
  }
  return checkLinks(root, root);
}
export function checkInterfaceMaps(docs) {
  const maps = Object.fromEntries(
    ["rest-api-map.md", "cli-map.md", "mcp-map.md"].map((name) => [
      name,
      readFileSync(join(docs, name), "utf8"),
    ]),
  );
  for (const [name, content] of Object.entries(maps)) {
    if (
      (content.match(/<!-- interface-map:start -->[\s\S]*?<!-- interface-map:end -->/g) ?? [])
        .length !== 1
    )
      fail(`Missing interface catalogue: ${name}`);
    for (const block of content.matchAll(/^```json\n([\s\S]*?)^```/gm)) {
      try {
        JSON.parse(block[1]);
      } catch {
        fail(`Invalid JSON example/schema in ${name}`);
      }
    }
    const anchors = [...content.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1]);
    if (new Set(anchors).size !== anchors.length) fail(`Duplicate interface anchor: ${name}`);
    for (const link of content.matchAll(/\]\(#([^)]*)\)/g))
      if (!anchors.includes(link[1])) fail(`Missing interface anchor in ${name}: ${link[1]}`);
  }
  const operations = Object.values(json(join(docs, "reference/openapi-v1.json")).paths).flatMap(
    (path) =>
      Object.entries(path)
        .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
        .map(([, operation]) => operation.operationId),
  );
  const rest = maps["rest-api-map.md"];
  if (
    Number(/## Fixed REST registry: (\d+) operations/.exec(rest)?.[1]) !== operations.length ||
    operations.some((id) => !rest.includes(`<a id="${id.toLowerCase()}"></a>`))
  )
    fail("REST map differs from the complete OpenAPI operation inventory");
  const mcp = maps["mcp-map.md"];
  const tools = [...mcp.matchAll(/^### (cms_(?!ext_)[a-z0-9_]+)$/gm)].map((match) => match[1]);
  if (
    !tools.length ||
    new Set(tools).size !== tools.length ||
    Number(/## Built-in tools: (\d+)/.exec(mcp)?.[1]) !== tools.length
  )
    fail("MCP map has missing/duplicate tools");
  const cli = maps["cli-map.md"];
  if (
    Number(/Audited implementation files: \*\*(\d+)\*\*/.exec(cli)?.[1]) !==
    (cli.match(/^### packages\/cli\/src\//gm) ?? []).length
  )
    fail("CLI map has missing source inventories");
  return { restOperations: operations.length, mcpTools: tools.length };
}
function sameSkill(expected, actual) {
  const expectedNames = files(expected).map((path) => relative(expected, path));
  const actualNames = files(actual).map((path) => relative(actual, path));
  if (
    JSON.stringify(expectedNames) !== JSON.stringify(actualNames) ||
    expectedNames.some(
      (name) => !readFileSync(join(expected, name)).equals(readFileSync(join(actual, name))),
    )
  ) {
    fail(
      "Release root Skill differs from docs/skills; replace the same-id folder in isolated release sources",
    );
  }
}
export function checkDocs(
  docs,
  version = readFileSync(join(docs, "release-version.txt"), "utf8").trim(),
  skills,
) {
  validateVersion(version);
  if (readFileSync(join(docs, "release-version.txt"), "utf8") !== `${version}\n`)
    fail(`Documentation does not match release ${version}`);
  for (const path of currentFiles)
    if (!existsSync(join(docs, path))) fail(`Missing current-release entrypoint: ${path}`);
  const interfaceMaps = checkInterfaceMaps(docs);
  const paths = files(docs);
  for (const absolute of paths.filter((path) => textExtensions.test(path))) {
    const path = relative(docs, absolute);
    if (path === "release-version.txt") continue;
    const text = readFileSync(absolute, "utf8");
    if (path.endsWith(".json")) scanJson(JSON.parse(text), path);
    else scanText(text, path, version);
  }
  for (const entry of json(join(docs, "skills/catalog.json")).skills) {
    for (const field of ["distribution", "manifest", "entrypoint"]) {
      const path = resolve(docs, entry[field]);
      if (!inside(docs, path) || !existsSync(path))
        fail(`Missing or escaping catalogue ${field}: ${entry.id}`);
    }
    const manifest = json(join(docs, entry.manifest));
    if (
      entry.id !== manifest.id ||
      entry.version !== manifest.version ||
      entry.requiresCms !== manifest.requires.cms
    )
      fail(`Skill catalogue drift: ${entry.id}`);
  }
  const resources = generatedResources(docs);
  for (const [path, content] of resources) {
    const actual = join(docs, path);
    if (
      !existsSync(actual) ||
      !(path.endsWith(".json")
        ? isDeepStrictEqual(json(actual), JSON.parse(content.toString("utf8")))
        : readFileSync(actual).equals(content))
    )
      fail(`Stale generated Skill resource: ${path}; run sync`);
  }
  for (const path of files(join(docs, skillPath, "assets"))) {
    if (!resources.has(relative(docs, path))) fail(`Unexpected generated Skill asset: ${path}`);
  }
  const links = checkLinks(docs);
  for (const id of standaloneSkillIds) {
    checkSkill(join(docs, "skills", id));
    if (skills) sameSkill(join(docs, "skills", id), join(skills, id));
  }
  return {
    version,
    markdownFiles: paths.filter((path) => path.endsWith(".md")).length,
    links,
    generatedResources: resources.size,
    ...interfaceMaps,
  };
}
export function prepareRelease(docs, version, output) {
  validateVersion(version);
  docs = resolve(docs);
  output = resolve(output);
  if (inside(docs, output) || inside(output, docs) || existsSync(output))
    fail("Release overlay output must be new and outside the documentation source");
  checkDocs(docs);
  try {
    mkdirSync(output, { recursive: true });
    const stagedDocs = join(output, "docs");
    cpSync(docs, stagedDocs, { recursive: true });
    syncDocs(stagedDocs, version);
    for (const id of standaloneSkillIds)
      cpSync(join(stagedDocs, "skills", id), join(output, "skills", id), { recursive: true });
    write(join(output, "scripts/public-docs.mjs"), readFileSync(scriptPath));
    return checkDocs(stagedDocs, version, join(output, "skills"));
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}
function main() {
  const [command = "check", ...args] = process.argv.slice(2);
  if (!["check", "sync", "prepare"].includes(command)) fail("Use check, sync or prepare");
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--release-version", "--docs-dir", "--skills-dir", "--out"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      fail(`Invalid option: ${args[i]}`);
    options[args[i]] = args[i + 1];
  }
  if (command !== "prepare" && options["--out"]) fail("--out is only valid with prepare");
  if (command === "prepare" && options["--skills-dir"])
    fail("--skills-dir is only valid with check/sync");
  const docs = resolve(
    options["--docs-dir"] ??
      join(sourceRoot, existsSync(join(sourceRoot, "public-docs")) ? "public-docs" : "docs"),
  );
  const skills = options["--skills-dir"]
    ? resolve(options["--skills-dir"])
    : existsSync(join(sourceRoot, "public-docs"))
      ? undefined
      : join(sourceRoot, "skills");
  const explicitVersion = options["--release-version"] ?? process.env.PCMS_RELEASE_VERSION;
  const version = explicitVersion ?? readFileSync(join(docs, "release-version.txt"), "utf8").trim();
  if (command === "prepare") {
    if (!explicitVersion || !options["--out"])
      fail("prepare requires --release-version (or PCMS_RELEASE_VERSION) and --out");
    console.log(JSON.stringify(prepareRelease(docs, version, options["--out"])));
  } else {
    if (command === "sync") syncDocs(docs, version);
    console.log(JSON.stringify(checkDocs(docs, version, skills)));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`public-docs: ${error.message}`);
    process.exitCode = 1;
  }
}
