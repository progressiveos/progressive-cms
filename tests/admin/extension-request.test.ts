import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApiFastify,
  createApiV1,
  makeDiscoveryRoutes,
  makeExtensionsRoutes,
  makeMutationRoutes,
} from "@pcms/api";
import { createProvisioningService, createRoleService } from "@pcms/auth";
import type { AdminContributionApi, ExtensionContribution } from "@pcms/extensions";
import { createExtensionCatalog, defineExtensionArtifact } from "@pcms/extensions/internal";
import {
  ApiError,
  apiPost,
  setCsrfToken,
  UNAUTHENTICATED_EVENT,
} from "../../apps/admin/src/api/client.js";
import { extensionContributions } from "../../apps/admin/src/extension/contributions.generated.js";
import { refreshExtensionContributions } from "../../apps/admin/src/extension/contributions.js";
import { unregisterExtensionContributions } from "../../apps/admin/src/extension/registry.js";
import { requestExtensionApi } from "../../apps/admin/src/extension/request.js";
import { getLocale, setLocale, t as translate } from "../../apps/admin/src/i18n/index.js";
import { contribution, editNavigation } from "../fixtures/admin-request-contribution/index.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";

test("Admin extension requests reject external, non-normalized and auth-state paths before fetch", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("{}"));
  for (const path of [
    "https://evil.example/api/v1",
    "//evil.example",
    "entries",
    "/../actor",
    "/%2e%2e/actor",
    "/entries/../actor",
    "/a//b",
    "/a\\b",
    "/entries%2f..",
    "/actor#token",
    "/auth/login",
    "/auth/session/rotate",
    "/%61uth/session/rotate",
    "/bad%zz",
    "/actor\n",
  ]) {
    await assert.rejects(() => requestExtensionApi("GET", path), {
      code: "API_REQUEST_INVALID",
      status: 0,
    });
  }
  for (const name of ["Cookie", "Authorization", "X-PCMS-CSRF"]) {
    await assert.rejects(
      () => requestExtensionApi("POST", "/entries", { headers: { [name]: "override" } }),
      { code: "API_REQUEST_INVALID" },
    );
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("Admin extension request errors follow the active Admin locale", async (t) => {
  const previousLocale = getLocale();
  t.after(() => setLocale(previousLocale));
  for (const locale of ["ru", "en"] as const) {
    setLocale(locale);
    await assert.rejects(
      () => requestExtensionApi("GET", "https://evil.example/api/v1"),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "API_REQUEST_INVALID" &&
        error.message === translate("extensions.api_request_invalid"),
    );
  }
});

test("Admin extension uploads reuse host rawBody precedence and current CSRF", async (t) => {
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init);
    requests.push(init);
    return new Response('{"asset":{"id":"test"}}', {
      headers: { "content-type": "application/json" },
    });
  });
  t.after(() => setCsrfToken(null));
  setCsrfToken("host-token-one");
  const upload = new FormData();
  upload.append("file", new Blob(["image"]), "image.png");
  await requestExtensionApi("post", "/media", { rawBody: upload, body: { ignored: true } });
  assert.equal(requests[0]?.body, upload);
  assert.equal(new Headers(requests[0]?.headers).get("content-type"), null);
  assert.equal(new Headers(requests[0]?.headers).get("x-pcms-csrf"), "host-token-one");
  setCsrfToken("host-token-two");
  await requestExtensionApi("PATCH", "/entries/test", {
    body: { title: "New" },
    headers: { "x-request-id": "example" },
  });
  assert.equal(requests[1]?.body, '{"title":"New"}');
  assert.equal(new Headers(requests[1]?.headers).get("x-pcms-csrf"), "host-token-two");
  assert.equal(requests[1]?.credentials, "same-origin");
  assert.equal(requests[1]?.redirect, "error");
});

test("Admin extension errors preserve host permission/session/network handling", async (t) => {
  const events: string[] = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        events.push(event.type);
        return true;
      },
    },
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ error: { code: "AUTH_SESSION_INVALID", message: "expired" } }),
        { status: 401, headers: { "x-request-id": "request-1" } },
      ),
  );
  await assert.rejects(
    () => requestExtensionApi("GET", "/actor"),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === "AUTH_SESSION_INVALID" &&
      error.requestId === "request-1",
  );
  assert.deepEqual(events, [UNAUTHENTICATED_EVENT]);
  fetch.mock.mockImplementation(async () => {
    throw new Error("offline");
  });
  await assert.rejects(() => requestExtensionApi("GET", "/actor"), {
    code: "NETWORK_UNREACHABLE",
    retryable: true,
  });
});

test("independent contribution uses real host login/CSRF, preserves Core mutations and server RBAC", async (t) => {
  assert.ok(process.env.PCMS_TEST_DATABASE_URL, "test database required");
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: {
        id: "example.admin-client",
        name: "Client fixture",
        version: "1.0.0",
        extension_contract: "2.0",
        cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
        requires: [],
        provides: [],
        permissions: [],
        data_policy: "retain",
        entrypoint: { type: "module" },
        registrations: {},
      },
      module: {},
      contentSha256: "0".repeat(64),
    }),
  );
  const { app } = await rollbackApiFixture(t, { extensionCatalog: catalog });
  await app.routes.ensureSite("default");
  await app.extensions.lifecycle.install({ extensionId: "example.admin-client", config: {} });
  await app.extensions.lifecycle.enable("example.admin-client");
  const provisioning = createProvisioningService(app.pool, {
    users: app.users,
    passwords: app.passwords,
    policy: app.passwordPolicy,
    roles: createRoleService(app.pool),
  });
  await provisioning.bootstrapOwner({
    displayName: "Owner",
    email: "owner@admin-client.test",
    password: "Owner-fixture-passphrase-2026!",
  });
  const server = createApiFastify(() => "admin-client");
  await server.register(
    createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes(), ...makeExtensionsRoutes()]),
    {
      application: app,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      cookieSecure: false,
    },
  );
  t.after(() => server.close());
  t.after(() => setCsrfToken(null));
  let cookie = "";
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.credentials, "same-origin");
    const url = String(input);
    paths.push(url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    if (cookie) headers.cookie = cookie;
    headers.host = "admin-client.test";
    headers.origin = "http://admin-client.test";
    const response = await server.inject({
      method: init?.method as "GET",
      url,
      headers,
      ...(init?.body === undefined ? {} : { payload: init.body as string }),
    });
    const cookies = response.headers["set-cookie"];
    for (const value of Array.isArray(cookies)
      ? cookies
      : cookies === undefined
        ? []
        : [String(cookies)]) {
      if (value.startsWith("pcms_session=")) cookie = value.split(";", 1)[0] ?? "";
    }
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "content-type": "application/json", "x-request-id": "admin-client" },
    });
  });
  const login = async (email: string, password: string) => {
    const result = await apiPost<{ csrf_token: string }>("/auth/login", { email, password });
    setCsrfToken(result.csrf_token); // Exactly the host AuthProvider flow.
  };
  await login("owner@admin-client.test", "Owner-fixture-passphrase-2026!");
  let publicApi: AdminContributionApi | undefined;
  const generated = extensionContributions as ExtensionContribution[];
  const before = [...generated];
  generated.push(
    contribution((api) => {
      publicApi = api;
    }),
  );
  t.after(() => {
    generated.splice(0, generated.length, ...before);
    unregisterExtensionContributions("example.admin-client");
  });
  await refreshExtensionContributions((key) => key);
  assert.ok(publicApi, "enabled independent contribution receives host API");
  assert.deepEqual(Object.keys(publicApi).sort(), [
    "extensionId",
    "nav",
    "request",
    "route",
    "t",
    "translations",
  ]);
  const api = publicApi;
  const sessionCookie = cookie;
  assert.equal(await editNavigation(publicApi), "After");
  await apiPost("/navigation/sets", { key: "core-after-extension", title: "Core still works" });
  assert.equal(cookie, sessionCookie, "contribution did not rotate/recreate the session");
  await apiPost("/users/direct", {
    display_name: "Editor",
    email: "editor@admin-client.test",
    role_key: "EDITOR",
    password: "Editor-fixture-passphrase-2026!",
  });
  await apiPost("/auth/logout");
  setCsrfToken(null);
  await login("editor@admin-client.test", "Editor-fixture-passphrase-2026!");
  await assert.rejects(
    () =>
      api.request("POST", "/users/direct", {
        body: {
          display_name: "Denied",
          email: "denied@admin-client.test",
          role_key: "OWNER",
          password: "Denied-fixture-passphrase-2026!",
        },
      }),
    { code: "AUTH_PERMISSION_DENIED", status: 403 },
  );
  await apiPost("/auth/logout");
  assert.equal(paths.filter((path) => path === "/api/v1/auth/login").length, 2);
  assert.equal(
    paths.some((path) => path.includes("/auth/session/rotate")),
    false,
  );
});
