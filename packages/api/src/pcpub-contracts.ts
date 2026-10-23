// Adapter: real content/block registries → structural PcpubTargetContracts
// (ADR-0014; layering — @pcms/api is L2 and may import subsystems). The
// compat semantics live here because only L2 sees both registries:
// unknown content type / unknown block version ⇒ fail closed; known type at
// an older schema version rides the registered props migration first.
import { type BlockDocumentResult, type BlockRegistry, validateBlockDocument } from "@pcms/blocks";
import type { LoadedContentType } from "@pcms/content";
import {
  type ContentTypeRegistry,
  markdownToRichText,
  validateContentPayload,
  validateRichText,
} from "@pcms/content";
import type {
  CanonicalBlockDocument,
  PcpubDiagnostic,
  PcpubTargetContentType,
  PcpubTargetContracts,
  RichTextPropsResolver,
} from "@pcms/publication";
import { mapEntryRichText, validateRichTextBlockPolicy } from "./richtext-documents.js";

function failClosedBlocks(
  documentPath: string,
  typeId: string,
  schemaVersion: number,
  blocks: BlockRegistry,
): PcpubDiagnostic[] {
  const knownVersions = blocks
    .listBlockTypeVersions()
    .find((entry) => entry.typeId === typeId)?.versions;
  return [
    {
      code: "PCPUB_COMPAT_UNSUPPORTED_BLOCK_VERSION",
      path: documentPath,
      message:
        knownVersions === undefined
          ? `block "${typeId}" is unknown on the target`
          : `block "${typeId}@${schemaVersion}" unsupported (target knows ${knownVersions.join(", ")})`,
    },
  ];
}

function toIssues(result: BlockDocumentResult, documentPath: string): PcpubDiagnostic[] {
  if (result.ok) return [];
  return result.issues.map((issue) => ({
    code: "PCPUB_DOCUMENT_INVALID" as const,
    path: `${documentPath}/blocks${issue.path}`,
    message: issue.message,
  }));
}

export function createPcpubTargetContracts(
  contentTypes: ContentTypeRegistry,
  blocks: BlockRegistry,
): PcpubTargetContracts {
  const contentTypeContracts = new Map<string, PcpubTargetContentType | null>();
  return {
    getContentType(key: string): PcpubTargetContentType | null {
      const cached = contentTypeContracts.get(key);
      if (cached !== undefined) return cached;
      const loaded: LoadedContentType | null = contentTypes.getLatestContentType(key);
      const contract: PcpubTargetContentType | null =
        loaded === null
          ? null
          : {
              validateFields(fields: unknown) {
                return validateContentPayload(loaded, fields, "publish").errors;
              },
              validateEntry(documentPath, payload) {
                const issues: PcpubDiagnostic[] = validateRichTextBlockPolicy(
                  loaded.bodyPolicy,
                  payload.blocks,
                  "WORKING",
                ).map((issue) => ({
                  code: "PCPUB_DOCUMENT_INVALID",
                  path: `${documentPath}${issue.path ?? ""}`,
                  message: issue.message,
                }));
                mapEntryRichText(payload, loaded, blocks, (document, path) => {
                  const validation = validateRichText(document);
                  if (!validation.ok)
                    for (const issue of validation.issues)
                      issues.push({
                        code: "PCPUB_DOCUMENT_INVALID",
                        path: `${documentPath}${path}${issue.path}`,
                        message: issue.message,
                      });
                  return document;
                });
                return issues;
              },
            };
      contentTypeContracts.set(key, contract);
      return contract;
    },
    blockVersions() {
      return blocks.listBlockTypeVersions();
    },
    validateEntryBlocks(
      documentPath: string,
      canonical: CanonicalBlockDocument,
    ): PcpubDiagnostic[] {
      const issues: PcpubDiagnostic[] = [];
      const migratedNodes: {
        id: string;
        type: string;
        schema_version: number;
        props: Record<string, unknown>;
      }[] = [];
      for (const node of canonical.blocks) {
        const registered = blocks.getBlockType(node.type, node.schema_version);
        if (registered === null) {
          issues.push(...failClosedBlocks(documentPath, node.type, node.schema_version, blocks));
          continue;
        }
        // Older-but-migratable versions ride the registered props migration
        // before validation (Content spec §70); unsupported versions were
        // already rejected above.
        let props = node.props;
        let version = node.schema_version;
        if (registered.schemaVersion !== node.schema_version) {
          try {
            const migrated = blocks.migrateBlockProps(
              node.type,
              node.schema_version,
              node.props,
              registered.schemaVersion,
            );
            props = migrated.props;
            version = migrated.toVersion;
          } catch {
            issues.push({
              code: "PCPUB_COMPAT_UNSUPPORTED_BLOCK_VERSION",
              path: documentPath,
              message: `block "${node.type}@${node.schema_version}" has no migration path to the target version`,
            });
            continue;
          }
        }
        migratedNodes.push({ id: node.id, type: node.type, schema_version: version, props });
      }
      if (migratedNodes.length === 0 && canonical.blocks.length > 0 && issues.length > 0) {
        return issues;
      }
      const result = validateBlockDocument({ schema_version: 1, blocks: migratedNodes }, blocks);
      issues.push(...toIssues(result, documentPath));
      return issues;
    },
  };
}

/** PCMD rich_text markdown → canonical RichText AST (Content spec §16). */
export const pcpubRichTextBridge = {
  markdownToRichText,
};

/** Per-type rich-text prop names from the block registry (PCMD §95.2). */
export function richTextPropsResolver(blocks: BlockRegistry): RichTextPropsResolver {
  return (typeId, schemaVersion) => {
    const known = blocks.listBlockTypeVersions().find((e) => e.typeId === typeId);
    const registered =
      blocks.getBlockType(typeId, schemaVersion) ??
      (known === undefined
        ? null
        : blocks.getBlockType(typeId, known.versions[known.versions.length - 1]!));
    if (registered === null) return undefined;
    return new Set(registered.richTextProps);
  };
}
