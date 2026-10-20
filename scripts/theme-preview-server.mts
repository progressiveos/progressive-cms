// Theme preview HTTP server (PCMS-THEME-T021/T023; Theme Contract spec §48/§57).
// Dev/test-only surface: renders reference theme fixtures over HTTP for
// browser smoke tests and manual preview. Not a product route — the public
// site renderer arrives with publication (M07) and routing (M04).
//   node --import tsx scripts/theme-preview-server.mts --port 8787

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  createThemePreview,
  type MediaAssetViewModel,
  type NavigationAssignment,
  renderRichText,
  type SafeHtml,
  type ThemeManifest,
  validateThemeManifest,
} from "@pcms/themes";

const THEME_DIR = "themes/reference-theme-v1";
const PORT = Number(process.argv[process.argv.indexOf("--port") + 1] ?? "8787");

const manifestResult = validateThemeManifest(
  JSON.parse(readFileSync(join(THEME_DIR, "theme.json"), "utf8")),
);
if (!manifestResult.ok) {
  console.error("invalid reference theme manifest", manifestResult.issues);
  process.exit(1);
}
const manifest: ThemeManifest = manifestResult.value;

const snapshot: Record<string, string> = {};
for (const dir of ["templates", "components", "blocks"]) {
  walk(join(THEME_DIR, dir), `${dir}/`);
}
function walk(dir: string, prefix: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
    else snapshot[`${prefix}${entry.name}`] = readFileSync(full, "utf8");
  }
}

const preview = createThemePreview({ manifest, snapshot, devMode: true });

interface Fixture {
  name: string;
  entry: {
    templateKey: string;
    contentTypeKey: string;
    contentTypeVersion: number;
    title: string;
    fields: Record<string, unknown>;
    blocks: Parameters<typeof preview.blocks.renderBlockDocument>[0];
  };
  media: Record<string, MediaAssetViewModel>;
  navigation: NavigationAssignment[];
  globals: Record<string, unknown>;
  bodyHtml?: string | SafeHtml;
}

function loadFixture(name: string): Fixture | null {
  const file = join(THEME_DIR, "fixtures", `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Fixture;
}

function fixtureNames(): string[] {
  return readdirSync(join(THEME_DIR, "fixtures"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

async function renderFixture(name: string): Promise<string | null> {
  const fixture = loadFixture(name);
  if (fixture === null) return null;
  const fields = fixture.entry.fields;
  let bodyHtml = fixture.bodyHtml;
  const rawBody = fields.body;
  if (
    bodyHtml === undefined &&
    typeof rawBody === "object" &&
    rawBody !== null &&
    "type" in rawBody
  ) {
    bodyHtml = renderRichText(rawBody);
  }
  return preview.renderEntry(
    {
      templateKey: fixture.entry.templateKey,
      contentTypeKey: fixture.entry.contentTypeKey,
      contentTypeVersion: fixture.entry.contentTypeVersion,
      title: fixture.entry.title,
      fields,
      blocks: fixture.entry.blocks,
      mediaMap: fixture.media,
      bodyHtml: bodyHtml ?? "",
    },
    { siteName: "Акме", navigationAssignments: fixture.navigation },
  );
}

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type = "text/html; charset=utf-8",
): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/" || url.pathname === "/preview") {
    const list = fixtureNames()
      .map((n) => `<li><a href="/preview/${n}">${n}</a></li>`)
      .join("");
    send(
      res,
      200,
      `<!DOCTYPE html><html lang="ru"><head><title>Preview index</title></head><body><h1>Preview</h1><ul>${list}</ul></body></html>`,
    );
    return;
  }
  const previewMatch = /^\/preview\/([a-z0-9-]+)$/.exec(url.pathname);
  if (previewMatch) {
    void renderFixture(previewMatch[1] ?? "").then(
      (html) => (html === null ? send(res, 404, "unknown fixture") : send(res, 200, html)),
      (error) => send(res, 500, `render error: ${(error as Error).message}`),
    );
    return;
  }
  // Media derivative stand-ins (the Media subsystem arrives in M05): tiny
  // valid SVGs so preview images render without external services.
  const mediaMatch = /^\/media\/[a-z0-9.-]+$/.exec(url.pathname);
  if (mediaMatch) {
    send(
      res,
      200,
      "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'><rect width='100%' height='100%' fill='#f2f4f8'/></svg>",
      "image/svg+xml",
    );
    return;
  }
  const assetMatch = /^\/themes\/reference-theme-v1\/(assets\/[a-z0-9._/-]+)$/.exec(url.pathname);
  if (assetMatch && assetMatch[1] !== undefined && !assetMatch[1].includes("..")) {
    const file = join(THEME_DIR, assetMatch[1]);
    if (existsSync(file)) {
      send(
        res,
        200,
        readFileSync(file, "utf8"),
        MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
      );
      return;
    }
  }
  send(res, 404, "not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`theme preview server on http://127.0.0.1:${PORT}/preview`);
});
