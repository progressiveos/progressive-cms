// @pcms/themes — Theme Contract subsystem (M03, PCMS-THEME-T001).
//
// Public application surface of the Theme bounded context. Themes are pure
// presentation: they receive typed plain-data View Models (see view-models.ts)
// and never touch PostgreSQL, publication internals, auth/session, routing
// internals, SEO semantics, secrets or media transformation pipelines
// (Theme Contract spec §2/§72).
//
// Boundary rules (tests/architecture.test.ts):
//   - L1 subsystem: may import @pcms/core only — no @pcms/content,
//     @pcms/blocks or other L1 packages; the View Model types are structural
//     mirrors, and composition code (apps/CLI/tests) wires real content data
//     in as plain objects.
//   - Deep imports of any @pcms/* package are forbidden; this entry is the
//     package's only public surface.
//
// Later M03 tasks re-export their contracts here: manifest schema (T002),
// theme registry (T003), template/component/block registries (T005–T009),
// RichText bridge (T010), placements/presets/tokens/settings (T011–T015),
// head boundary (T016), assets (T017/T018), validation (T019/T020),
// preview (T021) and discovery (T026).

export {
  type AssetBuildOutput,
  type AssetIssue,
  detectAdminLeakage,
  hashAsset,
  MAX_ASSET_BYTES,
  planAssetBuild,
} from "./assets/assets.js";
export {
  buildCspPolicy,
  type CspIssue,
  validateCspDeclaration,
  validatePublicJs,
} from "./assets/csp.js";
export {
  DEFAULT_PERFORMANCE_BUDGET,
  type PerformanceBreach,
  type PerformanceBudget,
  type PerformanceReport,
  performanceReport,
} from "./assets/performance.js";
export { createThemeDiscovery, type ThemeDiscovery } from "./discovery/discovery.js";
export {
  createThemeEngine,
  type TemplateSnapshot,
  type ThemeEngineOptions,
} from "./engine/liquid.js";
export { isSafeHtml, type SafeHtml, safeHtml } from "./engine/safe-html.js";
export { ThemeError } from "./errors.js";
export {
  type CapabilityProvider,
  type CompatibilityInput,
  type CompatibilityIssue,
  type CompatibilityResult,
  createThemeRegistry,
  SUPPORTED_THEME_CONTRACT_RANGE,
  THEME_CONTRACT_VERSION,
  type ThemeRegistry,
} from "./manifest/registry.js";
export {
  type ManifestIssue,
  parseThemeManifest,
  THEME_ID_PATTERN,
  THEME_MANIFEST_JSON_SCHEMA,
  THEME_MANIFEST_SCHEMA_ID,
  type ThemeManifest,
  type ThemeManifestBlockRenderer,
  type ThemeManifestCollection,
  type ThemeManifestComponent,
  type ThemeManifestMediaPreset,
  type ThemeManifestNavigationPlacement,
  type ThemeManifestSetting,
  type ThemeManifestTemplate,
  type ThemeManifestValidationResult,
  VERSION_RANGE_PATTERN,
  validateThemeManifest,
} from "./manifest/schema.js";
export { type ParsedVersion, parseVersion, satisfiesVersion } from "./manifest/semver.js";
export { readThemeManifestPresets } from "./manifest/theme-presets.js";
export {
  buildImageModel,
  createMediaPresetRegistry,
  type ImageModel,
  type MediaPresetDescriptor,
  type MediaPresetRegistry,
  resolveDerivative,
} from "./media/presets.js";
export { STABLE_ID_PATTERN } from "./navigation/patterns.js";
export {
  createNavigationPlacementRegistry,
  type NavigationAssignment,
  type NavigationIssue,
  type NavigationPlacementContract,
  type NavigationPlacementRegistry,
} from "./navigation/placements.js";
export { buildNavigationScope } from "./navigation/render-navigation.js";
export {
  createThemePreview,
  type PreviewEntryInput,
  type PreviewSiteInput,
  type ThemePreview,
  type ThemePreviewInput,
} from "./preview/preview.js";
export {
  type BlockDiagnostic,
  diagnoseBlockDocument,
  renderBlockDocumentWithDiagnostics,
} from "./render/block-diagnostics.js";
export {
  type BlockRendererDescriptor,
  type BlockRendererRegistry,
  type BlockRenderScope,
  type BlockSupportIssue,
  createBlockRendererRegistry,
} from "./render/block-renderer-registry.js";
export {
  type ComponentDescriptor,
  type ComponentRegistry,
  createComponentRegistry,
} from "./render/component-registry.js";
export {
  assembleHeadHtml,
  filterThemeHeadSlots,
  type HeadSlotViolation,
  headViolations,
} from "./render/head.js";
export {
  createRenderService,
  loadTemplateSnapshot,
  type RenderContext,
  type RenderService,
  type RenderServiceOptions,
  type SnapshotLoadResult,
} from "./render/render-service.js";
export {
  isRichTextDocument,
  renderRichText,
  renderRichTextInProps,
} from "./render/richtext-renderer.js";
export {
  assertTemplateAcceptance,
  createTemplateRegistry,
  type TemplateAcceptanceInput,
  type TemplateAcceptanceIssue,
  type TemplateAcceptanceResult,
  type TemplateContract,
  type TemplateRegistry,
} from "./render/template-registry.js";
export {
  applyTokenOverrides,
  resolveSettingsValues,
  type SettingIssue,
  type SettingsValues,
  tokenOverridesFromSettings,
  unmatchedSettingTokens,
} from "./settings/settings.js";
export {
  parseTokensSource,
  type ThemeToken,
  type TokenIssue,
  type TokenMap,
  type TokensParseResult,
  type TokenType,
  tokenCssName,
  tokensToCss,
} from "./tokens/tokens.js";
export {
  type SiteBlockInfo,
  type SiteContentTypeInfo,
  type SiteEntryInfo,
  type SiteValidationIssue,
  type SiteValidationOptions,
  type SiteValidationReport,
  validateSiteAgainstTheme,
} from "./validate/site-validate.js";
export {
  type ThemeValidationReport,
  type ValidationIssue,
  validateThemeDir,
} from "./validate/theme-validate.js";
export type {
  BlockNodeViewModel,
  BreadcrumbsViewModel,
  EntryViewModel,
  FormFieldOptionViewModel,
  FormFieldViewModel,
  FormViewModel,
  HeadViewModel,
  MediaAssetViewModel,
  MediaDerivativeViewModel,
  NavigationItemViewModel,
  NavigationPlacementViewModel,
  PageViewModel,
  QuizQuestionViewModel,
  QuizStepViewModel,
  QuizViewModel,
  RequestContextPublicViewModel,
  RichTextNodeViewModel,
  SearchResultItemViewModel,
  SearchResultPageViewModel,
  SearchResultSnippetViewModel,
  SiteViewModel,
  ValidationErrorViewModel,
} from "./view-models.js";
export const PACKAGE_NAME = "@pcms/themes";

export {
  type DesignTokenDraft,
  extractDesignTokens,
  type FigmaFile,
  type FigmaLocation,
  type FigmaNode,
  figmaTokensToCss,
  frameIdsOf,
  parseFigmaUrl,
} from "./figma.js";
export {
  installThemePackage,
  isAllowedThemeEntryName,
  listInstalledThemes,
  resolveInstalledThemeDirectory,
  stageThemePackage,
  ThemeInstallError,
  uninstallThemePackage,
  updateActiveThemePackage,
  validateThemeEntryNames,
  validateThemePackage,
} from "./install-package.js";
export {
  removeThemeRevisionFiles,
  restoreThemeCatalog,
  snapshotThemeFiles,
  themeRevisionDirectory,
} from "./revision-files.js";
