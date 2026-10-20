import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { register } from "tsx/esm/api";

test("Admin theme cleanup previews, confirms only listed revisions and respects read-only permission", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://example.invalid/admin/#/theme",
    pretendToBeVisual: true,
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  let permissions = ["theme.read", "theme.write"];
  const writes: Record<string, unknown>[] = [];
  const id = "01900000-0000-7000-8000-000000000001";
  t.mock.method(globalThis, "fetch", async (url: unknown, options?: RequestInit) => {
    if (String(url).endsWith("/actor")) return Response.json({ permissions });
    if (String(url).endsWith("/auth/session/rotate"))
      return Response.json({ csrf_token: "synthetic" });
    assert.equal(String(url), "/api/v1/themes/revisions/cleanup");
    assert.equal(new Headers(options?.headers).get("x-pcms-csrf"), "synthetic");
    const input = JSON.parse(String(options?.body));
    writes.push(input);
    return Response.json({
      ok: true,
      theme_generation: 7,
      keep_last: 5,
      older_than_days: 1,
      candidates: [
        { revision_id: id, theme_id: "old-theme", package_version: "1.0.0" },
        {
          revision_id: "01900000-0000-7000-8000-000000000002",
          theme_id: "keep-this",
          package_version: "1.0.0",
        },
      ],
      removed: input.dry_run ? [] : [id],
      pending: [],
      has_more: false,
    });
  });
  const { createRoot } = await import("react-dom/client");
  const loader = register({ namespace: "theme-cleanup-ui", tsconfig: "apps/admin/tsconfig.json" });
  const load = (path: string) => loader.import(`../../apps/admin/src/${path}`, import.meta.url);
  const { ThemeHistoryCleanup } = await load("screens/theme/ThemeHistoryCleanup.js");
  const { AuthProvider } = await load("auth/AuthContext.js");
  const { setLocale } = await load("i18n/index.js");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const flush = async (work: () => void) => {
    await act(async () => {
      work();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  };
  t.after(async () => {
    await flush(() => root.unmount());
    await loader.unregister();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await flush(() => {
    setLocale("ru");
    root.render(createElement(AuthProvider, { key: "write" }, createElement(ThemeHistoryCleanup)));
  });
  const button = (label: string, within: ParentNode = container) => {
    const node = [...within.querySelectorAll("button")].find((n) => n.textContent === label);
    assert.ok(node, label);
    return node;
  };
  await flush(() => button("Проверить старые ревизии").click());
  assert.equal(writes.length, 1);
  const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  assert.equal(boxes.length, 2);
  await flush(() => boxes[1]!.click());
  assert.match(container.textContent ?? "", /old-theme/);
  await flush(() => button("Удалить выбранные ревизии").click());
  assert.equal(writes.length, 1, "opening confirmation must not remove files");
  const dialog = container.querySelector('[role="alertdialog"]');
  assert.ok(dialog);
  await flush(() => button("Удалить выбранные ревизии", dialog).click());
  assert.deepEqual(writes[1], {
    dry_run: false,
    keep_last: 5,
    older_than_days: 1,
    expected_generation: 7,
    revision_ids: [id],
  });
  assert.match(container.textContent ?? "", /Удалено: 1/);
  permissions = ["theme.read"];
  await flush(() =>
    root.render(createElement(AuthProvider, { key: "read" }, createElement(ThemeHistoryCleanup))),
  );
  await flush(() => button("Проверить старые ревизии").click());
  assert.equal(
    [...container.querySelectorAll("button")].some(
      (n) => n.textContent === "Удалить выбранные ревизии",
    ),
    false,
  );
});
