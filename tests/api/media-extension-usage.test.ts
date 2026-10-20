import assert from "node:assert/strict";
import test from "node:test";
import { getMediaUsageOp } from "../../packages/api/src/operations.js";

test("media usage resolves titles only for entry references", async () => {
  const mediaId = "01a1330a-ba58-765f-93a0-4e8628fc3c04";
  const entryId = "01a1330a-f6a7-79df-bf83-2994ed153025";
  const revisionLookups: unknown[] = [];
  const extensionReference = {
    sourceEntryId: "progressive.platform-fixture/item/widget-1",
    sourcePath: "/media_id",
    origin: "extension" as const,
  };
  const app = {
    authorize: () => undefined,
    mediaUsage: {
      getUsage: async () => ({
        assetId: mediaId,
        inboundCount: 2,
        distinctSources: 2,
        references: [
          { sourceEntryId: entryId, sourcePath: "/fields/hero", origin: "field" as const },
          extensionReference,
        ],
      }),
    },
    pool: {
      query: async (_sql: string, params: readonly unknown[]) => {
        revisionLookups.push(params[0]);
        return { rows: [{ id: entryId, title: "Entry title" }] };
      },
    },
  };

  const result = await getMediaUsageOp(app as never, { actor: {} } as never, mediaId);

  assert.deepEqual(revisionLookups, [[entryId]]);
  assert.deepEqual(result.titles, { [entryId]: "Entry title" });
  assert.ok(result.references.includes(extensionReference));
});
