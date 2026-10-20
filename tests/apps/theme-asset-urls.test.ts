import assert from "node:assert/strict";
import { test } from "node:test";
import { pinThemeAssetUrls } from "../../apps/web/src/theme-asset-urls.js";

test("theme URL pinning preserves inline CSP bytes, SRI, unrelated attributes and origins", () => {
  const original = `/themes/demo/assets/`;
  const pinned = `/themes/demo/revisions/revision-id/assets/`;
  const raw = `<script>const sample='<img src="${original}raw.png">';</script><style>x{background:url('${original}raw.png')}</style>`;
  const other = `<div data-example=' src="${original}text.png"'></div><!-- <img src="${original}comment.png"> --><img src="https://other.test${original}x.png"><textarea><img src="${original}raw.png"></textarea>`;
  const html = `<link href="${original}css/theme.css?v=1&amp;x=2" integrity="sha256-original"><script src='${original}js/theme.js'></script><img srcset="${original}small.png 1x, ${original}large.png 2x" poster=https://site.test${original}poster.png>${raw}${other}`;
  const result = pinThemeAssetUrls(html, {
    themeId: "demo",
    revisionId: "revision-id",
    origin: "https://site.test",
  });
  assert.match(
    result,
    new RegExp(`href="${pinned}css/theme.css\\?v=1&amp;x=2" integrity="sha256-original"`),
  );
  assert.ok(result.includes(`src='${pinned}js/theme.js'`));
  assert.ok(result.includes(`srcset="${pinned}small.png 1x, ${pinned}large.png 2x"`));
  assert.ok(result.includes(`poster=https://site.test${pinned}poster.png`));
  assert.ok(result.endsWith(raw + other));
});
