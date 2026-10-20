// PCMS-SEO-T015 — VideoObject from Video Block/provider facts (spec §39).
// Only genuinely available metadata is emitted; nothing invented.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVideoNode, type VideoFacts, validateGraphNode } from "@pcms/seo";

const FULL: VideoFacts = {
  id: "https://example.ru/video/demo/#video",
  name: "Демо",
  description: "Обзор продукта",
  thumbnail_url: "https://example.ru/media/a/x/v1/social-abc.jpeg",
  upload_date: "2026-08-30T12:00:00+03:00",
  duration: "PT1M30S",
  embed_url: "https://www.youtube.com/embed/AbCd_123",
  content_url: "https://example.ru/media/video/demo.mp4",
};

test("video maps name/description/thumbnail/dates/duration/embed/content", () => {
  const node = buildVideoNode(FULL);
  assert.equal(node["@type"], "VideoObject");
  assert.equal(node.thumbnailUrl, FULL.thumbnail_url);
  assert.equal(node.uploadDate, FULL.upload_date);
  assert.equal(node.duration, "PT1M30S");
  assert.equal(node.embedUrl, FULL.embed_url);
  assert.equal(node.contentUrl, FULL.content_url);
  assert.deepEqual(validateGraphNode(node), []);
});

test("minimal provider facts produce a truthful minimal node — nothing invented", () => {
  const node = buildVideoNode({ id: FULL.id, name: "Демо" });
  assert.deepEqual(node, { "@type": "VideoObject", "@id": FULL.id, name: "Демо" });
});

test("unavailable dates/durations and unsafe urls are rejected (§39/§46)", () => {
  assert.throws(
    () => buildVideoNode({ ...FULL, upload_date: "August 2026" }),
    (err: Error) => err.message.includes("ISO 8601"),
  );
  assert.throws(
    () => buildVideoNode({ ...FULL, duration: "90 seconds" }),
    (err: Error) => err.message.includes("ISO 8601 duration"),
  );
  assert.throws(
    () => buildVideoNode({ ...FULL, embed_url: "javascript:alert(1)" }),
    (err: Error) => err.message.includes("absolute http(s) URL"),
  );
});
