// PCMS-ADMIN-T006/T007 — semantic block validation + calculator preview.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

async function fixture(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, {});
  return { app };
}

test("validate_block_props: schema violations, calculator preview, permission", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const { validateBlockProps } = await import("@pcms/api");

  const bad = await validateBlockProps(app, ctx, {
    type_id: "heading",
    props: { level: 9, text: "" },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.length > 0);

  const good = await validateBlockProps(app, ctx, {
    type_id: "heading",
    props: { level: 2, text: "Раздел" },
  });
  assert.equal(good.ok, true);

  const calc = await validateBlockProps(app, ctx, {
    type_id: "calculator",
    props: {
      inputs: [{ key: "price", label: "Цена", type: "number", default: 100 }],
      formula: "price * 2",
      outputs: [{ label: "Итог", digits: 2 }],
    },
  });
  assert.equal(calc.ok, true);
  assert.deepEqual(calc.computed, [{ label: "Итог", value: "200.00" }]);

  const brokenFormula = await validateBlockProps(app, ctx, {
    type_id: "calculator",
    props: {
      inputs: [{ key: "a", label: "A", type: "number" }],
      formula: "a + (",
      outputs: [{ label: "X" }],
    },
  });
  assert.equal(brokenFormula.ok, false);

  const limited = apiContextOf(scopedActor(["media.read"]));
  await assert.rejects(
    () => validateBlockProps(app, limited, { type_id: "heading", props: {} }),
    (error: { readonly code?: string }) => error?.code === "AUTH_PERMISSION_DENIED",
  );
});
