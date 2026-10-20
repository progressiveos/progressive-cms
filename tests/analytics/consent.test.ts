import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  buildSystemDocumentInjection,
  createAnalyticsRegistry,
  defaultAnalyticsSettings,
  FIRST_PARTY_PROVIDERS,
} from "@pcms/analytics";

function consentInjection(immediate = false) {
  const registry = createAnalyticsRegistry();
  for (const provider of FIRST_PARTY_PROVIDERS) registry.registerProvider(provider);
  const settings = defaultAnalyticsSettings();
  const injection = buildSystemDocumentInjection(
    {
      ...settings,
      providers: {
        ...settings.providers,
        google_analytics_4: {
          enabled: true,
          measurementId: "G-TEST123456",
          activationPolicy: immediate ? "immediate" : "analytics_consent",
        },
        google_tag_manager: {
          enabled: true,
          containerId: "GTM-ABC1234",
          debugMode: false,
          activationPolicy: "marketing_consent",
        },
      },
    },
    registry,
    {
      siteKey: "consent-test",
      pageId: "page",
      pageType: "page",
      locale: "en",
      isSearch: false,
      isNotFound: false,
    },
  );
  assert.ok(injection);
  return injection;
}

function runtime(storage = new Map<string, string>(), denyWrites = false) {
  const injection = consentInjection();
  const inserted: string[] = [];
  const navigation: string[] = [];
  const handlers: Record<string, (event: Record<string, unknown>) => void> = {};
  const sandbox = {
    window: {} as Record<string, unknown>,
    URL,
    location: {
      href: "https://consent.example/",
      replace: (href: string) => navigation.push(href),
      reload: () => navigation.push("reload"),
    },
    document: {
      readyState: "loading",
      addEventListener() {},
      createElement: () => ({ src: "", textContent: "" }),
      head: {
        appendChild(script: { src: string; textContent: string }) {
          if (script.src) inserted.push(script.src);
          else runInNewContext(script.textContent, sandbox);
        },
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem(key: string, value: string) {
        if (denyWrites) throw new Error("storage denied");
        storage.set(key, value);
      },
    },
    addEventListener: (name: string, fn: (event: Record<string, unknown>) => void) => {
      handlers[name] = fn;
    },
  };
  sandbox.window = sandbox;
  const code = injection.headEarlyHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(code);
  runInNewContext(code, sandbox);
  const api = sandbox.window.pcmsConsent as {
    grant(category: string): void;
    revoke(category: string): void;
    getState(): { analytics: boolean; marketing: boolean };
  };
  return { api, storage, inserted, navigation, handlers, sandbox };
}

test("consent isolates category bootstrap/loader, deduplicates, remembers choice and resets on revoke", () => {
  const first = runtime();
  assert.deepEqual(first.inserted, []);
  first.api.grant("unknown");
  assert.deepEqual(first.inserted, []);
  first.api.grant("marketing");
  first.api.grant("marketing");
  assert.equal(first.inserted.length, 1);
  assert.match(first.inserted[0] ?? "", /gtm.js/);
  const layer = first.sandbox.window.dataLayer as unknown[];
  assert.equal(
    JSON.stringify(layer).includes("G-TEST123456"),
    false,
    "denied GA config not queued",
  );
  first.api.grant("analytics");
  assert.equal(first.inserted.length, 2);
  assert.equal(JSON.stringify(layer).includes("G-TEST123456"), true);
  const copy = first.api.getState();
  copy.analytics = false;
  assert.equal(first.api.getState().analytics, true);
  const revisit = runtime(first.storage);
  assert.equal(revisit.inserted.length, 2);
  first.api.revoke("analytics");
  assert.equal(first.navigation.length, 1);
  first.api.grant("analytics");
  assert.equal(first.api.getState().analytics, false, "cannot regrant before loaded code is reset");
  const reset = runtime(first.storage);
  assert.equal(reset.inserted.length, 1);
  assert.match(reset.inserted[0] ?? "", /gtm.js/);
  const key = "pcms:consent:consent-test";
  const saved = first.storage.get(key);
  assert.ok(saved);
  const parsed = JSON.parse(saved);
  first.storage.set(key, JSON.stringify({ ...parsed, version: "other" }));
  assert.deepEqual(
    runtime(first.storage).inserted,
    [],
    "changed provider config requires a new choice",
  );
});

test("revoke in another tab handles both categories without overwriting denial; storage failure has a denial handoff", () => {
  const current = runtime();
  current.api.grant("analytics");
  current.api.grant("marketing");
  assert.ok(current.handlers.storage);
  current.handlers.storage({ key: "pcms:consent:consent-test", newValue: null });
  assert.equal(current.api.getState().analytics, false);
  assert.equal(current.api.getState().marketing, false);
  assert.deepEqual(current.navigation, ["reload"]);
  const cleared = runtime();
  cleared.api.grant("analytics");
  assert.ok(cleared.handlers.storage);
  cleared.handlers.storage({ key: null, newValue: null });
  assert.equal(cleared.api.getState().analytics, false);
  assert.deepEqual(cleared.navigation, ["reload"]);
  const unavailable = runtime(new Map(), true);
  unavailable.api.grant("analytics");
  unavailable.api.revoke("analytics");
  assert.match(unavailable.navigation[0] ?? "", /_pcms_consent_revoke=analytics/);
});

test("owner can choose immediate collection; disabled installation remains inert", () => {
  assert.match(
    consentInjection(true).headEarlyHtml,
    /<script src="https:\/\/www.googletagmanager.com\/gtag/,
  );
  assert.equal(
    buildSystemDocumentInjection(defaultAnalyticsSettings(), createAnalyticsRegistry(), {
      siteKey: "default",
      pageId: "page",
      pageType: "page",
      locale: "en",
      isSearch: false,
      isNotFound: false,
    }),
    null,
  );
});

test("read-only choice storage cannot resurrect a previous grant", () => {
  const writable = runtime();
  writable.api.grant("analytics");
  const readOnly = runtime(writable.storage, true);
  assert.deepEqual(readOnly.inserted, []);
  assert.equal(readOnly.api.getState().analytics, false);
});
