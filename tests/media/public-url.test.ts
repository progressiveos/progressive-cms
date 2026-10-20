// PCMS-MEDIA-T020 — generated public URL / cache identity: variant URLs
// fingerprint version+content (immutable-cache safe), document downloads
// split versioned vs logical current URLs, filenames sanitize to safe
// slugs (incl. Unicode) without ever influencing storage identity.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  documentCurrentUrl,
  documentDownloadUrl,
  MediaError,
  sanitizeFilenameSlug,
  variantPublicUrl,
} from "@pcms/media";

const ASSET = "01900000-0000-7000-8000-00000000feed";

function url(input: { versionNo: number; key: string }): string {
  return variantPublicUrl({
    assetId: ASSET,
    versionNo: input.versionNo,
    presetId: "card",
    variantKey: input.key,
    format: "webp",
  });
}

test("URL identity is fingerprinted by version and variant key", () => {
  const v1 = url({ versionNo: 1, key: "a".repeat(32) });
  assert.equal(v1, `/media/a/${ASSET}/v1/card-${"a".repeat(16)}.webp`);
  // content change (new key) → new URL, same logical asset
  assert.notEqual(url({ versionNo: 1, key: "b".repeat(32) }), v1);
  // version change → new URL
  assert.notEqual(url({ versionNo: 2, key: "a".repeat(32) }), v1);
  // regeneration with the same inputs → same URL (cache-stable)
  assert.equal(url({ versionNo: 1, key: "a".repeat(32) }), v1);
});

test("malformed asset IDs and unknown formats are refused", () => {
  assert.throws(
    () =>
      variantPublicUrl({
        assetId: "../../etc/passwd",
        versionNo: 1,
        presetId: "card",
        variantKey: "a".repeat(32),
        format: "webp",
      }),
    (error: unknown) => error instanceof MediaError,
  );
  assert.throws(
    () =>
      variantPublicUrl({
        assetId: ASSET,
        versionNo: 1,
        presetId: "card",
        variantKey: "a".repeat(32),
        format: "tiff",
      }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TYPE_NOT_ALLOWED",
  );
});

test("document downloads separate versioned and logical current URLs", () => {
  const versioned = documentDownloadUrl({
    assetId: ASSET,
    versionNo: 2,
    filename: "price-2026-09.pdf",
  });
  const current = documentCurrentUrl({ assetId: ASSET, filename: "price-2026-09.pdf" });
  assert.equal(versioned, `/media/a/${ASSET}/v2/dl/price-2026-09.pdf`);
  assert.equal(current, `/media/a/${ASSET}/current/price-2026-09.pdf`);
  // replacing the document moves the versioned URL
  const replaced = documentDownloadUrl({
    assetId: ASSET,
    versionNo: 3,
    filename: "price-2026-09.pdf",
  });
  assert.notEqual(replaced, versioned);
  assert.match(replaced, /\/v3\/dl\//);
  // same filename across versions → the logical current URL never moves
  assert.equal(
    documentCurrentUrl({ assetId: ASSET, filename: "price-2026-09.pdf" }),
    current,
    "current URL is version-independent",
  );
});

test("filenames sanitize to safe slugs; traversal and markup never survive", () => {
  assert.equal(sanitizeFilenameSlug("My Great Photo.JPG"), "my-great-photo");
  assert.equal(sanitizeFilenameSlug("../../etc/passwd"), "passwd", "path segments stripped");
  assert.equal(
    sanitizeFilenameSlug("..\\..\\windows\\system32"),
    "system32",
    "only the last segment remains",
  );
  assert.equal(sanitizeFilenameSlug("...."), "file");
  assert.equal(
    sanitizeFilenameSlug("report <v2>/final?.pdf"),
    "final",
    "only the last path segment survives",
  );
  assert.equal(sanitizeFilenameSlug("Прайс-лист 2026.pdf"), "прайс-лист-2026");
  assert.equal(
    sanitizeFilenameSlug("第二次課題.pdf").length > 0,
    true,
    "unicode kept, never empty",
  );
  assert.ok(!sanitizeFilenameSlug("x<script>.pdf").includes("<"));
  assert.equal(sanitizeFilenameSlug(""), "file");
});
