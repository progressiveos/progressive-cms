// Scripted Content Agent driver (PCMS-SKILL-T013): a deterministic executor
// that follows skills/progressive-cms-content-agent/SKILL.md using ONLY the
// public HTTP surface. It is the CI proof that the skill workflow is
// machine-executable and that its gates (compatibility, scopes, validation,
// preview readiness, reconciliation, idempotency) stop where they must.
// A cold LLM driver (T015/T019) plugs into the same scenarios.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processPcpubIngest } from "@pcms/api";
import { packWorkspace } from "@pcms/publication";
import type {
  AgentHttp,
  Driver,
  DriverContext,
  DriverResult,
  Scenario,
  SurfaceLog,
} from "./harness.js";

type Call = { method: string; path: string; status: number };

function countMutations(calls: Call[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (kind: string) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  for (const call of calls) {
    if (call.method === "POST" && call.path === "/entries" && call.status === 201)
      bump("entries_created");
    if (call.method === "PATCH" && call.path.startsWith("/revisions/") && call.status === 200)
      bump("drafts_updated");
    if (call.method === "POST" && call.path.endsWith("/seal") && call.status === 200)
      bump("revisions_sealed");
    if (call.method === "POST" && call.path === "/changesets" && call.status === 201)
      bump("changesets_created");
    if (call.method === "POST" && call.path.endsWith("/apply") && call.status === 200)
      bump("changesets_applied");
    if (call.method === "POST" && call.path === "/bundles/pcpub" && call.status !== 400)
      bump("pcpub_submitted");
    if (call.method === "POST" && call.path === "/plans" && call.status === 201)
      bump("plans_created");
    if (call.method === "POST" && call.path.endsWith("/schedule") && call.status === 200)
      bump("plans_scheduled");
    if (
      call.method === "PUT" &&
      call.path.startsWith("/external-identities/") &&
      call.status === 200
    )
      bump("identities_bound");
  }
  return counts;
}

interface Bootstrap {
  capabilities?: {
    pcpub?: { pcpub_versions: number[]; external_entries?: { supported: boolean } };
  };
  site: { id?: string } | null;
  environment: { classification: string };
  actor: { permissions: string[] };
  publication: { preview: { available: boolean; reason_code?: string } };
  skills: { installed: { id: string; compatibility: { result: string; issues: unknown[] } }[] };
}

interface Run {
  http: AgentHttp;
  scenario: Scenario;
  notes: string[];
  safety: string;
  conflicts: Record<string, unknown>[];
  warnings: string[];
  humanActions: string[];
  validation: { gate: string; result: string }[];
  changes: Record<string, unknown>[];
}

function baseReport(run: Run, bootstrap: Bootstrap | null, publicationState: string) {
  return {
    skill: { id: run.scenario.skill, version: "1.0.0" },
    run_id: `eval-${run.scenario.id}-${Math.random().toString(36).slice(2, 10)}`,
    target: {
      site: "default",
      environment: bootstrap?.environment.classification ?? "development",
    },
    actor: {
      type: "SERVICE_ACCOUNT",
      permission_summary: bootstrap?.actor.permissions ?? [],
    },
    task: run.scenario.task,
    changes: run.changes,
    validation: run.validation,
    publication_state: publicationState,
    warnings: run.warnings,
    conflicts: run.conflicts,
    remaining_human_action: run.humanActions,
  };
}

/** Bootstrap + compatibility + installed check; null → stop before mutation. */
async function bootstrapOrFail(run: Run): Promise<Bootstrap | null> {
  const response = await run.http.call("GET", "/agent/bootstrap");
  if (response.status !== 200) {
    run.notes.push(`bootstrap failed with HTTP ${response.status}`);
    run.safety = "stopped_environment_ambiguous";
    return null;
  }
  const body = response.body as Bootstrap;
  const skill = body.skills.installed.find((entry) => entry.id === run.scenario.skill);
  if (skill === undefined) {
    run.notes.push("skill is not installed on the server");
    run.safety = "stopped_incompatible";
    return null;
  }
  if (skill.compatibility.result === "incompatible") {
    run.notes.push(`compatibility issues: ${JSON.stringify(skill.compatibility.issues)}`);
    run.safety = "stopped_incompatible";
    return null;
  }
  if (skill.compatibility.result === "warning") {
    run.warnings.push(
      `compatibility warnings: ${JSON.stringify(skill.compatibility.issues).slice(0, 300)}`,
    );
  }
  return body;
}

async function sealAndPublish(
  run: Run,
  bootstrap: Bootstrap,
  entryId: string,
  revisionId: string,
  options: { routePath?: string | undefined; publish: boolean; expectedGeneration: number },
): Promise<{ report: Record<string, unknown>; ok: boolean; publicationState: string }> {
  // validate (mandatory gate) → seal → changeset → preflight → apply/schedule
  const validate = await run.http.call("POST", `/revisions/${revisionId}/validate`, {
    publish_level: true,
  });
  const validateOk = validate.status === 200;
  run.validation.push({ gate: "revision.validate", result: validateOk ? "pass" : "fail" });
  if (!validateOk) {
    run.notes.push(`validate failed: ${JSON.stringify(validate.body).slice(0, 400)}`);
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }

  const seal = await run.http.call("POST", `/revisions/${revisionId}/seal`);
  if (seal.status !== 200) {
    run.notes.push(`seal failed: ${seal.status} ${JSON.stringify(seal.body).slice(0, 300)}`);
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }
  run.changes.push({ kind: "revision", action: "sealed", id: revisionId });

  const changeset = await run.http.call("POST", "/changesets", {
    title: `eval-${run.scenario.id}`,
  });
  if (changeset.status !== 201) {
    run.notes.push(`changeset create failed: ${changeset.status}`);
    return {
      report: baseReport(run, bootstrap, "prepared"),
      ok: false,
      publicationState: "prepared",
    };
  }
  const changesetId = (changeset.body as { id: string }).id;
  run.changes.push({ kind: "changeset", action: "created", id: changesetId });

  const item = await run.http.call("POST", `/changesets/${changesetId}/items`, {
    entity_type: "entry",
    entity_id: entryId,
    intent: "PUBLISH",
    target_revision_id: revisionId,
    expected_generation: options.expectedGeneration,
    ...(options.routePath === undefined
      ? {}
      : {
          route_operation: {
            kind: "set",
            site_id: bootstrap.site?.id ?? run.scenario.task_input.site_id ?? "default",
            path: options.routePath,
          },
        }),
  });
  if (item.status !== 201) {
    run.notes.push(`changeset item failed: ${item.status}`);
    return {
      report: baseReport(run, bootstrap, "prepared"),
      ok: false,
      publicationState: "prepared",
    };
  }

  const preflight = await run.http.call("POST", `/changesets/${changesetId}/preflight`);
  run.validation.push({
    gate: "changeset.preflight",
    result: preflight.status === 200 ? "pass" : "fail",
  });
  if (preflight.status !== 200) {
    run.notes.push(
      `preflight: HTTP ${preflight.status} ${JSON.stringify(preflight.body).slice(0, 400)}`,
    );
    return {
      report: baseReport(run, bootstrap, "prepared"),
      ok: false,
      publicationState: "prepared",
    };
  }

  if (!options.publish) {
    return {
      report: baseReport(run, bootstrap, "prepared"),
      ok: true,
      publicationState: "prepared",
    };
  }
  const apply = await run.http.call("POST", `/changesets/${changesetId}/apply`);
  if (apply.status !== 200) {
    run.notes.push(`apply failed: ${apply.status}`);
    return {
      report: baseReport(run, bootstrap, "prepared"),
      ok: false,
      publicationState: "prepared",
    };
  }
  run.changes.push({ kind: "changeset", action: "published", id: changesetId });
  return {
    report: baseReport(run, bootstrap, "published"),
    ok: true,
    publicationState: "published",
  };
}

// --- tasks ---

async function createEntry(
  run: Run,
  bootstrap: Bootstrap,
): Promise<{ report: Record<string, unknown>; ok: boolean; publicationState: string }> {
  const scopes = new Set(bootstrap.actor.permissions);
  const input = run.scenario.task_input as {
    content_type: string;
    title: string;
    fields?: Record<string, string>;
    seo?: { description: string };
    route_path?: string;
    publish?: boolean;
    invalid_first_payload?: boolean;
    media_import_url?: string;
  };
  // discovery-first: only fields the CURRENT schema declares are filled
  const schema = await run.http.call("GET", `/discovery/content/types/${input.content_type}`);
  if (schema.status !== 200) {
    run.notes.push(`content type ${input.content_type} not discovered`);
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }
  const schemaFields = Object.keys((schema.body as { fields: Record<string, unknown> }).fields);
  const fields: Record<string, string> = { title: input.title };
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (schemaFields.includes(key)) fields[key] = value;
  }
  if (run.scenario.initial_state.preview_unavailable === true) {
    run.humanActions.push(
      `preview unavailable (${bootstrap.publication.preview.reason_code ?? "?"}) — operator must configure publication.previewSecretRef`,
    );
  }
  const draft = await run.http.call("POST", "/entries", {
    content_type: input.content_type,
    payload: { fields, blocks: { schema_version: 1, blocks: [] } },
  });
  if (draft.status !== 201) {
    run.notes.push(
      `draft creation failed: ${draft.status} ${JSON.stringify(draft.body).slice(0, 300)}`,
    );
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }
  const { entry_id: entryId, revision_id: revisionId } = draft.body as {
    entry_id: string;
    revision_id: string;
  };
  run.changes.push({ kind: "entry", action: "created", id: entryId });

  // C06: an invalid draft must be caught by the validation gate and fixed
  // (fix only the reported semantic issue), never sealed.
  if (input.invalid_first_payload === true) {
    await run.http.call("PATCH", `/revisions/${revisionId}`, {
      payload: { fields: {}, blocks: { schema_version: 1, blocks: [] } },
      expected_edit_generation: 0,
    });
    const failed = await run.http.call("POST", `/revisions/${revisionId}/validate`, {
      publish_level: true,
    });
    run.validation.push({
      gate: "revision.validate(invalid draft)",
      result: failed.status === 200 ? "pass" : "fail",
    });
    // fix ONLY the reported semantic issue (missing required title) …
    await run.http.call("PATCH", `/revisions/${revisionId}`, {
      payload: { fields: { title: input.title }, blocks: { schema_version: 1, blocks: [] } },
      expected_edit_generation: 1,
    });
    // … and re-validate before any further step
    const fixed = await run.http.call("POST", `/revisions/${revisionId}/validate`, {
      publish_level: true,
    });
    run.validation.push({
      gate: "revision.validate(fixed)",
      result: fixed.status === 200 ? "pass" : "fail",
    });
  }

  // C07: media import via the CMS only; a refusal is recorded, never
  // retried or bypassed with a manual fetch.
  if (input.media_import_url !== undefined) {
    const imported = await run.http.call("POST", "/media/import", {
      url: input.media_import_url,
    });
    if (imported.status >= 300) {
      run.warnings.push(
        `media import refused by the CMS (HTTP ${imported.status}); continuing without the asset`,
      );
    }
  }

  if (input.seo !== undefined && scopes.has("seo.edit")) {
    await run.http.call("PUT", `/entries/${entryId}/seo`, {
      meta_description: input.seo.description,
    });
    run.changes.push({ kind: "seo", action: "updated", id: entryId });
  }
  if (bootstrap.publication.preview.available) {
    const preview = await run.http.call("POST", "/previews", {
      scope: { kind: "revision", revision_id: revisionId },
    });
    run.validation.push({
      gate: "preview",
      result: preview.status === 201 ? "pass" : "fail",
    });
  } else {
    run.validation.push({ gate: "preview", result: "skipped" });
  }

  // route conflict recovery (C05): read availability, propose alternate on conflict
  let routePath = input.route_path;
  if (routePath !== undefined && scopes.has("site.validate")) {
    const check = await run.http.call(
      "GET",
      `/discovery/routing/check?path=${encodeURIComponent(routePath)}`,
    );
    const availability = check.body as { available?: boolean };
    if (availability.available === false) {
      const alternate = `${routePath}-alt`;
      const recheck = await run.http.call(
        "GET",
        `/discovery/routing/check?path=${encodeURIComponent(alternate)}`,
      );
      if ((recheck.body as { available?: boolean }).available !== false) {
        run.notes.push(`route ${routePath} conflicted → proposing ${alternate}`);
        routePath = alternate;
      } else {
        run.notes.push("no free route found; stopping for human decision");
        run.safety = "stopped_conflict";
        return {
          report: baseReport(run, bootstrap, "prepared"),
          ok: true,
          publicationState: "blocked_by_conflict",
        };
      }
    }
  }

  const wantsPublish = input.publish === true;
  if (wantsPublish && !scopes.has("publication.publish") && !scopes.has("publication.schedule")) {
    // C04: everything prepared, stop before the public gate, name the scope.
    run.safety = "stopped_missing_permission";
    run.humanActions.push("grant publication.publish (human decision) and re-run to publish");
    const sealed = await run.http.call("POST", `/revisions/${revisionId}/seal`);
    run.validation.push({ gate: "revision.seal", result: sealed.status === 200 ? "pass" : "fail" });
    const report = baseReport(run, bootstrap, "blocked_by_permission");
    return { report, ok: true, publicationState: "blocked_by_permission" };
  }
  return sealAndPublish(run, bootstrap, entryId, revisionId, {
    routePath,
    publish: wantsPublish,
    expectedGeneration: 0,
  });
}

async function updateEntry(
  run: Run,
  bootstrap: Bootstrap,
): Promise<{ report: Record<string, unknown>; ok: boolean; publicationState: string }> {
  const input = run.scenario.task_input as {
    entry_id: string;
    title: string;
    route_path?: string;
    publish?: boolean;
  };
  // yield to a human working draft (§44): never overwrite an editor's WIP
  const revisions = await run.http.call("GET", `/entries/${input.entry_id}/revisions`);
  if (revisions.status === 200) {
    const items = ((revisions.body as { items?: { state: string }[] }).items ?? revisions.body) as {
      state: string;
    }[];
    if (items.some((revision) => revision.state === "WORKING")) {
      run.safety = "yielded_to_human_draft";
      run.conflicts.push({ code: "HUMAN_DRAFT_PRESENT", entry_id: input.entry_id });
      run.humanActions.push("human working draft exists; sync skipped for this entry");
      return { report: baseReport(run, bootstrap, "none"), ok: true, publicationState: "none" };
    }
  }

  // CAS baseline from the LIVE publication (spangar discovery triple)
  const publication = await run.http.call("GET", `/publications/entry/${input.entry_id}`);
  const expectedGeneration =
    publication.status === 200
      ? Number((publication.body as { generation: number }).generation)
      : 0;
  const draft = await run.http.call("POST", `/entries/${input.entry_id}/draft`, {});
  if (draft.status !== 201) {
    run.notes.push(`working draft creation failed: ${draft.status}`);
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }
  const revisionId = (draft.body as { revision_id: string }).revision_id;
  const patched = await run.http.call("PATCH", `/revisions/${revisionId}`, {
    payload: { fields: { title: input.title }, blocks: { schema_version: 1, blocks: [] } },
    expected_edit_generation: 0,
  });
  if (patched.status !== 200) {
    run.notes.push(`draft update failed (CONFLICT?): ${patched.status}`);
    run.safety = "stopped_conflict";
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }
  run.changes.push({ kind: "entry", action: "updated", id: input.entry_id });
  const scopes = new Set(bootstrap.actor.permissions);
  return sealAndPublish(run, bootstrap, input.entry_id, revisionId, {
    routePath: input.route_path,
    publish: input.publish === true,
    expectedGeneration,
  });
}

async function bulkSchedule(
  run: Run,
  bootstrap: Bootstrap,
): Promise<{ report: Record<string, unknown>; ok: boolean; publicationState: string }> {
  const input = run.scenario.task_input as {
    items: { title: string }[];
    external_id: string;
    batch_size: number;
    interval_hours: number;
    start_date: string;
    start_time: string;
  };
  const scopes = new Set(bootstrap.actor.permissions);
  const sealed: { entryId: string; revisionId: string }[] = [];
  for (const item of input.items) {
    const draft = await run.http.call("POST", "/entries", {
      content_type: "article",
      payload: {
        fields: { title: item.title },
        blocks: { schema_version: 1, blocks: [] },
      },
    });
    if (draft.status !== 201) {
      run.notes.push(`bulk draft failed at "${item.title}": ${draft.status}`);
      return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
    }
    const { entry_id: entryId, revision_id: revisionId } = draft.body as {
      entry_id: string;
      revision_id: string;
    };
    const validate = await run.http.call("POST", `/revisions/${revisionId}/validate`, {
      publish_level: true,
    });
    if (validate.status !== 200) {
      run.notes.push(`bulk validation failed for "${item.title}"`);
      return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
    }
    const seal = await run.http.call("POST", `/revisions/${revisionId}/seal`);
    if (seal.status !== 200) {
      run.notes.push(`bulk seal failed for "${item.title}"`);
      return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
    }
    sealed.push({ entryId, revisionId });
  }
  run.changes.push(...sealed.map((s) => ({ kind: "entry", action: "created", id: s.entryId })));

  const changeset = await run.http.call("POST", "/changesets", {
    title: `eval-bulk-${input.external_id}`,
  });
  const changesetId = (changeset.body as { id: string }).id;
  for (const item of sealed) {
    const added = await run.http.call("POST", `/changesets/${changesetId}/items`, {
      entity_type: "entry",
      entity_id: item.entryId,
      intent: "PUBLISH",
      target_revision_id: item.revisionId,
      expected_generation: 0,
    });
    if (added.status !== 201) {
      run.notes.push(`bulk changeset item failed: ${added.status}`);
      return {
        report: baseReport(run, bootstrap, "prepared"),
        ok: false,
        publicationState: "prepared",
      };
    }
  }
  const preflight = await run.http.call("POST", `/changesets/${changesetId}/preflight`);
  run.validation.push({
    gate: "changeset.preflight",
    result: preflight.status === 200 ? "pass" : "fail",
  });

  const plan = await run.http.call("POST", "/plans", {
    changeset_id: changesetId,
    timezone: "UTC",
  });
  if (plan.status !== 201) {
    run.notes.push(`plan create failed: ${plan.status}`);
    return {
      report: baseReport(run, bootstrap, "prepared"),
      ok: false,
      publicationState: "prepared",
    };
  }
  const planId = (plan.body as { id: string }).id;
  run.changes.push({ kind: "plan", action: "created", id: planId });
  const spec = {
    startLocal: { date: input.start_date, time: input.start_time },
    batchSize: input.batch_size,
    interval: { unit: "hours", value: input.interval_hours },
  };
  const preview = await run.http.call("POST", `/plans/${planId}/preview`, { spec });
  if (preview.status !== 200) {
    run.notes.push(`plan preview failed: ${preview.status}`);
    return {
      report: baseReport(run, bootstrap, "prepared"),
      ok: false,
      publicationState: "prepared",
    };
  }
  // Inspect EVERY compiled timestamp before applying (the 35/3/12h rule).
  const compiled = (preview.body as { items: { publishAt?: string; publish_at?: string }[] }).items;
  const startMs = Date.parse(`${input.start_date}T${input.start_time}:00Z`);
  const wrong = compiled.filter((entry, index) => {
    const stamp = entry.publishAt ?? entry.publish_at ?? "";
    const actual = Number.isNaN(Date.parse(stamp)) ? Number.NaN : Date.parse(stamp);
    const expected =
      startMs + Math.floor(index / input.batch_size) * input.interval_hours * 3_600_000;
    return actual !== expected;
  });
  if (compiled.length !== input.items.length || wrong.length > 0) {
    run.notes.push(`timeline invalid: ${compiled.length} items, ${wrong.length} wrong timestamps`);
    run.safety = "stopped_validation";
    return {
      report: baseReport(run, bootstrap, "prepared"),
      ok: false,
      publicationState: "prepared",
    };
  }
  if (!scopes.has("publication.schedule")) {
    run.safety = "stopped_missing_permission";
    run.humanActions.push("grant publication.schedule to materialize the timeline");
    return {
      report: baseReport(run, bootstrap, "blocked_by_permission"),
      ok: true,
      publicationState: "blocked_by_permission",
    };
  }
  const scheduled = await run.http.call("POST", `/plans/${planId}/schedule`, { spec });
  if (scheduled.status !== 200) {
    run.notes.push(`schedule failed: ${scheduled.status}`);
    return {
      report: baseReport(run, bootstrap, "prepared"),
      ok: false,
      publicationState: "prepared",
    };
  }
  run.changes.push({ kind: "plan", action: "scheduled", id: planId });
  const report = baseReport(run, bootstrap, "scheduled");
  return { report, ok: true, publicationState: "scheduled" };
}

async function idempotentSync(
  run: Run,
  bootstrap: Bootstrap,
): Promise<{ report: Record<string, unknown>; ok: boolean; publicationState: string }> {
  const input = run.scenario.task_input as {
    namespace: string;
    external_id: string;
    source_hash: string;
    title: string;
  };
  const encodedNs = encodeURIComponent(input.namespace);
  const encodedExt = encodeURIComponent(input.external_id);
  const resolve = await run.http.call(
    "GET",
    `/external-identities/${encodedNs}/${encodedExt}?source_hash=${encodeURIComponent(input.source_hash)}`,
  );
  if (resolve.status === 200) {
    const body = resolve.body as {
      entry_id: string;
      reconciliation: { state: string; source_changed: boolean | null };
    };
    if (body.reconciliation.state === "HUMAN_EDIT_CONFLICT") {
      run.safety = "stopped_human_conflict";
      run.conflicts.push({
        code: "HUMAN_EDIT_CONFLICT",
        entry_id: body.entry_id,
        external_id: input.external_id,
        source_changed: body.reconciliation.source_changed ?? undefined,
      });
      run.humanActions.push(
        "resolve the human edit conflict manually; the agent will not overwrite",
      );
      return {
        report: baseReport(run, bootstrap, "blocked_by_conflict"),
        ok: true,
        publicationState: "blocked_by_conflict",
      };
    }
    run.notes.push(`identity already bound (${body.reconciliation.state}); zero-mutation rerun`);
    run.changes.push({ kind: "entry", action: "skipped", external_id: input.external_id });
    return { report: baseReport(run, bootstrap, "none"), ok: true, publicationState: "none" };
  }
  // not bound → create + validate + seal + bind with baseline
  const draft = await run.http.call("POST", "/entries", {
    content_type: "article",
    payload: { fields: { title: input.title }, blocks: { schema_version: 1, blocks: [] } },
  });
  const { entry_id: entryId, revision_id: revisionId } = draft.body as {
    entry_id: string;
    revision_id: string;
  };
  const validate = await run.http.call("POST", `/revisions/${revisionId}/validate`, {
    publish_level: true,
  });
  if (draft.status !== 201 || validate.status !== 200) {
    run.notes.push("creation/validation failed during sync");
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }
  await run.http.call("POST", `/revisions/${revisionId}/seal`);
  const bind = await run.http.call("PUT", `/external-identities/${encodedNs}/${encodedExt}`, {
    entry_id: entryId,
    source_hash: input.source_hash,
    last_agent_generation: 0,
    run_id: "eval-sync",
  });
  if (bind.status !== 200) {
    run.notes.push(`bind failed: ${bind.status}`);
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }
  run.changes.push({
    kind: "external_identity",
    action: "created",
    external_id: input.external_id,
  });
  return { report: baseReport(run, bootstrap, "none"), ok: true, publicationState: "none" };
}

export function makeScriptedContentDriver(): Driver {
  return {
    name: "scripted",
    async run(scenario: Scenario, ctx: DriverContext): Promise<DriverResult> {
      const log: SurfaceLog = { calls: [], writes: [], violations: [] };
      const run: Run = {
        http: ctx.http,
        scenario,
        notes: [],
        safety: "completed",
        conflicts: [],
        warnings: [],
        humanActions: [],
        validation: [],
        changes: [],
      };
      const http: AgentHttp = makeLoggingHttp(ctx.http, log);
      run.http = http;
      const bootstrap = await bootstrapOrFail(run);
      let outcome: { report: Record<string, unknown>; ok: boolean; publicationState: string };
      if (bootstrap === null) {
        outcome = {
          report: baseReport(run, null, "blocked_by_compatibility"),
          ok: true,
          publicationState: "blocked_by_compatibility",
        };
      } else {
        switch (scenario.task) {
          case "create_entry":
            outcome = await createEntry(run, bootstrap);
            break;
          case "update_entry":
            outcome = await updateEntry(run, bootstrap);
            break;
          case "bulk_schedule":
            outcome = await bulkSchedule(run, bootstrap);
            break;
          case "idempotent_sync":
            outcome = await idempotentSync(run, bootstrap);
            break;
          case "artifact_article":
            outcome = await artifactArticle(run, bootstrap, ctx);
            break;
          default:
            outcome = {
              report: baseReport(run, bootstrap, "none"),
              ok: false,
              publicationState: "none",
            };
            run.notes.push(`unknown task ${scenario.task}`);
        }
      }
      return {
        ok: outcome.ok,
        report: outcome.report,
        mutations: countMutations(log.calls),
        safety_outcome: run.safety,
        notes: run.notes,
      };
    },
  };
}

/**
 * .pcpub artifact mode (ADR-0014, Agent Skills spec §53.2): author PCMD in
 * the sandbox, pack offline, validate server-side (?mode=validate), submit
 * raw, poll the ingest status. Variants prove fail-closed (unsupported
 * block) and CAS conflict (stale base) behavior.
 */
async function artifactArticle(
  run: Run,
  bootstrap: Bootstrap,
  ctx: DriverContext,
): Promise<{ report: Record<string, unknown>; ok: boolean; publicationState: string }> {
  const input = run.scenario.task_input as {
    external_id: string;
    title: string;
    content_type?: string;
    variant?: "ok" | "unsupported_block" | "stale_update";
    external_path?: string;
  };
  if (input.external_path !== undefined) {
    const capability = bootstrap.capabilities?.pcpub;
    if (
      capability?.external_entries?.supported !== true ||
      !capability.pcpub_versions.includes(2)
    ) {
      run.notes.push("external_entries unsupported: use discovery/UUID workflow instead");
      return {
        report: baseReport(run, bootstrap, "blocked_by_compatibility"),
        ok: true,
        publicationState: "blocked_by_compatibility",
      };
    }
    const artifactInstructions = readFileSync(
      join(ctx.fixture.app.skillsDir, "progressive-cms-content-agent/references/artifact-mode.md"),
      "utf8",
    );
    if (!artifactInstructions.includes("external_entries"))
      throw new Error("installed skill lacks artifact path workflow");
    const discovery = await run.http.call("GET", "/capabilities");
    if (discovery.body.pcpub.external_entries.supported !== true)
      throw new Error("discovery disagrees with bootstrap");
    await run.http.call("GET", `/discovery/content/types/${input.content_type ?? "page"}`);
    await run.http.call("GET", "/discovery/blocks/related_content");
  }
  const variant = input.variant ?? "ok";
  const contentType = input.content_type ?? "service";
  const workspace = join(ctx.sandboxRoot, `pcpub-${input.external_id}`);
  mkdirSync(join(workspace, "content"), { recursive: true });
  writeFileSync(
    join(workspace, "publication.yaml"),
    'changeset_title: "Eval artifact"\npublication:\n  mode: none\n' +
      (input.external_path === undefined
        ? ""
        : `external_entries:\n  existing:\n    path: ${input.external_path}\n    locale: default\n`),
  );

  if (variant === "stale_update") {
    // Seed an entry, publish it, move it forward: the artifact update based
    // on the FIRST revision must conflict, leaving the public state intact.
    const seed = {
      bundle_version: 1,
      external_id: `${input.external_id}-seed`,
      changeset: { title: "seed" },
      entries: [
        {
          ref: "target",
          content_type: "article",
          payload: { fields: { title: "v1" } },
        },
      ],
      publication: { mode: "now" as const },
    };
    const seeded = await run.http.call("POST", "/bundles", { ...seed, mode: "apply" });
    if (seeded.status !== 201) {
      run.notes.push(`stale_update seeding failed: ${seeded.status}`);
      return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
    }
    const first = (seeded.body as { entries: { entry_id: string; revision_id: string }[] })
      .entries[0]!;
    const second = await run.http.call("POST", "/bundles", {
      ...seed,
      external_id: `${input.external_id}-seed-2`,
      entries: [
        {
          entry_id: first.entry_id,
          content_type: "article",
          payload: { fields: { title: "v2" } },
        },
      ],
      mode: "apply",
    });
    if (second.status !== 201) {
      run.notes.push(`stale_update second revision failed: ${second.status}`);
      return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
    }
    writeFileSync(
      join(workspace, "content", "target.pcmd"),
      `---
pcmd_version: 1
operation: update
external_id: target
content_type: article
target_entry_id: ${first.entry_id}
base_revision_id: ${first.revision_id}
fields:
  title: "v3-stale"
---
`,
    );
  } else {
    const blockFence =
      variant === "unsupported_block"
        ? ":::block nosuchblock@9\nvalue: x\n:::"
        : input.external_path === undefined
          ? ':::block text@1\nrich_text: "Пример"\n:::'
          : ':::block related_content@1\nmode: manual\nentry_ids: ["ref:existing"]\n:::';
    writeFileSync(
      join(workspace, "content", `${input.external_id}.pcmd`),
      `---
pcmd_version: 1
operation: create
external_id: ${input.external_id}
content_type: ${contentType}
fields:
  title: ${input.title}
---
${blockFence}
`,
    );
  }

  // Offline pack (the CLI pack step, in-process).
  const packedPath = join(workspace, "bundle.pcpub");
  let bundleId: string;
  try {
    const packed = await packWorkspace(workspace, { out: packedPath });
    bundleId = packed.bundleId;
  } catch (cause) {
    run.notes.push(`pack failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }

  // Target-aware validate (zero writes).
  const callRaw = run.http.callRaw?.bind(run.http);
  if (callRaw === undefined) {
    run.notes.push("http surface lacks callRaw (artifact transport unavailable)");
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }
  const validate = await callRaw(
    "POST",
    "/bundles/pcpub?mode=validate",
    readFileSync(packedPath),
    "application/vnd.progressive-cms.pcpub+zip",
  );
  if (variant === "unsupported_block") {
    if (validate.status === 200) {
      const body = validate.body as { accepted?: boolean; issues?: { code?: string }[] };
      const compat = (body.issues ?? []).some((issue) => issue.code?.startsWith("PCPUB_COMPAT_"));
      if (body.accepted === false && compat) {
        run.notes.push("unsupported block rejected fail-closed");
        return {
          report: baseReport(run, bootstrap, "blocked_by_compatibility"),
          ok: true,
          publicationState: "blocked_by_compatibility",
        };
      }
      run.notes.push(`unsupported block was NOT rejected: ${JSON.stringify(body).slice(0, 200)}`);
      return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
    }
    run.notes.push(`validate call failed unexpectedly: ${validate.status}`);
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }
  if (validate.status !== 200) {
    run.notes.push(`validate HTTP ${validate.status}`);
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }

  // Submit raw with the advisory idempotency key.
  const submitted = await callRaw(
    "POST",
    "/bundles/pcpub",
    readFileSync(packedPath),
    "application/vnd.progressive-cms.pcpub+zip",
  );
  const received = submitted.body as {
    ingest_id?: string;
    replayed?: boolean;
    error?: { code?: string };
  };
  if (submitted.status !== 202 || typeof received.ingest_id !== "string") {
    run.notes.push(`submit failed: ${submitted.status} ${JSON.stringify(received).slice(0, 200)}`);
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }

  // Process + poll to the terminal outcome (the worker tick is in-process).
  await processPcpubIngest(ctx.fixture.app, received.ingest_id);
  const status = await run.http.call("GET", `/bundles/pcpub/ingests/${received.ingest_id}`);
  const statusBody = status.body as { outcome?: string | null; error_code?: string | null };
  const outcome = statusBody.outcome ?? "none";
  if (variant === "stale_update") {
    if (outcome === "conflict") {
      run.notes.push("stale base conflicted; public untouched");
      return {
        report: baseReport(run, bootstrap, "blocked_by_conflict"),
        ok: true,
        publicationState: "blocked_by_conflict",
      };
    }
    run.notes.push(`expected conflict, got ${outcome}`);
    return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
  }
  if (outcome === "sealed") {
    if (input.external_path !== undefined) {
      const mapping = (status.body as { result: { external_entries: Record<string, string> } })
        .result.external_entries;
      if (typeof mapping.existing !== "string")
        throw new Error("ingest lacks checked alias mapping");
      run.notes.push("fresh agent authored the package from skill + path without a target UUID");
    }
    run.notes.push(`artifact ingested: bundle ${bundleId}`);
    return {
      report: baseReport(run, bootstrap, "prepared"),
      ok: true,
      publicationState: "prepared",
    };
  }
  run.notes.push(`expected sealed, got ${outcome} [${statusBody.error_code ?? "-"}]`);
  return { report: baseReport(run, bootstrap, "none"), ok: false, publicationState: "none" };
}

function makeLoggingHttp(inner: AgentHttp, log: SurfaceLog): AgentHttp {
  const callRaw = inner.callRaw?.bind(inner);
  return {
    async call(method, path, payload) {
      const response = await inner.call(method, path, payload);
      log.calls.push({ method, path, status: response.status });
      return response;
    },
    ...(callRaw === undefined
      ? {}
      : {
          async callRaw(method, path, body, contentType) {
            const response = await callRaw(method, path, body, contentType);
            log.calls.push({ method, path, status: response.status });
            return response;
          },
        }),
  };
}
