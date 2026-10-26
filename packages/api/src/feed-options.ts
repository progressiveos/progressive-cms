// Feed-anywhere options (CORE-FEED-ANYWHERE; Theme Contract §43).
//
// One normalizer + one semantic validator shared by the block renderer, the
// public collections REST surface and the seal-time entry adapter. The block
// props are OPTIONAL and additive: a document that declares none of them
// keeps its historical behavior, so old blocks stay valid and old themes keep
// rendering the same HTML. Defaults are never written back into documents.
import type { LoadedContentType } from "@pcms/content";
import type { ThemeManifestCollection } from "@pcms/themes";

/** Readable field-id pattern (never a JSON path, SQL fragment or expression). */
export const FEED_FIELD_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const FEED_SCOPES = ["section", "subtree", "site"] as const;
export type FeedScope = (typeof FEED_SCOPES)[number];

export interface FeedOrder {
  readonly by: "published_at" | "field";
  readonly direction: "asc" | "desc";
  /** Required when by === "field"; validated as an integer content field. */
  readonly field?: string;
}

export const DEFAULT_FEED_ORDER: FeedOrder = { by: "published_at", direction: "desc" };
export const DEFAULT_IMAGE_FIELD = "hero_image";
export const DEFAULT_IMAGE_PRESET = "card";

/** Normalized block options — defaults resolved, never persisted. */
export interface RelatedFeedOptions {
  readonly scope: FeedScope;
  /** Explicit content-type override (collection/hybrid only), else null. */
  readonly contentTypes: readonly string[] | null;
  readonly fields: readonly string[];
  readonly imagePreset: string;
  readonly imageField: string;
  readonly excludeEntryIds: readonly string[];
  readonly order: FeedOrder;
}

export interface BindingFeedOptions {
  readonly scope: FeedScope;
  readonly order: FeedOrder;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function readFeedOrder(value: unknown): FeedOrder {
  if (typeof value !== "object" || value === null) return DEFAULT_FEED_ORDER;
  const record = value as Record<string, unknown>;
  const by = record.by === "field" ? "field" : "published_at";
  const direction = record.direction === "asc" ? "asc" : "desc";
  const field = typeof record.field === "string" ? record.field : undefined;
  return by === "field" && field !== undefined
    ? { by, direction, field }
    : { by: "published_at", direction };
}

/** Reserved projection aliases: always valid, and they win inside `fields`. */
export const PROJECTION_ALIASES = ["title", "description", "image", "published_at"] as const;
export type ProjectionAlias = (typeof PROJECTION_ALIASES)[number];

export function isProjectionAlias(key: string): boolean {
  return (PROJECTION_ALIASES as readonly string[]).includes(key);
}

export function readRelatedFeedOptions(
  props: Record<string, unknown>,
  binding?: ThemeManifestCollection | null,
): RelatedFeedOptions {
  const contentTypes = strings(props.content_types);
  return {
    scope: props.scope === "site" || props.scope === "subtree" ? props.scope : "section",
    contentTypes: contentTypes.length > 0 ? contentTypes : null,
    fields: strings(props.fields),
    imagePreset: typeof props.image_preset === "string" ? props.image_preset : DEFAULT_IMAGE_PRESET,
    imageField: typeof props.image_field === "string" ? props.image_field : DEFAULT_IMAGE_FIELD,
    excludeEntryIds: strings(props.exclude_entry_ids),
    // Effective order: the block wins, then its collection binding, then the
    // default — the same order REST and template collections use.
    order:
      props.order !== undefined
        ? readFeedOrder(props.order)
        : binding !== undefined && binding !== null
          ? readFeedOrder(binding.order)
          : DEFAULT_FEED_ORDER,
  };
}

/** Theme binding options: `section` is the theme-side name for the scope. */
export function readBindingFeedOptions(binding: ThemeManifestCollection): BindingFeedOptions {
  return {
    scope:
      binding.section === "subtree" || binding.section === "site" ? binding.section : "section",
    order: readFeedOrder(binding.order),
  };
}

export interface FeedOptionIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface FeedOptionValidationInput {
  readonly mode: string;
  readonly props: Record<string, unknown>;
  /** JSON pointer of the props object inside the revision payload. */
  readonly path: string;
  /** Resolved content types to check requested fields/ordering against. */
  readonly appliedTypes: readonly LoadedContentType[];
  /** Collection key declared by the rendering theme? null = theme unresolved. */
  readonly collectionKnown: boolean | null;
  /** Preset ids declared by the rendering theme; null = theme unresolved. */
  readonly knownPresets: ReadonlySet<string> | null;
  /** Keys the caller already reported (e.g. unknown content type). */
  readonly contentTypes: (key: string) => LoadedContentType | null;
  /** True when any new (non-historical) option is explicitly present. */
  readonly explicit: boolean;
  /**
   * The binding's order, already resolved by the caller. Validation checks the
   * EFFECTIVE order (props.order → binding.order → default), not just the
   * props — otherwise a block inheriting a bad binding order seals clean.
   */
  readonly bindingOrder?: FeedOrder;
}

const NEW_OPTION_KEYS = [
  "scope",
  "content_types",
  "fields",
  "image_preset",
  "image_field",
  "exclude_entry_ids",
  "order",
] as const;

export function hasExplicitFeedOptions(props: Record<string, unknown>): boolean {
  return NEW_OPTION_KEYS.some((key) => props[key] !== undefined);
}

/**
 * Semantic validation of explicitly-declared options only. Old blocks (no new
 * keys) never produce an issue — validation must not retroactively reject
 * SEALED history or unrelated documents.
 */
export function validateFeedOptions(input: FeedOptionValidationInput): FeedOptionIssue[] {
  if (!input.explicit) return [];
  const issues: FeedOptionIssue[] = [];
  const props = input.props;

  if (props.content_types !== undefined && input.mode === "manual") {
    issues.push({
      code: "BLOCK_PROPS_INVALID",
      path: `${input.path}/content_types`,
      message: "content_types is only allowed for collection/hybrid related_content",
    });
  }
  const requestedTypes = strings(props.content_types);
  for (const [index, key] of requestedTypes.entries()) {
    if (input.contentTypes(key) === null) {
      issues.push({
        code: "CONTENT_TYPE_UNKNOWN",
        path: `${input.path}/content_types/${index}`,
        message: `content type "${key}" is not registered on this server`,
      });
    }
  }
  if (
    (input.mode === "collection" || input.mode === "hybrid") &&
    typeof props.collection_key === "string" &&
    input.collectionKnown === false
  ) {
    issues.push({
      code: "COLLECTION_UNKNOWN",
      path: `${input.path}/collection_key`,
      message: `collection "${props.collection_key}" is not declared by the active theme`,
    });
  }

  if (
    typeof props.image_preset === "string" &&
    input.knownPresets !== null &&
    !input.knownPresets.has(props.image_preset)
  ) {
    issues.push({
      code: "RELATED_PRESET_UNKNOWN",
      path: `${input.path}/image_preset`,
      message: `image preset "${props.image_preset}" is not declared by the active theme`,
    });
  }

  const fieldOf = (type: LoadedContentType, key: string) => type.fieldSchema.fields[key];
  // With no resolvable schema (no selected type, unresolved theme, removed
  // pins) field-level checks have nothing to compare against — the cause is
  // reported by the content-type check above instead of as a phony "unknown".
  const applied = input.appliedTypes;
  if (applied.length === 0) return issues;

  for (const [index, key] of strings(props.fields).entries()) {
    // Documented aliases are always requestable, even when the content type
    // declares no field of that name.
    if (isProjectionAlias(key)) continue;
    if (!applied.some((type) => fieldOf(type, key) !== undefined)) {
      issues.push({
        code: "RELATED_FIELD_UNKNOWN",
        path: `${input.path}/fields/${index}`,
        message: `field "${key}" is not declared by any selected content type`,
      });
    }
  }

  if (typeof props.image_field === "string") {
    const declared = applied
      .map((type) => fieldOf(type, props.image_field as string))
      .filter((field) => field !== undefined);
    if (declared.length === 0 || declared.some((field) => field.type !== "media")) {
      issues.push({
        code: "RELATED_IMAGE_FIELD_INVALID",
        path: `${input.path}/image_field`,
        message: `image_field "${props.image_field}" must be a declared media field`,
      });
    }
  }

  const orderFromProps = props.order !== undefined;
  const order = orderFromProps
    ? readFeedOrder(props.order)
    : (input.bindingOrder ?? DEFAULT_FEED_ORDER);
  if (order.by === "field") {
    const key = order.field ?? "";
    const declared = applied
      .map((type) => fieldOf(type, key))
      .filter((field) => field !== undefined);
    if (declared.length === 0 || declared.some((field) => field.type !== "integer")) {
      issues.push({
        code: "RELATED_ORDER_FIELD_INVALID",
        // An inherited binding order points at the collection reference, not
        // at a prop the document does not have.
        path: orderFromProps ? `${input.path}/order/field` : `${input.path}/collection_key`,
        message: orderFromProps
          ? `order field "${key}" must be a declared integer field`
          : `collection "${String(props.collection_key)}" binding orders by "${key}", which must be a declared integer field`,
      });
    }
  }

  return issues;
}
