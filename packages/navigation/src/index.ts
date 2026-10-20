// @pcms/navigation — Navigation subsystem (M04, PCMS-NAV-T001).
//
// Public application surface of the Navigation bounded context. The
// Navigation Tree is an independent first-class model (Navigation spec §2):
// it is not the Content Tree and not the URL Tree. Internal items reference
// entries by stable Entry ID; URLs are resolved by the Routing subsystem and
// handed over at the composition layer — this package never computes URLs.
// Deep imports like "@pcms/navigation/src/…" are boundary violations
// (tests/architecture.test.ts).

export {
  createPlacementBindingService,
  type PlacementBindingIssue,
  type PlacementBindingService,
  type PlacementDescriptor,
} from "./bindings.js";
export {
  type BreadcrumbItem,
  type BreadcrumbLookups,
  type BreadcrumbStrategy,
  deriveBreadcrumbs,
} from "./breadcrumbs.js";
export {
  createNavigationDiscovery,
  type NavigationDiscovery,
} from "./discovery.js";
export { NAVIGATION_ERROR_CODES, NavigationError, type NavigationErrorCode } from "./errors.js";
export type {
  ActionTarget,
  ActionUiIntent,
  AnchorTarget,
  ExternalLinkTarget,
  ExternalRelToken,
  InternalEntryTarget,
  ItemVisibilityPolicy,
  NavigationItemNode,
  NavigationItemTarget,
  NavigationItemType,
  NavigationOverrideOp,
  NavigationOverrideRecord,
  NavigationPlacementBinding,
  NavigationRevisionRecord,
  NavigationSetRecord,
} from "./model.js";
export {
  DEFAULT_MAX_TREE_DEPTH,
  EXTERNAL_REL_TOKENS,
  MAX_ANCHOR_LENGTH,
  MAX_ITEMS_PER_SET,
  NAVIGATION_ITEM_TYPES,
} from "./model.js";
export { type ApplicableOverride, applyOverrides } from "./overrides.js";
export {
  type CreateNavigationSetInput,
  createNavigationService,
  type InsertNavigationItemInput,
  type NavigationService,
} from "./service.js";
export {
  isAllowedExternalUrl,
  itemPayloadIssues,
  NAVIGATION_ACTION_KINDS,
  type NavigationActionKind,
  normalizeExternalRel,
  type ValidatedItemInput,
  validateItemInput,
} from "./validate.js";
export const PACKAGE_NAME = "@pcms/navigation";
