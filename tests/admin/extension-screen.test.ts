import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContribution } from "@pcms/extensions";
import { JSDOM } from "jsdom";
import { act, createElement, useEffect, useLayoutEffect, useState } from "react";
import { register } from "tsx/esm/api";

// Mount the real App/providers with a synthetic contribution; no Web server or Shop.
test("extension screen keeps its editor through locale, query and registry rerenders", async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://admin.example.invalid/admin/#/review/first",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Element: dom.window.Element,
    CustomEvent: dom.window.CustomEvent,
    HashChangeEvent: dom.window.HashChangeEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const realFetch = globalThis.fetch;
  let enabled = true;
  globalThis.fetch = async (input) => {
    const path = String(input);
    let body: unknown;
    if (path.endsWith("/actor"))
      body = {
        actor_type: "USER",
        actor_id: "editor",
        permissions: [],
        factors: [],
        authenticated_at: new Date().toISOString(),
      };
    else if (path.endsWith("/auth/session/rotate")) body = { csrf_token: "host-only" };
    else if (path.endsWith("/extensions"))
      body = { items: [{ id: "example.review", state: enabled ? "ENABLED" : "DISABLED" }] };
    else if (path.endsWith("/agent/bootstrap"))
      body = {
        site: { key: "default", title: "Test" },
        environment: { classification: "development" },
        server: { cms_version: "1.0.0-rc.24", server_time: new Date().toISOString() },
      };
    else throw new Error(`unexpected API request: ${path}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const { createRoot } = await import("react-dom/client");
  const loader = register({ namespace: "admin-screen-test", tsconfig: "apps/admin/tsconfig.json" });
  const loadAdmin = (path: string) =>
    loader.import(`../../apps/admin/src/${path}`, import.meta.url);
  const { App } = await loadAdmin("App.js");
  const { AuthProvider } = await loadAdmin("auth/AuthContext.js");
  const { ToastProvider } = await loadAdmin("design/toast.js");
  const { setLocale, getLocale } = await loadAdmin("i18n/index.js");
  const { navigate } = await loadAdmin("layout/router.js");
  const { unregisterExtensionContributions } = await loadAdmin("extension/registry.js");
  const { refreshExtensionContributions } = await loadAdmin("extension/contributions.js");
  const { extensionContributions } = await loadAdmin("extension/contributions.generated.js");
  const { t: translate } = await loadAdmin("i18n/index.js");
  const contributions = extensionContributions as ExtensionContribution[];
  let mounts = 0;
  let unmounts = 0;
  let layouts = 0;
  let layoutCleanups = 0;
  let loads = 0;
  function Screen(props: Record<string, string>) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState("");
    useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    useLayoutEffect(() => {
      layouts++;
      return () => {
        layoutCleanups++;
      };
    }, []);
    return createElement(
      "section",
      { "data-review": "screen" },
      createElement("span", { "data-review": "locale" }, getLocale()),
      createElement("span", { "data-review": "param" }, props.id),
      createElement(
        "button",
        { type: "button", "data-review": "edit", onClick: () => setOpen(true) },
        "Edit",
      ),
      open
        ? createElement(
            "div",
            { "data-review": "editor" },
            createElement("input", { value: text, readOnly: true }),
            createElement(
              "button",
              { type: "button", "data-review": "dirty", onClick: () => setText("unsaved") },
              "Change",
            ),
          )
        : null,
    );
  }
  const load = async () => {
    loads++;
    return { default: Screen };
  };
  let activeLoad = load;
  let permission: string | undefined;
  contributions.push({
    extensionId: "example.review",
    register(api) {
      api.route({
        pattern: "review/:id",
        title: "Review",
        load: activeLoad,
        ...(permission === undefined ? {} : { permission }),
      });
    },
  });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = async (run: () => void | Promise<void>) => {
    await act(async () => {
      await run();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  };
  t.after(async () => {
    await flush(() => root.unmount());
    unregisterExtensionContributions("example.review");
    contributions.splice(
      contributions.findIndex((entry) => entry.extensionId === "example.review"),
      1,
    );
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
    root.render(
      createElement(AuthProvider, null, createElement(ToastProvider, null, createElement(App))),
    );
  });
  const select = (name: string) => container.querySelector(`[data-review="${name}"]`);
  const click = async (name: string) => {
    await flush(() => {
      const node = select(name);
      assert.ok(node);
      (node as HTMLElement).click();
    });
  };
  await click("edit");
  await click("dirty");
  assert.equal(container.querySelector("input")?.value, "unsaved");
  assert.equal(mounts, 1);
  assert.equal(loads, 1);
  const observations: {
    event: string;
    unmounts: number;
    cleanups: number;
    loads: number;
    text: string | undefined;
    editor: boolean;
  }[] = [];
  for (const [event, run] of [
    ["RU -> EN", () => setLocale("en")],
    ["EN -> RU", () => setLocale("ru")],
    ["query only", () => navigate("review/first?tab=details", { replace: true })],
    ["registry refresh", () => refreshExtensionContributions(translate)],
  ] as const) {
    await flush(run);
    assert.equal(select("locale")?.textContent, getLocale(), event);
    observations.push({
      event,
      unmounts,
      cleanups: layoutCleanups,
      loads,
      text: container.querySelector("input")?.value,
      editor: Boolean(select("editor")),
    });
  }
  for (const state of observations) {
    assert.equal(state.unmounts, 0, state.event);
    assert.equal(state.cleanups, 0, state.event);
    assert.equal(state.loads, 1, state.event);
    assert.equal(state.text, "unsaved", state.event);
    assert.equal(state.editor, true, state.event);
  }
  assert.equal(select("locale")?.textContent, "ru");
  await flush(() => navigate("review/second", { replace: true }));
  assert.equal(select("param")?.textContent, "second");
  assert.equal(container.querySelector("input")?.value, "unsaved");
  assert.equal(loads, 1);
  assert.equal(layoutCleanups, 0);

  let replacementMounts = 0;
  let replacementUnmounts = 0;
  function Replacement() {
    useEffect(() => {
      replacementMounts++;
      return () => {
        replacementUnmounts++;
      };
    }, []);
    return createElement("div", { "data-review": "replacement" }, "New implementation");
  }
  activeLoad = async () => ({ default: Replacement });
  await flush(() => refreshExtensionContributions(translate));
  assert.ok(select("replacement"));
  assert.equal(unmounts, 1, "a new loader replaces the previous screen");
  assert.equal(replacementMounts, 1);

  permission = "content.read";
  await flush(() => refreshExtensionContributions(translate));
  assert.equal(select("replacement"), null);
  assert.equal(replacementUnmounts, 1);
  assert.ok(container.textContent?.includes(translate("permission_denied_title")));

  enabled = false;
  await flush(() => refreshExtensionContributions(translate));
  assert.ok(container.textContent?.includes(translate("core.page_not_found")));
  await flush(() => navigate("content", { replace: true }));
  assert.ok(
    container.textContent?.includes(translate("permission_denied_title")),
    "Core routing and permissions still work without the contribution",
  );
  const { UNAUTHENTICATED_EVENT } = await loadAdmin("api/client.js");
  await flush(() => {
    dom.window.dispatchEvent(new dom.window.Event(UNAUTHENTICATED_EVENT));
  });
  assert.ok(container.querySelector('input[type="password"]'), "auth gate still returns to login");
});
