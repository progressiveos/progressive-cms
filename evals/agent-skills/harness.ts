// Agent Skill eval harness (PCMS-SKILL-T013/T014; task brief §57, §90–§94).
//
// Model-agnostic by construction: a scenario is data, the driver is a
// pluggable executor, the CMS connection is a fixture. The CI driver is
// "scripted" — a deterministic executor that follows the skill workflow via
// public surfaces only — proving the workflows are machine-executable and
// that the gates (validation, preview, compatibility, permissions,
// idempotency, reconciliation) actually stop an agent where they must.
// The "model" driver (cold LLM runs, T019) plugs into the same scenarios.
//
// §60 boundary: the HARNESS may use DB/fixtures for setup and verification;
// the DRIVER (simulated agent path) may only use the recorded public HTTP
// surface and its declared file-scope — direct DB access by a driver is a
// recorded violation.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createApiFastify,
  createApiV1,
  makeAgentRoutes,
  makeDiscoveryRoutes,
  makeMutationRoutes,
  makePcpubBundleRoutes,
  type OperationContext,
} from "@pcms/api";
import Ajv from "ajv";
import { apiContextOf, createApiFixture, ownerActor } from "../../tests/helpers/api-composition.js";
import { testDatabaseConfigured } from "../../tests/helpers/testdb.js";

export { testDatabaseConfigured };

// --- report schema validation (agent-run-report-v1) ---
const REPORT_SCHEMA = JSON.parse(
  readFileSync("skills/schemas/agent-run-report-v1.schema.json", "utf8"),
) as object;
const ajv = new Ajv({ allErrors: true });
const validateReport = ajv.compile(REPORT_SCHEMA);

export function reportIssues(report: unknown): string[] {
  return validateReport(report)
    ? []
    : (validateReport.errors ?? []).map((e) => `${e.instancePath}: ${e.message}`);
}

// --- machine http surface (the ONLY channel a scripted driver sees) ---
export interface AgentHttp {
  call(method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }>;
  /** Raw-body call (ADR-0014 .pcpub artifact uploads). */
  callRaw?(
    method: string,
    path: string,
    body: Buffer,
    contentType: string,
  ): Promise<{ status: number; body: any }>;
}

export interface SurfaceLog {
  calls: { method: string; path: string; status: number }[];
  writes: string[];
  violations: string[];
}

export function makeAgentHttp(fastify: any, token: string, log: SurfaceLog): AgentHttp {
  return {
    async call(method, path, payload) {
      const response = await fastify.inject({
        method,
        url: `/api/v1${path}`,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload }),
      });
      log.calls.push({ method, path, status: response.statusCode });
      let body: any = null;
      try {
        body = response.json();
      } catch {
        body = response.body;
      }
      return { status: response.statusCode, body };
    },
    async callRaw(method, path, body, contentType) {
      const response = await fastify.inject({
        method,
        url: `/api/v1${path}`,
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        payload: body,
      });
      log.calls.push({ method, path, status: response.statusCode });
      let parsed: any = null;
      try {
        parsed = response.json();
      } catch {
        parsed = response.body;
      }
      return { status: response.statusCode, body: parsed };
    },
  };
}

// --- scenario document (task brief §92) ---
export interface Scenario {
  id: string;
  skill: string;
  description: string;
  initial_state: Record<string, unknown>;
  actor_scopes: string[];
  task: string;
  task_input: Record<string, unknown>;
  allowed_surfaces: string[];
  forbidden_surfaces: string[];
  expected: {
    mutations: Record<string, number>;
    safety_outcome: string;
    report: Record<string, unknown>;
    rerun?: { mutations: Record<string, number> };
  };
}

export function loadScenarios(suite: "content" | "theme"): Scenario[] {
  const dir = join("evals/agent-skills/scenarios", suite);
  return readdirSync(dir)
    .filter((name: string) => name.endsWith(".json"))
    .sort()
    .map((name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

// --- fixture boot (harness infrastructure; §60 allowed) ---
export interface EvalFixture {
  app: any;
  fastify: any;
  owner: OperationContext;
  close: () => void;
  /** Harness-only REST channel with human-editor scopes (setup ops). */
  ownerHttp?: ReturnType<typeof makeAgentHttp>;
}

const CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true, sortable: true },
      intro: { id: "intro", type: "text" },
    },
  },
  {
    key: "article",
    version: 1,
    title: "Article",
    bodyPolicy: "rich_text",
    fields: {
      title: { id: "title", type: "string", required: true, sortable: true },
      teaser: { id: "teaser", type: "text" },
    },
  },
  {
    key: "service",
    version: 1,
    title: "Service",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true, sortable: true },
      price: { id: "price", type: "string" },
      intro: { id: "intro", type: "text" },
    },
  },
] as const;

export async function bootEvalFixture(
  t: { after: (fn: () => void) => void },
  options: { previewSecret?: string | null } = {},
): Promise<EvalFixture> {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...CONTENT_TYPES],
    ...(options.previewSecret === null ? { previewSecret: null } : {}),
  });
  await app.routes.ensureSite("default", "Eval Site");
  const fastify = createApiFastify(() => `req_eval_${Math.random().toString(36).slice(2, 8)}`);
  await fastify.register(
    createApiV1([
      ...makeAgentRoutes(),
      ...makeDiscoveryRoutes(),
      ...makeMutationRoutes(),
      // .pcpub artifact transport (ADR-0014 §8).
      ...makePcpubBundleRoutes(),
    ]),
    { application: app, logger: silentLogger(), cookieSecure: false },
  );
  return {
    app,
    fastify,
    owner: apiContextOf(ownerActor(), "rest", "req_eval_owner"),
    close: () => {},
  };
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
}

// --- driver interface (§90: model runner is pluggable) ---
export interface DriverResult {
  ok: boolean;
  report: Record<string, unknown>;
  mutations: Record<string, number>;
  safety_outcome: string;
  notes: string[];
}

export interface DriverContext {
  http: AgentHttp;
  fixture: EvalFixture;
  /** Per-run scratch dir for theme tasks (never the real themes/ corpus). */
  sandboxRoot: string;
}

export interface Driver {
  readonly name: "scripted" | "model";
  run(scenario: Scenario, ctx: DriverContext): Promise<DriverResult>;
}

// --- evaluation: compare driver result against scenario expectations ---
export interface ScenarioOutcome {
  id: string;
  ok: boolean;
  failures: string[];
}

export function evaluate(scenario: Scenario, result: DriverResult): ScenarioOutcome {
  const failures: string[] = [];
  if (!result.ok) failures.push("driver reported failure");
  for (const [kind, count] of Object.entries(scenario.expected.mutations)) {
    if ((result.mutations[kind] ?? 0) !== count) {
      failures.push(`mutations.${kind}: expected ${count}, got ${result.mutations[kind] ?? 0}`);
    }
  }
  if (result.safety_outcome !== scenario.expected.safety_outcome) {
    failures.push(
      `safety_outcome: expected ${scenario.expected.safety_outcome}, got ${result.safety_outcome}`,
    );
  }
  for (const [key, value] of Object.entries(scenario.expected.report)) {
    if (JSON.stringify((result.report as any)[key]) !== JSON.stringify(value)) {
      failures.push(
        `report.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify((result.report as any)[key])}`,
      );
    }
  }
  const issues = reportIssues(result.report);
  failures.push(...issues.map((issue) => `report schema: ${issue}`));
  return { id: scenario.id, ok: failures.length === 0, failures };
}
