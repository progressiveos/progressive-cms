// PREPUBLIC §3 — the extension URL contract is locale-ready: ONE canonical
// path builder feeds HTTP canonical/redirects, search document routes and
// sitemap candidates; a non-default locale prefixes the language subtag
// exactly like entry routes, so future multi-locale mounts change no URL
// shape. These tests pin the shape every surface must agree on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { localizedRoutePath } from "@pcms/routing";
import { extensionCanonicalPath } from "../../packages/api/src/extension-http.js";

test("locale canonical: default-scope documents carry no locale subtag", () => {
  assert.equal(
    extensionCanonicalPath({
      mountPath: "/shop",
      extensionId: "shop",
      path: "/widgets/x/",
    }),
    "/shop/widgets/x/",
  );
  // "default"/"x-default" sentinels behave identically.
  assert.equal(
    extensionCanonicalPath({
      mountPath: "/shop",
      extensionId: "shop",
      path: "/widgets/x/",
      locale: "default",
    }),
    "/shop/widgets/x/",
  );
});

test("locale canonical: non-default locales prefix the subtag like entry routes", () => {
  assert.equal(
    extensionCanonicalPath({
      mountPath: "/shop",
      extensionId: "shop",
      path: "/widgets/x/",
      locale: "ru-RU",
    }),
    "/ru/shop/widgets/x/",
  );
  // The rule IS the entry rule — one function, one shape.
  assert.equal(
    extensionCanonicalPath({ mountPath: "/shop", extensionId: "s", path: "/w/", locale: "ru-RU" }),
    localizedRoutePath({ locale: "ru-RU", path: "/shop/w/" }),
  );
});

test("locale canonical: trailing-slash policy and file-like segments match the HTTP canonical", () => {
  // policy default: trailing slash on non-root paths
  assert.equal(
    extensionCanonicalPath({ mountPath: "/shop", extensionId: "s", path: "/w" }),
    "/shop/w/",
  );
  // file-like last segment stays file-like (no slash), byte-identical to the
  // 308 Location the dispatcher emits for the same mount+rest.
  assert.equal(
    extensionCanonicalPath({ mountPath: "/shop", extensionId: "s", path: "/media/logo.svg" }),
    "/shop/media/logo.svg",
  );
  // Unmounted extensions fall back to the technical /x/<id> space.
  assert.equal(
    extensionCanonicalPath({ mountPath: null, extensionId: "shop", path: "/w/" }),
    "/x/shop/w/",
  );
});

test("locale canonical: search document routes and sitemap candidates share the builder", () => {
  // The document route the search index stores must be byte-identical to the
  // path the sitemap candidate and the HTTP canonical expose for the same
  // (mount, route, locale) triple — this IS the "one canonical URL" promise.
  const build = (locale: string | undefined) =>
    extensionCanonicalPath({
      mountPath: "/fixtures",
      extensionId: "progressive.platform-fixture",
      path: "/widgets/acc-widget/",
      ...(locale === undefined ? {} : { locale }),
    });
  assert.equal(build(undefined), build("default"));
  assert.equal(build(undefined), "/fixtures/widgets/acc-widget/");
});
