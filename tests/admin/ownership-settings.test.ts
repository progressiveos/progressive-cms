import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSeoSiteIdentity } from "@pcms/seo";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { register } from "tsx/esm/api";

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

test("ownership settings: direct tab, editable proofs, file import, save/reopen and last-proof removal", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://admin.example.invalid/admin/#/settings?tab=verification",
    pretendToBeVisual: true,
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HashChangeEvent: dom.window.HashChangeEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  let identity = parseSeoSiteIdentity({ site_name: "Test" });
  let writes = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "/api/v1/settings/site-identity");
    if (options?.method === "PUT") {
      identity = parseSeoSiteIdentity(JSON.parse(String(options.body)).identity);
      writes++;
    }
    return Response.json({ identity });
  };
  const { createRoot } = await import("react-dom/client");
  const loader = register({ namespace: "ownership-ui", tsconfig: "apps/admin/tsconfig.json" });
  const load = (path: string) => loader.import(`../../apps/admin/src/${path}`, import.meta.url);
  const { SettingsScreen } = await load("screens/settings/SettingsScreen.js");
  const { ToastProvider } = await load("design/toast.js");
  const { setLocale } = await load("i18n/index.js");
  const { navigate } = await load("layout/router.js");
  const container = present(dom.window.document.getElementById("root"));
  const root = createRoot(container);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = async (run: () => void) => {
    await act(async () => {
      run();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  };
  t.after(async () => {
    await flush(() => root.unmount());
    t.mock.timers.reset();
    await loader.unregister();
    globalThis.fetch = realFetch;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  });
  await flush(() => {
    setLocale("ru");
    root.render(createElement(ToastProvider, null, createElement(SettingsScreen)));
  });
  const button = (label: string) => {
    const node = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
    assert.ok(node, label);
    return node;
  };
  const row = () => present(container.querySelector('[data-testid="verification-entry-0"]'));
  const change = async (input: HTMLInputElement | HTMLSelectElement, value: string) => {
    await flush(() => {
      const proto =
        input.tagName === "SELECT"
          ? dom.window.HTMLSelectElement.prototype
          : dom.window.HTMLInputElement.prototype;
      present(Object.getOwnPropertyDescriptor(proto, "value")?.set).call(input, value);
      input.dispatchEvent(
        new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
      );
    });
  };
  assert.ok(container.querySelector('[data-testid="verification-editor"]'));
  assert.match(container.textContent ?? "", /После сохранения вернитесь/);
  assert.ok(!container.textContent?.includes("Опубликовано:"));
  await flush(() => button("Добавить доказательство").click());
  const input = present(row().querySelector("input"));
  input.focus();
  for (const value of ["a", "ab", '<meta name="google-site-verification" content="abc" />']) {
    await change(input, value);
    assert.equal(row().querySelector("input"), input, "typing must not remount the row");
    assert.equal(dom.window.document.activeElement, input, "typing must preserve focus");
    assert.equal(input.value, value);
  }
  await flush(() => button("Сохранить").click());
  assert.equal(writes, 1);
  assert.equal(identity.verification?.[0]?.content, "abc");
  await flush(() => navigate("settings?tab=identity", { replace: true }));
  assert.equal(container.querySelector('[data-testid="verification-editor"]'), null);
  await flush(() => navigate("settings?tab=verification", { replace: true }));
  assert.equal(row().querySelector("input")?.value, "abc");

  await change(present(row().querySelectorAll("select")[1]), "file");
  const filename = "google0123456789abcdef.html";
  const body = `google-site-verification: ${filename}`;
  const picker = present(row().querySelector('input[type="file"]'));
  await flush(() => {
    Object.defineProperty(picker, "files", { value: [{ name: filename, text: async () => body }] });
    picker.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.equal(
    row().querySelector("input")?.value,
    filename,
    "file import extracts supplied token",
  );
  await flush(() => button("Сохранить").click());
  assert.deepEqual(identity.verification?.[0]?.file, { filename, body });
  await change(present(row().querySelectorAll("select")[1]), "meta");
  await flush(() => button("Сохранить").click());
  assert.equal(identity.verification?.[0]?.file, undefined, "meta switch removes stale file data");
  await flush(() => button("Удалить").click());
  await flush(() => button("Сохранить").click());
  assert.equal(identity.verification, undefined, "last proof must really be removed");
  assert.equal(container.querySelector('[data-testid="verification-entry-0"]'), null);
});
