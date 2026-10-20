// PCMS-SKILL-T013/T014 — scripted eval corpus runner (CI gate). Every
// scenario boots a dedicated disposable DB/site (§59), mints the scoped
// agent token from the scenario document, and runs the deterministic
// scripted driver over the public HTTP surface only (§60: the agent path
// never touches the DB; the harness uses fixtures for setup/verification).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  bindExternalIdentityOp,
  createDraft,
  type OperationContext,
  publishRevision,
  sealRevision,
  updateDraft,
} from "@pcms/api";
import { makeScriptedContentDriver } from "../../evals/agent-skills/driver-content.js";
import {
  makeScriptedThemeDriver,
  prewriteBrokenTheme,
} from "../../evals/agent-skills/driver-theme.js";
import {
  bootEvalFixture,
  type DriverContext,
  type EvalFixture,
  evaluate,
  loadScenarios,
  makeAgentHttp,
  type Scenario,
  testDatabaseConfigured,
} from "../../evals/agent-skills/harness.js";
import { apiContextOf, ownerActor } from "../helpers/api-composition.js";

const OWNER = (): OperationContext => apiContextOf(ownerActor(), "rest", "req_eval_setup");
const CONTENT_DRIVER = makeScriptedContentDriver();
const THEME_DRIVER = makeScriptedThemeDriver();

async function createAndPublish(
  fixture: EvalFixture,
  contentType: string,
  title: string,
  expectedGeneration: number,
): Promise<{ entryId: string; revisionId: string }> {
  const draft = await createDraft(fixture.app, OWNER(), {
    content_type: contentType,
    payload: { fields: { title }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(fixture.app, OWNER(), { revision_id: draft.revision_id });
  await publishRevision(fixture.app, OWNER(), {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: expectedGeneration,
  });
  return { entryId: draft.entry_id, revisionId: draft.revision_id };
}

/** Harness-side setup (§60: fixtures are harness infrastructure). */
async function setupScenario(fixture: EvalFixture, scenario: Scenario): Promise<string[]> {
  const created: string[] = [];
  for (const step of (scenario.initial_state.setup ?? []) as Record<string, unknown>[]) {
    switch (step.op) {
      case "publish_entry": {
        const { entryId } = await createAndPublish(
          fixture,
          step.content_type as string,
          step.title as string,
          0,
        );
        if (typeof step.path === "string") {
          const site = await fixture.app.routes.ensureSite(fixture.app.defaultSiteKey);
          await fixture.app.routes.activateRoute({
            siteId: site.id,
            path: step.path,
            targetType: "entry",
            targetId: entryId,
          });
        }
        created.push(entryId);
        break;
      }
      case "human_publish_edit": {
        const entryId = ref(step.entry, created);
        assert.ok(entryId, "human_publish_edit needs $ref");
        const publication = (await fixture.app.publications.getPublication(
          fixture.app.pool,
          "entry",
          entryId as never,
        )) as { generation: number } | null;
        const draft = await (fixture.ownerHttp as NonNullable<EvalFixture["ownerHttp"]>).call(
          "POST",
          `/entries/${entryId}/draft`,
          {},
        );
        assert.equal(draft.status, 201, "human opens a working draft");
        const revisionId = (draft.body as { revision_id: string }).revision_id;
        await updateDraft(fixture.app, OWNER(), {
          revision_id: revisionId,
          payload: { fields: { title: step.title }, blocks: { schema_version: 1, blocks: [] } },
          expected_edit_generation: 0,
        });
        await sealRevision(fixture.app, OWNER(), { revision_id: revisionId });
        await publishRevision(fixture.app, OWNER(), {
          entity_type: "entry",
          entity_id: entryId,
          target_revision_id: revisionId,
          expected_generation: publication?.generation ?? 0,
        });
        break;
      }
      case "human_draft": {
        const entryId = ref(step.entry, created);
        assert.ok(entryId, "human_draft needs $ref");
        const draft = await (fixture.ownerHttp as NonNullable<EvalFixture["ownerHttp"]>).call(
          "POST",
          `/entries/${entryId}/draft`,
          {},
        );
        assert.equal(draft.status, 201, "human opens a working draft");
        break;
      }
      case "bind_identity": {
        const entryId =
          ref(step.entry, created) ??
          (await createAndPublish(fixture, "article", step.entry_title as string, 0)).entryId;
        await bindExternalIdentityOp(
          fixture.app,
          OWNER(),
          step.namespace as string,
          step.external_id as string,
          {
            entry_id: entryId,
            ...(step.baseline_generation === undefined
              ? {}
              : { last_agent_generation: step.baseline_generation as number }),
          },
        );
        break;
      }
      case "write_broken_theme":
        prewriteBrokenTheme(join("evals/agent-skills/.work", scenario.id));
        break;
      default:
        throw new Error(`unknown setup op ${String(step.op)}`);
    }
  }
  return created;
}

function ref(value: unknown, created: string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.startsWith("$") ? created[Number(value.slice(1))] : value;
}

/** Full-scope REST channel for HARNESS setup ops only (never the agent). */
async function mintOwnerHttp(fixture: EvalFixture): Promise<void> {
  if (fixture.ownerHttp !== undefined) return;
  type AgentHttp = ReturnType<typeof makeAgentHttp>;
  const scopes = [
    "content.read",
    "content.create",
    "content.edit",
    "revision.seal",
    "publication.plan",
    "publication.publish",
    "publication.read",
  ];
  const account = await fixture.app.machineIdentity.createServiceAccount({
    name: "eval-human-editor",
    purpose: "harness setup (human editor simulation)",
    allowedScopes: scopes,
  });
  const token = await fixture.app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes,
    ttlMilliseconds: 3_600_000,
  });
  const ownerHttp: AgentHttp = makeAgentHttp(fixture.fastify, token.rawSecret, {
    calls: [],
    writes: [],
    violations: [],
  });
  fixture.ownerHttp = ownerHttp;
}

async function mintToken(fixture: EvalFixture, scenario: Scenario): Promise<string> {
  const account = await fixture.app.machineIdentity.createServiceAccount({
    name: `eval-${scenario.id}`,
    purpose: scenario.description.slice(0, 100),
    allowedScopes: scenario.actor_scopes,
  });
  const token = await fixture.app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: scenario.actor_scopes,
    ttlMilliseconds: 3_600_000,
  });
  return token.rawSecret;
}

for (const scenario of [...loadScenarios("content"), ...loadScenarios("theme")]) {
  test(`eval ${scenario.id}: ${scenario.description}`, async (t) => {
    if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
    const fixture = await bootEvalFixture(t, {
      ...(scenario.initial_state.preview_unavailable === true ? { previewSecret: null } : {}),
    });
    await mintOwnerHttp(fixture);
    const created = await setupScenario(fixture, scenario);
    const token = await mintToken(fixture, scenario);
    if (typeof scenario.task_input.entry_ref === "string") {
      scenario.task_input.entry_id = ref(scenario.task_input.entry_ref, created);
      delete scenario.task_input.entry_ref;
    }
    const sandboxRoot = join("evals/agent-skills/.work", scenario.id);
    mkdirSync(sandboxRoot, { recursive: true });
    const ctx: DriverContext = {
      http: makeAgentHttp(fixture.fastify, token, { calls: [], writes: [], violations: [] }),
      fixture,
      sandboxRoot,
    };

    const driver =
      scenario.skill === "progressive-cms-content-agent" ? CONTENT_DRIVER : THEME_DRIVER;
    const result = await driver.run(scenario, ctx);
    const outcome = evaluate(scenario, result);
    assert.equal(
      outcome.ok,
      true,
      `failures: ${outcome.failures.join("; ")} / notes: ${result.notes.join("; ")}`,
    );

    if (scenario.expected.rerun !== undefined) {
      const rerun = await driver.run(scenario, ctx);
      for (const [kind, count] of Object.entries(scenario.expected.rerun.mutations)) {
        assert.equal(rerun.mutations[kind] ?? 0, count, `rerun mutation ${kind}`);
      }
    }

    // C10 harness-side verification: the human's published version survived.
    if (scenario.id === "C10") {
      const entryId = ref("$0", created);
      const rows = (await fixture.app.pool.query(
        `SELECT r.payload FROM publications p
           JOIN revisions r ON r.id = p.current_revision_id
          WHERE p.entity_id = $1`,
        [entryId],
      )) as { rows: { payload?: { fields?: { title?: string } } }[] };
      assert.equal(rows.rows[0]?.payload?.fields?.title, "Human version");
    }
  });
}
