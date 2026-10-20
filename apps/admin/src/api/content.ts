// Wire types + fetchers for content model contracts (PCMS-ADMIN-T002).
// Mirrors the M09/M02 discovery payloads — no client-side renaming.
import { apiGet, apiPatch, apiPost } from "./client.js";

export interface ContentTypeSummary {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly bodyPolicy: "none" | "rich_text" | "block_document";
}

/** Field schema as served by `get_content_type_schema` (`field_schema`). */
export interface FieldSchemaWire {
  readonly id: string;
  readonly type: string;
  readonly required?: boolean;
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  // integer/decimal bounds
  readonly min?: number | string;
  readonly max?: number | string;
  readonly precision?: number;
  readonly scale?: number;
  // enum
  readonly values?: readonly string[];
  // relation / relation_list / media constraints
  readonly accepts?: readonly string[];
  // object / list / repeater structure
  readonly fields?: Readonly<Record<string, FieldSchemaWire>>;
  readonly item?: FieldSchemaWire;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface ContentTypeSchemaWire {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly description?: string;
  readonly bodyPolicy: string;
  readonly fields: Readonly<Record<string, { type: string; required: boolean }>>;
  readonly fieldSchema: {
    readonly id: string;
    readonly type: "object";
    readonly fields: Readonly<Record<string, FieldSchemaWire>>;
  };
}

export interface ContentTreeItemWire {
  readonly entry_id: string;
  readonly parent_entry_id: string | null;
  /** Structural role: "folder" nodes are editorial-tree-only. */
  readonly kind: "content" | "folder";
  readonly content_type: string;
  readonly template_key: string | null;
  readonly title: string | null;
  readonly created_at: string;
  readonly archived_at: string | null;
  readonly has_working: boolean;
  readonly working_revision_id: string | null;
  readonly has_publication: boolean;
}

export function fetchContentTypes(): Promise<{ items: readonly ContentTypeSummary[] }> {
  return apiGet("/discovery/content/types");
}

export function fetchContentTypeSchema(key: string): Promise<ContentTypeSchemaWire> {
  return apiGet(`/discovery/content/types/${encodeURIComponent(key)}`);
}

export function fetchContentTree(
  includeArchived: boolean,
): Promise<{ items: readonly ContentTreeItemWire[] }> {
  return apiGet(`/discovery/content/tree${includeArchived ? "?include_archived=true" : ""}`);
}

export interface RevisionListItemWire {
  readonly id: string;
  readonly revision_no: number;
  readonly state: "WORKING" | "SEALED";
  readonly edit_generation: number;
  readonly created_at: string;
  readonly sealed_at: string | null;
}

export interface RevisionWire {
  readonly id: string;
  readonly entity_id: string;
  readonly revision_no: number;
  readonly state: "WORKING" | "SEALED";
  readonly payload: { readonly fields?: Record<string, unknown>; readonly blocks?: unknown };
  readonly edit_generation: number;
  readonly created_at: string;
}

export interface CreateDraftResult {
  readonly entry_id: string;
  readonly revision_id: string;
  readonly edit_generation: number;
}

export interface UpdateDraftResult {
  readonly revision_id: string;
  readonly state: string;
  readonly edit_generation: number;
  readonly updated_at: string;
}

export function createDraft(input: {
  readonly content_type: string;
  readonly parent_entry_id?: string | null;
  readonly template_key?: string | null;
  readonly payload: { fields?: Record<string, unknown>; blocks?: unknown };
}): Promise<CreateDraftResult> {
  return apiPost("/entries", {
    content_type: input.content_type,
    payload: input.payload,
    ...(input.parent_entry_id === undefined ? {} : { parent_entry_id: input.parent_entry_id }),
    ...(input.template_key === undefined ? {} : { template_key: input.template_key }),
  });
}

export function setEntryTemplate(
  entryId: string,
  templateKey: string | null,
): Promise<{ ok: true }> {
  return apiPatch(`/entries/${entryId}/template`, { template_key: templateKey });
}

export function updateDraft(
  revisionId: string,
  payload: { fields?: Record<string, unknown>; blocks?: unknown },
  expectedEditGeneration: number,
): Promise<UpdateDraftResult> {
  return apiPatch(`/revisions/${revisionId}`, {
    payload: {
      ...(payload.fields === undefined ? {} : { fields: payload.fields }),
      ...(payload.blocks === undefined ? {} : { blocks: payload.blocks }),
    },
    expected_edit_generation: expectedEditGeneration,
  });
}

export function moveEntry(entryId: string, parentEntryId: string | null): Promise<{ ok: true }> {
  return apiPost(`/entries/${entryId}/move`, { parent_entry_id: parentEntryId });
}

export function archiveEntry(entryId: string): Promise<unknown> {
  return apiPost(`/entries/${entryId}/archive`);
}

export function restoreEntry(entryId: string): Promise<{ ok: true }> {
  return apiPost(`/entries/${entryId}/restore`);
}

export function duplicateEntry(entryId: string): Promise<CreateDraftResult> {
  return apiPost(`/entries/${entryId}/duplicate`, {});
}

export function createWorkingDraft(
  entryId: string,
  fromRevisionId?: string,
): Promise<{ revision_id: string; edit_generation: number; created: boolean }> {
  return apiPost(`/entries/${entryId}/draft`, {
    ...(fromRevisionId === undefined ? {} : { from_revision_id: fromRevisionId }),
  });
}

export function listRevisions(
  entryId: string,
): Promise<{ items: readonly RevisionListItemWire[] }> {
  return apiGet(`/entries/${entryId}/revisions?limit=100`);
}

export function getRevision(revisionId: string): Promise<RevisionWire> {
  return apiGet(`/revisions/${revisionId}`);
}
