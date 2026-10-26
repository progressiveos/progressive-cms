// Feed card projection (CORE-FEED-ANYWHERE; Theme Contract §43).
//
// ONE builder for every published-content card: related_content blocks
// (pinned, collection, hybrid) and the `collections.<key>` theme scope. It
// reads rows already fetched by the feed source (no per-card revision/route
// query) and loads ALL referenced media in one batch, so a 20-card page costs
// a constant number of statements instead of one round-trip per card.

import { isProjectionAlias } from "@pcms/api";
import { type BlockRegistry, validateBlockDocument } from "@pcms/blocks";
import type {
  FieldSchema,
  ListFieldSchema,
  LoadedContentType,
  RepeaterFieldSchema,
} from "@pcms/content";
import type { MediaAssetPublicViewModel } from "@pcms/media";
import { buildImageModel, type ThemeManifestMediaPreset } from "@pcms/themes";

/** Canonical UUIDv7 stable-ID string pattern. */
export const STABLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Guaranteed card minimum handed to themes; legacy aliases stay alongside. */
export interface FeedCard {
  readonly entry_id: string;
  readonly content_type: string;
  readonly title: string;
  /** teaser → intro → first 200 plain-text body characters → null. */
  readonly description: string | null;
  /** ISO instant of the current publication. */
  readonly published_at: string;
  readonly tags: readonly string[];
  /** URL of the configured image field (or the legacy block fallback). */
  readonly image: string | null;
  readonly image_alt: string | null;
  /** Legacy related-card aliases (unchanged priority chains). */
  readonly note: string | null;
  readonly tag: string | null;
  /** Content-field publication date when the document declares one. */
  readonly date_field: string | null;
  /** Aliases + explicitly requested content fields. */
  readonly fields: Record<string, unknown>;
}

export interface FeedCardOptions {
  /** Content fields to project into `card.fields` (empty = aliases only). */
  readonly fields: readonly string[];
  readonly imageField: string;
  readonly imagePreset: string;
  readonly tagField: string;
}

export interface FeedCardRow {
  readonly entry_id: string;
  readonly content_type: string;
  readonly published_at: string;
  readonly fields: Record<string, unknown>;
  readonly blocks: unknown;
  readonly route_path: string;
  readonly route_locale: string;
}

export interface FeedCardDeps {
  readonly blocks: BlockRegistry;
  readonly contentType: (key: string) => LoadedContentType | null;
  readonly assets: (
    ids: readonly string[],
  ) => Promise<Readonly<Record<string, MediaAssetPublicViewModel | null>>>;
  readonly presets: readonly ThemeManifestMediaPreset[];
}

/** Walk declared media fields, including nested objects and repeaters. */
export function collectFieldMediaIds(
  fields: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, FieldSchema>>,
  into: Set<string>,
): void {
  const visit = (value: unknown, field: FieldSchema): void => {
    if (field.type === "media") {
      if (typeof value === "string" && STABLE_ID_RE.test(value)) into.add(value);
    } else if (field.type === "media_list" && Array.isArray(value)) {
      for (const id of value) if (typeof id === "string" && STABLE_ID_RE.test(id)) into.add(id);
    } else if (
      field.type === "object" &&
      "fields" in field &&
      typeof value === "object" &&
      value !== null
    ) {
      collectFieldMediaIds(value as Record<string, unknown>, field.fields, into);
    } else if (
      field.type === "repeater" &&
      "item" in field &&
      "fields" in field.item &&
      Array.isArray(value)
    ) {
      for (const row of value) {
        if (typeof row === "object" && row !== null)
          collectFieldMediaIds(row, field.item.fields, into);
      }
    } else if (
      field.type === "list" &&
      "item" in field &&
      "type" in field.item &&
      Array.isArray(value)
    ) {
      for (const item of value) visit(item, field.item);
    }
  };
  for (const [key, field] of Object.entries(schema)) visit(fields[key], field);
}

export function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const document = value as { type?: string; content?: unknown };
  if (document.type !== "document") return "";
  const walk = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(walk).join("");
    if (typeof node === "object" && node !== null) {
      const record = node as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      return walk(record.content);
    }
    return "";
  };
  return walk(document.content).trim();
}

/** Text of the first paragraph-level node — card teasers must not start with
 * a heading or list fragment, which is what plainText picks up first. */
export function firstParagraphText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const document = value as { type?: string; content?: unknown };
  if (document.type !== "document" || !Array.isArray(document.content)) return "";
  const paragraph = document.content.find(
    (node) =>
      typeof node === "object" &&
      node !== null &&
      (node as Record<string, unknown>).type === "paragraph",
  );
  // plainText expects a document-shaped node; wrap the paragraph.
  return paragraph === undefined ? "" : plainText({ type: "document", content: [paragraph] });
}

/** Published payloads carry a snake_case BlockDocument; the card image
 * fallback walks the normalized node array. The seal already validated the
 * document — a failed re-validation degrades to an empty list. */
export function blockNodesOf(
  blocks: unknown,
  registry: BlockRegistry,
  onInvalid?: (issues: readonly { readonly code: string; readonly path: string }[]) => void,
): unknown[] {
  const parsed = validateBlockDocument(blocks, registry);
  if (parsed.ok) return parsed.value.blocks;
  const nodes = (blocks as { blocks?: unknown } | null)?.blocks;
  const kept = Array.isArray(nodes)
    ? nodes.filter(
        (node) => validateBlockDocument({ schema_version: 1, blocks: [node] }, registry).ok,
      )
    : [];
  onInvalid?.(parsed.issues.map((issue) => ({ code: issue.code, path: issue.path })));
  return kept;
}

/**
 * Ordered image candidates of a published entry: the explicit hero when set,
 * else the document's image/gallery blocks. `blocks` stays empty for an
 * explicitly different image field — a card never substitutes a random
 * document image for the one the author asked for.
 */
export function imageCandidates(
  hero: unknown,
  blocks: unknown[],
): { id: unknown; alt?: unknown }[] {
  const explicit = typeof hero === "string" && hero.trim() !== "";
  const candidates: { id: unknown; alt?: unknown }[] = [];
  const visit = (nodes: unknown[]): void => {
    for (const value of nodes) {
      const block = value as {
        type: string;
        props?: Record<string, unknown>;
        children?: unknown[];
      };
      const props = block.props ?? {};
      if (block.type === "image") candidates.push({ id: props.media_id, alt: props.alt_override });
      if (block.type === "gallery" && Array.isArray(props.items)) {
        for (const item of props.items as Record<string, unknown>[])
          candidates.push({ id: item.media_id, alt: item.alt_override });
      }
      visit(block.children ?? []);
    }
  };
  if (explicit) candidates.push({ id: hero });
  else visit(blocks);
  return candidates;
}

/** Ordered image/gallery candidates from the published, normalized document. */
/** The chosen image candidate of one card: asset + its usage alt. */
export interface CardImageChoice {
  readonly asset: MediaAssetPublicViewModel;
  readonly alt: string | null;
}

/**
 * First candidate whose asset can serve the preset. One function decides the
 * card image, so the top-level `image` and the `fields.image` alias can never
 * disagree.
 */
export function chooseCardImage(
  hero: unknown,
  blocks: unknown[],
  assetOf: (id: string) => MediaAssetPublicViewModel | null,
  presetId: string,
): CardImageChoice | null {
  for (const candidate of imageCandidates(hero, blocks)) {
    if (typeof candidate.id !== "string" || !STABLE_ID_RE.test(candidate.id)) continue;
    const asset = assetOf(candidate.id);
    if (asset === null || asset.kind !== "image") continue;
    if (!asset.derivatives.some((derivative) => derivative.preset === presetId)) continue;
    return {
      asset,
      alt: typeof candidate.alt === "string" ? candidate.alt : asset.alt || null,
    };
  }
  return null;
}

export async function selectCardImage(
  hero: unknown,
  blocks: unknown[],
  getMedia: (id: string) => Promise<MediaAssetPublicViewModel | null>,
  presetId = "card",
): Promise<{ image: string | null; image_alt: string | null }> {
  const loaded = new Map<string, MediaAssetPublicViewModel | null>();
  for (const candidate of imageCandidates(hero, blocks)) {
    if (typeof candidate.id !== "string" || !STABLE_ID_RE.test(candidate.id)) continue;
    if (!loaded.has(candidate.id)) loaded.set(candidate.id, await getMedia(candidate.id));
  }
  const choice = chooseCardImage(hero, blocks, (id) => loaded.get(id) ?? null, presetId);
  if (choice === null) return { image: null, image_alt: null };
  return {
    image:
      choice.asset.derivatives.find((derivative) => derivative.preset === presetId)?.url ?? null,
    image_alt: choice.alt,
  };
}

/**
 * Publication instants cross this projection as ISO strings. The collection
 * feed hands them over as JSON text, but a direct timestamptz read (pinned
 * rows) arrives as a Date — both must produce the same string, never an
 * object a theme would print as "[object Object]".
 */
function isoInstant(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}

/**
 * Projects rows into cards. Media resolution is a single batch for the whole
 * page; projection follows declared schemas only (rich_text → plain text,
 * media → the requested preset's image model) and never exposes raw ASTs,
 * HTML, storage keys or the Working payload.
 */
export async function buildFeedCards(
  input: readonly FeedCardRow[],
  options: FeedCardOptions,
  deps: FeedCardDeps,
): Promise<readonly FeedCard[]> {
  // A published payload may carry no `fields` object at all (a type without
  // required fields, or imported history) — the card still renders.
  const rows = input.map((row) => ({ ...row, fields: row.fields ?? {} }));
  const types: (LoadedContentType | null)[] = rows.map(
    (row) => deps.contentType(row.content_type) ?? null,
  );
  const presetManifest = deps.presets.find((preset) => preset.id === options.imagePreset);
  const loadedRowBlocks = rows.map((row) =>
    options.imageField === "hero_image" ? blockNodesOf(row.blocks, deps.blocks) : [],
  );
  const candidatesOf = (row: FeedCardRow, blocks: unknown[]) =>
    imageCandidates(row.fields[options.imageField], blocks);

  // --- Phase 1: every asset this page references ---
  const allIds = new Set<string>();
  for (const [index, row] of rows.entries()) {
    for (const candidate of candidatesOf(row, loadedRowBlocks[index] ?? [])) {
      if (typeof candidate.id === "string" && STABLE_ID_RE.test(candidate.id)) {
        allIds.add(candidate.id);
      }
    }
    const type = types[index] ?? null;
    if (type === null) continue;
    for (const key of options.fields) {
      const field = type.fieldSchema.fields[key];
      if (field === undefined) continue;
      const ids = new Set<string>();
      collectFieldMediaIds({ [key]: row.fields[key] }, { [key]: field }, ids);
      for (const id of ids) allIds.add(id);
    }
  }

  // --- Phase 2: one batch for every distinct asset ---
  const loaded = allIds.size === 0 ? {} : await deps.assets([...allIds]);
  const assetOf = (id: unknown) => (typeof id === "string" ? (loaded[id] ?? null) : null);

  // --- Phase 3: projection ---
  // `alt` carries the USAGE alt of the chosen candidate (alt_override wins,
  // an empty override stays empty); without one the asset default applies.
  const toImage = (id: unknown, alt?: string | null): Record<string, unknown> | null => {
    const asset = assetOf(id);
    if (asset === null) return null;
    try {
      const image = buildImageModel(asset, options.imagePreset, presetManifest);
      return {
        ...image,
        url: image.src,
        media_id: asset.id,
        ...(alt === undefined || alt === null ? {} : { alt }),
      };
    } catch {
      // Known preset without a ready derivative for this asset: image null.
      return null;
    }
  };
  const project = (value: unknown, schema: FieldSchema): unknown => {
    switch (schema.type) {
      case "rich_text":
        return plainText(value).slice(0, 500) || null;
      case "media":
        return toImage(value);
      case "media_list":
        return Array.isArray(value) ? value.map((item) => toImage(item)) : [];
      case "object":
        return "fields" in schema ? projectObject(value, schema.fields, project) : null;
      case "repeater": {
        if (!("item" in schema) || !Array.isArray(value)) return [];
        const rowFields = (schema as RepeaterFieldSchema).item.fields;
        return value.map((item) =>
          typeof item === "object" && item !== null ? projectObject(item, rowFields, project) : {},
        );
      }
      case "list": {
        if (!("item" in schema) || !Array.isArray(value)) return [];
        const itemSchema = (schema as ListFieldSchema).item;
        return value.map((item) => project(item, itemSchema));
      }
      default:
        return value ?? null;
    }
  };

  // A known preset without a ready derivative for ANY candidate yields null —
  // never an original-file fallback and never an on-GET transform.
  const choices = rows.map((row, index) =>
    chooseCardImage(
      row.fields[options.imageField],
      loadedRowBlocks[index] ?? [],
      (id) => assetOf(id),
      options.imagePreset,
    ),
  );

  return rows.map((row, index) => {
    const type = types[index] ?? null;
    const fields = row.fields;
    const tagValue = fields[options.tagField];
    const tags = Array.isArray(tagValue)
      ? tagValue.filter((value): value is string => typeof value === "string")
      : [];
    const description =
      plainText(fields.teaser) ||
      plainText(fields.intro) ||
      firstParagraphText(fields.body).slice(0, 200) ||
      null;
    const note =
      plainText(fields.intro) ||
      plainText(fields.teaser) ||
      firstParagraphText(fields.body).slice(0, 200) ||
      null;
    const dateField = isoInstant(fields.published_at);
    const publishedAt = isoInstant(row.published_at);
    const choice = choices[index] ?? null;
    const image = choice === null ? null : (toImage(choice.asset.id, choice.alt) ?? null);
    const cardFields: Record<string, unknown> = {};
    for (const key of options.fields) {
      const field = type === null ? undefined : type.fieldSchema.fields[key];
      // Reserved aliases own their documented meaning inside `card.fields`
      // even when the content type has a field of the same name: the stored
      // field itself and the legacy surfaces stay untouched.
      const value = isProjectionAlias(key)
        ? key === "title"
          ? typeof fields.title === "string"
            ? fields.title
            : row.entry_id
          : key === "description"
            ? description
            : key === "image"
              ? image
              : row.published_at
        : field === undefined
          ? null
          : project(fields[key], field);
      if (!isBlank(value)) cardFields[key] = value;
    }
    return {
      entry_id: row.entry_id,
      content_type: row.content_type,
      title: typeof fields.title === "string" ? fields.title : row.entry_id,
      description,
      published_at: publishedAt ?? row.published_at,
      tags,
      image: typeof image?.url === "string" ? image.url : null,
      image_alt: choice?.alt ?? null,
      note,
      tag: tags[0] ?? null,
      date_field: dateField,
      fields: cardFields,
    };
  });
}

function projectObject(
  value: unknown,
  fields: Record<string, FieldSchema>,
  project: (value: unknown, schema: FieldSchema) => unknown,
): Record<string, unknown> {
  const source = (value ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const projected = project(source[key], field);
    if (!isBlank(projected)) out[key] = projected;
  }
  return out;
}
