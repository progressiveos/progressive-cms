// Schema Registry + @graph composer (PCMS-SEO-T016; SEO spec §29–§31/§42/§45).
// Facts → registry → JSON-LD graph. SEO Core owns graph composition: stable
// node order, duplicate suppression by @id, conflict diagnostics, and a
// single serialized document. The registry is closed in v1 (spec §31) with a
// factory extension point for future types (spec §45) — arbitrary user JSON
// is never rendered.
import type { SeoDiagnostic } from "../diagnostics.js";
import type {
  ArticleFacts,
  BreadcrumbFacts,
  OrganizationFacts,
  VideoFacts,
  WebPageFacts,
  WebSiteFacts,
} from "./facts.js";
import {
  buildArticleNode,
  buildBreadcrumbNode,
  buildOrganizationNode,
  buildVideoNode,
  buildWebPageNode,
  buildWebSiteNode,
  type JsonLdNode,
  validateGraphNode,
} from "./nodes.js";

/** Baseline schema types supported in v1 (spec §31); informational surface. */
export const STRUCTURED_DATA_NODE_TYPES_V1 = [
  "WebSite",
  "Organization",
  "LocalBusiness",
  "WebPage",
  "Article",
  "NewsArticle",
  "BlogPosting",
  "BreadcrumbList",
  "VideoObject",
  "Person",
  "ImageObject",
] as const;

export interface StructuredDataPageInput {
  readonly website: WebSiteFacts | null;
  readonly organization: OrganizationFacts | null;
  readonly webpage: WebPageFacts | null;
  readonly article: ArticleFacts | null;
  readonly breadcrumbs: BreadcrumbFacts | null;
  readonly video: VideoFacts | null;
}

export interface ComposedStructuredData {
  /** Serialized, escape-safe JSON-LD documents (one @graph document). */
  readonly json_ld: readonly string[];
  readonly nodes: readonly JsonLdNode[];
  readonly diagnostics: readonly SeoDiagnostic[];
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Escapes `<`, U+2028, U+2029 so the JSON can never break out of <script>. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The v1 registry: fixed builder order, site facts before page facts. */
export function composeStructuredData(input: StructuredDataPageInput): ComposedStructuredData {
  const diagnostics: SeoDiagnostic[] = [];
  const nodes: JsonLdNode[] = [];
  const byId = new Map<string, JsonLdNode>();
  const kinds: readonly [string, () => JsonLdNode | null][] = [
    ["website", () => (input.website == null ? null : buildWebSiteNode(input.website))],
    [
      "organization",
      () => (input.organization == null ? null : buildOrganizationNode(input.organization)),
    ],
    ["webpage", () => (input.webpage == null ? null : buildWebPageNode(input.webpage))],
    [
      "breadcrumbs",
      () => (input.breadcrumbs == null ? null : buildBreadcrumbNode(input.breadcrumbs)),
    ],
    ["article", () => (input.article == null ? null : buildArticleNode(input.article))],
    ["video", () => (input.video == null ? null : buildVideoNode(input.video))],
  ];

  for (const [kind, build] of kinds) {
    let node: JsonLdNode | null;
    try {
      node = build();
    } catch (err) {
      diagnostics.push({
        code: "SEO_STRUCTURED_DATA_INVALID",
        severity: "error",
        message: err instanceof Error ? err.message : String(err),
        path: `/structured_data/${kind}`,
      });
      continue;
    }
    if (node == null) continue;
    const issues = validateGraphNode(node);
    if (issues.length > 0) {
      diagnostics.push({
        code: "SEO_STRUCTURED_DATA_INVALID",
        severity: "error",
        message: `${kind}: ${issues.join("; ")}`,
        path: `/structured_data/${kind}`,
      });
      continue;
    }
    const id = typeof node["@id"] === "string" ? (node["@id"] as string) : null;
    if (id != null) {
      const existing = byId.get(id);
      if (existing != null) {
        if (sameJson(existing, node)) continue; // duplicate → suppressed
        diagnostics.push({
          code: "SEO_STRUCTURED_DATA_CONFLICT",
          severity: "error",
          message: `conflicting structured-data node for @id ${id}; the earlier (site-level) node wins`,
          path: `/structured_data/${kind}`,
        });
        continue;
      }
      byId.set(id, node);
    }
    nodes.push(node);
  }

  const graph = {
    "@context": "https://schema.org",
    ...(nodes.length > 0 ? { "@graph": nodes } : {}),
  };
  return {
    json_ld: nodes.length > 0 ? [serializeJsonLd(graph)] : [],
    nodes,
    diagnostics,
  };
}
