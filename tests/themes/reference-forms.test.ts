// PCMS-FORM-T015 — reference theme renders form/quiz blocks from safe View
// Models (Forms spec §26): composition-provided URLs, no branching/scoring
// internals, graceful fallback when a definition is unavailable.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  type BlockNodeViewModel,
  createBlockRendererRegistry,
  createRenderService,
  validateThemeManifest,
} from "@pcms/themes";

const THEME_DIR = "themes/reference-theme-v1";

function readSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else snapshot[`${prefix}${entry.name}`] = readFileSync(full, "utf8");
    }
  };
  for (const dir of ["templates", "components", "blocks"]) {
    walk(join(THEME_DIR, dir), `${dir}/`);
  }
  return snapshot;
}

async function referenceRegistry() {
  const manifestResult = validateThemeManifest(
    JSON.parse(readFileSync(join(THEME_DIR, "theme.json"), "utf8")),
  );
  assert.ok(manifestResult.ok);
  if (!manifestResult.ok) throw new Error("manifest");
  const service = createRenderService({ manifest: manifestResult.value, snapshot: readSnapshot() });
  return createBlockRendererRegistry(manifestResult.value, service);
}

function block(type: string, props: Record<string, unknown>): BlockNodeViewModel {
  return { id: `b-${type}`, type, schemaVersion: 1, variant: null, props, children: [] };
}

const FORM_VM = {
  form_definition_id: "01970000-0000-7000-8000-0000000000f1",
  form_schema_version: 1,
  title: "Связаться с нами",
  fields: [
    { key: "name", type: "text", label: "Имя", required: true, max_length: 200 },
    { key: "email", type: "email", label: "E-mail", required: true },
    {
      key: "service",
      type: "select",
      label: "Услуга",
      required: true,
      options: [
        { value: "clean", label: "Уборка" },
        { value: "fix", label: "Ремонт" },
      ],
    },
    {
      key: "privacy_ok",
      type: "consent",
      label: "Согласие",
      required: true,
    },
    { key: "campaign", type: "hidden_controlled", label: "", required: false, value: "landing-42" },
  ],
  submission_url: "/api/v1/public/forms/01970000-0000-7000-8000-0000000000f1/submit",
  submit_label: "Submit",
  honeypot_field: "company_website",
} as const;

const QUIZ_VM = {
  quiz_definition_id: "01970000-0000-7000-8000-0000000000f2",
  quiz_schema_version: 1,
  title: "Подбор услуги",
  start_url: "/api/v1/public/quizzes/01970000-0000-7000-8000-0000000000f2/start",
  answer_url: "/api/v1/public/quizzes/runs/:run_id/answer",
  complete_url: "/api/v1/public/quizzes/runs/:run_id/complete",
  start_label: "Start quiz",
  step: {
    step_id: "intro",
    title: "Начало",
    questions: [
      {
        id: "service",
        type: "single_choice",
        label: "Что нужно?",
        required: true,
        options: [{ value: "cleaning", label: "Уборка" }],
      },
    ],
  },
} as const;

test("form block renders a safe form from the FormViewModel", async () => {
  const registry = await referenceRegistry();
  const html = (
    await registry.renderBlockDocument(
      [block("form", { form_definition_id: FORM_VM.form_definition_id })],
      {
        forms: { [FORM_VM.form_definition_id]: FORM_VM },
      },
    )
  ).html;
  assert.match(html, /<form[^>]*data-pcms-form/);
  assert.match(html, /action="\/api\/v1\/public\/forms\/[^"]+\/submit"/);
  assert.match(html, /type="email"/);
  assert.match(html, /<option value="clean">Уборка<\/option>/);
  assert.match(html, /type="checkbox" name="privacy_ok"/);
  assert.match(html, /type="hidden" name="campaign" value="landing-42"/);
  assert.match(html, /name="company_website"/, "honeypot rendered as hidden input");
  assert.ok(!html.includes("spam"), "no spam policy internals leak");
});

test("quiz block renders the server-driven step without scoring/branching internals", async () => {
  const registry = await referenceRegistry();
  const html = (
    await registry.renderBlockDocument(
      [block("quiz", { quiz_definition_id: QUIZ_VM.quiz_definition_id })],
      {
        quizzes: { [QUIZ_VM.quiz_definition_id]: QUIZ_VM },
      },
    )
  ).html;
  assert.match(html, /data-quiz-start="\/api\/v1\/public\/quizzes\/[^"]+\/start"/);
  assert.match(html, /data-quiz-answer=/);
  assert.match(html, /data-quiz-complete=/);
  assert.match(html, /Подбор услуги/);
  assert.match(html, /data-start-label="Start quiz"/);
  assert.ok(
    !html.includes("points") && !html.includes("goto"),
    "no scoring weights or branch targets",
  );
});

test("missing definition view model renders an explicit fallback, not arbitrary HTML", async () => {
  const registry = await referenceRegistry();
  const html = (
    await registry.renderBlockDocument(
      [
        block("form", { form_definition_id: "01970000-0000-7000-8000-0000000000f9" }),
        block("quiz", { quiz_definition_id: "01970000-0000-7000-8000-0000000000f9" }),
      ],
      { forms: {}, quizzes: {} },
    )
  ).html;
  assert.match(html, /block-form--unavailable/);
  assert.match(html, /block-quiz--unavailable/);
  assert.ok(!/<(script|iframe)/.test(html), "no script injection through missing VMs");
});
