// Core-owned branded maintenance page (PCMS-OPS-T118; task brief §19–§36, §70, §71).
//
// ONE source of truth renders every maintenance surface:
//   * the CMS Maintenance Mode response (apps/web interpolates site settings),
//   * the nginx emergency fallback page (statically materialized at release
//     build time with the default copy — scripts/build-release.mjs).
// The page must survive exactly the scenarios where maintenance mode matters:
// broken themes, missing content, even a dead Node process (the static
// variant is served by nginx alone).
//
// Accessibility/response contract (task brief §70/§71): semantic HTML,
// responsive, readable contrast, keyboard-safe link, alt text, no JS, and the
// branding is inlined as SVG — no external asset dependency, ever.
//
// Visual language mirrors the Admin warm flat workspace: warm ivory/charcoal
// surfaces, editorial serif heading, olive action — in both color schemes.

/**
 * Progressive CMS brand mark (inline SVG, gradient "P" — first-party product
 * asset, shared with the Admin shell and favicon; see assets/README.md).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeHtmlString as escapeHtml } from "@pcms/core";

let cachedMark: string | undefined;

export function loadPcmsMarkSvg(): string {
  if (cachedMark === undefined) {
    // Resolved relative to this module; ships inside the release artifact.
    const assetPath = join(import.meta.dirname, "..", "assets", "pcms-mark.svg");
    cachedMark = inlineSvg(readFileSync(assetPath, "utf8"));
  }
  return cachedMark;
}

/** Strips the XML prolog/comments; the gradient works on both color schemes. */
function inlineSvg(svg: string): string {
  const start = svg.indexOf("<svg");
  return svg.slice(start);
}

export interface MaintenancePageSettings {
  /** Heading, e.g. the site name or "Site temporarily unavailable". */
  readonly title: string;
  /** Main advertising/information copy (multi-line allowed). */
  readonly message: string;
  /** Call-to-action label under the copy. */
  readonly promoLabel: string;
  /** Call-to-action target (configurable promo URL — task brief §29). */
  readonly promoUrl: string;
}

/** Initial default copy (task brief §28); the live values are site settings. */
export const DEFAULT_MAINTENANCE_SETTINGS: MaintenancePageSettings = {
  title: "Site temporarily unavailable",
  message:
    "This site is being prepared for launch.\n\nWe are rebuilding it on Progressive CMS — the modern site management system by Progressive OS.\n\nThe site will be back online shortly.",
  promoLabel: "About Progressive CMS",
  promoUrl: "https://p-os.ru/",
};

function renderMessageParagraphs(message: string): string {
  return message
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br />")}</p>`)
    .join("\n      ");
}

export function createMaintenancePageHtml(
  settings: MaintenancePageSettings,
  options: { readonly logoSvg: string },
): string {
  const title = escapeHtml(settings.title);
  const promoLabel = escapeHtml(settings.promoLabel);
  const promoUrl = escapeHtml(settings.promoUrl);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f6f3ec;
    color: #302e28;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.6;
    padding: 24px;
  }
  .card {
    max-width: 640px;
    width: 100%;
    background: #fcfaf5;
    border: 1px solid #ded8cd;
    border-radius: 14px;
    padding: 48px 40px;
    box-shadow: 0 4px 16px rgb(46 38 25 / 0.08);
    text-align: center;
  }
  .mark { width: 72px; height: auto; margin: 0 auto; }
  .brand {
    margin: 16px 0 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #666257;
  }
  h1 {
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    font-weight: 500;
    font-size: 28px;
    margin: 12px 0 16px;
    line-height: 1.25;
  }
  .message { font-size: 17px; color: #666257; }
  .cta {
    display: inline-block;
    margin-top: 28px;
    padding: 12px 28px;
    border-radius: 10px;
    background: #586340;
    color: #ffffff;
    text-decoration: none;
    font-weight: 600;
  }
  .cta:hover, .cta:focus { background: #465132; }
  @media (prefers-color-scheme: dark) {
    body { background: #211f1b; color: #eee9de; }
    .card { background: #292620; border-color: #444035; box-shadow: none; }
    .brand { color: #c0b9aa; }
    .message { color: #c0b9aa; }
    .cta { background: #bdc79f; color: #211f1b; }
    .cta:hover, .cta:focus { background: #d0d9b7; }
  }
  @media (max-width: 480px) {
    .card { padding: 36px 20px; }
    h1 { font-size: 24px; }
  }
</style>
</head>
<body>
  <main class="card">
    <div class="mark" role="img" aria-label="Progressive CMS">${options.logoSvg}</div>
    <p class="brand">Progressive CMS</p>
    <h1>${title}</h1>
    <div class="message">
      ${renderMessageParagraphs(settings.message)}
    </div>
    <a class="cta" href="${promoUrl}" rel="noopener">${promoLabel}</a>
  </main>
</body>
</html>
`;
}
