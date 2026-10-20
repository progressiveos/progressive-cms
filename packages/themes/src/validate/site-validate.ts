// Site validation against a theme (PCMS-THEME-T020; Theme Contract spec §51).
//
// Theme validation (PCMS-THEME-T019) checks a theme without content; site
// validation checks real site content against the theme. Inputs are plain
// data (the CLI composition layer maps @pcms/content/@pcms/blocks objects
// into these shapes — L1 packages never import each other). Finds: unknown
// template keys, content types a template does not accept, missing template
// fields, entry fields unknown to the content type schema, missing globals
// and unsupported blocks/variants.

import type { ThemeManifest } from "../manifest/schema.js";
import {
  type BlockRendererRegistry,
  createBlockRendererRegistry,
} from "../render/block-renderer-registry.js";
import { createTemplateRegistry, type TemplateRegistry } from "../render/template-registry.js";

export interface SiteContentTypeInfo {
  readonly key: string;
  readonly version: number;
  readonly fieldIds: readonly string[];
}

export interface SiteBlockInfo {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly variant: string | null;
  readonly children: readonly SiteBlockInfo[];
}

export interface SiteEntryInfo {
  readonly id: string;
  readonly contentTypeKey: string;
  readonly contentTypeVersion: number;
  readonly templateKey: string;
  /** Field IDs present on the entry (values already validated by Content). */
  readonly fieldIds: readonly string[];
  /** Block tree (from the `block_document` field), flattened shape. */
  readonly blocks: readonly SiteBlockInfo[];
}

export interface SiteValidationOptions {
  /** Global Content keys provided by the site (spec §41). */
  readonly globals?: readonly string[];
}

export interface SiteValidationIssue {
  readonly code:
    | "THEME_SITE_TEMPLATE_UNKNOWN"
    | "THEME_SITE_TEMPLATE_CONTENT_TYPE_REJECTED"
    | "THEME_SITE_FIELD_MISSING"
    | "THEME_SITE_FIELD_UNKNOWN"
    | "THEME_SITE_GLOBAL_MISSING"
    | "THEME_SITE_BLOCK_RENDERER_NOT_FOUND"
    | "THEME_SITE_BLOCK_VARIANT_UNSUPPORTED";
  readonly entryId: string;
  readonly path: string;
  readonly message: string;
}

export interface SiteValidationReport {
  readonly theme: string;
  readonly entries: number;
  readonly ok: boolean;
  readonly issues: readonly SiteValidationIssue[];
}

export function validateSiteAgainstTheme(
  manifest: ThemeManifest,
  contentTypes: readonly SiteContentTypeInfo[],
  entries: readonly SiteEntryInfo[],
  options?: SiteValidationOptions,
): SiteValidationReport {
  const templates: TemplateRegistry = createTemplateRegistry(manifest);
  const renderers: BlockRendererRegistry = createBlockRendererRegistry(manifest, {
    renderComponent: async () => "",
  });
  const schemaById = new Map(contentTypes.map((ct) => [`${ct.key}@${ct.version}`, ct]));
  const globals = new Set(options?.globals ?? []);
  const issues: SiteValidationIssue[] = [];

  const walkBlocks = (entryId: string, blocks: readonly SiteBlockInfo[], path: string): void => {
    for (const [index, block] of blocks.entries()) {
      const issue = renderers.checkBlockSupport({
        id: block.id,
        type: block.type,
        schemaVersion: block.schemaVersion,
        variant: block.variant,
        props: {},
        children: [],
      });
      if (issue !== null) {
        issues.push({
          code:
            issue.code === "THEME_BLOCK_VARIANT_UNSUPPORTED"
              ? "THEME_SITE_BLOCK_VARIANT_UNSUPPORTED"
              : "THEME_SITE_BLOCK_RENDERER_NOT_FOUND",
          entryId,
          path: `${path}/${index}`,
          message: issue.message,
        });
      }
      walkBlocks(entryId, block.children, `${path}/${index}/children`);
    }
  };

  for (const entry of entries) {
    const schema = schemaById.get(`${entry.contentTypeKey}@${entry.contentTypeVersion}`);
    // Unknown fields (against the content type schema).
    if (schema !== undefined) {
      const known = new Set(schema.fieldIds);
      for (const fieldId of entry.fieldIds) {
        if (!known.has(fieldId)) {
          issues.push({
            code: "THEME_SITE_FIELD_UNKNOWN",
            entryId: entry.id,
            path: `/fields/${fieldId}`,
            message: `field "${fieldId}" is not declared by ${entry.contentTypeKey}@${entry.contentTypeVersion}`,
          });
        }
      }
    }
    // Template acceptance.
    const acceptance = templates.checkAcceptance({
      templateId: entry.templateKey,
      contentTypeKey: entry.contentTypeKey,
      contentTypeVersion: entry.contentTypeVersion,
      presentFields: entry.fieldIds,
      presentGlobals: [...globals],
    });
    if (!acceptance.ok) {
      for (const issue of acceptance.issues) {
        const code: SiteValidationIssue["code"] =
          issue.code === "THEME_TEMPLATE_NOT_FOUND"
            ? "THEME_SITE_TEMPLATE_UNKNOWN"
            : issue.code === "THEME_TEMPLATE_CONTENT_TYPE_REJECTED"
              ? "THEME_SITE_TEMPLATE_CONTENT_TYPE_REJECTED"
              : issue.code === "THEME_TEMPLATE_FIELD_MISSING"
                ? "THEME_SITE_FIELD_MISSING"
                : "THEME_SITE_GLOBAL_MISSING";
        issues.push({
          code,
          entryId: entry.id,
          path: issue.path,
          message: issue.message,
        });
      }
    }
    // Block renderer/variant support.
    walkBlocks(entry.id, entry.blocks, "/blocks");
  }

  return { theme: manifest.id, entries: entries.length, ok: issues.length === 0, issues };
}
