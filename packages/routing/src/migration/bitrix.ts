// 1C-Bitrix connector (site-migration extension, experimental): maps the
// Bitrix agent export (sections + elements of one information block) onto
// the shared core. Element URLs in Bitrix come from SEF templates, so the
// operator supplies a URL template; unsupported templates fail loudly.
import { buildMigrationWorkspace, type MigrationWorkspace, type SourcePage } from "./common.js";

export interface BitrixSection {
  readonly id: number;
  readonly parent: number;
  readonly name: string;
  readonly code: string;
  readonly url: string;
}

export interface BitrixElement {
  readonly id: number;
  readonly section: number;
  readonly name: string;
  readonly code: string;
  readonly url: string;
  readonly active: boolean;
  readonly detail_text: string;
  readonly preview_text: string;
  readonly properties: readonly { readonly code: string; readonly value: unknown }[];
}

/** Path from a SEF template: {CODE}/{SECTION_CODE}/{ID}/{SECTION_PATH}. */
export function bitrixPathFromTemplate(
  template: string,
  element: { readonly code: string; readonly id: number; readonly section: number },
  sectionById: ReadonlyMap<number, BitrixSection>,
): string {
  if (!template.includes("#") && !template.includes("{")) {
    throw new Error("bitrix URL template must contain placeholders (#CODE# or {CODE})");
  }
  const sectionPath = (sectionId: number): string => {
    const chain: string[] = [];
    let current: number | null = sectionId;
    while (current !== null && current !== 0) {
      const section = sectionById.get(current);
      if (section === undefined) break;
      if (section.code !== "") chain.unshift(section.code);
      current = section.parent;
    }
    return chain.join("/");
  };
  const replace = (raw: string): string =>
    raw
      .replaceAll("{SECTION_PATH}", sectionPath(element.section))
      .replaceAll("{SECTION_CODE}", sectionById.get(element.section)?.code ?? "")
      .replaceAll("{CODE}", element.code)
      .replaceAll("{ID}", String(element.id))
      .replaceAll("#SECTION_PATH#", sectionPath(element.section))
      .replaceAll("#SECTION_CODE#", sectionById.get(element.section)?.code ?? "")
      .replaceAll("#CODE#", element.code)
      .replaceAll("#ID#", String(element.id))
      .replaceAll("//", "/");
  const path = replace(template);
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized.includes("#") || normalized.includes("{")) {
    throw new Error(`bitrix URL template left unresolved placeholders: ${normalized}`);
  }
  return normalized;
}

export function buildWorkspaceFromBitrixExport(
  sections: readonly BitrixSection[],
  elements: readonly BitrixElement[],
  options: {
    readonly sectionUrlTemplate: string;
    readonly elementUrlTemplate: string;
    readonly siteUrl: string;
  },
): MigrationWorkspace {
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const sourcePages: SourcePage[] = [];
  for (const section of sections) {
    sourcePages.push({
      id: `s${section.id}`,
      engine: "bitrix",
      uri: bitrixPathFromTemplate(
        options.sectionUrlTemplate,
        { code: section.code, id: section.id, section: section.parent },
        sectionById,
      ),
      title: section.name,
      html: "",
      deleted: false,
      ...(section.url === "" ? { skip: { classKey: "section-no-url" } } : {}),
    });
  }
  for (const element of elements) {
    sourcePages.push({
      id: element.id,
      engine: "bitrix",
      uri: bitrixPathFromTemplate(options.elementUrlTemplate, element, sectionById),
      title: element.name,
      html: `${element.detail_text}\n${element.preview_text}`.trim(),
      deleted: !element.active,
    });
  }
  return buildMigrationWorkspace({ pages: sourcePages, siteUrl: options.siteUrl });
}
