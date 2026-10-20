// PCMS-CONT-T017 — map/timeline/documents blocks.
// Acceptance: provider-neutral map + Media refs validated
// (Content spec §51/§52/§53).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BlockDocumentResult,
  createBlockRegistry,
  newBlockId,
  registerFirstPartyBlocksV1,
  validateBlockDocument,
} from "@pcms/blocks";
import { newStableId } from "@pcms/core";

function firstPartyRegistry() {
  const registry = createBlockRegistry();
  registerFirstPartyBlocksV1(registry);
  return registry;
}

function issuesOf(result: BlockDocumentResult) {
  return result.ok ? [] : result.issues;
}

function block(type: string, props: Record<string, unknown>): Record<string, unknown> {
  return {
    id: newBlockId(),
    type,
    schema_version: 1,
    variant: null,
    props,
    children: [],
  };
}

const DOC_MEDIA = newStableId();

test("map: provider-neutral markers with lat/lon or address locator validate", () => {
  const registry = firstPartyRegistry();
  const document = {
    schema_version: 1,
    blocks: [
      block("map", {
        center: { lat: 55.7558, lon: 37.6173 },
        zoom_hint: 12,
        markers: [
          {
            id: newStableId(),
            title: "Главный офис",
            lat: 55.7558,
            lon: 37.6173,
            description: "Вход со двора",
          },
          {
            id: newStableId(),
            title: "Филиал",
            address: "г. Москва, ул. Примерная, 1",
          },
          {
            id: newStableId(),
            title: "Склад",
            lat: 55.8,
            lon: 37.5,
            media_id: DOC_MEDIA,
            link: { type: "anchor", anchor: "warehouse" },
          },
        ],
      }),
    ],
  };
  const result = validateBlockDocument(document, registry);
  assert.equal(result.ok, true, JSON.stringify(issuesOf(result)));
});

test("map: marker without lat/lon AND without address has no deterministic locator", () => {
  const registry = firstPartyRegistry();
  const providerIdOnly = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [
        block("map", {
          markers: [{ id: newStableId(), title: "Точка", provider_place_id: "ChIJxyz" }],
        }),
      ],
    },
    registry,
  );
  // Both the missing locator (props schema anyOf) and the stray provider key fail.
  assert.ok(issuesOf(providerIdOnly).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));
  const outOfRange = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [block("map", { markers: [{ id: newStableId(), title: "x", lat: 120, lon: 10 }] })],
    },
    registry,
  );
  assert.ok(issuesOf(outOfRange).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));
});

test("timeline: items need stable id, title and date or date_text", () => {
  const registry = firstPartyRegistry();
  const document = {
    schema_version: 1,
    blocks: [
      block("timeline", {
        title: "История компании",
        items: [
          {
            id: newStableId(),
            date: "2008-05-01",
            title: "Основание",
            text: { schema_version: 2, type: "document", content: [] },
          },
          { id: newStableId(), date_text: "Весна 2012", title: "Второй офис" },
          {
            id: newStableId(),
            date_text: "2019",
            title: "Награда",
            media_id: DOC_MEDIA,
            action: {
              type: "external_url",
              url: "https://example.com/award",
              target: "_blank",
              rel: "noopener",
            },
          },
        ],
      }),
    ],
  };
  assert.equal(validateBlockDocument(document, registry).ok, true);

  const neither = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [block("timeline", { items: [{ id: newStableId(), title: "Без даты" }] })],
    },
    registry,
  );
  assert.ok(issuesOf(neither).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));
});

test("documents: files are referenced through Media IDs only", () => {
  const registry = firstPartyRegistry();
  const document = {
    schema_version: 1,
    blocks: [
      block("documents", {
        title: "Документы",
        items: [
          {
            id: newStableId(),
            media_id: DOC_MEDIA,
            display_title: "Регламент (PDF, 2 МБ)",
            version_label: "v3",
            action_label: "Скачать",
          },
        ],
      }),
    ],
  };
  assert.equal(validateBlockDocument(document, registry).ok, true);

  const urlInstead = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [
        block("documents", {
          items: [{ id: newStableId(), media_id: "https://example.com/file.pdf" }],
        }),
      ],
    },
    registry,
  );
  assert.ok(issuesOf(urlInstead).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));

  const noMedia = validateBlockDocument(
    { schema_version: 1, blocks: [block("documents", { items: [{ id: newStableId() }] })] },
    registry,
  );
  assert.ok(issuesOf(noMedia).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));
});
