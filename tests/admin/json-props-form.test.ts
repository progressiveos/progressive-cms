// CORE-FEED-ANYWHERE R1 — the generic block props form must edit arrays of
// SCALARS (field ids, content-type keys, entry ids). Before this, ArrayField
// rendered every row as an object form, so a string schema produced zero
// inputs and Add appended `{}`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { register } from "tsx/esm/api";

const ENTRY_ID = "01980000-0000-7000-8000-0000000000a1";
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fields: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
    },
    exclude_entry_ids: {
      type: "array",
      maxItems: 100,
      items: {
        type: "string",
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      },
    },
  },
} as const;

const OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { title: { type: "string", maxLength: 500 } },
      },
    },
  },
} as const;

async function mount(t: import("node:test").TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://admin.example.invalid/admin/" });
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
  const { createRoot } = await import("react-dom/client");
  const loader = register({ namespace: "json-props-form", tsconfig: "apps/admin/tsconfig.json" });
  const { JsonPropsForm } = (await loader.import(
    "../../apps/admin/src/screens/content/blocks/JsonPropsForm.js",
    import.meta.url,
  )) as {
    JsonPropsForm: (props: {
      schema: unknown;
      value: Record<string, unknown>;
      onChange: (value: Record<string, unknown>) => void;
      references: readonly unknown[];
    }) => unknown;
  };
  const { setLocale } = (await loader.import(
    "../../apps/admin/src/i18n/index.js",
    import.meta.url,
  )) as { setLocale: (locale: string) => void };
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = async (run: () => void) => {
    await act(async () => {
      run();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  };
  t.after(async () => {
    await flush(() => root.unmount());
    await loader.unregister();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  });
  setLocale("ru");

  /** Renders the form over `state`; onChange records the next props value. */
  const state: { value: Record<string, unknown>; writes: number; schema: unknown } = {
    value: {},
    writes: 0,
    schema: null,
  };
  const draw = () =>
    createElement(
      JsonPropsForm as never,
      {
        schema: state.schema,
        value: state.value,
        references: [],
        onChange: (next: Record<string, unknown>) => {
          state.writes += 1;
          state.value = next;
        },
      } as never,
    );
  const render = async (schema: unknown, initial: Record<string, unknown>) => {
    state.schema = schema;
    state.value = initial;
    await flush(() => root.render(draw()));
  };
  const rerender = async () => {
    await flush(() => root.render(draw()));
  };
  return { container, state, render, rerender, Event: dom.window.Event };
}

const inputs = (container: HTMLElement) => [...container.querySelectorAll("input")];
const addButton = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find(
    (node) =>
      (node.getAttribute("aria-label") ?? node.textContent ?? "").length >= 0 &&
      node.textContent?.includes("Добавить"),
  );

test("R1: scalar string arrays render one input per row, add/edit/remove and reopen", async (t) => {
  const { container, state, render, rerender, Event } = await mount(t);
  await render(SCHEMA, { fields: ["rank"] });
  // One row -> one real input bound to the string, not an empty object form.
  assert.equal(inputs(container).length, 1, "a scalar row gets exactly one input");
  assert.equal((inputs(container)[0] as HTMLInputElement).value, "rank");

  // Add: the new row is an empty STRING, never `{}`.
  const add = addButton(container);
  assert.ok(add);
  await act(async () => add.click());
  assert.deepEqual(state.value.fields, ["rank", ""]);
  await rerender();
  assert.equal(inputs(container).length, 2);

  // Edit the second row.
  const second = inputs(container)[1] as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(second), "value")?.set;
  assert.ok(setValue);
  await act(async () => {
    setValue.call(second, "published_at");
    second.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual(state.value.fields, ["rank", "published_at"]);
  await rerender();

  // Remove the first row.
  const remove = [...container.querySelectorAll("button")].find((node) =>
    node.getAttribute("aria-label")?.includes("Удалить"),
  );
  assert.ok(remove);
  await act(async () => remove.click());
  assert.deepEqual(state.value.fields, ["published_at"]);
  await rerender();

  // Reopen with the saved document: the value round-trips, no defaults added.
  const writesBefore = state.writes;
  await render(SCHEMA, { fields: ["published_at"] });
  assert.equal((inputs(container)[0] as HTMLInputElement).value, "published_at");
  assert.equal(state.writes, writesBefore, "opening never writes defaults");
});

test("R1: entry-id arrays keep the picker, object arrays keep their fields", async (t) => {
  const { container, state, render, rerender } = await mount(t);
  await render(SCHEMA, { exclude_entry_ids: [ENTRY_ID] });
  // A stable-id row renders the entry picker, not a free-text field.
  assert.match(container.textContent ?? "", /Выбрать/);
  assert.ok((container.textContent ?? "").includes(ENTRY_ID));
  assert.equal(inputs(container).length, 0, "the picker does not add a text input");

  // Existing object rows are untouched: their own control still appears.
  await render(OBJECT_SCHEMA, { items: [{ title: "Card title" }] });
  const objectInputs = inputs(container);
  assert.equal(objectInputs.length, 1);
  assert.equal((objectInputs[0] as HTMLInputElement).value, "Card title");
  // Adding an object row still starts from `{}` (no id schema here).
  const add = addButton(container);
  assert.ok(add);
  await act(async () => add.click());
  assert.deepEqual(state.value.items, [{ title: "Card title" }, {}]);
  await rerender();
});
