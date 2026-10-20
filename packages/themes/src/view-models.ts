// Public View Model contract (PCMS-THEME-T001; Theme Contract spec §14/§22–§24/
// §35–§36/§40/§41). These are plain-data shapes the application layer hands to
// a theme renderer. A theme receives resolved, presentation-ready values and
// never sees: DB handles, publication internals, auth/session, secrets,
// routing internals or media transformation protocols.
//
// The types are structural on purpose: `packages/themes` is an L1 subsystem
// and may import `@pcms/core` only (tests/architecture.test.ts), so the
// shapes mirror — without importing — the Content/Blocks public data
// (RichText AST nodes, BlockNode trees). Composition code (apps, CLI, tests)
// passes their plain objects straight through.

/** A media derivative the Media subsystem already resolved for a preset. */
export interface MediaDerivativeViewModel {
  /** Media preset key declared by the theme manifest (PCMS-THEME-T015). */
  readonly preset: string;
  /** Ready-to-serve URL. Themes never append `?w=`/`?h=` style parameters. */
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  /** Served MIME type (MIME-separated picture sources); optional so older
   * producers of the plain shape stay structurally compatible. */
  readonly mime?: string | null;
}

/**
 * Media asset view model (Theme spec §35/§36). Identity is the canonical
 * stable ID; alternates are preset derivatives resolved by the Media
 * subsystem (M05). Full-resolution originals are deliberately absent.
 */
export interface MediaAssetViewModel {
  readonly id: string;
  readonly alt: string;
  /** Intrinsic dimensions when known; templates use them to avoid layout shift. */
  readonly width: number | null;
  readonly height: number | null;
  readonly derivatives: readonly MediaDerivativeViewModel[];
}

/** Navigation item kinds a theme must support (Theme spec §24). */
export type NavigationItemViewModel =
  | {
      readonly type: "internal_entry";
      readonly entry_id: string;
      readonly title: string;
      /** Resolved public href — provided by Core/routing (M04), never computed by the theme. */
      readonly href: string;
      readonly items: readonly NavigationItemViewModel[];
    }
  | {
      readonly type: "external_url";
      readonly title: string;
      readonly href: string;
      readonly items: readonly NavigationItemViewModel[];
    }
  | {
      readonly type: "anchor";
      readonly title: string;
      readonly anchor: string;
      readonly items: readonly NavigationItemViewModel[];
    }
  | {
      readonly type: "group";
      readonly title: string;
      readonly items: readonly NavigationItemViewModel[];
    }
  | { readonly type: "separator" }
  | {
      readonly type: "action";
      readonly title: string;
      /** Provider-independent action payload; Forms/actions subsystems own semantics (M12/M13). */
      readonly action: Readonly<Record<string, unknown>>;
    };

/** One resolved navigation placement (e.g. `header.primary`). */
export interface NavigationPlacementViewModel {
  readonly placement: string;
  readonly max_depth: number;
  readonly items: readonly NavigationItemViewModel[];
}

/** Breadcrumb trail resolved by the application layer (Content Tree order). */
export interface BreadcrumbsViewModel {
  readonly items: readonly { readonly title: string; readonly href: string }[];
}

/**
 * Core-protected head model (Theme spec §38/§39; PCMS-THEME-T016). The core
 * section is produced by the CMS (SEO subsystem from M06; empty-model stand-in
 * until then) and cannot be suppressed or reordered by a theme. Themes extend
 * the page head only through `theme_slots`.
 */
export interface HeadViewModel {
  readonly title: string | null;
  readonly core_meta: readonly {
    /** Standard named meta (`<meta name=…>`); required unless `property` is set. */
    readonly name?: string;
    /** Open Graph property meta (`<meta property=…>`, M06); e.g. "og:title". */
    readonly property?: string;
    readonly content: string;
  }[];
  readonly canonical: string | null;
  readonly robots: string | null;
  /**
   * Favicon/icon links from Site Identity media (M06) — part of the
   * protected core section; themes cannot emit rel=icon slots themselves.
   */
  readonly icons?: readonly {
    readonly rel: string;
    readonly href: string;
    readonly type?: string;
    readonly sizes?: string;
  }[];
  /**
   * Reciprocal language alternates (opt-in multilingual): published locale
   * versions of the same logical page, self included. Empty/absent on
   * single-language sites — drafts never appear here.
   */
  readonly alternates?: readonly {
    readonly hreflang: string;
    readonly href: string;
  }[];
  /** JSON-LD blocks as serialized text produced by trusted subsystems. */
  readonly json_ld: readonly string[];
  /** Theme extension slot entries (stylesheet links, theme-color, …). */
  readonly theme_slots: readonly {
    readonly kind: "stylesheet" | "meta" | "link" | "script";
    readonly attributes: Readonly<Record<string, string>>;
  }[];
}

/** Public site identity (Theme spec §40) — no internal site settings. */
export interface SiteViewModel {
  readonly site_name: string;
  readonly logo: MediaAssetViewModel | null;
  readonly contact: Readonly<Record<string, string>>;
  readonly social: readonly { readonly platform: string; readonly href: string }[];
}

/**
 * Block tree as plain data — structurally the Blocks subsystem BlockNode
 * (stable id, `type@schema_version`, bounded variant, strict props, children).
 */
export interface BlockNodeViewModel {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly variant: string | null;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly BlockNodeViewModel[];
}

/**
 * One published/preview entry reduced to its public presentation surface.
 * `fields` contains only schema-defined semantic fields (Theme spec §15) —
 * no undocumented magic properties; `template_key` is the logical template
 * the entry requests (Content Type ≠ Template, §12).
 */
export interface EntryViewModel {
  readonly id: string;
  readonly content_type_key: string;
  readonly content_type_version: number;
  readonly template_key: string;
  readonly title: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly blocks: readonly BlockNodeViewModel[];
}

/**
 * RichText AST node — structural mirror of the Content subsystem AST
 * (10 node types, marks strong/emphasis/code). Themes never parse Markdown
 * per request and never trust raw HTML (§21); they render these trees through
 * the trusted bridge.
 */
export interface RichTextNodeViewModel {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Public request context — locale/path only, no session or routing internals. */
export interface RequestContextPublicViewModel {
  readonly locale: string | null;
  readonly path: string;
}

/**
 * Semantic snippet segments (M11, Search spec §13/§14): the search engine
 * never emits HTML — matched fragments arrive pre-split; the renderer is
 * responsible for safe markup (escape text, wrap `match` segments).
 */
export interface SearchResultSnippetViewModel {
  readonly source: "body" | "summary" | "title";
  readonly segments: readonly { readonly text: string; readonly match: boolean }[];
}

/** One public search result (Search spec §14 result model). */
export interface SearchResultItemViewModel {
  readonly entity_type: string;
  readonly revision_id: string;
  readonly locale: string;
  readonly summary: string;
  readonly score: number;
  readonly modified_at: string | null;
  /** Server-only published fields; the theme explicitly chooses what to show. */
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly seo?: unknown;
  readonly entity_id: string;
  readonly content_type: string | null;
  readonly title: string;
  /** Current canonical path from Routing (never slug-rebuilt). */
  readonly path: string | null;
  readonly snippet: SearchResultSnippetViewModel | null;
  readonly published_at: string | null;
}

/** View model for the public /search/ system page (Search spec §21/§22). */
export interface SearchResultPageViewModel {
  readonly query: string;
  readonly locale: string;
  readonly total: number;
  readonly items: readonly SearchResultItemViewModel[];
  /** Cursor to the next bounded page, or null. */
  readonly next_cursor: string | null;
  readonly limit: number;
  readonly sort: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly next_url: string | null;
}

/**
 * Full page view model handed to a template renderer (Theme spec §14).
 * All members are plain data; settings values are already schema-validated
 * (PCMS-THEME-T014) and globals contain only declared global payloads (§41).
 */
export interface PageViewModel {
  readonly site: SiteViewModel;
  readonly entry: EntryViewModel;
  /** Head model assembled by the application layer (core-protected). */
  readonly head: HeadViewModel;
  readonly navigation: readonly NavigationPlacementViewModel[];
  readonly breadcrumbs: BreadcrumbsViewModel | null;
  readonly globals: Readonly<Record<string, unknown>>;
  readonly theme_settings: Readonly<Record<string, boolean | string | number | null>>;
  readonly request: RequestContextPublicViewModel;
  /**
   * Locale context (opt-in multilingual; absent on single-language sites).
   * A language switcher is a theme capability rendering these values — the
   * runtime never hardcodes locale codes.
   */
  readonly i18n?: {
    readonly active_locale: string;
    readonly default_locale: string;
    readonly locales: readonly string[];
    /** Same-entity alternate URLs per published locale (self included). */
    readonly alternates: readonly { readonly locale: string; readonly url: string }[];
  };
}

// ─── Interactions: Forms & Quizzes (M12, Forms spec §26) ────────────────────
// Safe view models for public interaction rendering. The application layer
// resolves definition documents into these shapes; a theme renders them and
// never computes authoritative branching/scoring, never sees spam policy
// internals, credentials or arbitrary backend URLs (submission/start URLs are
// resolved by the composition layer).

/** One field-level validation problem (server-authoritative, Forms §8). */
export interface ValidationErrorViewModel {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** Presentation options for select/radio/checkbox_group fields. */
export interface FormFieldOptionViewModel {
  readonly value: string;
  readonly label: string;
}

/** One form field, already sanitized: identity (key/type) + presentation. */
export interface FormFieldViewModel {
  readonly key: string;
  readonly type: string;
  readonly label: string;
  readonly required: boolean;
  readonly help?: string;
  readonly placeholder?: string;
  readonly min_length?: number;
  readonly max_length?: number;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly FormFieldOptionViewModel[];
  /** hidden_controlled: the server-pinned value is safe to render. */
  readonly value?: string;
  /** Server-side validation errors from a previous submit attempt. */
  readonly errors?: readonly ValidationErrorViewModel[];
}

/** Safe form rendering model (Theme spec: form render contract, M12). */
export interface FormViewModel {
  readonly form_definition_id: string;
  readonly form_schema_version: number;
  readonly title: string;
  readonly fields: readonly FormFieldViewModel[];
  /** Resolved public submission endpoint — themes never invent backend URLs. */
  readonly submission_url: string;
  readonly submit_label: string;
  /** Rendered as an aria-hidden honeypot input when the definition asks for one. */
  readonly honeypot_field?: string;
}

/** One quiz question, sanitized (no scoring weights, no branching targets). */
export interface QuizQuestionViewModel {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly required: boolean;
  readonly help?: string;
  readonly options?: readonly FormFieldOptionViewModel[];
  readonly min?: number;
  readonly max?: number;
  readonly max_length?: number;
}

/** One server-driven quiz step (Forms spec §26). */
export interface QuizStepViewModel {
  readonly step_id: string;
  readonly title?: string;
  readonly questions: readonly QuizQuestionViewModel[];
}

/** Safe quiz rendering model; the current step is whatever the server says. */
export interface QuizViewModel {
  readonly quiz_definition_id: string;
  readonly quiz_schema_version: number;
  readonly title: string;
  /** Resolved public quiz endpoints (composition-provided); themes never
   * invent backend URLs. answer_url/complete_url contain a `{quiz_run_id}`
   * placeholder the theme client substitutes with the started run's id. */
  readonly start_url: string;
  readonly answer_url: string;
  readonly complete_url: string;
  readonly start_label: string;
  readonly step?: QuizStepViewModel;
  readonly errors?: readonly ValidationErrorViewModel[];
}
