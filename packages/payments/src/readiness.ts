// Instance readiness and credential validation (CORE-PAYMENTS-ADMIN-CONFIG-01).
//
// ONE evaluator answers "is this connection locally able to take payments /
// verify callbacks?" for every caller: the runtime resolver (fails closed),
// the offline check (Admin button), the settings GET view and the settings
// save (enable gate). It only ever reports slot NAMES — never a value, never
// a ciphertext, never a masked fragment.
import { describeEndpointIssue, endpointPolicyIssues } from "./endpoint-policy.js";
import { PaymentError } from "./errors.js";
import {
  decryptInstanceCredentials,
  loadInstanceCredentials,
  type PaymentSecretBox,
  type SqlExecutor,
} from "./runtime-secrets.js";
import { validateAgainstSchema } from "./schema.js";
import type { PaymentProvider } from "./providers.js";

/** Upper bound of one stored credential value. PEM keys of every supported
 * provider fit; anything larger is a paste accident, not a key. */
export const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1024;

export type ReadinessCode =
  | "ready"
  | "disabled"
  | "provider_not_composed"
  | "config_invalid"
  | "config_unsupported"
  | "config_endpoint_untrusted"
  | "credentials_missing"
  | "credentials_unreadable"
  | "legacy_refs_pending_import";

export interface InstanceReadiness {
  readonly ready: boolean;
  readonly code: ReadinessCode;
  /** Declared provider slots and whether this instance has them. */
  readonly slots: Readonly<Record<string, boolean>>;
  /** Slots required by the adapter that this instance does not satisfy. */
  readonly missing: readonly string[];
  /** Slots whose stored value cannot be decrypted with the current key. */
  readonly unreadable: readonly string[];
  /** Stored config fails the adapter's schema (paths only). */
  readonly configIssues: readonly string[];
  /** Legacy process-secret names still awaiting the import (names only). */
  readonly legacyRefs: readonly string[];
  /** Short human/machine explanation; contains no secret material. */
  readonly detail: string;
}

/** Snapshot of one instance's credentials as read at the start of a call. */
export interface InstanceCredentialSnapshot {
  /** Runtime (encrypted instance store) values by slot. */
  readonly runtime: Readonly<Record<string, string>>;
  /** Legacy process-secret refs still recorded on the instance. */
  readonly legacyRefs: Readonly<Record<string, string>>;
  /** True when the deployment has no master key. */
  readonly keyMissing: boolean;
  /** Stored slots that cannot be decrypted with the current key. */
  readonly unreadable: readonly string[];
}

/**
 * Loads every credential of one instance in a single query and decrypts in
 * memory. `legacyResolver` is the process secret channel — used only for
 * slots that have no runtime value (pending import); it is synchronous and
 * never touches the network.
 */
export async function loadInstanceCredentialSnapshot(
  executor: SqlExecutor,
  box: PaymentSecretBox | undefined,
  instance: { readonly id: string; readonly secretRefs: Readonly<Record<string, string>> },
): Promise<InstanceCredentialSnapshot & { readonly unreadable: readonly string[] }> {
  const rows = await loadInstanceCredentials(executor, box, instance.id);
  if (rows === null || box === undefined) {
    return {
      runtime: {},
      legacyRefs: { ...instance.secretRefs },
      keyMissing: true,
      unreadable: [],
    };
  }
  const { values, unreadable } = decryptInstanceCredentials(box, rows);
  return {
    runtime: values,
    legacyRefs: { ...instance.secretRefs },
    keyMissing: false,
    unreadable,
  };
}

/**
 * How a slot resolves for a MONEY/INBOUND call: the encrypted instance store
 * only. A legacy process-secret reference is deliberately NOT a runtime
 * fallback any more (CORE-PAYMENTS-ADMIN-CONFIG-01 review R1): until the
 * importer has retired it, the connection reports `legacy_refs_pending_import`
 * and money operations fail with a typed diagnostic instead of quietly
 * reading the deployment environment.
 */
export function resolveSlotValue(
  slot: string,
  snapshot: InstanceCredentialSnapshot,
): { readonly source: "runtime" | "missing"; readonly value?: string } {
  const runtime = snapshot.runtime[slot];
  if (runtime !== undefined && runtime !== "") return { source: "runtime", value: runtime };
  return { source: "missing" };
}

export interface CredentialResolution {
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Resolves the adapter's declared requirements; throws a typed PaymentError
 * when any is missing or unreadable. Messages and details list slot NAMES
 * only.
 */
export function resolveRequiredCredentials(
  provider: PaymentProvider,
  instance: { readonly name: string },
  snapshot: InstanceCredentialSnapshot,
  options?: { readonly allowLegacyRefs?: boolean },
): CredentialResolution {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const unreadable: string[] = [];
  for (const slot of provider.secretRequirements) {
    const resolved = resolveSlotValue(slot, snapshot);
    if (resolved.source !== "missing" && resolved.value !== undefined) {
      values[slot] = resolved.value;
    } else if (snapshot.unreadable.includes(slot)) {
      unreadable.push(slot);
    } else {
      missing.push(slot);
    }
  }
  if (unreadable.length > 0) {
    throw new PaymentError(
      "PAYMENT_CREDENTIALS_UNREADABLE",
      `credential(s) ${unreadable.join(", ")} of provider instance "${instance.name}" cannot be decrypted with the current key; re-enter them in Admin`,
      { details: { slots: unreadable } },
    );
  }
  if (missing.length > 0) {
    // Distinct, actionable diagnosis: the value may still exist in the old
    // process secret channel, but it MUST be imported before money moves.
    const pending = missing.filter((slot) => snapshot.legacyRefs[slot] !== undefined);
    if (pending.length > 0 && options?.allowLegacyRefs !== true) {
      throw new PaymentError(
        "PAYMENT_CREDENTIALS_INCOMPLETE",
        `credential(s) ${pending.join(", ")} of provider instance "${instance.name}" are still process-secret references — run the payment credentials import (cms payments credentials import); payments stay blocked until it completes`,
        { details: { slots: pending, reason: "legacy_refs_pending_import" } },
      );
    }
    throw new PaymentError(
      "PAYMENT_CREDENTIALS_INCOMPLETE",
      `credential(s) ${missing.join(", ")} are not configured for provider instance "${instance.name}"`,
      { details: { slots: missing } },
    );
  }
  return { values };
}
/**
 * Full readiness evaluation of one instance. `provider` is the composed
 * adapter (undefined when the provider type is absent). A non-empty config
 * on an adapter without withConfig is a real blocker, never a silent ignore.
 */
export async function evaluateInstanceReadiness(
  executor: SqlExecutor,
  box: PaymentSecretBox | undefined,
  input: {
    readonly instance: {
      readonly id: string;
      readonly name: string;
      readonly enabled: boolean;
      readonly config: Readonly<Record<string, unknown>>;
      readonly secretRefs: Readonly<Record<string, string>>;
    };
    readonly provider: PaymentProvider | undefined;
  },
): Promise<InstanceReadiness> {
  const { instance, provider } = input;
  const legacyRefs = Object.entries(instance.secretRefs).map(([, ref]) => ref);
  if (provider === undefined) {
    return {
      ready: false,
      code: "provider_not_composed",
      slots: {},
      missing: [],
      unreadable: [],
      configIssues: [],
      legacyRefs,
      detail:
        "provider type is not composed — install and enable its payment extension; existing payment history keeps rendering",
    };
  }
  const slots: Record<string, boolean> = {};
  for (const slot of provider.secretRequirements) slots[slot] = false;
  const configIssues = [
    ...validateAgainstSchema(provider.configSchema, instance.config, "config"),
    ...(provider.configDiagnostics?.(instance.config) ?? []),
  ];
  const configUnsupported =
    provider.withConfig === undefined && Object.keys(instance.config).length > 0;
  const snapshot = await loadInstanceCredentialSnapshot(executor, box, instance);
  const missing: string[] = [];
  const unreadable = [...snapshot.unreadable];
  for (const slot of provider.secretRequirements) {
    const resolved = resolveSlotValue(slot, snapshot);
    slots[slot] = resolved.source !== "missing";
    if (resolved.source === "missing" && !unreadable.includes(slot)) missing.push(slot);
  }
  // Legacy references that still HAVE no runtime value are a migration
  // blocker: the value exists only in the process secret channel and money
  // operations no longer read it (review R1).
  const legacyPending = Object.keys(snapshot.legacyRefs).some(
    (slot) => snapshot.runtime[slot] === undefined,
  );
  // Callback-verification parameters (e.g. a platform public key) are part of
  // readiness but NOT of the draft schema: a disabled draft may omit them,
  // an enabled connection may not (review R6).
  for (const key of provider.callbackConfigRequirements ?? []) {
    const value = instance.config[key];
    const present = typeof value === "string" ? value.trim() !== "" : value !== undefined;
    if (!present) configIssues.push(`${key}: required to verify provider callbacks`);
  }
  const base = { slots, missing, unreadable, configIssues, legacyRefs };

  if (configUnsupported) {
    return {
      ...base,
      ready: false,
      code: "config_unsupported",
      detail:
        "this provider package cannot receive instance settings — update the payment extension",
    };
  }
  if (configIssues.length > 0) {
    return {
      ...base,
      ready: false,
      code: "config_invalid",
      detail: `stored settings do not match the provider schema: ${configIssues.join("; ")}`,
    };
  }
  // Review R3 (second pass): an endpoint this provider package does not trust
  // is a blocker, not a detail — readiness must never report "ready" for a
  // connection whose credentials would be sent elsewhere.
  const endpointIssues = endpointPolicyIssues(provider, instance.config);
  if (endpointIssues.length > 0) {
    return {
      ...base,
      ready: false,
      code: "config_endpoint_untrusted",
      detail: `${endpointIssues.map(describeEndpointIssue).join("; ")} — no provider call is made until a trusted endpoint is saved`,
    };
  }
  if (unreadable.length > 0) {
    return {
      ...base,
      ready: false,
      code: "credentials_unreadable",
      detail: `credential(s) cannot be decrypted with the current key: ${unreadable.join(", ")}`,
    };
  }
  if (missing.length > 0) {
    // Every missing slot is still backed by an un-imported process-secret
    // reference: that is a migration state with its own remedy, not "the
    // operator forgot a key".
    const allPending = missing.every((slot) => snapshot.legacyRefs[slot] !== undefined);
    if (legacyPending && allPending) {
      return {
        ...base,
        ready: false,
        code: "legacy_refs_pending_import",
        detail:
          "credentials are still process-secret references — run the payment credentials import (cms payments credentials import); payments stay blocked until it completes",
      };
    }
    return {
      ...base,
      ready: false,
      code: "credentials_missing",
      detail: `credential(s) not configured: ${missing.join(", ")}`,
    };
  }
  if (legacyPending) {
    return {
      ...base,
      ready: false,
      code: "legacy_refs_pending_import",
      detail:
        "credentials still come from deployment secrets — restore the master key and run the payment credentials import",
    };
  }
  if (!instance.enabled) {
    return {
      ...base,
      ready: true,
      code: "disabled",
      detail:
        "configured for payments; new payments are refused while disabled — callbacks for existing payments still process",
    };
  }
  return {
    ...base,
    ready: true,
    code: "ready",
    detail: "configured to accept payments (a local readiness check, not a bank/money test)",
  };
}

/** Field-level validation of a credential VALUE for one slot. Returns issue
 * strings that name the slot only — the value never appears. */
export function credentialValueIssues(slot: string, value: unknown): readonly string[] {
  if (typeof value !== "string") return [`${slot}: must be text`];
  if (value.trim() === "") return [`${slot}: must not be empty`];
  if (value !== value.trim()) return [`${slot}: no leading/trailing whitespace`];
  if (/[\r\n]/.test(value) && !value.includes("-----BEGIN")) {
    return [`${slot}: single-line credential must not contain line breaks`];
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_VALUE_BYTES) {
    return [`${slot}: value is larger than ${MAX_CREDENTIAL_VALUE_BYTES} bytes`];
  }
  return [];
}
