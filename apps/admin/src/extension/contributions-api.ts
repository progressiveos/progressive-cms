// Admin UI contribution contract (ADR-0017 S6 — the UI half of the Extension
// SDK). An external first-party package ships `admin/index.ts` exporting
// `registerAdminContributions(api)`; the GENERATED contributions module
// (scripts/compose-first-party.mjs emit-admin) lazily loads it and the
// runtime gates registration on the extension's ENABLED state — no manual
// imports of package code anywhere in the Admin core.
export type { AdminContributionApi, ExtensionContribution } from "@pcms/extensions";
