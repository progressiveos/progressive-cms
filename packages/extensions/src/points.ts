// Explicit validator extension points (PCMS-EXT-T009, Extensions spec §9).
//
// Where an operation needs synchronous validation contribution, the point is
// a versioned, TYPED registry — never a generic beforeX hook. Each point has
// a name, a contract version and a fixed input/output type; contributions
// come only from enabled extensions through controlled composition, run in
// deterministic order and collide fail-closed. The composition layer adapts
// the contributions to the subsystem pipelines (e.g. the M07 structural
// `PublicationValidator` pipeline, which already accepts validators via its
// public `deps.validators` option).
import { ExtensionError } from "./errors.js";

export interface ValidatorPointContribution<TInput, TIssue> {
  readonly extensionId: string;
  readonly validatorId: string;
  /** Deterministic, synchronous validation — no I/O, no side effects. */
  readonly validate: (input: TInput) => readonly TIssue[];
}

export interface ValidatorExtensionPoint<TInput, TIssue> {
  readonly name: string;
  readonly contractVersion: string;
  register(contribution: ValidatorPointContribution<TInput, TIssue>): void;
  /** Deterministic discovery: sorted by extension id, then validator id. */
  contributions(): readonly ValidatorPointContribution<TInput, TIssue>[];
  /** Runs every contribution in deterministic order; returns all issues. */
  run(input: TInput): readonly TIssue[];
}

export function createValidatorExtensionPoint<TInput, TIssue>(options: {
  readonly name: string;
  readonly contractVersion: string;
}): ValidatorExtensionPoint<TInput, TIssue> {
  const contributions = new Map<string, ValidatorPointContribution<TInput, TIssue>>();
  const keyOf = (contribution: ValidatorPointContribution<TInput, TIssue>) =>
    `${contribution.extensionId}/${contribution.validatorId}`;
  return {
    name: options.name,
    contractVersion: options.contractVersion,
    register(contribution) {
      const key = keyOf(contribution);
      if (contributions.has(key)) {
        throw new ExtensionError(
          "EXTENSION_REGISTRATION_CONFLICT",
          `validator point "${options.name}" already has contribution "${key}"`,
          { details: { point: options.name, key } },
        );
      }
      if (typeof contribution.validate !== "function") {
        throw new ExtensionError(
          "EXTENSION_HANDLER_UNRESOLVED",
          `validator point "${options.name}" contribution "${key}" has no validate function`,
          { details: { point: options.name, key } },
        );
      }
      contributions.set(key, contribution);
    },
    contributions() {
      return [...contributions.values()].sort((a, b) =>
        keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
      );
    },
    run(input) {
      const issues: TIssue[] = [];
      for (const contribution of this.contributions()) {
        issues.push(...contribution.validate(input));
      }
      return issues;
    },
  };
}

/**
 * Resolves the composed `validators` registrations of enabled extensions
 * into point contributions via their named handler exports. This is the
 * composition-side adapter: it runs at application composition time, never
 * at request time, and only for artifacts already in the trusted catalog.
 */
export function registerValidatorContributions<TInput, TIssue>(
  point: {
    readonly name: string;
    register(contribution: ValidatorPointContribution<TInput, TIssue>): void;
  },
  inputs: readonly {
    readonly artifact: {
      readonly manifest: { readonly id: string };
      readonly module: Record<string, unknown>;
    };
    readonly registration: {
      readonly point: string;
      readonly validator_id: string;
      readonly handler: string;
    };
  }[],
): void {
  for (const input of inputs) {
    if (input.registration.point !== point.name) continue;
    const handler = input.artifact.module[input.registration.handler];
    if (typeof handler !== "function") {
      throw new ExtensionError(
        "EXTENSION_HANDLER_UNRESOLVED",
        `validator "${input.registration.validator_id}" of extension "${input.artifact.manifest.id}" has no exported handler "${input.registration.handler}"`,
        {
          details: {
            extension_id: input.artifact.manifest.id,
            handler: input.registration.handler,
          },
        },
      );
    }
    point.register({
      extensionId: input.artifact.manifest.id,
      validatorId: input.registration.validator_id,
      validate: handler as (input: TInput) => readonly TIssue[],
    });
  }
}
