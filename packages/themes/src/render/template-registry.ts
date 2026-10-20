// Template registry + Content Type acceptance rules (PCMS-THEME-T006;
// Theme Contract spec §11–§13, §41).
//
// Content Type ≠ Template (§12): compatibility is declared in the manifest
// (`accepts_content_types` with `key@version` keys), never inferred from
// file names. An Entry whose logical template key or content type is not
// accepted is a validation error before publish/activation (§13).
import { ThemeError } from "../errors.js";
import type { ThemeManifest, ThemeManifestTemplate } from "../manifest/schema.js";

export interface TemplateContract {
  readonly id: string;
  readonly file: string;
  readonly accepts_content_types: readonly string[];
  readonly required_fields: readonly string[];
  readonly optional_fields: readonly string[];
  readonly supported_blocks: readonly string[] | null;
  readonly globals: readonly string[];
}

export interface TemplateAcceptanceInput {
  readonly templateId: string;
  /** Declared Content Type of the entry, e.g. "page". */
  readonly contentTypeKey: string;
  /** Declared Content Type version, e.g. 1 (matched against `page@1`). */
  readonly contentTypeVersion: number;
  /** Present semantic field IDs on the entry. */
  readonly presentFields: readonly string[];
  /** Global Content keys provided by the application layer (spec §41). */
  readonly presentGlobals?: readonly string[];
}

export interface TemplateAcceptanceIssue {
  readonly code:
    | "THEME_TEMPLATE_NOT_FOUND"
    | "THEME_TEMPLATE_CONTENT_TYPE_REJECTED"
    | "THEME_TEMPLATE_FIELD_MISSING"
    | "THEME_TEMPLATE_GLOBAL_MISSING";
  readonly path: string;
  readonly message: string;
}

export type TemplateAcceptanceResult =
  | { readonly ok: true; readonly contract: TemplateContract }
  | { readonly ok: false; readonly issues: readonly TemplateAcceptanceIssue[] };

export interface TemplateRegistry {
  listTemplates(): readonly TemplateContract[];
  getTemplateContract(templateId: string): TemplateContract | null;
  checkAcceptance(input: TemplateAcceptanceInput): TemplateAcceptanceResult;
  /** Whether the template accepts a content type key (any version). */
  acceptsContentTypeKey(templateId: string, contentTypeKey: string): boolean;
}

function toContract(entry: ThemeManifestTemplate): TemplateContract {
  return {
    id: entry.id,
    file: entry.file,
    accepts_content_types: entry.accepts_content_types,
    required_fields: entry.required_fields ?? [],
    optional_fields: entry.optional_fields ?? [],
    supported_blocks: entry.supported_blocks ?? null,
    globals: entry.globals ?? [],
  };
}

export function createTemplateRegistry(manifest: ThemeManifest): TemplateRegistry {
  const byId = new Map(manifest.templates.map((t) => [t.id, toContract(t)]));
  return {
    listTemplates() {
      return manifest.templates.map(toContract).sort((a, b) => a.id.localeCompare(b.id));
    },
    getTemplateContract(templateId) {
      return byId.get(templateId) ?? null;
    },
    acceptsContentTypeKey(templateId, contentTypeKey) {
      const contract = byId.get(templateId);
      if (contract === undefined) return false;
      return contract.accepts_content_types.some((key) => key.split("@")[0] === contentTypeKey);
    },
    checkAcceptance(input) {
      const contract = byId.get(input.templateId);
      if (contract === undefined) {
        return {
          ok: false,
          issues: [
            {
              code: "THEME_TEMPLATE_NOT_FOUND",
              path: "/template",
              message: `template "${input.templateId}" is not declared by this theme`,
            },
          ],
        };
      }
      const issues: TemplateAcceptanceIssue[] = [];
      const acceptedKey = `${input.contentTypeKey}@${input.contentTypeVersion}`;
      if (!contract.accepts_content_types.includes(acceptedKey)) {
        issues.push({
          code: "THEME_TEMPLATE_CONTENT_TYPE_REJECTED",
          path: "/template/accepts_content_types",
          message: `template "${input.templateId}" does not accept ${acceptedKey} (accepts: ${contract.accepts_content_types.join(", ")})`,
        });
      }
      const present = new Set(input.presentFields);
      for (const field of contract.required_fields) {
        if (!present.has(field)) {
          issues.push({
            code: "THEME_TEMPLATE_FIELD_MISSING",
            path: `/fields/${field}`,
            message: `template "${input.templateId}" requires field "${field}"`,
          });
        }
      }
      const globals = new Set(input.presentGlobals ?? []);
      for (const global of contract.globals) {
        if (!globals.has(global)) {
          issues.push({
            code: "THEME_TEMPLATE_GLOBAL_MISSING",
            path: `/globals/${global}`,
            message: `template "${input.templateId}" requires global "${global}"`,
          });
        }
      }
      return issues.length === 0 ? { ok: true, contract } : { ok: false, issues };
    },
  };
}

/** Convenience for transports: throws the first acceptance issue as a ThemeError. */
export function assertTemplateAcceptance(
  registry: TemplateRegistry,
  input: TemplateAcceptanceInput,
): TemplateContract {
  const result = registry.checkAcceptance(input);
  if (result.ok) return result.contract;
  const first = result.issues[0];
  throw new ThemeError(
    first?.code ?? "THEME_TEMPLATE_NOT_FOUND",
    first?.message ?? "template rejected",
    {
      details: { issues: result.issues },
    },
  );
}
