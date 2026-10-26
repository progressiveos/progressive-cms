// `theme.json` manifest JSON Schema v2 + validator (PCMS-THEME-T002;
// Theme Contract spec §5–§10, §22, §27–§28, §31–§35).
//
// The manifest is the machine contract between a theme and the CMS: identity,
// versions, capability requirements, templates, components, block renderers,
// navigation placements, media presets, typed settings schema, asset build
// and CSP declarations. Validation is strict JSON Schema (additionalProperties:
// false everywhere, ADR-0004 posture) on top of AJV — the approved JSON Schema
// machinery (same stack as Content/Blocks) — plus a small set of explicit
// semantic checks AJV cannot express (semver shape, path escapes, duplicate
// IDs, enum defaults). Every rejection carries a stable machine code.
//
// Later tasks layer *semantic* validation on top of this structural contract:
// placements depth/type policy (T011), settings/token bridge (T014), preset
// discovery (T015), asset/JS/CSP policy (T017/T018).
import Ajv from "ajv";
import { ThemeError } from "../errors.js";
import { isValidVersionRange } from "./semver.js";

export const THEME_MANIFEST_SCHEMA_ID =
  "https://progressive-cms.dev/schemas/theme-manifest-v2.json";

/** Stable-id shape (shared pattern with Blocks first-party declarations). */
const STABLE_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/** Machine-safe theme ID (Theme spec §7). */
export const THEME_ID_PATTERN = "^[a-z][a-z0-9-]{2,63}$";
/** Exact semantic version (Theme spec §8). */
const SEMVER_PATTERN = "^\\d+\\.\\d+\\.\\d+$";
/** Printable npm SemVer range text; semantic validation uses semver.validRange. */
export const VERSION_RANGE_PATTERN = "^[0-9A-Za-z.+*<>=~^|, -]{1,128}$";
/** Logical template/component/placement/preset/setting identifier keys. */
const KEY_PATTERN = "^[a-z][a-z0-9_-]{0,63}$";
/** Placement IDs are dotted: `header.primary` (Theme spec §22). */
const PLACEMENT_ID_PATTERN = "^[a-z][a-z0-9_-]{0,31}(\\.[a-z][a-z0-9_-]{0,31}){1,3}$";
/** Content Type acceptance key: `key@version` (Theme spec §12). */
const CONTENT_TYPE_KEY_PATTERN = "^[a-z][a-z0-9_]{0,63}@[1-9]\\d*$";
/** Block renderer mapping key: `type@schemaVersion` (Theme spec §17). */
const BLOCK_TYPE_KEY_PATTERN = "^[a-z][a-z0-9_]{0,63}@[1-9]\\d*$";
/** Theme-relative template/component/block/asset paths — no traversal. */
const THEME_FILE_PATTERN =
  "^(templates|components|blocks|assets)/[a-z0-9][a-z0-9._/-]{0,127}\\.(liquid|css|js|svg|png|jpg|jpeg|webp|avif|woff2|json|txt)$";
const NAVIGATION_ITEM_TYPES = [
  "internal_entry",
  "external_url",
  "anchor",
  "group",
  "separator",
  "action",
] as const;
const SETTING_TYPES = ["boolean", "string", "enum", "number", "color", "media"] as const;
const CSP_DIRECTIVES = [
  "script_src",
  "style_src",
  "img_src",
  "font_src",
  "connect_src",
  "frame_src",
  "media_src",
] as const;

export const THEME_MANIFEST_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: THEME_MANIFEST_SCHEMA_ID,
  title: "Progressive CMS theme manifest v2",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "version",
    "theme_contract",
    "templates",
    "components",
    "block_renderers",
    "navigation_placements",
    "media_presets",
    "settings_schema",
  ],
  properties: {
    id: { type: "string", pattern: THEME_ID_PATTERN },
    name: { type: "string", minLength: 1, maxLength: 100 },
    description: { type: "string", maxLength: 1000 },
    version: { type: "string", pattern: SEMVER_PATTERN },
    /** Theme Contract version this theme targets (Theme spec §9). */
    theme_contract: { type: "string", pattern: VERSION_RANGE_PATTERN },
    /** Global CMS compatibility range; capability `requires` is preferred (§9/§10). */
    cms_compatibility: { type: "string", pattern: VERSION_RANGE_PATTERN },
    /** Capability requirements checked before activation (Theme spec §10). */
    requires: {
      type: "object",
      minProperties: 1,
      propertyNames: { pattern: "^[a-z][a-z0-9_.-]{0,63}$" },
      additionalProperties: { type: "string", pattern: VERSION_RANGE_PATTERN },
    },
    /** Capabilities the theme itself provides (discovery surface). */
    capabilities: {
      type: "array",
      maxItems: 100,
      items: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    },
    /** Optional directories beyond the mandatory ones, with implied roles (§5). */
    directories: {
      type: "array",
      maxItems: 4,
      uniqueItems: true,
      items: { type: "string", enum: ["scripts", "styles", "locales", "tests"] },
    },
    templates: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: { $ref: "#/definitions/template" },
    },
    layout: {
      type: "object",
      additionalProperties: false,
      properties: {
        default: { $ref: "#/definitions/template_id" },
      },
    },
    components: { type: "array", maxItems: 200, items: { $ref: "#/definitions/component" } },
    block_renderers: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: { $ref: "#/definitions/block_renderer" },
    },
    navigation_placements: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { $ref: "#/definitions/navigation_placement" },
    },
    media_presets: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { $ref: "#/definitions/media_preset" },
    },
    settings_schema: {
      type: "array",
      maxItems: 100,
      items: { $ref: "#/definitions/setting" },
    },
    /**
     * Named collection bindings (Theme Contract §43): declarative published
     * feeds the theme consumes. The key is the `collection_key` that
     * related_content blocks and the public collections REST surface
     * reference; scope is injected as `collections.<key>` on the declared
     * templates only. No SQL ever reaches the theme.
     */
    collections: {
      type: "object",
      maxProperties: 20,
      propertyNames: { pattern: "^[a-z][a-z0-9_-]{0,63}$" },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["content_types"],
        properties: {
          content_types: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
          },
          tag_field: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
          page_size: { type: "integer", minimum: 1, maximum: 100 },
          /**
           * Feed scope (Theme Contract §43, additive): "self" = children of
           * the rendered page (historical default), "subtree" = every
           * non-archived descendant, "site" = the whole site/locale.
           */
          section: { type: "string", enum: ["self", "subtree", "site"] },
          /** Explicit ordering; default published_at DESC + entry_id tie-break. */
          order: {
            type: "object",
            additionalProperties: false,
            required: ["by"],
            properties: {
              by: { type: "string", enum: ["published_at", "field"] },
              direction: { type: "string", enum: ["asc", "desc"] },
              field: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
            },
            allOf: [
              {
                if: { properties: { by: { const: "field" } } },
                then: { required: ["field"] },
              },
            ],
          },
          templates: {
            type: "array",
            maxItems: 50,
            uniqueItems: true,
            items: { type: "string", pattern: KEY_PATTERN },
          },
        },
      },
    },
    /** Asset build manifest (Theme spec §31; PCMS-THEME-T017/T018). */
    assets: {
      type: "object",
      additionalProperties: false,
      properties: {
        css: {
          type: "array",
          maxItems: 50,
          items: { type: "string", pattern: THEME_FILE_PATTERN },
        },
        js: { type: "array", maxItems: 50, items: { type: "string", pattern: THEME_FILE_PATTERN } },
        fingerprint: { type: "boolean" },
        /** Public embed origins the theme needs (§34); policy checked in T018. */
        csp: {
          type: "object",
          minProperties: 1,
          propertyNames: { enum: CSP_DIRECTIVES },
          additionalProperties: {
            type: "array",
            maxItems: 50,
            items: { type: "string", pattern: "^'self'$|^https://[a-z0-9.-]+(:\\d{1,5})?$" },
          },
        },
      },
    },
  },
  definitions: {
    template_id: { type: "string", pattern: KEY_PATTERN },
    template: {
      type: "object",
      additionalProperties: false,
      required: ["id", "file", "accepts_content_types"],
      properties: {
        id: { type: "string", pattern: KEY_PATTERN },
        file: { type: "string", pattern: "^templates/[a-z0-9][a-z0-9._/-]{0,127}\\.liquid$" },
        /** Content Types the template accepts — never inferred from names (§12). */
        accepts_content_types: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: { type: "string", pattern: CONTENT_TYPE_KEY_PATTERN },
        },
        /** Extension views this template renders (Extension Contract 2.0,
         * ADR-0018): "<extensionId>/<viewId>@<major>" entries; the canonical
         * override for the package's base template. */
        accepts_views: {
          type: "array",
          maxItems: 32,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]*/[a-z0-9][a-z0-9_-]*@\\d+$" },
        },
        required_fields: {
          type: "array",
          maxItems: 100,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        },
        optional_fields: {
          type: "array",
          maxItems: 100,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        },
        /** Optional per-template block restriction (default: all rendered types). */
        supported_blocks: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        },
        /** Declared Global Content dependencies (§41) — missing globals are a validation error. */
        globals: {
          type: "array",
          maxItems: 50,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
        },
        /** Render-compatible does not imply editor-selectable: system templates
         * (home, error pages) set false to stay out of the entry template
         * picker. Default true for backward compatibility. */
        editor_selectable: { type: "boolean" },
      },
    },
    component: {
      type: "object",
      additionalProperties: false,
      required: ["id", "file"],
      properties: {
        id: { type: "string", pattern: KEY_PATTERN },
        file: { type: "string", pattern: "^components/[a-z0-9][a-z0-9._/-]{0,127}\\.liquid$" },
      },
    },
    block_renderer: {
      type: "object",
      additionalProperties: false,
      required: ["block", "file"],
      properties: {
        /** `type@schemaVersion` mapping (§17). */
        block: { type: "string", pattern: BLOCK_TYPE_KEY_PATTERN },
        file: { type: "string", pattern: "^blocks/[a-z0-9][a-z0-9._/-]{0,127}\\.liquid$" },
        /** Supported presentation variants (§19); absent = only unvarianted blocks. */
        variants: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
        },
      },
    },
    navigation_placement: {
      type: "object",
      additionalProperties: false,
      required: ["id", "max_depth", "supported_item_types"],
      properties: {
        id: { type: "string", pattern: PLACEMENT_ID_PATTERN },
        /** Human-facing placement name (theme-owned metadata; Admin shows it
         * instead of the raw key; falls back to the key when absent). */
        label: { type: "string", maxLength: 200 },
        description: { type: "string", maxLength: 300 },
        required: { type: "boolean" },
        max_depth: { type: "integer", minimum: 1, maximum: 8 },
        supported_item_types: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
          items: { type: "string", enum: NAVIGATION_ITEM_TYPES },
        },
        /** Optional fallback placement when a set is missing (§22). */
        fallback: { type: "string", pattern: PLACEMENT_ID_PATTERN },
        supports_mega_menu: { type: "boolean" },
      },
    },
    media_preset: {
      type: "object",
      additionalProperties: false,
      required: ["id", "width"],
      properties: {
        id: { type: "string", pattern: KEY_PATTERN },
        width: { type: "integer", minimum: 16, maximum: 8192 },
        height: { type: "integer", minimum: 16, maximum: 8192 },
        fit: { type: "string", enum: ["cover", "contain", "fill", "inside", "outside"] },
        /** Crop focus hint consumed by the Media subsystem (M05). */
        crop: { type: "string", enum: ["center", "top", "bottom", "left", "right", "entropy"] },
        formats: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          items: { type: "string", enum: ["avif", "webp", "jpeg", "png"] },
        },
        quality: { type: "integer", minimum: 1, maximum: 100 },
        /** Lazy by default; `eager` reserved for above-the-fold heroes (§54). */
        loading: { type: "string", enum: ["lazy", "eager"] },
      },
    },
    setting: {
      type: "object",
      additionalProperties: false,
      required: ["key", "type"],
      properties: {
        key: { type: "string", pattern: KEY_PATTERN },
        type: { type: "string", enum: SETTING_TYPES },
        label: { type: "string", maxLength: 200 },
        /** Documented token this setting overrides (§29), e.g. `--color-primary`. */
        token: { type: "string", pattern: "^--[a-z][a-z0-9-]*$" },
        choices: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: "string", maxLength: 100 },
        },
        min: { type: "number" },
        max: { type: "number" },
        default: {},
      },
      allOf: [
        {
          if: { properties: { type: { const: "boolean" } } },
          then: { properties: { default: { type: "boolean" } } },
        },
        {
          if: { properties: { type: { const: "string" } } },
          then: { properties: { default: { type: "string", maxLength: 500 } } },
        },
        {
          if: { properties: { type: { const: "enum" } } },
          then: { required: ["choices"], properties: { default: { type: "string" } } },
        },
        {
          if: { properties: { type: { const: "number" } } },
          then: {
            properties: {
              default: { type: "number" },
              min: { type: "number" },
              max: { type: "number" },
            },
          },
        },
        {
          if: { properties: { type: { const: "color" } } },
          then: { properties: { default: { type: "string", pattern: "^#[0-9a-fA-F]{3,8}$" } } },
        },
        {
          if: { properties: { type: { const: "media" } } },
          then: {
            properties: {
              default: {
                type: "string",
                oneOf: [
                  { pattern: STABLE_ID_PATTERN },
                  { pattern: "^assets/[a-z0-9][a-z0-9._/-]*$" },
                  { maxLength: 0 },
                ],
              },
            },
          },
        },
        // `media`/`color` settings without a token are presentation noise —
        // they must target a documented token to take effect (§29).
        {
          if: { properties: { type: { enum: ["color", "media"] } } },
          then: { required: ["token"] },
        },
      ],
    },
  },
} as const;

/** Manifest sub-types (structural mirrors of the JSON Schema). */
export interface ThemeManifestTemplate {
  readonly id: string;
  readonly file: string;
  readonly accepts_content_types: readonly string[];
  /** Extension views overridden by this template (ADR-0018 §3). */
  readonly accepts_views?: readonly string[];
  readonly required_fields?: readonly string[];
  readonly optional_fields?: readonly string[];
  readonly supported_blocks?: readonly string[];
  readonly globals?: readonly string[];
  /** Defaults to true; false hides the template from editor pickers while
   * keeping it render-compatible. */
  readonly editor_selectable?: boolean;
}
export interface ThemeManifestComponent {
  readonly id: string;
  readonly file: string;
}
export interface ThemeManifestBlockRenderer {
  readonly block: string;
  readonly file: string;
  readonly variants?: readonly string[];
}
export interface ThemeManifestNavigationPlacement {
  readonly id: string;
  /** Human-facing name; Admin surfaces it as the primary label (key stays as
   * technical detail). Falls back to the key when absent. */
  readonly label?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly max_depth: number;
  readonly supported_item_types: readonly (typeof NAVIGATION_ITEM_TYPES)[number][];
  readonly fallback?: string;
  readonly supports_mega_menu?: boolean;
}
export interface ThemeManifestMediaPreset {
  readonly id: string;
  readonly width: number;
  readonly height?: number;
  readonly fit?: "cover" | "contain" | "fill" | "inside" | "outside";
  readonly crop?: "center" | "top" | "bottom" | "left" | "right" | "entropy";
  readonly formats?: readonly ("avif" | "webp" | "jpeg" | "png")[];
  readonly quality?: number;
  readonly loading?: "lazy" | "eager";
}
export interface ThemeManifestSetting {
  readonly key: string;
  readonly type: (typeof SETTING_TYPES)[number];
  readonly label?: string;
  readonly token?: string;
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly default?: boolean | string | number;
}
/** Named collection binding (Theme Contract §43). */
export interface ThemeManifestCollection {
  readonly content_types: readonly string[];
  /** list<string> field carrying tags; default "tags". */
  readonly tag_field?: string;
  /** Page size for feed rendering; default 12, hard maximum 100. */
  readonly page_size?: number;
  /** Feed scope; "self" (page children) is the historical default. */
  readonly section?: "self" | "subtree" | "site";
  /** Explicit ordering; default published_at DESC, entry_id tie-break. */
  readonly order?: ThemeManifestFeedOrder;
  /** Template ids receiving the `collections.<key>` scope; default none. */
  readonly templates?: readonly string[];
}

export interface ThemeManifestFeedOrder {
  readonly by: "published_at" | "field";
  readonly direction?: "asc" | "desc";
  readonly field?: string;
}
export interface ThemeManifest {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly theme_contract: string;
  readonly cms_compatibility?: string;
  readonly requires?: Readonly<Record<string, string>>;
  readonly capabilities?: readonly string[];
  readonly directories?: readonly ("scripts" | "styles" | "locales" | "tests")[];
  readonly templates: readonly ThemeManifestTemplate[];
  /** Declared component id used as the extension-view layout. The component
   * receives the rendered view as trusted `content_html`. */
  readonly layout?: { readonly default?: string };
  readonly components: readonly ThemeManifestComponent[];
  readonly block_renderers: readonly ThemeManifestBlockRenderer[];
  readonly navigation_placements: readonly ThemeManifestNavigationPlacement[];
  readonly media_presets: readonly ThemeManifestMediaPreset[];
  readonly settings_schema: readonly ThemeManifestSetting[];
  readonly collections?: Readonly<Record<string, ThemeManifestCollection>>;
  readonly assets?: {
    readonly css?: readonly string[];
    readonly js?: readonly string[];
    readonly fingerprint?: boolean;
    readonly csp?: Readonly<Partial<Record<(typeof CSP_DIRECTIVES)[number], readonly string[]>>>;
  };
}

export interface ManifestIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ThemeManifestValidationResult =
  | { readonly ok: true; readonly value: ThemeManifest }
  | { readonly ok: false; readonly issues: readonly ManifestIssue[] };

const ajv = new Ajv({ allErrors: true });
const compiled = ajv.compile(THEME_MANIFEST_JSON_SCHEMA as unknown as object);

function issue(path: string, code: string, message: string): ManifestIssue {
  return { path, code, message };
}

/** Rejects `..`, backslashes and non-listed roots inside theme-relative paths. */
function pathEscapeIssues(value: unknown, path: string): ManifestIssue[] {
  if (typeof value !== "string") return [];
  if (value.includes("..") || value.includes("\\") || value.startsWith("/")) {
    return [issue(path, "THEME_FILE_PATH_INVALID", `path escapes the theme directory: ${value}`)];
  }
  return [];
}

function collectFilePaths(manifest: Record<string, unknown>): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key of ["templates", "components", "block_renderers"] as const) {
    for (const [index, item] of (manifest[key] as unknown[] | undefined)?.entries() ?? []) {
      entries.push([`/${key}/${index}/file`, (item as Record<string, unknown>)?.file]);
    }
  }
  const assets = manifest.assets as Record<string, unknown> | undefined;
  if (assets) {
    for (const key of ["css", "js"] as const) {
      for (const [index, file] of (assets[key] as unknown[] | undefined)?.entries() ?? []) {
        entries.push([`/assets/${key}/${index}`, file]);
      }
    }
  }
  return entries.filter(([, v]) => typeof v === "string");
}

/** Semantic checks AJV cannot express (duplicate IDs, enum defaults, escapes). */
function semanticIssues(manifest: ThemeManifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const ranges: [string, string][] = [
    ["/theme_contract", manifest.theme_contract],
    ...(manifest.cms_compatibility === undefined
      ? []
      : [["/cms_compatibility", manifest.cms_compatibility] as [string, string]]),
    ...Object.entries(manifest.requires ?? {}).map(
      ([key, range]) => [`/requires/${key}`, range] as [string, string],
    ),
  ];
  for (const [path, range] of ranges) {
    if (!isValidVersionRange(range)) {
      issues.push(issue(path, "THEME_VERSION_RANGE_INVALID", `invalid SemVer range: ${range}`));
    }
  }
  const seen = new Map<string, string>();
  const unique = (kind: string, id: string, path: string): void => {
    const first = seen.get(`${kind}:${id}`);
    if (first !== undefined) {
      issues.push(
        issue(
          path,
          `THEME_${kind}_ID_DUPLICATE`,
          `${kind} id "${id}" already declared at ${first}`,
        ),
      );
    } else seen.set(`${kind}:${id}`, path);
  };
  for (const [index, t] of manifest.templates.entries())
    unique("TEMPLATE", t.id, `/templates/${index}/id`);
  if (
    manifest.layout?.default !== undefined &&
    !manifest.components.some((component) => component.id === manifest.layout?.default)
  ) {
    issues.push(
      issue(
        "/layout/default",
        "THEME_LAYOUT_COMPONENT_UNKNOWN",
        `layout component "${manifest.layout.default}" is not declared in components`,
      ),
    );
  }
  for (const [index, c] of manifest.components.entries())
    unique("COMPONENT", c.id, `/components/${index}/id`);
  for (const [index, p] of manifest.navigation_placements.entries())
    unique("PLACEMENT", p.id, `/navigation_placements/${index}/id`);
  for (const [index, p] of manifest.media_presets.entries())
    unique("PRESET", p.id, `/media_presets/${index}/id`);
  for (const [index, s] of manifest.settings_schema.entries())
    unique("SETTING", s.key, `/settings_schema/${index}/key`);
  for (const [index, r] of manifest.block_renderers.entries())
    unique("BLOCK_RENDERER", r.block, `/block_renderers/${index}/block`);
  // Placement fallbacks must reference declared placements.
  const placementIds = new Set(manifest.navigation_placements.map((p) => p.id));
  for (const [index, p] of manifest.navigation_placements.entries()) {
    if (p.fallback !== undefined && !placementIds.has(p.fallback)) {
      issues.push(
        issue(
          `/navigation_placements/${index}/fallback`,
          "THEME_PLACEMENT_FALLBACK_UNKNOWN",
          `fallback "${p.fallback}" is not a declared placement`,
        ),
      );
    }
    if (p.fallback === p.id) {
      issues.push(
        issue(
          `/navigation_placements/${index}/fallback`,
          "THEME_PLACEMENT_FALLBACK_SELF",
          "fallback must differ from the placement",
        ),
      );
    }
  }
  // enum settings: default must be one of the declared choices.
  for (const [index, s] of manifest.settings_schema.entries()) {
    if (
      s.type === "enum" &&
      typeof s.default === "string" &&
      s.choices !== undefined &&
      !s.choices.includes(s.default)
    ) {
      issues.push(
        issue(
          `/settings_schema/${index}/default`,
          "THEME_SETTING_DEFAULT_INVALID",
          `default "${s.default}" is not one of the declared choices`,
        ),
      );
    }
    if (s.type === "number" && s.min !== undefined && s.max !== undefined && s.min > s.max) {
      issues.push(
        issue(
          `/settings_schema/${index}/min`,
          "THEME_SETTING_RANGE_INVALID",
          "min must not exceed max",
        ),
      );
    }
  }
  // Collection bindings may only target declared templates (§43).
  if (manifest.collections !== undefined) {
    const templateIds = new Set(manifest.templates.map((t) => t.id));
    for (const [key, binding] of Object.entries(manifest.collections)) {
      for (const templateId of binding.templates ?? []) {
        if (!templateIds.has(templateId)) {
          issues.push(
            issue(
              `/collections/${key}/templates`,
              "THEME_COLLECTION_TEMPLATE_UNKNOWN",
              `template "${templateId}" is not declared by this theme`,
            ),
          );
        }
      }
    }
  }
  return issues;
}

/**
 * Validates an untyped manifest document against the v2 schema.
 * Stable codes: THEME_MANIFEST_INVALID (schema), THEME_FILE_PATH_INVALID,
 * THEME_TEMPLATE_ID_DUPLICATE, THEME_COMPONENT_ID_DUPLICATE,
 * THEME_PLACEMENT_ID_DUPLICATE, THEME_PLACEMENT_FALLBACK_UNKNOWN,
 * THEME_PLACEMENT_FALLBACK_SELF, THEME_PRESET_ID_DUPLICATE,
 * THEME_SETTING_ID_DUPLICATE, THEME_SETTING_DEFAULT_INVALID,
 * THEME_SETTING_RANGE_INVALID, THEME_BLOCK_RENDERER_ID_DUPLICATE,
 * THEME_LAYOUT_COMPONENT_UNKNOWN.
 */
export function validateThemeManifest(doc: unknown): ThemeManifestValidationResult {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return {
      ok: false,
      issues: [issue("", "THEME_MANIFEST_INVALID", "manifest must be a JSON object")],
    };
  }
  const record = doc as Record<string, unknown>;
  const issues: ManifestIssue[] = [];
  if (!compiled(record)) {
    for (const err of compiled.errors ?? []) {
      issues.push(
        issue(
          err.instancePath || "/",
          "THEME_MANIFEST_INVALID",
          `${err.message ?? "invalid"} (${err.schemaPath})`,
        ),
      );
    }
  }
  for (const [path, value] of collectFilePaths(record))
    issues.push(...pathEscapeIssues(value, path));
  if (issues.length === 0) {
    const manifest = record as unknown as ThemeManifest;
    issues.push(...semanticIssues(manifest));
    if (issues.length === 0) return { ok: true, value: manifest };
  }
  return { ok: false, issues };
}

/** Parses and validates a manifest from raw JSON text. */
export function parseThemeManifest(json: string): ThemeManifestValidationResult {
  let doc: unknown;
  try {
    doc = JSON.parse(json) as unknown;
  } catch (cause) {
    throw new ThemeError("THEME_MANIFEST_INVALID", `theme.json is not valid JSON`, { cause });
  }
  return validateThemeManifest(doc);
}
