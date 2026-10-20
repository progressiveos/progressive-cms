// MODX 3.0/3.2 → Progressive CMS redirect-plan connector (site migrations).
//
// Input: a CSV export of `modx_site_content` for the public context:
//   SELECT id, parent, alias, uri, uri_override, content_type, context_key,
//          isfolder, deleted, published, class_key, pagetitle
//   FROM modx_site_content WHERE context_key = 'web';
// (phpMyAdmin export or mysqldump --tab; UTF-8, header row required.)
//
// URI model (docs.modx.com 3.x): `uri` is MODX's materialized full path —
// parent-chain aliases (use_alias_path) + own alias + the content type's
// file_extension (MODX 3 moved FURL prefix/suffix into Content Types;
// containers take container_suffix, default "/"). Frozen URIs
// (uri_override=1) are used verbatim, as MODX serves them. So the connector
// never recomposes URIs — it trusts the column, exactly like the live site.
//
// Output (plan for `cms redirects validate|apply`):
//   redirects.csv — 410 for deleted resources, 301 for resources whose new
//                   path differs (via --map or prefix rewrite rules);
//   canonical.csv — id,old_uri,canonical_path for every surviving document:
//                   the §61 "preserve the old URL as canonical" plan, feeding
//                   content import/route activation;
//   summary (JSON, stdout) — counts, warnings, data problems.
import { readFileSync } from "node:fs";

export interface ModxRow {
  readonly id: number;
  readonly pagetitle: string;
  readonly uri: string;
  readonly uriOverride: boolean;
  readonly isFolder: boolean;
  readonly deleted: boolean;
  readonly published: boolean;
  readonly classKey: string;
}

export interface RedirectPlanRow {
  readonly source: string;
  readonly target: string | null;
  readonly status_code: 301 | 410;
  readonly reason: string;
}

export interface CanonicalPlanRow {
  readonly id: number;
  readonly old_uri: string;
  readonly canonical_path: string;
}

export interface PlanWarning {
  readonly code:
    | "EMPTY_URI"
    | "DUPLICATE_URI"
    | "SKIPPED_CLASS"
    | "QUERY_URI"
    | "UNMAPPED_FROZEN"
    | "CASE_VARIANT"
    | "NORMALIZED_COLLISION";
  readonly detail: string;
}

export interface PlanSummary {
  readonly documents: number;
  readonly containers: number;
  readonly deleted410: number;
  readonly redirected: number;
  readonly preserved: number;
  readonly skippedClasses: Record<string, number>;
  readonly warnings: PlanWarning[];
}

export interface ModxPlan {
  readonly redirects: readonly RedirectPlanRow[];
  readonly canonical: readonly CanonicalPlanRow[];
  readonly summary: PlanSummary;
}

export interface ModxPlanOptions {
  /** Context to plan for (MODX URIs are per-context; public site = "web"). */
  readonly contextKey?: string;
  /** CSV mapping modx_id,new_path — resources whose new path differs. */
  readonly mapCsv?: string;
  /** Strip this prefix from every old URI (site lived under a subdirectory). */
  readonly dropPrefix?: string;
  /** Prepend this prefix to every old URI (new site lives under a subdirectory). */
  readonly addPrefix?: string;
}

/** Minimal RFC-4180-ish CSV reader (quoted fields, doubled quotes, CRLF). */
export function parseCsvRecords(text: string, delimiter = ","): string[][] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (inQuotes) {
      if (char === '"') {
        if (clean[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === delimiter) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && clean[index + 1] === "\n") index += 1;
      record.push(field);
      field = "";
      if (record.length > 1 || (record[0] ?? "").trim() !== "") records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  record.push(field);
  if (record.length > 1 || (record[0] ?? "").trim() !== "") records.push(record);
  return records;
}

function toBool(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** MODX URI → site path (home "" → "/", query URIs → null). */
export function normalizePath(uri: string): string | null {
  // The MODX home resource carries an empty uri — it IS the site root.
  if (uri === "") return "/";
  // MODX URIs with FURLs off are query URLs — not expressible as site paths.
  if (uri.includes("?") || uri.includes("index.php")) return null;
  const path = uri.startsWith("/") ? uri : `/${uri}`;
  if (!path.endsWith("/") && !/\.[a-z0-9]+$/i.test(path)) return `${path}/`;
  return path;
}

function rewritePrefix(path: string, options: ModxPlanOptions): string {
  let result = path;
  if (options.dropPrefix !== undefined && result.startsWith(options.dropPrefix)) {
    result = result.slice(options.dropPrefix.length) || "/";
  }
  if (options.addPrefix !== undefined) {
    const prefix = options.addPrefix.endsWith("/") ? options.addPrefix : `${options.addPrefix}/`;
    result = `${prefix}${result.replace(/^\//, "")}`;
  }
  return result;
}

/**
 * Builds the migration plan from a modx_site_content CSV export. Pure: no
 * I/O beyond the caller-provided strings. MODX URIs are trusted as-is (the
 * live site serves exactly those); the plan only classifies and remaps.
 */
export function buildModxRedirectPlan(
  siteContentCsv: string,
  options: ModxPlanOptions = {},
): ModxPlan {
  const contextKey = options.contextKey ?? "web";
  const records = parseCsvRecords(siteContentCsv);
  const [header, ...dataRecords] = records;
  if (header === undefined)
    throw new Error("modx_site_content CSV is empty (expected a header row)");
  const names = header.map((name) => name.trim().toLowerCase());
  const at = (name: string) => names.indexOf(name);
  const required = ["id", "uri", "class_key", "context_key"];
  for (const column of required) {
    if (at(column) < 0) throw new Error(`modx_site_content CSV lacks the "${column}" column`);
  }

  const warnings: PlanWarning[] = [];
  const skippedClasses: Record<string, number> = {};
  const documents: ModxRow[] = [];
  for (const cells of dataRecords) {
    const classKey = (cells[at("class_key")] ?? "").trim();
    const rowContext = (cells[at("context_key")] ?? "").trim();
    if (rowContext !== contextKey) continue;
    if (classKey !== "modDocument") {
      // Weblinks/symlinks/static resources redirect by nature or are not
      // pages; count them, never plan them.
      skippedClasses[classKey] = (skippedClasses[classKey] ?? 0) + 1;
      if (classKey !== "modDocument") {
        warnings.push({ code: "SKIPPED_CLASS", detail: `${classKey}: ${cells[at("id")] ?? "?"}` });
      }
      continue;
    }
    const id = Number((cells[at("id")] ?? "").trim());
    if (!Number.isFinite(id)) continue;
    documents.push({
      id,
      pagetitle: (cells[at("pagetitle")] ?? "").trim(),
      uri: (cells[at("uri")] ?? "").trim(),
      uriOverride: toBool(cells[at("uri_override")]),
      isFolder: toBool(cells[at("isfolder")]),
      deleted: toBool(cells[at("deleted")]),
      published: toBool(cells[at("published")]),
      classKey,
    });
  }

  const pathByUri = new Map<string, number>();
  const canonical: CanonicalPlanRow[] = [];
  const redirects: RedirectPlanRow[] = [];
  let deleted410 = 0;
  let redirected = 0;

  // New-path overrides: modx_id → new_path (renames/restructures).
  const mapById = new Map<number, string>();
  if (options.mapCsv !== undefined) {
    const [mapHeader, ...mapRecords] = parseCsvRecords(options.mapCsv);
    const mapNames = (mapHeader ?? []).map((name) => name.trim().toLowerCase());
    const idAt = mapNames.indexOf("modx_id") >= 0 ? mapNames.indexOf("modx_id") : 0;
    const pathAt = mapNames.indexOf("new_path") >= 0 ? mapNames.indexOf("new_path") : 1;
    for (const cells of mapRecords) {
      const id = Number((cells[idAt] ?? "").trim());
      const path = (cells[pathAt] ?? "").trim();
      if (Number.isFinite(id) && path !== "") mapById.set(id, path);
    }
  }

  const seenUri = new Set<string>();
  const caseSeen = new Map<string, number>();
  const normSeen = new Map<string, number>();
  for (const doc of documents) {
    const oldPath = normalizePath(doc.uri);
    if (oldPath === null) {
      warnings.push({
        code: "QUERY_URI",
        detail: `resource ${doc.id} (${doc.pagetitle}): uri="${doc.uri}" — friendly_urls off? export after enabling FURLs`,
      });
      continue;
    }
    if (seenUri.has(oldPath)) {
      warnings.push({ code: "DUPLICATE_URI", detail: `${oldPath}: resource ${doc.id}` });
      continue;
    }
    // SEO-mess audit (report-only — both URLs stay in the plan; the owner or
    // the agent decides via --map which one survives, and the validator keeps
    // the outcome graph-safe):
    // - case-only variants (/About.html vs /about.html): distinct URLs on a
    //   Linux host, one page in search indexes;
    // - normalization collisions (/about.html vs /about/): the same page
    //   addressable two ways — classic crooked-MODX duplicate content.
    const caseKey = oldPath.toLowerCase();
    const normKey = caseKey.replace(/\.(html?|php)$/i, "").replace(/\/$/, "");
    const caseOwner = caseSeen.get(caseKey);
    if (caseOwner !== undefined) {
      warnings.push({
        code: "CASE_VARIANT",
        detail: `${oldPath}: resource ${doc.id} vs ${caseOwner}`,
      });
    } else {
      caseSeen.set(caseKey, doc.id);
    }
    const normOwner = normSeen.get(normKey);
    if (normOwner !== undefined && normOwner !== caseOwner) {
      warnings.push({
        code: "NORMALIZED_COLLISION",
        detail: `${oldPath}: resource ${doc.id} collides after normalization with resource ${normOwner}`,
      });
    } else if (normOwner === undefined) {
      normSeen.set(normKey, doc.id);
    }
    seenUri.add(oldPath);
    pathByUri.set(oldPath, doc.id);

    const source = rewritePrefix(oldPath, options);
    if (doc.deleted) {
      deleted410 += 1;
      redirects.push({ source, target: null, status_code: 410, reason: "modx: resource deleted" });
      continue;
    }

    const mapped = mapById.get(doc.id);
    if (mapped !== undefined) {
      redirected += 1;
      redirects.push({
        source,
        target: mapped,
        status_code: 301,
        reason: `modx: resource ${doc.id} moved to a new path`,
      });
      continue;
    }
    // §61: surviving resources keep their old URL as the canonical path.
    canonical.push({ id: doc.id, old_uri: oldPath, canonical_path: oldPath });
  }

  // Overridden (frozen) URIs that also carry a map entry are flagged: MODX
  // serves the frozen URI, so both the map and the frozen value must agree.
  for (const doc of documents) {
    if (doc.uriOverride && mapById.has(doc.id)) {
      warnings.push({
        code: "UNMAPPED_FROZEN",
        detail: `resource ${doc.id} has a frozen URI (uri_override=1) and a map entry — verify the target`,
      });
    }
  }

  return {
    redirects,
    canonical,
    summary: {
      documents: documents.length,
      containers: documents.filter((doc) => doc.isFolder).length,
      deleted410,
      redirected,
      preserved: canonical.length,
      skippedClasses,
      warnings,
    },
  };
}

/** Reads the connector inputs from disk and builds the plan. */
export function buildModxPlanFromFiles(options: {
  readonly siteContentCsvPath: string;
  readonly mapCsvPath?: string;
  readonly contextKey?: string;
  readonly dropPrefix?: string;
  readonly addPrefix?: string;
}): ModxPlan {
  const siteContentCsv = readFileSync(options.siteContentCsvPath, "utf8");
  return buildModxRedirectPlan(siteContentCsv, {
    ...(options.contextKey === undefined ? {} : { contextKey: options.contextKey }),
    ...(options.dropPrefix === undefined ? {} : { dropPrefix: options.dropPrefix }),
    ...(options.addPrefix === undefined ? {} : { addPrefix: options.addPrefix }),
    ...(options.mapCsvPath === undefined
      ? {}
      : { mapCsv: readFileSync(options.mapCsvPath, "utf8") }),
  });
}

/** CSV serializations feeding `cms redirects validate|apply` and the migration review. */
export function toRedirectsCsv(plan: ModxPlan): string {
  const lines = ["source,target,status_code,reason"];
  for (const row of plan.redirects) {
    const quote = (value: string) =>
      /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    lines.push(
      [
        quote(row.source),
        row.target === null ? "" : quote(row.target),
        String(row.status_code),
        quote(row.reason),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function toCanonicalCsv(plan: ModxPlan): string {
  const lines = ["id,old_uri,canonical_path"];
  for (const row of plan.canonical) {
    lines.push(`${row.id},${row.old_uri},${row.canonical_path}`);
  }
  return `${lines.join("\n")}\n`;
}
