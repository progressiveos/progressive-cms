import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { register } from "tsx/esm/api";

test("Admin addressed privacy preselects source, previews before apply and records owner exception", async (t) => {
  const id = "01900000-0000-7000-8000-000000000001";
  const caseId = "01900000-0000-7000-8000-000000000002";
  const deliveryId = "01900000-0000-7000-8000-000000000003";
  const dom = new JSDOM('<div id="root"></div>', {
    url: `https://example.invalid/admin/#/interactions/privacy?entity=submission&id=${id}`,
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
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let finishPreview: (() => void) | undefined;
  const followup = {
    delivery_id: deliveryId,
    instance_id: id,
    state: "pending",
    evidence_ref: null,
  };
  t.mock.method(globalThis, "fetch", async (path: unknown, options?: RequestInit) => {
    assert.equal(new Headers(options?.headers).get("x-pcms-csrf"), "synthetic");
    const body = JSON.parse(String(options?.body));
    calls.push({ path: String(path), body });
    if (String(path).endsWith("/preview")) {
      await new Promise<void>((resolve) => {
        finishPreview = resolve;
      });
      return Response.json({
        source: { entity: "submission", id },
        lead_ids: [id],
        outbox_ids: [id],
        delivery_ids: [deliveryId],
        expected_token: "preview",
        in_flight: false,
        external_copies: [{ delivery_id: deliveryId, instance_id: id, status: "SUCCEEDED" }],
        limitations: [],
      });
    }
    return Response.json({
      case_id: caseId,
      local_state: "blocked",
      external_state: String(path).endsWith("/apply") ? "pending" : "acknowledged_or_excepted",
      followups: [
        { ...followup, state: String(path).endsWith("/apply") ? "pending" : "owner_exception" },
      ],
    });
  });
  const { createRoot } = await import("react-dom/client");
  const loader = register({ namespace: "privacy-ui", tsconfig: "apps/admin/tsconfig.json" });
  const load = (path: string) => loader.import(`../../apps/admin/src/${path}`, import.meta.url);
  const { AdminPrivacyScreen } = await load("features/interactions/privacy.js");
  const { setLocale } = await load("i18n/index.js");
  const { setCsrfToken } = await load("api/client.js");
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
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
    setCsrfToken("synthetic");
    root.render(createElement(AdminPrivacyScreen));
  });
  const button = (label: string) => {
    const element = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    assert.ok(element, label);
    return element;
  };
  assert.equal(container.querySelectorAll<HTMLInputElement>("input")[0]?.value, id);
  assert.equal(
    [...container.querySelectorAll("button")].some((node) =>
      node.textContent?.includes("Применить"),
    ),
    false,
  );
  await flush(() => button("Предварительная проверка").click());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.body, { target: { entity: "submission", id }, action: "block" });
  assert.ok(
    [...container.querySelectorAll("input,select,textarea")].every(
      (node) => (node as HTMLInputElement).disabled,
    ),
    "prevent editing target while preview is in flight",
  );
  await flush(() => {
    assert.ok(finishPreview);
    finishPreview();
  });
  assert.equal(calls.length, 1, "preview cannot apply");
  await flush(() => button("Применить выбранное действие: Приостановить обработку").click());
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.body.expected_token, "preview");
  assert.match(
    String(calls[1]?.body.request_id),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(container.textContent ?? "", /CMS не удаляет копии/);
  await flush(() => button("Исключение по решению владельца").click());
  assert.deepEqual(calls[2]?.body, { decision: "owner_exception" });
  assert.match(
    calls[2]?.path ?? "",
    new RegExp(`/cases/${caseId}/deliveries/${deliveryId}/acknowledge$`),
  );
  assert.match(container.textContent ?? "", /acknowledged_or_excepted/);
});
