import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultAnalyticsSettings, validateAnalyticsSettings } from "@pcms/analytics";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { register } from "tsx/esm/api";

test("Analytics: remove a network rule, explicitly save and retain the Metrica check switch", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://admin.example.invalid/admin/#/analytics",
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
  let settings = validateAnalyticsSettings({
    ...defaultAnalyticsSettings(),
    networkRules: [
      { id: "one", origin: "https://one.example", directives: ["script-src"] },
      { id: "two", origin: "https://two.example", directives: ["img-src"] },
    ],
  });
  let generation = 7;
  let writes = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "/api/v1/analytics/settings");
    if (options?.method === "PUT") {
      const input = JSON.parse(String(options.body));
      assert.equal(input.expected_generation, generation);
      settings = validateAnalyticsSettings(input.settings);
      generation++;
      writes++;
    }
    return Response.json({ settings, generation });
  };
  const { createRoot } = await import("react-dom/client");
  const loader = register({ namespace: "analytics-ui", tsconfig: "apps/admin/tsconfig.json" });
  const load = (path: string) => loader.import(`../../apps/admin/src/${path}`, import.meta.url);
  const { AnalyticsScreen } = await load("screens/settings/AnalyticsScreen.js");
  const { ToastProvider } = await load("design/toast.js");
  const { setLocale } = await load("i18n/index.js");
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
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
  const render = () => createElement(ToastProvider, null, createElement(AnalyticsScreen));
  await flush(() => {
    setLocale("ru");
    root.render(render());
  });
  const remove = container.querySelector<HTMLButtonElement>(
    '[aria-label="Удалить правило для https://one.example"]',
  );
  assert.ok(remove);
  await flush(() => remove.click());
  assert.equal(writes, 0, "removing is a draft until explicitly saved");
  assert.equal(settings.networkRules.length, 2);
  const label = [...container.querySelectorAll("label")].find((node) =>
    node.textContent?.includes("Разрешить проверку счётчика в Яндекс Метрике"),
  );
  const check = label?.querySelector("input");
  assert.ok(check);
  await flush(() => check.click());
  const save = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Сохранить",
  );
  assert.ok(save);
  await flush(() => save.click());
  assert.equal(writes, 1);
  assert.deepEqual(
    settings.networkRules.map((rule) => rule.id),
    ["two"],
  );
  assert.equal(settings.providers.yandex_metrica.debugMode, true);
  await flush(() => root.render(null));
  await flush(() => root.render(render()));
  assert.ok(!container.textContent?.includes("https://one.example"));
  assert.ok(container.textContent?.includes("https://two.example"));
  assert.match(container.textContent ?? "", /Выходить из админки не нужно/);
  assert.match(container.textContent ?? "", /HTTP 503/);
});
