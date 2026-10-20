import assert from "node:assert/strict";
import { test } from "node:test";
import { type AnalyticsSettings, defaultAnalyticsSettings } from "@pcms/analytics";
import { saveAnalyticsSettingsOp } from "../../packages/api/src/analytics-ops.js";
import type { ApplicationServices, OperationContext } from "../../packages/api/src/context.js";
import { ApiError } from "../../packages/api/src/errors.js";

test("removing the final analytics network rule requires its scope and matching generation", async () => {
  const empty = defaultAnalyticsSettings();
  const withRule: AnalyticsSettings = {
    ...empty,
    networkRules: [{ id: "one", origin: "https://one.example", directives: ["script-src"] }],
  };
  const ctx = {
    actor: { type: "USER", id: "operator" },
    transport: "rest",
    requestId: "network-removal",
  } as OperationContext;
  function fixture(before: AnalyticsSettings, networkPermission: boolean) {
    const events: unknown[] = [];
    let transactions = 0;
    const app = {
      defaultSiteKey: "default",
      authorize(_actor: unknown, permission: string) {
        if (permission === "analytics.network.manage" && !networkPermission) {
          throw new ApiError("AUTH_PERMISSION_DENIED", "permission denied", { status: 403 });
        }
      },
      pool: {
        query: async () => ({ rows: [{ settings: before, settings_generation: 1 }] }),
        withTransaction: async (work: (tx: unknown) => Promise<unknown>) => {
          transactions++;
          return work({
            query: async (sql: string, values: unknown[]) => {
              if (sql.includes("INSERT INTO analytics_events")) events.push(values[2]);
              return { rows: [{ settings_generation: 2 }] };
            },
          });
        },
      },
      analytics: { updateCachedSettings() {} },
    } as unknown as ApplicationServices;
    return { app, events, transactions: () => transactions };
  }
  const denied = fixture(withRule, false);
  await assert.rejects(
    saveAnalyticsSettingsOp(denied.app, ctx, { settings: empty, expected_generation: 1 }),
    { code: "AUTH_PERMISSION_DENIED" },
  );
  assert.equal(denied.transactions(), 0);
  const allowed = fixture(withRule, true);
  assert.deepEqual(
    await saveAnalyticsSettingsOp(allowed.app, ctx, { settings: empty, expected_generation: 1 }),
    { generation: 2 },
  );
  assert.deepEqual(allowed.events, ["ANALYTICS_NETWORK_RULE_REMOVED"]);
  const ordinary = fixture(empty, false);
  await saveAnalyticsSettingsOp(ordinary.app, ctx, { settings: empty, expected_generation: 1 });
  assert.equal(ordinary.transactions(), 1, "ordinary settings retain analytics.manage semantics");
  const stale = fixture(empty, false);
  await assert.rejects(
    saveAnalyticsSettingsOp(stale.app, ctx, { settings: empty, expected_generation: 2 }),
    { code: "ANALYTICS_SETTINGS_STALE" },
  );
  assert.equal(stale.transactions(), 0, "cannot guess a future CAS generation to evade the guard");
});
