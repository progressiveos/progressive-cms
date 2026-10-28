import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { register } from "tsx/esm/api";

test("published revision is visible without creating a draft", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://example.test/admin/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const requests: string[] = [];
  const responses: Record<string, unknown> = {
    "/api/v1/actor": {
      permissions: ["content.edit", "publication.read", "revision.seal", "publication.publish"],
    },
    "/api/v1/auth/session/rotate": { csrf_token: "test" },
    "/api/v1/discovery/content/types/page": {
      key: "page",
      version: 1,
      title: "Page",
      bodyPolicy: "rich_text",
      fieldSchema: {
        id: "root",
        type: "object",
        fields: {
          title: { id: "title", type: "string" },
          description: { id: "description", type: "text" },
        },
      },
    },
    "/api/v1/entries/entry-1/revisions?limit=100": {
      items: [
        { id: "old", state: "SEALED" },
        { id: "current", state: "SEALED" },
      ],
    },
    "/api/v1/publications/entry/entry-1": {
      state: "PUBLISHED",
      current_revision_id: "current",
      generation: 3,
    },
    "/api/v1/revisions/current": {
      id: "current",
      entity_id: "entry-1",
      state: "SEALED",
      edit_generation: 0,
      payload: { fields: { title: "Same title", description: "This is the published article" } },
    },
    "/api/v1/revisions/draft": {
      id: "draft",
      entity_id: "entry-1",
      state: "WORKING",
      parent_revision_id: "current",
      edit_generation: 0,
      payload: { fields: { title: "Same title", description: "This is the published article" } },
    },
  };
  let editGeneration = 0;
  const mockFetch = async (path: string | URL | Request, init?: RequestInit) => {
    const key = String(path);
    requests.push(`${init?.method ?? "GET"} ${key}`);
    if (key === "/api/v1/entries/entry-1/draft") {
      assert.deepEqual(JSON.parse(String(init?.body)), { from_revision_id: "current" });
      return new Response(JSON.stringify({ revision_id: "draft", edit_generation: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (key === "/api/v1/revisions/draft" && init?.method === "PATCH") {
      assert.equal(JSON.parse(String(init.body)).expected_edit_generation, editGeneration);
      editGeneration++;
      return new Response(JSON.stringify({ edit_generation: editGeneration }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (key === "/api/v1/revisions/draft/seal") {
      assert.equal(JSON.parse(String(init?.body)).expected_edit_generation, editGeneration);
    }
    if (key === "/api/v1/publications/publish") {
      assert.equal(JSON.parse(String(init?.body)).expected_generation, 3);
    }
    return new Response(JSON.stringify(responses[key] ?? { items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: mockFetch,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const loader = register({ namespace: "published-content", tsconfig: "apps/admin/tsconfig.json" });
  const { createRoot } = await import("react-dom/client");
  const { EntryWorkspace } = (await loader.import(
    "../../apps/admin/src/screens/content/EntryWorkspace.js",
    import.meta.url,
  )) as any;
  const { AuthProvider } = (await loader.import(
    "../../apps/admin/src/auth/AuthContext.js",
    import.meta.url,
  )) as any;
  const { ToastProvider } = (await loader.import(
    "../../apps/admin/src/design/toast.js",
    import.meta.url,
  )) as any;
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    await loader.unregister();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  });
  await act(async () => {
    root.render(
      createElement(
        AuthProvider,
        null,
        createElement(
          ToastProvider,
          null,
          createElement(EntryWorkspace, {
            entryId: "entry-1",
            contentTypeKey: "page",
            onChanged: () => {},
          }),
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const panel = dom.window.document.querySelector('[data-testid="published-content"]');
  assert.ok(panel, dom.window.document.body.innerHTML);
  assert.match(panel.textContent ?? "", /Same title/);
  const textarea = panel.querySelector("textarea");
  assert.equal(textarea?.value, "This is the published article");
  assert.equal(textarea?.disabled, true);
  assert.ok(requests.includes("GET /api/v1/revisions/current"));
  assert.ok(!requests.some((request) => request.startsWith("POST /api/v1/entries/")));
  const button = panel.querySelector("button");
  assert.ok(button);
  responses["/api/v1/publications/entry/entry-1"] = {
    state: "PUBLISHED",
    current_revision_id: "newer",
    generation: 4,
  };
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.ok(!requests.some((request) => request.startsWith("POST /api/v1/entries/")));
  responses["/api/v1/publications/entry/entry-1"] = {
    state: "PUBLISHED",
    current_revision_id: "current",
    generation: 3,
  };
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.ok(requests.includes("POST /api/v1/entries/entry-1/draft"));
  const workspace = dom.window.document.querySelector('[data-testid="entry-workspace"]');
  assert.ok(workspace);
  const save = [...workspace.querySelectorAll("button")].find((item) =>
    /сохранить черновик|save draft/i.test(item.textContent ?? ""),
  );
  assert.ok(save);
  await act(async () => {
    save.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const publish = [...workspace.querySelectorAll("button")].find((item) =>
    /^(опубликовать|publish)$/i.test(item.textContent?.trim() ?? ""),
  );
  assert.ok(publish);
  assert.equal(publish.disabled, false);
  responses["/api/v1/publications/entry/entry-1"] = {
    state: "PUBLISHED",
    current_revision_id: "newer",
    generation: 4,
  };
  await act(async () => {
    publish.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.ok(!requests.includes("POST /api/v1/revisions/draft/seal"));
  const staleDialog = dom.window.document.querySelector('[role="dialog"]');
  assert.ok(staleDialog, "changed publication requires explicit review");
  const stay = [...staleDialog.querySelectorAll("button")].find((item) =>
    /остаться в редакторе|stay in the editor/i.test(item.textContent ?? ""),
  );
  assert.ok(stay);
  await act(async () => {
    stay.click();
  });
  responses["/api/v1/publications/entry/entry-1"] = {
    state: "PUBLISHED",
    current_revision_id: "current",
    generation: 3,
  };
  await act(async () => {
    publish.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.ok(requests.includes("POST /api/v1/revisions/draft/seal"));
  assert.ok(requests.includes("POST /api/v1/publications/publish"));
  const showPublished = [...workspace.querySelectorAll("button")].find((item) =>
    /посмотреть публикацию|view published version/i.test(item.textContent ?? ""),
  );
  assert.ok(showPublished);
  await act(async () => {
    showPublished.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const readOnly = dom.window.document.querySelector('[data-testid="published-content"]');
  assert.ok(readOnly);
  responses["/api/v1/revisions/draft"] = {
    id: "draft",
    entity_id: "entry-1",
    state: "WORKING",
    parent_revision_id: null,
    edit_generation: editGeneration,
    payload: { fields: { title: "Legacy draft", description: "Unknown origin" } },
  };
  const returnToDraft = [...readOnly.querySelectorAll("button")].find((item) =>
    /вернуться к черновику|return to draft/i.test(item.textContent ?? ""),
  );
  assert.ok(returnToDraft);
  await act(async () => {
    returnToDraft.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const legacyWorkspace = dom.window.document.querySelector('[data-testid="entry-workspace"]');
  assert.ok(legacyWorkspace);
  const saveLegacy = [...legacyWorkspace.querySelectorAll("button")].find((item) =>
    /сохранить черновик|save draft/i.test(item.textContent ?? ""),
  );
  assert.ok(saveLegacy);
  await act(async () => {
    saveLegacy.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const publishLegacy = [...legacyWorkspace.querySelectorAll("button")].find((item) =>
    /^(опубликовать|publish)$/i.test(item.textContent?.trim() ?? ""),
  );
  assert.ok(publishLegacy);
  await act(async () => {
    publishLegacy.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const dialog = dom.window.document.querySelector('[role="dialog"]');
  assert.ok(dialog, "legacy draft requires explicit confirmation");
  const confirm = [...dialog.querySelectorAll("button")].find((item) =>
    /сравнил версии|compared the versions/i.test(item.textContent ?? ""),
  );
  assert.ok(confirm);
  responses["/api/v1/publications/entry/entry-1"] = {
    state: "PUBLISHED",
    current_revision_id: "newer",
    generation: 4,
  };
  await act(async () => {
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(
    requests.filter((request) => request === "POST /api/v1/publications/publish").length,
    1,
    "new publication after approval must prevent overwrite",
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 8100));
  });
});
