// Unsupported block/variant diagnostics (PCMS-THEME-T009; Theme Contract
// spec §18/§19/§58).
//
// Policy split:
//  - production: unsupported renderer/variant is a validation error — content
//    is never silently dropped (`diagnoseBlockDocument` feeds site validation,
//    PCMS-THEME-T020);
//  - developer preview: unsupported blocks render as explicit diagnostic
//    placeholders (`renderBlockDocumentWithDiagnostics`), never as lost
//    content, while supported parents around them render normally.

import { escapeHtmlString, type SafeHtml, safeHtml } from "../engine/safe-html.js";
import type { BlockNodeViewModel } from "../view-models.js";
import type { BlockRendererRegistry, BlockSupportIssue } from "./block-renderer-registry.js";
import type { RenderContext } from "./render-service.js";

export interface BlockDiagnostic extends BlockSupportIssue {
  /** JSON-pointer-ish location inside the block document, e.g. `/blocks/2/children/0`. */
  readonly path: string;
  readonly blockType: string;
  readonly variant: string | null;
}

/** Walks the whole block tree and reports every unsupported block/variant. */
export function diagnoseBlockDocument(
  registry: Pick<BlockRendererRegistry, "checkBlockSupport">,
  blocks: readonly BlockNodeViewModel[],
): readonly BlockDiagnostic[] {
  const issues: BlockDiagnostic[] = [];
  const walk = (nodes: readonly BlockNodeViewModel[], path: string): void => {
    for (const [index, node] of nodes.entries()) {
      const issue = registry.checkBlockSupport(node);
      if (issue !== null) {
        issues.push({
          ...issue,
          path: `${path}/${index}`,
          blockType: node.type,
          variant: node.variant,
        });
      }
      walk(node.children, `${path}/${index}/children`);
    }
  };
  walk(blocks, "/blocks");
  return issues;
}

function placeholder(diagnostic: BlockDiagnostic): string {
  const variant = diagnostic.variant ? ` (variant ${escapeHtmlString(diagnostic.variant)})` : "";
  return [
    `<!-- pcms:unsupported-block code=${diagnostic.code} path=${escapeHtmlString(diagnostic.path)} -->`,
    `<div data-pcms-diagnostic="unsupported-block" data-code="${diagnostic.code}">`,
    `[Unsupported block ${escapeHtmlString(diagnostic.blockType)}${variant} — shown in preview only]`,
    "</div>",
  ].join("\n");
}

/**
 * Preview-mode document rendering: supported blocks render normally (their
 * supported children recursively), unsupported blocks/variants become bounded
 * diagnostic placeholders. Output is a trusted fragment: registry output plus
 * escaped diagnostics only.
 */
export async function renderBlockDocumentWithDiagnostics(
  registry: BlockRendererRegistry,
  blocks: readonly BlockNodeViewModel[],
  scope: Readonly<Record<string, unknown>> = {},
  context: RenderContext = {},
): Promise<{ readonly html: SafeHtml; readonly diagnostics: readonly BlockDiagnostic[] }> {
  const diagnostics: BlockDiagnostic[] = [];
  const walk = async (nodes: readonly BlockNodeViewModel[], path: string): Promise<SafeHtml> => {
    const inner: string[] = [];
    for (const [index, node] of nodes.entries()) {
      const issue = registry.checkBlockSupport(node);
      if (issue !== null) {
        const diagnostic: BlockDiagnostic = {
          ...issue,
          path: `${path}/${index}`,
          blockType: node.type,
          variant: node.variant,
        };
        diagnostics.push(diagnostic);
        inner.push(placeholder(diagnostic));
        continue;
      }
      const children = await walk(node.children, `${path}/${index}/children`);
      inner.push(await registry.renderBlockWithChildren(node, children, scope, context));
    }
    return safeHtml(inner.join("\n"));
  };
  const html = await walk(blocks, "/blocks");
  return { html, diagnostics };
}
