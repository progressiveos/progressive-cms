// PCMS-NAV-T010 — slug normalization policies (Navigation spec §27/§28).
// Acceptance: Cyrillic/transliteration fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeSlug,
  SlugInvalidError,
  type SlugPolicy,
  slugSegmentsToPath,
} from "@pcms/routing";

const TRANSLIT: SlugPolicy = { cyrillic: "transliterate" };
const UNICODE: SlugPolicy = { cyrillic: "unicode-slug" };

test("latin baseline: lowercase, hyphen separated, collapsed separators", () => {
  assert.equal(normalizeSlug("Plant Modernization", TRANSLIT), "plant-modernization");
  assert.equal(normalizeSlug("  About_Us  ", TRANSLIT), "about-us");
  assert.equal(normalizeSlug("A--B___c", TRANSLIT), "a-b-c");
  assert.equal(normalizeSlug("Price/100%!", TRANSLIT), "price100");
});

test("cyrillic transliterate policy maps to ASCII (fixtures)", () => {
  assert.equal(normalizeSlug("Привет мир", TRANSLIT), "privet-mir");
  assert.equal(normalizeSlug("О компании", TRANSLIT), "o-kompanii");
  assert.equal(normalizeSlug("Услуги — Аудит и консалтинг", TRANSLIT), "uslugi-audit-i-konsalting");
  assert.equal(normalizeSlug("Ёлка, Жёлудь и Щука", TRANSLIT), "yolka-zhyolud-i-shchuka");
});

test("cyrillic unicode-slug policy keeps Unicode letters (fixtures)", () => {
  assert.equal(normalizeSlug("Привет мир", UNICODE), "привет-мир");
  assert.equal(normalizeSlug("О компании", UNICODE), "о-компании");
  assert.equal(normalizeSlug("Услуги: аудит", UNICODE), "услуги-аудит");
});

test("same hint, different policies — neither is hard-coded", () => {
  const hint = "Модернизация завода";
  const translit = normalizeSlug(hint, TRANSLIT);
  const unicode = normalizeSlug(hint, UNICODE);
  assert.equal(translit, "modernizatsiya-zavoda");
  assert.equal(unicode, "модернизация-завода");
  assert.notEqual(translit, unicode);
});

test("unicode normalization folds compatibility forms", () => {
  // Full-width and compatibility forms fold via NFKD.
  assert.equal(normalizeSlug("Ｐｌａｎｔ ４", TRANSLIT), "plant-4");
  // Combining marks are stripped (é as e + combining acute).
  assert.equal(normalizeSlug("café", TRANSLIT), "cafe");
});

test("path-unsafe characters never survive", () => {
  assert.equal(normalizeSlug("../../etc", TRANSLIT), "etc");
  assert.equal(normalizeSlug("a%2Fb?x=1#c", TRANSLIT), "a2fbx1c");
  assert.equal(normalizeSlug("a\\b:c*d", TRANSLIT), "abcd");
});

test("slugs are bounded and never empty", () => {
  assert.throws(() => normalizeSlug("", TRANSLIT), SlugInvalidError);
  assert.throws(() => normalizeSlug("///", TRANSLIT), SlugInvalidError);
  assert.throws(() => normalizeSlug("🙂🙂", TRANSLIT), SlugInvalidError);
  const long = normalizeSlug("a".repeat(400), TRANSLIT);
  assert.equal(long.length, 128);
});

test("slug segments compose canonical trailing-slash paths", () => {
  assert.equal(slugSegmentsToPath(["Услуги", "Аудит"], TRANSLIT), "/uslugi/audit/");
  assert.equal(
    slugSegmentsToPath(["cases", "plant-modernization"], TRANSLIT),
    "/cases/plant-modernization/",
  );
  assert.equal(slugSegmentsToPath(["О нас"], UNICODE), "/о-нас/");
  assert.throws(() => slugSegmentsToPath([], TRANSLIT), SlugInvalidError);
});
