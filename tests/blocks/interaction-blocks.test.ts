// PCMS-CONT-T015 — gallery/faq/cta/action/video blocks.
// Acceptance: multiple CTA + provider-safe video fixture passes
// (Content spec §39/§45/§46/§47/§48).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BlockDocumentResult,
  createBlockRegistry,
  FIRST_PARTY_BLOCK_TYPES_V1,
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

const RICH = { schema_version: 2, type: "document", content: [{ type: "paragraph", content: [] }] };
const MEDIA = newStableId();

test("gallery/faq/cta/video register as first-party v1 types", () => {
  const registry = firstPartyRegistry();
  const listed = registry.listBlockTypeVersions().map((entry) => entry.typeId);
  for (const type of ["gallery", "faq", "cta", "video"]) {
    assert.ok(listed.includes(type), `${type} must be registered`);
  }
  assert.equal(listed.length, FIRST_PARTY_BLOCK_TYPES_V1.length);
});

test("multiple CTA blocks on one page are allowed (repeatable, not singleton)", () => {
  const registry = firstPartyRegistry();
  const action = { type: "internal_entry", entry_id: newStableId() };
  const document = {
    schema_version: 1,
    blocks: [
      block("cta", {
        title: "Заказать аудит",
        text: RICH,
        primary_action: action,
        secondary_action: { type: "phone", phone: "+7 495 000-00-00" },
        media_id: MEDIA,
        variant: "accent",
        tracking_key: "cta_audit",
      }),
      block("cta", { title: "Смотреть кейсы", primary_action: action }),
      block("cta", {
        title: "Написать нам",
        primary_action: { type: "email", email: "hi@example.com" },
      }),
    ],
  };
  const result = validateBlockDocument(document, registry);
  assert.equal(result.ok, true, JSON.stringify(issuesOf(result)));
});

test("action payloads are type-checked: missing payload and unknown payload keys rejected", () => {
  const registry = firstPartyRegistry();
  const missingPayload = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [block("cta", { title: "x", primary_action: { type: "internal_entry" } })],
    },
    registry,
  );
  assert.ok(issuesOf(missingPayload).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));

  const badUrl = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [
        block("cta", {
          title: "x",
          primary_action: { type: "external_url", url: "javascript:alert(1)" },
        }),
      ],
    },
    registry,
  );
  assert.ok(issuesOf(badUrl).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));
});

test("faq items carry stable ids, questions and rich answers", () => {
  const registry = firstPartyRegistry();
  const document = {
    schema_version: 1,
    blocks: [
      block("faq", {
        items: [
          { id: newStableId(), question: "Сколько длится аудит?", answer: RICH },
          { id: newStableId(), question: "Что входит?", answer: RICH },
        ],
      }),
    ],
  };
  assert.equal(validateBlockDocument(document, registry).ok, true);
  const noId = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [block("faq", { items: [{ question: "x", answer: RICH }] })],
    },
    registry,
  );
  assert.ok(issuesOf(noId).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));
});

test("gallery items reference media by stable ID with per-item identity", () => {
  const registry = firstPartyRegistry();
  const document = {
    schema_version: 1,
    blocks: [
      block("gallery", {
        items: [
          { id: newStableId(), media_id: MEDIA, alt_override: "Кадр 1" },
          { id: newStableId(), media_id: newStableId(), caption: "Кадр 2" },
        ],
        layout_hint: "grid",
        lightbox_enabled: true,
      }),
    ],
  };
  assert.equal(validateBlockDocument(document, registry).ok, true);
});

test("video: standard providers take ids, never iframe HTML; custom takes https URL", () => {
  const registry = firstPartyRegistry();
  const safe = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [
        block("video", {
          provider: "youtube",
          video_id: "dQw4w9WgXcQ",
          title: "Презентация",
          poster_media_id: MEDIA,
          start_at: 30,
          privacy_mode: true,
          aspect_ratio: "16:9",
        }),
        block("video", { provider: "vkvideo", video_id: "-12345_456239017" }),
        block("video", { provider: "rutube", video_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" }),
        block("video", { provider: "custom", url: "https://video.example.com/embed/abc" }),
      ],
    },
    registry,
  );
  assert.equal(safe.ok, true, JSON.stringify(issuesOf(safe)));

  // Custom provider with a non-https URL is rejected.
  const insecure = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [block("video", { provider: "custom", url: "http://video.example.com" })],
    },
    registry,
  );
  assert.ok(issuesOf(insecure).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));

  // Standard provider without video_id is rejected.
  const missing = validateBlockDocument(
    { schema_version: 1, blocks: [block("video", { provider: "youtube" })] },
    registry,
  );
  assert.ok(issuesOf(missing).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));

  // iframe HTML is not a storable prop at all — props schema rejects it.
  const iframeHtml = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [
        block("video", { provider: "youtube", video_id: "dQw4w9WgXcQ", embed_html: "<iframe..." }),
      ],
    },
    registry,
  );
  assert.ok(issuesOf(iframeHtml).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));
});
