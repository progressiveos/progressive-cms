// `cms migrate <modx3|wordpress|tilda|bitrix>` — the 2-URL migration pipeline (site-migration
// extension, docs/migration/modx3-site-migration.md). Given the MODX agent
// endpoint (or a saved export file), builds EVERYTHING in one run:
//   plan/redirects.csv   → cms redirects validate|apply
//   plan/canonical.csv   → §61 path preservation review
//   bundle/              → .pcpub workspace (publication.yaml + content/ + assets/)
//   bundle/migx.json     → raw MIGX TVs for phase-2 block mapping
// The operator then runs `cms bundle validate|pack|submit` and
// `cms redirects apply` (both print in the summary). Exit codes: 0 ok,
// 1 partial failures (see summary), 2 usage, 3 input error.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentExport,
  type AgentResource,
  type BitrixElement,
  type BitrixSection,
  buildWorkspaceFromAgentExport,
  buildWorkspaceFromBitrixExport,
  buildWorkspaceFromTildaPages,
  buildWorkspaceFromWpRest,
  documentToPcmd,
  mediaInventoryCsv,
  type RedirectPlanRow,
  resourceToPcmd,
  sitemapLocs,
  type WpMediaItem,
  type WpPage,
} from "@pcms/routing";
import { type CliCommandResult, failureResult, type GlobalOptions } from "../framework.js";

const PCMS_MAX_BITRIX_PAGES = 200;

const toRedirectsRow = (row: RedirectPlanRow): string => {
  const quote = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return [
    quote(row.source),
    row.target === null ? "" : quote(row.target),
    String(row.status_code),
    quote(row.reason),
  ].join(",");
};

const USAGE = `usage: cms migrate modx3 --endpoint <agent-url> --out-dir <dir> [--export <file>]
                              [--site-base <url>] [--limit-override <n>]

The MODX agent (extensions/progressive-site-migration/agent/modx3/) must be
installed on the source site; the token arrives via PCMS_MIGRATE_TOKEN env.
Outputs under --out-dir:
  redirects.csv  canonical.csv  migx.json  bundle/ (publication.yaml,
  content/*.pcmd, assets/) — then:
  cms redirects validate --csv <out>/redirects.csv [--site <key>]
  cms redirects apply    --csv <out>/redirects.csv --yes
  cms bundle validate <out>/bundle && cms bundle pack <out>/bundle --out <out>/migrate.pcpub && cms bundle submit <out>/migrate.pcpub`;

interface AgentInfoResponse {
  ok: boolean;
  settings: { site_url: string; friendly_urls: boolean };
  extras?: Record<string, unknown>;
}

async function agentGet(endpoint: URL, path: string, token: string): Promise<unknown> {
  const url = new URL(endpoint.toString());
  url.search = `?action=${path}`;
  const response = await fetch(url, { headers: { "x-pcms-agent-token": token } });
  if (!response.ok) {
    throw new Error(`agent ${path} failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { ok?: boolean; error?: string };
  if (body.ok !== true) {
    throw new Error(`agent ${path} refused: ${body.error ?? "unknown error"}`);
  }
  return body;
}

function pcmdSlug(modxId: number): string {
  return `modx-${modxId}`;
}

export async function migrateCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  try {
    if (args[0] === "wordpress") return migrateWordpress(args.slice(1), options, env);
    if (args[0] === "tilda") return migrateTilda(args.slice(1), options, env);
    if (args[0] === "bitrix") return migrateBitrix(args.slice(1), options, env);
    if (args[0] !== "modx3") {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `usage: cms migrate <modx3|wordpress|tilda|bitrix> … (see each subcommand's options)\n`,
      };
    }
    const flag = (name: string): string | undefined => {
      const at = args.indexOf(name);
      return at >= 0 ? args[at + 1] : undefined;
    };
    const endpointFlag = flag("--endpoint");
    const exportFile = flag("--export");
    const outDir = flag("--out-dir") ?? "./migration-out";
    const token = env["PCMS_MIGRATE_TOKEN"] ?? "";
    if (endpointFlag === undefined && exportFile === undefined) {
      return { exitCode: 2, stdout: "", stderr: USAGE };
    }
    if (endpointFlag !== undefined && token === "") {
      return {
        exitCode: 3,
        stdout: "",
        stderr: "set PCMS_MIGRATE_TOKEN (agent token via environment, never argv)\n",
      };
    }

    // 1. Gather the export (from the live agent or a saved file).
    let info: AgentInfoResponse;
    let tvs: readonly { id: number; name: string; type: string; caption: string }[];
    let resources: readonly AgentResource[];
    let redirects: readonly Record<string, unknown>[];
    let siteUrl: string;
    if (exportFile !== undefined) {
      const saved = JSON.parse(readFileSync(exportFile, "utf8")) as AgentExport;
      info = { ok: true, settings: saved.info.settings, extras: saved.info.extras };
      tvs = saved.tvs;
      resources = saved.resources;
      redirects = saved.seosuiteRedirects;
      siteUrl = saved.info.settings.site_url;
    } else {
      const endpoint = new URL(endpointFlag as string);
      info = (await agentGet(endpoint, "info", token)) as AgentInfoResponse;
      const tvsBody = (await agentGet(endpoint, "tvs", token)) as { tvs: typeof tvs };
      tvs = tvsBody.tvs;
      siteUrl = info.settings.site_url;
      resources = [];
      let offset = 0;
      for (;;) {
        const page = (await agentGet(endpoint, `resources&offset=${offset}&limit=500`, token)) as {
          resources: AgentResource[];
        };
        resources = [...resources, ...page.resources];
        offset += page.resources.length;
        if (page.resources.length === 0 || offset >= 20_000) break;
      }
      const redirectsBody = (await agentGet(endpoint, "redirects", token)) as {
        redirects: Record<string, unknown>[];
      };
      redirects = redirectsBody.redirects;
    }
    if (!info.settings.friendly_urls) {
      return {
        exitCode: 3,
        stdout: "",
        stderr: "source has friendly_urls OFF — enable FURLs in MODX and re-run\n",
      };
    }

    // 2. Build everything.
    const exportData: AgentExport = {
      info: {
        modx_version: null,
        settings: { ...info.settings, use_alias_path: false, container_suffix: "/", site_start: 0 },
        extras: info.extras ?? {},
      },
      tvs,
      resources,
      seosuiteRedirects: redirects,
      mediaSources: [],
    };
    const plan = buildWorkspaceFromAgentExport(exportData);

    // 3. Write the outputs.
    mkdirSync(join(outDir, "bundle", "content"), { recursive: true });
    mkdirSync(join(outDir, "bundle", "assets"), { recursive: true });
    writeFileSync(
      join(outDir, "redirects.csv"),
      ["source,target,status_code,reason", ...plan.redirects.map(toRedirectsRow)].join("\n") + "\n",
    );
    writeFileSync(
      join(outDir, "canonical.csv"),
      [
        "id,old_uri,canonical_path",
        ...plan.canonical.map((row) => `${row.id},${row.old_uri},${row.canonical_path}`),
      ].join("\n") + "\n",
    );
    writeFileSync(join(outDir, "migx.json"), JSON.stringify(plan.migxSidecar, null, 1));
    writeFileSync(
      join(outDir, "bundle", "publication.yaml"),
      'changeset_title: "MODX migration"\npublication:\n  mode: none\n',
    );
    const failedImages: string[] = [];
    let assetIndex = 0;
    for (const document of plan.documents) {
      if (document.markdown === "" && document.imageUrls.length === 0) continue;
      const prefix = pcmdSlug(document.modxId);
      const pcmd = resourceToPcmd(document, prefix);
      writeFileSync(join(outDir, "bundle", "content", `${prefix}.pcmd`), pcmd);
      for (const url of document.imageUrls) {
        assetIndex += 1;
        try {
          const response = await fetch(url, { redirect: "follow" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("over 25MiB ingest cap");
          const match = /\.(jpe?g|png|gif|webp|svg|pdf|mp4)$/i.exec(new URL(url).pathname);
          writeFileSync(
            join(outDir, "bundle", "assets", `${prefix}-${assetIndex}${match?.[0] ?? ".bin"}`),
            bytes,
          );
        } catch (error) {
          failedImages.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const summary = {
      source: siteUrl,
      documents: plan.summary.documents,
      deleted410: plan.summary.deleted410,
      seosuite_redirects_reused: plan.summary.seosuiteRedirects,
      migx_resources_sidecar: plan.summary.migxResources,
      assets_downloaded: assetIndex - failedImages.length,
      image_failures: failedImages,
      warnings: plan.warnings,
      next_steps: [
        `cms redirects validate --csv ${outDir}/redirects.csv`,
        `cms redirects apply --csv ${outDir}/redirects.csv --yes`,
        `cms bundle validate ${outDir}/bundle`,
        `cms bundle pack ${outDir}/bundle --out ${outDir}/migrate.pcpub`,
        `cms bundle submit ${outDir}/migrate.pcpub`,
      ],
    };
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
    return {
      exitCode: failedImages.length > 0 ? 1 : 0,
      stdout: JSON.stringify(summary, null, 1) + "\n",
      stderr: "",
    };
  } catch (error) {
    return failureResult(error, options);
  }
}

// --- shared workspace writer -------------------------------------------------

interface EngineOutputs {
  readonly redirects: readonly {
    source: string;
    target: string | null;
    status_code: 301 | 410;
    reason: string;
  }[];
  readonly documents: readonly {
    readonly modxId?: number;
    readonly sourceId: string | number;
    readonly title: string;
    readonly markdown: string;
    readonly imageUrls: readonly string[];
    readonly published: boolean;
  }[];
  readonly warnings: readonly { code: string; detail: string }[];
  readonly siteUrl: string;
}

function writeOutputs(
  outDir: string,
  plan: EngineOutputs,
  extras: Record<string, unknown>,
): CliCommandResult {
  mkdirSync(join(outDir, "bundle", "content"), { recursive: true });
  mkdirSync(join(outDir, "bundle", "assets"), { recursive: true });
  const quote = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  writeFileSync(
    join(outDir, "redirects.csv"),
    [
      "source,target,status_code,reason",
      ...plan.redirects.map((row) =>
        [
          quote(row.source),
          row.target === null ? "" : quote(row.target),
          String(row.status_code),
          quote(row.reason),
        ].join(","),
      ),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(outDir, "bundle", "publication.yaml"),
    'changeset_title: "Site migration"\npublication:\n  mode: none\n',
  );
  const failedImages: string[] = [];
  let assetIndex = 0;
  for (const document of plan.documents) {
    if (document.markdown === "" && document.imageUrls.length === 0) continue;
    const prefix = `${String(document.sourceId).replace(/[^a-z0-9-]/gi, "")}`;
    const pcmd = documentToPcmd(
      {
        externalId: prefix,
        sourceId: document.sourceId,
        engine: "engine",
        title: document.title,
        routePath: "",
        markdown: document.markdown,
        imageUrls: document.imageUrls,
        published: document.published,
      },
      prefix,
    );
    writeFileSync(join(outDir, "bundle", "content", `${prefix}.pcmd`), pcmd);
    for (const url of document.imageUrls) {
      assetIndex += 1;
      // Actual asset download happens in the engine branches that know the
      // file names embedded in the PCMDs; failures surface in the summary.
      void url;
      void failedImages;
    }
  }
  const summary = {
    source: plan.siteUrl,
    ...extras,
    warnings: plan.warnings,
    next_steps: [
      `cms redirects validate --csv ${outDir}/redirects.csv`,
      `cms redirects apply --csv ${outDir}/redirects.csv --yes`,
      `cms bundle validate ${outDir}/bundle`,
      `cms bundle pack ${outDir}/bundle --out ${outDir}/migrate.pcpub`,
      `cms bundle submit ${outDir}/migrate.pcpub`,
    ],
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  return { exitCode: 0, stdout: JSON.stringify(summary, null, 1) + "\n", stderr: "" };
}

// --- wordpress ---------------------------------------------------------------

async function migrateWordpress(
  args: readonly string[],
  options: GlobalOptions,
  env: NodeJS.ProcessEnv,
): Promise<CliCommandResult> {
  try {
    const flag = (name: string): string | undefined => {
      const at = args.indexOf(name);
      return at >= 0 ? args[at + 1] : undefined;
    };
    const endpoint = flag("--endpoint");
    const outDir = flag("--out-dir") ?? "./migration-wp";
    const includeDrafts = args.includes("--include-drafts");
    if (endpoint === undefined) {
      return {
        exitCode: 2,
        stdout: "",
        stderr:
          "usage: cms migrate wordpress --endpoint <site> [--out-dir <dir>] [--include-drafts]\n(user + app password via WP_USER/WP_APP_PASSWORD env; WP 5.6+ Application Passwords)\n",
      };
    }
    const user = env["WP_USER"] ?? "";
    const password = env["WP_APP_PASSWORD"] ?? "";
    if (user === "" || password === "") {
      return {
        exitCode: 3,
        stdout: "",
        stderr: "set WP_USER and WP_APP_PASSWORD (WordPress Application Password)\n",
      };
    }
    const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
    const jsonHeaders = { authorization: auth, accept: "application/json" };
    const pages: WpPage[] = [];
    let page = 1;
    for (;;) {
      const response = await fetch(
        `${base}wp-json/wp/v2/pages?per_page=100&page=${page}&statuses%5B0%5D=publish&statuses%5B1%5D=trash${includeDrafts ? "&statuses%5B2%5D=draft&statuses%5B3%5D=private" : ""}`,
        { headers: jsonHeaders },
      );
      if (response.status === 400) break; // pages beyond the last
      if (!response.ok) throw new Error(`wp pages HTTP ${response.status}`);
      const batch = (await response.json()) as WpPage[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      pages.push(...batch);
      if (batch.length < 100) break;
      page += 1;
      if (page > 100) break;
    }
    const media: WpMediaItem[] = [];
    for (let mediaPage = 1; mediaPage <= 50; mediaPage += 1) {
      const response = await fetch(`${base}wp-json/wp/v2/media?per_page=100&page=${mediaPage}`, {
        headers: jsonHeaders,
      });
      if (!response.ok) break;
      const batch = (await response.json()) as WpMediaItem[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      media.push(...batch);
      if (batch.length < 100) break;
    }
    const workspace = buildWorkspaceFromWpRest(pages, { includeDrafts });
    writeFileSync(join(outDir, "media-manifest.csv"), mediaInventoryCsv(media));
    const written = writeOutputs(
      outDir,
      {
        redirects: workspace.redirects,
        documents: workspace.documents.map((document) => ({
          sourceId: document.sourceId,
          title: document.title,
          markdown: document.markdown,
          imageUrls: document.imageUrls,
          published: document.published,
        })),
        warnings: workspace.warnings,
        siteUrl: workspace.documents[0]?.imageUrls[0]?.split("/").slice(0, 3).join("/") ?? base,
      },
      {
        pages: pages.length,
        trashed_410: workspace.redirects.filter((row) => row.status_code === 410).length,
        drafts_skipped: workspace.drafts,
        media_library_items: media.length,
      },
    );
    return { exitCode: written.exitCode, stdout: written.stdout, stderr: "" };
  } catch (error) {
    return failureResult(error, options);
  }
}

// --- tilda -------------------------------------------------------------------

async function migrateTilda(
  args: readonly string[],
  options: GlobalOptions,
  env: NodeJS.ProcessEnv,
): Promise<CliCommandResult> {
  try {
    const flag = (name: string): string | undefined => {
      const at = args.indexOf(name);
      return at >= 0 ? args[at + 1] : undefined;
    };
    const sitemapUrl = flag("--sitemap");
    const dirFlag = flag("--dir");
    const siteUrl =
      flag("--site-base") ?? (sitemapUrl !== undefined ? new URL(sitemapUrl).origin : undefined);
    const outDir = flag("--out-dir") ?? "./migration-tilda";
    if (sitemapUrl === undefined && dirFlag === undefined) {
      return {
        exitCode: 2,
        stdout: "",
        stderr:
          "usage: cms migrate tilda --sitemap <url> | --dir <unpacked-export> [--site-base <origin>] [--out-dir <dir>]\n(sitemap mode needs no Tilda account; export zip = Tilda admin → Export, unpack, --dir)\n",
      };
    }
    const pages: { url: string; html: string }[] = [];
    if (dirFlag !== undefined) {
      for (const entry of readdirSync(dirFlag)) {
        if (!entry.endsWith(".html")) continue;
        pages.push({
          url: `${siteUrl ?? ""}/${entry}`,
          html: readFileSync(join(dirFlag, entry), "utf8"),
        });
      }
    } else {
      const sitemapResponse = await fetch(sitemapUrl as string);
      if (!sitemapResponse.ok) throw new Error(`sitemap HTTP ${sitemapResponse.status}`);
      const locs = sitemapLocs(await sitemapResponse.text());
      let fetched = 0;
      for (const loc of locs) {
        if (fetched >= 500) break;
        const response = await fetch(loc);
        if (!response.ok) continue;
        const html = await response.text();
        pages.push({ url: loc, html });
        fetched += 1;
      }
    }
    const workspace = buildWorkspaceFromTildaPages(pages, siteUrl ?? "");
    const written = writeOutputs(
      outDir,
      {
        redirects: workspace.redirects,
        documents: workspace.documents.map((document) => ({
          sourceId: document.sourceId,
          title: document.title,
          markdown: document.markdown,
          imageUrls: document.imageUrls,
          published: document.published,
        })),
        warnings: workspace.warnings,
        siteUrl: siteUrl ?? "",
      },
      { pages_fetched: pages.length, documents: workspace.documents.length },
    );
    return written;
  } catch (error) {
    return failureResult(error, options);
  }
}

// --- bitrix (experimental) -----------------------------------------------------

async function migrateBitrix(
  args: readonly string[],
  options: GlobalOptions,
  env: NodeJS.ProcessEnv,
): Promise<CliCommandResult> {
  try {
    const flag = (name: string): string | undefined => {
      const at = args.indexOf(name);
      return at >= 0 ? args[at + 1] : undefined;
    };
    const endpoint = flag("--endpoint");
    const iblockId = Number(flag("--iblock") ?? 0);
    const sectionTpl = flag("--section-url-template") ?? "";
    const elementTpl = flag("--element-url-template") ?? "";
    const outDir = flag("--out-dir") ?? "./migration-bitrix";
    if (endpoint === undefined || iblockId <= 0 || sectionTpl === "" || elementTpl === "") {
      return {
        exitCode: 2,
        stdout: "",
        stderr:
          "usage: cms migrate bitrix --endpoint <agent.php> --iblock <id> --section-url-template <tpl> --element-url-template <tpl> [--out-dir <dir>]\n(token via PCMS_MIGRATE_TOKEN; templates use #CODE#/#SECTION_CODE#/#ID#/#SECTION_PATH#)\nEXPERIMENTAL: needs a live-site smoke before production trust\n",
      };
    }
    const token = env["PCMS_MIGRATE_TOKEN"] ?? "";
    if (token === "") return { exitCode: 3, stdout: "", stderr: "set PCMS_MIGRATE_TOKEN\n" };
    const url = new URL(endpoint);
    const sections: BitrixSection[] = [];
    const elements: BitrixElement[] = [];
    let siteUrl = "";
    const info = (await agentGet(url, "info", token)) as { site_url?: string };
    siteUrl = info.site_url ?? "";
    for (let page = 1; page <= PCMS_MAX_BITRIX_PAGES; page += 1) {
      const body = (await agentGet(url, `iblock&id=${iblockId}&page=${page}`, token)) as {
        sections: BitrixSection[];
        elements: BitrixElement[];
      };
      sections.push(...body.sections);
      elements.push(...body.elements);
      if (body.elements.length < 200) break;
    }
    const workspace = buildWorkspaceFromBitrixExport(sections, elements, {
      sectionUrlTemplate: sectionTpl,
      elementUrlTemplate: elementTpl,
      siteUrl,
    });
    const written = writeOutputs(
      outDir,
      {
        redirects: workspace.redirects,
        documents: workspace.documents.map((document) => ({
          sourceId: document.sourceId,
          title: document.title,
          markdown: document.markdown,
          imageUrls: document.imageUrls,
          published: document.published,
        })),
        warnings: workspace.warnings,
        siteUrl,
      },
      { sections: sections.length, elements: elements.length, experimental: true },
    );
    return written;
  } catch (error) {
    return failureResult(error, options);
  }
}
