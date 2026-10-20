// Figma → Progressive CMS design pipeline (theme-developer workflow).
// Automatable path: Figma REST API with a Personal Access Token
// (X-Figma-Token). The official "Dev Mode MCP server" is a LOCAL server
// inside the Figma desktop app (127.0.0.1:3845) — it cannot run on a server
// agent, and community MCP wrappers wrap this same REST API, so we call REST
// directly. Variables REST endpoints require Enterprise (403 elsewhere) —
// token extraction degrades to named paint/text styles, which exist on all
// plans.
import { ThemeError } from "./errors.js";

export interface FigmaLocation {
  readonly fileKey: string;
  /** node-id from the URL ("12-345" → "12:345"), when present. */
  readonly nodeId: string | null;
}

/** figma.com/design|file/<key>/…?node-id=12-345 (and legacy /file/). */
export function parseFigmaUrl(url: string): FigmaLocation {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ThemeError("FIGMA_URL_INVALID", `not a valid URL: ${url}`);
  }
  if (parsed.hostname !== "www.figma.com" && parsed.hostname !== "figma.com") {
    throw new ThemeError("FIGMA_URL_INVALID", `not a figma.com URL: ${url}`);
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  const kind = segments[0];
  const fileKey = segments[1];
  if (
    (kind !== "design" && kind !== "file" && kind !== "proto") ||
    fileKey === undefined ||
    !/^[A-Za-z0-9]{10,}$/.test(fileKey)
  ) {
    throw new ThemeError("FIGMA_URL_INVALID", `cannot find a file key in: ${url}`);
  }
  const rawNode = parsed.searchParams.get("node-id");
  const nodeId = rawNode === null ? null : rawNode.replace("-", ":");
  return { fileKey, nodeId };
}

// --- Figma REST payload shapes (subset we consume) ---------------------------

export interface FigmaPaint {
  readonly type: string;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly color?: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a?: number;
  };
}

export interface FigmaNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly children?: readonly FigmaNode[];
  readonly fills?: readonly FigmaPaint[];
  readonly style?: {
    readonly fontFamily?: string;
    readonly fontPostScriptName?: string;
    readonly fontWeight?: number;
    readonly fontSize?: number;
  };
  readonly styles?: Readonly<Record<string, string>>;
}

export interface FigmaFile {
  readonly name: string;
  readonly lastModified: string;
  readonly document: FigmaNode;
  readonly styles?: Readonly<
    Record<string, { readonly key: string; readonly name: string; readonly styleType: string }>
  >;
  readonly components?: Readonly<Record<string, { readonly name: string }>>;
}

export interface DesignTokenDraft {
  readonly palette: readonly { readonly hex: string; readonly count: number }[];
  readonly typography: readonly {
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly fontWeight: number;
    readonly count: number;
  }[];
  readonly namedStyles: readonly {
    readonly name: string;
    readonly kind: string;
    readonly css: string;
  }[];
  readonly components: readonly string[];
}

function cssColor(color: { r: number; g: number; b: number; a?: number }): string {
  const to255 = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  const base = `#${to255(color.r)}${to255(color.g)}${to255(color.b)}`;
  if (color.a !== undefined && color.a < 1) {
    return `${base}${Math.round(color.a * 255)
      .toString(16)
      .padStart(2, "0")}`;
  }
  return base;
}

function walk(node: FigmaNode, visit: (node: FigmaNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** Palette/typography/named-styles from a file (or subtree via nodeId). */
export function extractDesignTokens(
  file: FigmaFile,
  nodeId: string | null = null,
): DesignTokenDraft {
  let root: FigmaNode = file.document;
  if (nodeId !== null) {
    const found = ((): FigmaNode | null => {
      let match: FigmaNode | null = null;
      walk(file.document, (node) => {
        if (node.id === nodeId) match = node;
      });
      return match;
    })();
    if (found === null) {
      throw new ThemeError("FIGMA_NODE_NOT_FOUND", `node ${nodeId} is not in this file`);
    }
    root = found;
  }

  const paletteCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const usedStyleIds = new Set<string>();
  walk(root, (node) => {
    for (const paint of node.fills ?? []) {
      if (paint.visible === false || paint.type !== "SOLID" || paint.color === undefined) continue;
      const hex = cssColor(paint.color);
      paletteCounts.set(hex, (paletteCounts.get(hex) ?? 0) + 1);
    }
    if (node.type === "TEXT" && node.style?.fontFamily !== undefined) {
      const key = `${node.style.fontFamily}|${node.style.fontSize ?? 0}|${node.style.fontWeight ?? 400}`;
      typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1);
    }
    for (const styleId of Object.values(node.styles ?? {})) usedStyleIds.add(styleId);
  });

  const namedStyles: { name: string; kind: string; css: string }[] = [];
  for (const [styleId, used] of Object.entries(file.styles ?? {})) {
    if (!usedStyleIds.has(styleId)) continue;
    const css =
      used.styleType === "FILL"
        ? null // fill styles resolve to fills on nodes; palette covers colors
        : used.styleType === "TEXT"
          ? `/* text style: ${used.name} */`
          : null;
    if (css !== null) namedStyles.push({ name: used.name, kind: used.styleType, css });
  }

  return {
    palette: [...paletteCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([hex, count]) => ({ hex, count })),
    typography: [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => {
        const [fontFamily, fontSize, fontWeight] = key.split("|");
        return {
          fontFamily: fontFamily ?? "",
          fontSize: Number(fontSize),
          fontWeight: Number(fontWeight),
          count,
        };
      }),
    namedStyles,
    components: Object.values(file.components ?? {}).map((component) => component.name),
  };
}

/** CSS custom properties draft from the token extraction. */
/** CSS custom properties draft from the token extraction. */
export function figmaTokensToCss(tokens: DesignTokenDraft, maxPerGroup = 24): string {
  const lines = [":root {"];
  for (const [index, entry] of tokens.palette.slice(0, maxPerGroup).entries()) {
    lines.push(`  --figma-color-${index + 1}: ${entry.hex}; /* used ${entry.count}× */`);
  }
  lines.push("");
  for (const [index, entry] of tokens.typography.slice(0, maxPerGroup).entries()) {
    lines.push(
      `  --figma-font-${index + 1}: ${entry.fontWeight} ${entry.fontSize}px "${entry.fontFamily}"; /* used ${entry.count}× */`,
    );
  }
  lines.push("}");
  lines.push("");
  lines.push("/* Named text styles referenced in the design (map onto theme tokens): */");
  for (const style of tokens.namedStyles.slice(0, maxPerGroup)) {
    lines.push(`/* ${style.kind.toLowerCase()}: ${style.name} */`);
  }
  return `${lines.join("\n")}\n`;
}

/** Top-level frame ids+names to render via GET /v1/images/:key. */
export function frameIdsOf(
  file: FigmaFile,
  nodeId: string | null = null,
): readonly { readonly id: string; readonly name: string }[] {
  const frames: { id: string; name: string }[] = [];
  if (nodeId !== null) {
    walk(file.document, (node) => {
      if (node.id === nodeId) frames.push({ id: node.id, name: node.name });
    });
    return frames;
  }
  for (const page of file.document.children ?? []) {
    for (const child of page.children ?? []) {
      if (child.type === "FRAME" || child.type === "COMPONENT" || child.type === "GROUP") {
        frames.push({ id: child.id, name: child.name });
      }
    }
  }
  return frames;
}
