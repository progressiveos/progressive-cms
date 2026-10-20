// Optional .pcpub v2 refs: routing is the only identity lookup, never slug/title.
import type { FieldSchema } from "@pcms/content";
import type { DbClient } from "@pcms/core";
import { type ExternalEntries, PcpubError } from "@pcms/publication";
import { normalizeStoredPath } from "@pcms/routing";
import type { ApplicationServices } from "./context.js";

export interface ResolvedExternalEntry {
  readonly entry_id: string;
  readonly route_id: string | null;
}

/** On the second pass row locks hold the resolved identity through candidate creation. */
export async function resolveExternalEntries(
  app: ApplicationServices,
  external: ExternalEntries,
  executor: DbClient = app.pool,
  expected?: Readonly<Record<string, ResolvedExternalEntry>>,
): Promise<Record<string, ResolvedExternalEntry>> {
  if (Object.keys(external).length === 0) return {};
  const site = await app.routes.findSiteByKey(app.defaultSiteKey);
  const resolved: Record<string, ResolvedExternalEntry> = {};
  const localization = await app.localization.get();
  for (const [alias, target] of Object.entries(external)) {
    const path = `external_entries/${alias}`;
    const fail = (
      code:
        | "PCPUB_EXTERNAL_ENTRY_NOT_FOUND"
        | "PCPUB_EXTERNAL_ENTRY_UNPUBLISHED"
        | "PCPUB_EXTERNAL_ENTRY_LOCALE_UNKNOWN"
        | "PCPUB_EXTERNAL_ENTRY_INVALID",
      message: string,
    ): never => {
      throw new PcpubError(
        expected === undefined ? code : "PCPUB_CONFLICT_EXTERNAL_ENTRY_CHANGED",
        message,
        { path },
      );
    };
    if (site === null) fail("PCPUB_EXTERNAL_ENTRY_NOT_FOUND", "target site is missing");
    if (
      target.locale !== "default" &&
      (!localization.enabled ||
        !localization.locales.includes(target.locale) ||
        target.locale === localization.defaultLocale)
    )
      fail("PCPUB_EXTERNAL_ENTRY_LOCALE_UNKNOWN", `unknown publication context ${target.locale}`);
    let canonical: string;
    try {
      canonical = normalizeStoredPath(target.path, await app.routes.getPolicy(site!.id));
    } catch {
      fail("PCPUB_EXTERNAL_ENTRY_INVALID", "path violates target Routing Policy");
    }
    if (canonical! !== target.path)
      fail(
        "PCPUB_EXTERNAL_ENTRY_INVALID",
        `use canonical path ${canonical!}; redirects are not followed`,
      );
    const prefix = await app.localization.peelPrefix(target.path);
    if (prefix !== null && prefix.locale !== target.locale)
      fail("PCPUB_EXTERNAL_ENTRY_INVALID", "path prefix does not match declared locale");
    const routePath = prefix?.path ?? target.path;
    const lock = expected === undefined ? "" : " FOR SHARE";
    const route =
      routePath === "/"
        ? await executor.query<{ target_id: string; id: string | null }>(
            `SELECT home_entry_id AS target_id, NULL::text AS id FROM sites WHERE id = $1${lock}`,
            [site!.id],
          )
        : await executor.query<{ target_id: string; id: string | null }>(
            `SELECT target_id, id FROM routes WHERE site_id = $1 AND locale = $2 AND path = $3 AND domain_binding_id IS NULL AND retired_at IS NULL AND is_canonical AND target_type = 'entry'${lock}`,
            [
              site!.id,
              target.locale === "default" ? site!.defaultLocale : target.locale,
              routePath,
            ],
          );
    let entryId = route.rows[0]?.target_id;
    if (!entryId)
      fail("PCPUB_EXTERNAL_ENTRY_NOT_FOUND", "no active canonical entry route or home binding");
    if (routePath === "/" && target.locale !== "default") {
      const translation = await app.entries.findTranslation(entryId! as never, target.locale);
      entryId = translation?.id;
      if (!entryId) fail("PCPUB_EXTERNAL_ENTRY_NOT_FOUND", "home has no translation");
    }
    const entry = await executor.query(
      `SELECT id FROM entries WHERE id = $1 AND archived_at IS NULL${lock}`,
      [entryId],
    );
    if (entry.rows.length === 0)
      fail("PCPUB_EXTERNAL_ENTRY_NOT_FOUND", "entry missing or archived");
    const publication = await executor.query(
      `SELECT current_revision_id FROM publications WHERE entity_type = 'entry' AND entity_id = $1 AND context = $2 AND current_revision_id IS NOT NULL${lock}`,
      [entryId, target.locale],
    );
    if (publication.rows.length === 0)
      fail("PCPUB_EXTERNAL_ENTRY_UNPUBLISHED", "entry is not published in this context");
    const identity = { entry_id: entryId!, route_id: route.rows[0]!.id };
    if (
      expected !== undefined &&
      (expected[alias]?.entry_id !== identity.entry_id ||
        expected[alias]?.route_id !== identity.route_id)
    )
      fail("PCPUB_EXTERNAL_ENTRY_NOT_FOUND", "route target changed after validation");
    resolved[alias] = identity;
  }
  return resolved;
}

/** Rewrite only schema-declared Entry refs. Media and arbitrary text stay intact. */
export function rewriteExternalEntryRefs(
  app: ApplicationServices,
  contentType: string,
  payload: { fields: Record<string, unknown>; blocks: unknown },
  mapping: Readonly<Record<string, ResolvedExternalEntry>>,
): typeof payload {
  const copy = structuredClone(payload);
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    return typeof value === "string" && value.startsWith("ref:")
      ? (mapping[value.slice(4)]?.entry_id ?? value)
      : value;
  };
  const field = (value: unknown, schema: FieldSchema): unknown => {
    if (schema.type === "relation" || schema.type === "relation_list") return replace(value);
    if (schema.type === "object" && "fields" in schema) return fields(value, schema.fields);
    if (
      schema.type === "list" &&
      "item" in schema &&
      "type" in schema.item &&
      Array.isArray(value)
    ) {
      const itemSchema = schema.item;
      return value.map((item) => field(item, itemSchema));
    }
    if (
      schema.type === "repeater" &&
      "item" in schema &&
      "fields" in schema.item &&
      Array.isArray(value)
    ) {
      const itemFields = schema.item.fields;
      return value.map((item) => fields(item, itemFields));
    }
    return value;
  };
  const fields = (value: unknown, schemas: Record<string, FieldSchema>): unknown => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    for (const [key, schema] of Object.entries(schemas))
      if (key in object) object[key] = field(object[key], schema);
    return object;
  };
  const schema = app.contentTypes.getLatestContentType(contentType)?.fieldSchema;
  if (schema !== undefined) fields(copy.fields, schema.fields);
  const prop = (value: unknown, segments: string[]): void => {
    if (typeof value !== "object" || value === null) return;
    const [segment, ...rest] = segments;
    if (segment === undefined) return;
    const object = value as Record<string, unknown>;
    const key = segment.replace(/\[\]$/, "");
    if (rest.length === 0) {
      object[key] = replace(object[key]);
      return;
    }
    if (segment.endsWith("[]") && Array.isArray(object[key]))
      for (const item of object[key]) prop(item, rest);
    else prop(object[key], rest);
  };
  const visit = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes as Record<string, unknown>[]) {
      const descriptor = app.blocks.getBlockType(String(node.type), Number(node.schema_version));
      for (const ref of descriptor?.references ?? [])
        if (ref.kind === "relation") prop(node.props, ref.prop.split("."));
      visit(node.children);
    }
  };
  visit((copy.blocks as { blocks?: unknown } | null)?.blocks);
  return copy;
}
