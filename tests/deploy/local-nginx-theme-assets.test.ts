import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  type ApplicationServices,
  createApiFastify,
  createApiV1,
  makeThemeManageRoutes,
} from "@pcms/api";
import { createAuthorizationService } from "@pcms/auth";
import { createBlockRegistry } from "@pcms/blocks";
import { createLogger } from "@pcms/core";
import yazl from "yazl";
import { registerThemeFilesRoute } from "../../apps/web/src/theme-files.js";

const template = readFileSync("deploy/nginx/progressive-cms.conf", "utf8");

test("local-nginx proxies themes to the Web public-assets gate without filesystem access", () => {
  const location = template.match(/location \/themes\/ \{([^}]+)\}/)?.[1];
  assert.ok(location);
  assert.match(location, /proxy_pass http:\/\/127\.0\.0\.1:3000/);
  assert.doesNotMatch(location, /\b(root|alias|try_files|expires)\b/);
  assert.doesNotMatch(
    readFileSync("deploy/scripts/install-release.sh", "utf8"),
    /chmod 751.*STATEROOT/,
  );
});

test("API-installed restrictive theme serves CSS/JS/SVG through a real Nginx endpoint; private paths stay closed", async (t) => {
  const nginxBin = process.env.NGINX_BIN ?? "nginx";
  if (spawnSync(nginxBin, ["-v"]).error)
    return t.skip("nginx unavailable; set NGINX_BIN to run HTTP acceptance");
  const root = mkdtempSync(join(tmpdir(), "pcms-nginx-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const active = join(root, "themes", "active");
  mkdirSync(active, { recursive: true });
  const app = {
    defaultSiteKey: "default",
    authorize: createAuthorizationService().authorize,
    themeDir: active,
    themeRuntime: { configuredDir: active },
    blocks: createBlockRegistry(),
    actorResolver: {
      async authenticateToken() {
        return {
          actor: {
            type: "SERVICE_ACCOUNT",
            permissions: new Set(["theme.write"]),
            siteKey: null,
            environment: null,
          },
        };
      },
    },
  } as unknown as ApplicationServices;
  const server = createApiFastify(() => "nginx-theme-assets");
  t.after(() => server.close());
  await server.register(createApiV1(makeThemeManageRoutes()), {
    application: app,
    logger: createLogger({ level: "error", base: {} }),
    cookieSecure: false,
  });
  server.get("/proxy-scheme", (request) => ({ scheme: request.headers["x-forwarded-proto"] }));
  registerThemeFilesRoute(server, { renderDir: active });
  const upstream = await server.listen({ host: "127.0.0.1", port: 0 });
  const zip = new yazl.ZipFile();
  const source = resolve("themes/reference-theme-v1");
  function pack(dir: string, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) pack(join(dir, entry.name), `${name}/`);
      else zip.addBuffer(readFileSync(join(dir, entry.name)), name);
    }
  }
  pack(source);
  const chunks: Buffer[] = [];
  zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const packed = once(zip.outputStream, "end");
  zip.end();
  await packed;
  const oldUmask = process.umask(0o027);
  try {
    const installed = await fetch(`${upstream}/api/v1/themes/install`, {
      method: "POST",
      headers: { authorization: "Bearer fixture", "content-type": "application/octet-stream" },
      body: Uint8Array.from(Buffer.concat(chunks)),
    });
    assert.equal(installed.status, 201, await installed.text());
  } finally {
    process.umask(oldUmask);
  }
  const theme = join(root, "themes", "reference-theme-v1");
  assert.equal(statSync(join(theme, "assets/css/theme.css")).mode & 0o777, 0o640);
  assert.equal(statSync(join(theme, "assets/css")).mode & 0o777, 0o750);
  writeFileSync(join(theme, "assets", ".secret"), "PRIVATE");
  symlinkSync(join(theme, "theme.json"), join(theme, "assets", "escape.json"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    reservation.close((error) => (error ? reject(error) : resolveClose())),
  );
  const conf = join(root, "nginx.conf");
  const vhost = template
    .replaceAll("__SITE_HOST__", "localhost")
    .replace("listen 80;", `listen 127.0.0.1:${port};`)
    .replaceAll("http://127.0.0.1:3000", upstream)
    .replaceAll(
      "/etc/nginx/snippets/progressive-cms-proxy.conf",
      resolve("deploy/nginx/proxy-snippet.conf"),
    );
  writeFileSync(
    conf,
    `daemon off; pid ${root}/nginx.pid; error_log ${root}/error.log; events {} http { access_log off; client_body_temp_path ${root}/body; proxy_temp_path ${root}/proxy; fastcgi_temp_path ${root}/fastcgi; uwsgi_temp_path ${root}/uwsgi; scgi_temp_path ${root}/scgi; ${vhost} }`,
  );
  const syntax = spawnSync(nginxBin, ["-t", "-p", `${root}/`, "-c", conf], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const nginx = spawn(nginxBin, ["-p", `${root}/`, "-c", conf], { stdio: "ignore" });
  const exited = once(nginx, "exit");
  t.after(async () => {
    nginx.kill("SIGQUIT");
    await exited;
  });
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`${endpoint}/themes/reference-theme-v1/assets/css/theme.css`);
      ready = true;
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  assert.ok(ready, "nginx did not start");
  const scheme = await fetch(`${endpoint}/proxy-scheme`, {
    headers: { "x-forwarded-proto": "https" },
  });
  assert.deepEqual(await scheme.json(), { scheme: "http" }, "edge must overwrite spoofed scheme");
  for (const [path, mime] of [
    ["css/theme.css", "text/css"],
    ["js/theme.js", "text/javascript"],
    ["img/logo.svg", "image/svg+xml"],
  ]) {
    const response = await fetch(`${endpoint}/themes/reference-theme-v1/assets/${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type")?.split(";")[0], mime);
    assert.equal(await response.text(), readFileSync(join(theme, "assets", path!), "utf8"));
  }
  for (const path of [
    "theme.json",
    "templates/page-default.liquid",
    ".pcms-install.json",
    "assets/",
    "assets/.secret",
    "assets/escape.json",
    "assets/%2e%2e/theme.json",
  ]) {
    const response = await fetch(`${endpoint}/themes/reference-theme-v1/${path}`);
    assert.equal(response.status, 404, path);
  }
});
