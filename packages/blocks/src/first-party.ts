// First-party block types v1 (PCMS-CONT-T014; Content spec §35–§44).
//
// These descriptors register the mandatory v1 blocks into a Block Registry:
// text, heading, image, quote, callout, list, table, code. All props schemas
// are strict JSON Schemas (additionalProperties: false) — no layout/style
// JSON, no executable payloads (§31/§34/§44). Media references are canonical
// stable-ID strings, never URLs/paths (§21). Deep semantic validation of
// embedded RichText ASTs is owned by the Content subsystem and wired at the
// application layer (L1 packages do not import each other).
import { CALCULATOR_BLOCK } from "./calculator.js";
import type { BlockTypeDescriptor } from "./registry.js";

/** Canonical UUIDv7 stable-ID string pattern (identity kernel, @pcms/core). */
export const STABLE_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/** RichText AST placeholder shape: deep validation is the Content subsystem's contract. */
const RICH_TEXT_SCHEMA = { type: "object" } as const;

/**
 * Typed Action value per Content spec §47 — shared by action-bearing blocks.
 * `internal_entry`/`form`/`media_download` carry stable IDs, never URLs.
 */
export const ACTION_PROP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [
        "internal_entry",
        "external_url",
        "anchor",
        "form",
        "phone",
        "email",
        "media_download",
        "none",
      ],
    },
    entry_id: { type: "string", pattern: STABLE_ID_PATTERN },
    url: { type: "string", pattern: "^(https?://|/)" },
    target: { type: "string", enum: ["_self", "_blank"] },
    rel: { type: "string", pattern: "^[a-z ]{0,100}$" },
    anchor: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
    /** Explicit button/CTA label override (2026-09-29: form actions had no
     *  label prop, so themes hardcoded a default like "Leave a request"). */
    anchor_text: { type: "string", minLength: 1, maxLength: 200 },
    form_definition_id: { type: "string", pattern: STABLE_ID_PATTERN },
    phone: { type: "string", pattern: "^\\+?[0-9 ()-]{5,20}$" },
    email: { type: "string", pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
    media_asset_id: { type: "string", pattern: STABLE_ID_PATTERN },
  },
  required: ["type"],
  allOf: [
    { if: { properties: { type: { const: "internal_entry" } } }, then: { required: ["entry_id"] } },
    { if: { properties: { type: { const: "external_url" } } }, then: { required: ["url"] } },
    { if: { properties: { type: { const: "anchor" } } }, then: { required: ["anchor"] } },
    { if: { properties: { type: { const: "form" } } }, then: { required: ["form_definition_id"] } },
    { if: { properties: { type: { const: "phone" } } }, then: { required: ["phone"] } },
    { if: { properties: { type: { const: "email" } } }, then: { required: ["email"] } },
    {
      if: { properties: { type: { const: "media_download" } } },
      then: { required: ["media_asset_id"] },
    },
  ],
} as const;

export const FIRST_PARTY_BLOCK_TYPES_V1 = [
  "text",
  "heading",
  "image",
  "gallery",
  "quote",
  "callout",
  "list",
  "table",
  "code",
  "faq",
  "cta",
  "video",
  "video_gallery",
  "audio",
  "calculator",
  "map",
  "timeline",
  "documents",
  "related_content",
] as const;

export type FirstPartyBlockTypeV1 = (typeof FIRST_PARTY_BLOCK_TYPES_V1)[number];

const HEADINGS: BlockTypeDescriptor = {
  typeId: "heading",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      level: { type: "integer", minimum: 1, maximum: 6 },
      text: { type: "string", minLength: 1, maxLength: 500 },
      anchor: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
    },
    required: ["level", "text"],
  },
  childrenPolicy: "none",
};

const IMAGE: BlockTypeDescriptor = {
  typeId: "image",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      media_id: { type: "string", pattern: STABLE_ID_PATTERN },
      alt_override: { type: "string", maxLength: 1000 },
      caption: { type: "string", maxLength: 2000 },
      presentation_hint: { type: "string", enum: ["normal", "wide", "full_bleed"] },
    },
    required: ["media_id"],
  },
  childrenPolicy: "none",
  references: [{ prop: "media_id", kind: "media" }],
};

const QUOTE: BlockTypeDescriptor = {
  typeId: "quote",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      rich_text: RICH_TEXT_SCHEMA,
      author: { type: "string", maxLength: 300 },
      source: { type: "string", maxLength: 300 },
      source_url: { type: "string", pattern: "^https?://" },
    },
    required: ["rich_text"],
  },
  childrenPolicy: "none",
  richTextProps: ["rich_text"],
};

const CALLOUT: BlockTypeDescriptor = {
  typeId: "callout",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", maxLength: 300 },
      body: RICH_TEXT_SCHEMA,
      kind: { type: "string", enum: ["info", "note", "warning", "success", "accent"] },
      icon: { type: "string", pattern: STABLE_ID_PATTERN },
    },
    required: ["body", "kind"],
  },
  childrenPolicy: "none",
  richTextProps: ["body"],
  references: [{ prop: "icon", kind: "media" }],
};

const LIST: BlockTypeDescriptor = {
  typeId: "list",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", maxLength: 500 },
            text: RICH_TEXT_SCHEMA,
            icon: { type: "string", pattern: STABLE_ID_PATTERN },
            link: ACTION_PROP_SCHEMA,
          },
          anyOf: [{ required: ["title"] }, { required: ["text"] }],
        },
      },
    },
    required: ["items"],
  },
  childrenPolicy: "none",
  richTextProps: ["text"],
  references: [{ prop: "items[].icon", kind: "media", list: true }],
};

const TABLE: BlockTypeDescriptor = {
  typeId: "table",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      caption: { type: "string", maxLength: 1000 },
      columns: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
            title: { type: "string", minLength: 1, maxLength: 300 },
          },
          required: ["key", "title"],
        },
      },
      rows: {
        type: "array",
        maxItems: 2000,
        items: {
          type: "array",
          items: {
            // Restricted rich text or plain typed text per schema (§43).
            anyOf: [{ type: "string", maxLength: 5000 }, RICH_TEXT_SCHEMA],
          },
        },
      },
    },
    required: ["columns"],
  },
  childrenPolicy: "none",
};

const CODE: BlockTypeDescriptor = {
  typeId: "code",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      language: { type: "string", pattern: "^[a-z0-9+#-]{1,24}$" },
      code: { type: "string", maxLength: 100_000 },
      caption: { type: "string", maxLength: 1000 },
      filename: { type: "string", maxLength: 300 },
    },
    required: ["code"],
  },
  // §44: the Theme escapes code content; nothing here ever executes it.
  childrenPolicy: "none",
};

const GALLERY: BlockTypeDescriptor = {
  typeId: "gallery",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: STABLE_ID_PATTERN },
            media_id: { type: "string", pattern: STABLE_ID_PATTERN },
            alt_override: { type: "string", maxLength: 1000 },
            caption: { type: "string", maxLength: 2000 },
          },
          required: ["id", "media_id"],
        },
      },
      layout_hint: { type: "string", enum: ["grid", "slider", "masonry"] },
      lightbox_enabled: { type: "boolean" },
      caption: { type: "string", maxLength: 2000 },
    },
    required: ["items"],
  },
  childrenPolicy: "none",
  references: [{ prop: "items[].media_id", kind: "media", list: true }],
};

const FAQ: BlockTypeDescriptor = {
  typeId: "faq",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: STABLE_ID_PATTERN },
            question: { type: "string", minLength: 1, maxLength: 1000 },
            answer: RICH_TEXT_SCHEMA,
          },
          required: ["id", "question", "answer"],
        },
      },
    },
    required: ["items"],
  },
  childrenPolicy: "none",
  richTextProps: ["answer"],
};

const CTA: BlockTypeDescriptor = {
  typeId: "cta",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 500 },
      text: RICH_TEXT_SCHEMA,
      primary_action: ACTION_PROP_SCHEMA,
      secondary_action: ACTION_PROP_SCHEMA,
      media_id: { type: "string", pattern: STABLE_ID_PATTERN },
      variant: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
      tracking_key: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    },
    required: ["title", "primary_action"],
  },
  childrenPolicy: "none",
  richTextProps: ["text"],
  references: [{ prop: "media_id", kind: "media" }],
};

const VIDEO: BlockTypeDescriptor = {
  typeId: "video",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      provider: {
        type: "string",
        enum: ["youtube", "vimeo", "vkvideo", "rutube", "custom", "upload"],
      },
      video_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,64}$" },
      url: { type: "string", pattern: "^https://" },
      // provider=upload: a native uploaded video asset (MediaKind "video")
      // played by the theme from its public media URL — no third-party embed.
      media_asset_id: { type: "string", pattern: STABLE_ID_PATTERN },
      title: { type: "string", maxLength: 500 },
      caption: { type: "string", maxLength: 2000 },
      poster_media_id: { type: "string", pattern: STABLE_ID_PATTERN },
      start_at: { type: "integer", minimum: 0, maximum: 86_400 },
      privacy_mode: { type: "boolean" },
      aspect_ratio: { type: "string", pattern: "^[0-9]{1,2}:[0-9]{1,2}$" },
      // inline (default): plays on the page (facade button or player).
      // modal: poster/preview opens a lightbox overlay (theme JS).
      // background: ambient autoplay loop (muted, no controls, no
      //   autoplay-gesture requirement) — native upload assets only;
      //   embed providers fall back to inline.
      presentation: { type: "string", enum: ["inline", "modal", "background"] },
    },
    required: ["provider"],
    allOf: [
      {
        if: { properties: { provider: { enum: ["youtube", "vimeo", "vkvideo", "rutube"] } } },
        then: { required: ["video_id"] },
      },
      { if: { properties: { provider: { const: "custom" } } }, then: { required: ["url"] } },
      {
        if: { properties: { provider: { const: "upload" } } },
        then: { required: ["media_asset_id"] },
      },
    ],
  },
  // Content never stores arbitrary trusted iframe HTML for standard providers
  // (§48) — the provider adapter builds the embed at the render layer.
  childrenPolicy: "none",
  references: [
    { prop: "poster_media_id", kind: "media" },
    { prop: "media_asset_id", kind: "media" },
  ],
};

const VIDEO_GALLERY: BlockTypeDescriptor = {
  typeId: "video_gallery",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: STABLE_ID_PATTERN },
            // A native uploaded video asset per item (MediaKind "video").
            media_id: { type: "string", pattern: STABLE_ID_PATTERN },
            poster_media_id: { type: "string", pattern: STABLE_ID_PATTERN },
            title: { type: "string", maxLength: 500 },
            caption: { type: "string", maxLength: 2000 },
          },
          required: ["id", "media_id"],
        },
      },
      layout_hint: { type: "string", enum: ["grid", "slider"] },
      caption: { type: "string", maxLength: 2000 },
    },
    required: ["items"],
  },
  childrenPolicy: "none",
  references: [
    { prop: "items[].media_id", kind: "media", list: true },
    { prop: "items[].poster_media_id", kind: "media", list: true },
  ],
};

const AUDIO: BlockTypeDescriptor = {
  typeId: "audio",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      // A native uploaded audio asset (MediaKind "audio") — podcast episode,
      // voice-over, track preview.
      media_id: { type: "string", pattern: STABLE_ID_PATTERN },
      title: { type: "string", maxLength: 500 },
      caption: { type: "string", maxLength: 2000 },
      // "simple" = compact custom play/pause + progress; "rich" = the theme's
      // animated player. Both are theme-controlled; the native browser
      // controls are only a no-JS fallback.
      player_style: { type: "string", enum: ["simple", "rich"] },
    },
    required: ["media_id"],
  },
  childrenPolicy: "none",
  references: [{ prop: "media_id", kind: "media" }],
};

const MARKER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: STABLE_ID_PATTERN },
    title: { type: "string", minLength: 1, maxLength: 300 },
    description: { type: "string", maxLength: 2000 },
    address: { type: "string", minLength: 1, maxLength: 500 },
    lat: { type: "number", minimum: -90, maximum: 90 },
    lon: { type: "number", minimum: -180, maximum: 180 },
    link: ACTION_PROP_SCHEMA,
    media_id: { type: "string", pattern: STABLE_ID_PATTERN },
  },
  required: ["id", "title"],
  // A published marker needs a deterministic provider-independent locator:
  // lat+lon or a resolvable address — never only a transient provider ID (§51).
  anyOf: [{ required: ["lat", "lon"] }, { required: ["address"] }],
} as const;

const MAP_BLOCK: BlockTypeDescriptor = {
  typeId: "map",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      center: {
        type: "object",
        additionalProperties: false,
        properties: {
          lat: { type: "number", minimum: -90, maximum: 90 },
          lon: { type: "number", minimum: -180, maximum: 180 },
        },
        required: ["lat", "lon"],
      },
      zoom_hint: { type: "integer", minimum: 1, maximum: 19 },
      markers: { type: "array", minItems: 1, maxItems: 200, items: MARKER_SCHEMA },
    },
    required: ["markers"],
  },
  childrenPolicy: "none",
  references: [{ prop: "markers[].media_id", kind: "media", list: true }],
};

const TIMELINE_BLOCK: BlockTypeDescriptor = {
  typeId: "timeline",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", maxLength: 500 },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: STABLE_ID_PATTERN },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            date_text: { type: "string", maxLength: 100 },
            title: { type: "string", minLength: 1, maxLength: 500 },
            text: RICH_TEXT_SCHEMA,
            media_id: { type: "string", pattern: STABLE_ID_PATTERN },
            action: ACTION_PROP_SCHEMA,
          },
          required: ["id", "title"],
          // Exact ISO date or historical/marketing date text (§52).
          anyOf: [{ required: ["date"] }, { required: ["date_text"] }],
        },
      },
    },
    required: ["items"],
  },
  childrenPolicy: "none",
  richTextProps: ["text"],
  references: [{ prop: "items[].media_id", kind: "media", list: true }],
};

const DOCUMENTS_BLOCK: BlockTypeDescriptor = {
  typeId: "documents",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", maxLength: 500 },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: STABLE_ID_PATTERN },
            // Files are always referenced through Media IDs (§53).
            media_id: { type: "string", pattern: STABLE_ID_PATTERN },
            display_title: { type: "string", maxLength: 500 },
            description: { type: "string", maxLength: 2000 },
            version_label: { type: "string", maxLength: 100 },
            action_label: { type: "string", maxLength: 100 },
          },
          required: ["id", "media_id"],
        },
      },
    },
    required: ["items"],
  },
  childrenPolicy: "none",
  references: [{ prop: "items[].media_id", kind: "media", list: true }],
};

const RELATED_CONTENT_BLOCK: BlockTypeDescriptor = {
  typeId: "related_content",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      // Content spec §54: manual relation list, named CollectionDefinition, or
      // pinned + collection fill. The Theme receives a normalized view model,
      // never a raw query.
      mode: { type: "string", enum: ["manual", "collection", "hybrid"] },
      entry_ids: {
        type: "array",
        maxItems: 100,
        items: { type: "string", pattern: STABLE_ID_PATTERN },
      },
      collection_key: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      title: { type: "string", maxLength: 500 },
      // Feed scope/ordering/projection (Theme Contract §43, additive): all
      // optional — a block that declares none keeps its historical semantics.
      // Semantic checks (field/preset existence, manual-mode content_types)
      // live in the application entry adapter, not this structural schema.
      scope: { type: "string", enum: ["section", "subtree", "site"] },
      content_types: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        uniqueItems: true,
        items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
      },
      fields: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
        items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
      },
      image_preset: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
      image_field: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
      exclude_entry_ids: {
        type: "array",
        maxItems: 100,
        uniqueItems: true,
        items: { type: "string", pattern: STABLE_ID_PATTERN },
      },
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
    },
    required: ["mode"],
    allOf: [
      {
        if: { properties: { mode: { enum: ["manual", "hybrid"] } } },
        then: { required: ["entry_ids"] },
      },
      {
        if: { properties: { mode: { enum: ["collection", "hybrid"] } } },
        then: { required: ["collection_key"] },
      },
    ],
  },
  childrenPolicy: "none",
  references: [{ prop: "entry_ids", kind: "relation", list: true }],
};

const TEXT: BlockTypeDescriptor = {
  typeId: "text",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      rich_text: RICH_TEXT_SCHEMA,
    },
    required: ["rich_text"],
  },
  childrenPolicy: "none",
  richTextProps: ["rich_text"],
};

const FIRST_PARTY_DESCRIPTORS_V1: readonly BlockTypeDescriptor[] = [
  TEXT,
  HEADINGS,
  IMAGE,
  GALLERY,
  QUOTE,
  CALLOUT,
  LIST,
  TABLE,
  CODE,
  FAQ,
  CTA,
  VIDEO,
  VIDEO_GALLERY,
  AUDIO,
  CALCULATOR_BLOCK,
  MAP_BLOCK,
  TIMELINE_BLOCK,
  DOCUMENTS_BLOCK,
  RELATED_CONTENT_BLOCK,
];

/** Registers all mandatory v1 first-party blocks into `registry`. */
export function registerFirstPartyBlocksV1(registry: {
  registerBlockType(descriptor: BlockTypeDescriptor): unknown;
}): void {
  for (const descriptor of FIRST_PARTY_DESCRIPTORS_V1) {
    registry.registerBlockType(descriptor);
  }
}
