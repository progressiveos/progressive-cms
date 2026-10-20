// SVG privileged-path validation (PCMS-MEDIA-T013; Media spec §24).
//
// SVG is active content: script, event handlers, foreign-object embedding,
// external references and entity expansion are all attack surface. The v1
// policy is a strict allowlist validator on the privileged upload path:
// an SVG is accepted only when every element and attribute is provably
// inert; anything doubtful is rejected (MEDIA_SVG_NOT_ALLOWED), never
// rewritten on faith. Ordinary (non-privileged) uploads reject SVG earlier
// in the type validation. Transports should still serve SVG with
// `Content-Type: image/svg+xml` and a restrictive CSP/frame policy.
import { MediaError } from "./errors.js";

/** Bounds: an SVG larger than this is rejected before parsing. */
export const SVG_MAX_BYTES = 1_048_576;
const SVG_MAX_TAGS = 10_000;
const SVG_MAX_DEPTH = 64;

/** Structural/graphic elements that cannot execute script or fetch. */
const ELEMENT_ALLOWLIST = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "title",
  "desc",
  "metadata",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "linearGradient",
  "radialGradient",
  "pattern",
  "stop",
  "clipPath",
  "mask",
  "marker",
  "use",
  "filter",
  "feGaussianBlur",
  "feOffset",
  "feBlend",
  "feColorMatrix",
  "feComposite",
  "feFlood",
  "feMerge",
  "feMergeNode",
  "feOffset",
  "image",
]);

const ATTRIBUTE_ALLOWLIST = new Set([
  // identity / accessibility (inert)
  "id",
  "class",
  "role",
  "aria-hidden",
  "aria-label",
  "aria-labelledby",
  // URL-bearing attributes are allowlisted but restricted to #refs below
  "href",
  "xlink:href",
  // geometry / layout
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "points",
  "transform",
  "gradientTransform",
  "patternTransform",
  "pathLength",
  "viewBox",
  "preserveAspectRatio",
  "xmlns",
  "xmlns:xlink",
  "version",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "opacity",
  "color",
  "stop-color",
  "stop-opacity",
  "flood-color",
  "flood-opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "filter",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
  "text-anchor",
  "dominant-baseline",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "word-spacing",
  "text-decoration",
  "dx",
  "dy",
  "rotate",
  "startOffset",
  "textLength",
  "lengthAdjust",
  "spreadMethod",
  "gradientUnits",
  "patternUnits",
  "patternContentUnits",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
  "orient",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "primitiveUnits",
  "filterUnits",
  "in",
  "in2",
  "result",
  "stdDeviation",
  "values",
  "type",
  "mode",
  "slope",
  "intercept",
  "amplitude",
  "exponent",
  "offset",
  "tableValues",
  "style",
]);

/** URL-bearing attributes: only same-document references are safe. */
const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src"]);

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return true;
  return false;
}

const TAG_PATTERN =
  /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)\s*(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;

export interface SvgValidationResult {
  /** The validated bytes (unchanged — validation is allowlist admission). */
  readonly bytes: Buffer;
  readonly elements: number;
}

/**
 * Validates an SVG document for the privileged upload path. Throws
 * MEDIA_SVG_NOT_ALLOWED with the offending construct. Validation covers:
 * DOCTYPE/entity rejection, element allowlist, attribute allowlist,
 * event-handler denial, same-document-only URLs, no <script>, no
 * <foreignObject>, nesting bounds.
 */
export function validateSvg(bytes: Buffer): SvgValidationResult {
  if (bytes.length > SVG_MAX_BYTES) {
    throw new MediaError("MEDIA_SVG_NOT_ALLOWED", `SVG exceeds the ${SVG_MAX_BYTES}-byte bound`);
  }
  const text = bytes.toString("utf8");
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new MediaError("MEDIA_SVG_NOT_ALLOWED", "DOCTYPE/entity declarations are not allowed");
  }
  if (/<!\[CDATA\[/.test(text)) {
    throw new MediaError("MEDIA_SVG_NOT_ALLOWED", "CDATA sections are not allowed");
  }
  if (/<script[\s>]/i.test(text) || /<foreignObject[\s>]/i.test(text)) {
    throw new MediaError(
      "MEDIA_SVG_NOT_ALLOWED",
      "script and foreignObject elements are not allowed",
    );
  }
  if (/<?xml-stylesheet/i.test(text)) {
    throw new MediaError("MEDIA_SVG_NOT_ALLOWED", "xml-stylesheet instructions are not allowed");
  }

  const stack: string[] = [];
  let elements = 0;
  let rootSeen = false;
  let match: RegExpExecArray | null;
  TAG_PATTERN.lastIndex = 0;
  for (;;) {
    match = TAG_PATTERN.exec(text);
    if (match === null) break;
    const [full, closing, rawName, rawAttributes, selfClosing] = match;
    if (full.startsWith("<!--") || full.startsWith("<![")) continue; // comments handled above
    elements += 1;
    if (elements > SVG_MAX_TAGS) {
      throw new MediaError("MEDIA_SVG_NOT_ALLOWED", `more than ${SVG_MAX_TAGS} elements`);
    }
    const name = rawName ?? "";
    if (closing === "/") {
      const open = stack.pop();
      if (open === undefined || open.toLowerCase() !== name.toLowerCase()) {
        throw new MediaError("MEDIA_SVG_NOT_ALLOWED", `unbalanced closing tag </${String(name)}>`);
      }
      if (stack.length === 0) rootSeen = true;
      continue;
    }
    if (!ELEMENT_ALLOWLIST.has(name)) {
      throw new MediaError("MEDIA_SVG_NOT_ALLOWED", `element <${String(name)}> is not allowed`);
    }
    // XML allows exactly one root element.
    if (stack.length === 0) {
      if (rootSeen) {
        throw new MediaError("MEDIA_SVG_NOT_ALLOWED", "multiple root elements are not allowed");
      }
      if (selfClosing === "/") rootSeen = true;
    }
    const attributes = parseAttributes(rawAttributes ?? "", name);
    for (const [attrName, attrValue] of attributes) {
      const lowered = attrName.toLowerCase();
      if (lowered.startsWith("on")) {
        throw new MediaError(
          "MEDIA_SVG_NOT_ALLOWED",
          `event handler attribute "${attrName}" is not allowed`,
        );
      }
      if (!ATTRIBUTE_ALLOWLIST.has(attrName) && !ATTRIBUTE_ALLOWLIST.has(lowered)) {
        throw new MediaError("MEDIA_SVG_NOT_ALLOWED", `attribute "${attrName}" is not allowed`);
      }
      if (URL_ATTRIBUTES.has(lowered) && attrValue !== null && !isSafeUrl(attrValue)) {
        throw new MediaError(
          "MEDIA_SVG_NOT_ALLOWED",
          `attribute "${attrName}" must reference the same document (#id)`,
        );
      }
      if (
        lowered === "style" &&
        attrValue !== null &&
        /url\s*\(|expression|@import|javascript:/i.test(attrValue)
      ) {
        throw new MediaError(
          "MEDIA_SVG_NOT_ALLOWED",
          "style attribute contains forbidden constructs",
        );
      }
      // url(...) paint servers and filter references must be same-document.
      if (
        attrValue !== null &&
        /url\s*\(/i.test(attrValue) &&
        !/^url\(\s*['"]?#/.test(attrValue.trim())
      ) {
        throw new MediaError(
          "MEDIA_SVG_NOT_ALLOWED",
          `attribute "${attrName}" must only reference same-document url(#id) values`,
        );
      }
    }
    if (selfClosing !== "/") {
      stack.push(name);
      if (stack.length > SVG_MAX_DEPTH) {
        throw new MediaError("MEDIA_SVG_NOT_ALLOWED", `nesting deeper than ${SVG_MAX_DEPTH}`);
      }
    }
  }
  if (stack.length > 0) {
    throw new MediaError("MEDIA_SVG_NOT_ALLOWED", `unclosed element <${stack[stack.length - 1]}>`);
  }
  if (elements === 0) {
    throw new MediaError("MEDIA_SVG_NOT_ALLOWED", "no SVG elements found");
  }
  return { bytes, elements };
}

/**
 * Parses an attribute list: `name="value"`, `name='value'`, bare names.
 * Yields [name, value|null]. Malformed constructs throw.
 */
function parseAttributes(input: string, element: string): [string, string | null][] {
  const attributes: [string, string | null][] = [];
  const pattern = /([A-Za-z_][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+))?/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  for (;;) {
    match = pattern.exec(input);
    if (match === null) break;
    consumed += match[0].length;
    const name = match[1] ?? "";
    const value: string | null =
      match[2] === undefined ? null : ((match[3] ?? match[4] ?? match[2]) as string);
    if (value !== null && (value.includes("<") || value.includes(">"))) {
      throw new MediaError(
        "MEDIA_SVG_NOT_ALLOWED",
        `attribute value on <${element} ${name}> contains markup characters`,
      );
    }
    attributes.push([name, value]);
  }
  // Anything left over was malformed (stray quotes, bare `=`, …).
  const remainder = input.replace(pattern, "").trim();
  if (remainder.length !== 0 && consumed > 0) {
    throw new MediaError(
      "MEDIA_SVG_NOT_ALLOWED",
      `malformed attribute syntax on <${element} … ${remainder}>`,
    );
  }
  return attributes;
}
