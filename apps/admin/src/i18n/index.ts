// Admin localization (Admin spec §63; redesign spec §6): dictionary-based,
// RU + EN with stable keys. `t()` stays a plain synchronous lookup so screens
// migrate mechanically; locale switches re-render via useLocale(). Catalogs
// are the base dictionaries (ru.ts/en.ts) merged with per-domain fragments
// (dom/*.ts) — fragments keep RU/EN key parity at compile time.
import { useSyncExternalStore } from "react";
import { access } from "./dom/access.js";
import { analytics } from "./dom/analytics.js";
import { blocks } from "./dom/blocks.js";
import { core } from "./dom/core.js";
import { extensions } from "./dom/extensions.js";
import { integrations } from "./dom/integrations.js";
import { localization } from "./dom/localization.js";
import { media } from "./dom/media.js";
import { navigation } from "./dom/navigation.js";
import { notifications } from "./dom/notifications.js";
import { permissions } from "./dom/permissions.js";
import { privacy } from "./dom/privacy.js";
import { publication } from "./dom/publication.js";
import { search } from "./dom/search.js";
import { settings } from "./dom/settings.js";
import { tabs } from "./dom/tabs.js";
import { en as enBase } from "./en.js";
import type { CatalogFragment } from "./fragment.js";
import { type AdminLocale, getLocale, onLocaleChange } from "./locale.js";
import { ru as ruBase } from "./ru.js";

export {
  formatDate,
  formatDateTime,
  formatFileSize,
  formatNumber,
  formatTime,
} from "./format.js";
export { type CatalogFragment, defineFragment } from "./fragment.js";
export { getLocale, onLocaleChange, setLocale } from "./locale.js";
export type { AdminLocale };

/** Register domain fragments here as sweeps land (one line per domain). */
const fragments: readonly CatalogFragment[] = [
  core,
  access,
  publication,
  settings,
  extensions,
  navigation,
  media,
  tabs,
  blocks,
  integrations,
  search,
  localization,
  permissions,
  analytics,
  notifications,
  privacy,
];

export const ru = Object.assign(
  {},
  ruBase,
  ...(fragments.map((fragment) => fragment.ru) as readonly object[]),
) as typeof ruBase & Record<string, string>;
export const en = Object.assign(
  {},
  enBase,
  ...(fragments.map((fragment) => fragment.en) as readonly object[]),
) as typeof enBase & Record<string, string>;

export type MessageKey = keyof typeof ru;
export type Messages = Record<MessageKey, string>;

const dictionaries: Record<AdminLocale, Messages> = { ru, en };

/**
 * Registers extension-contribution translations at runtime (ADR-0017 S6 UI
 * contract): merges into BOTH dictionaries and notifies the locale store so
 * mounted screens re-render. Keys are namespaced by the package
 * (e.g. "admin_fixture.*") — collisions with platform keys would be a
 * package defect surfaced loudly by the same unknown-key contract.
 */
export function registerTranslations(fragment: {
  readonly ru: Record<string, string>;
  readonly en: Record<string, string>;
}): void {
  Object.assign(dictionaries.ru, fragment.ru);
  Object.assign(dictionaries.en, fragment.en);
  for (const listener of translationListeners) listener();
}

const translationListeners = new Set<() => void>();

/** Subscription for screens that must re-render when contribution
 * translations arrive (same channel the locale switch uses). */
export function onTranslationsChange(listener: () => void): () => void {
  translationListeners.add(listener);
  return () => translationListeners.delete(listener);
}

/**
 * t("key") → localized string; unknown keys surface loudly instead of blank
 * UI. Optional vars fill `{name}` placeholders in the catalog entry.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const value = dictionaries[getLocale()][key as MessageKey];
  if (value === undefined) {
    return `[${key}]`;
  }
  if (vars === undefined) {
    return value;
  }
  return value.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  );
}

/** Human localized text for stable API error codes (Admin spec §62). */
const errorMessages: Record<AdminLocale, Readonly<Record<string, string>>> = {
  ru: {
    AUTH_INVALID_CREDENTIALS: "Неверная почта или пароль",
    AUTH_THROTTLED: "Слишком много попыток входа. Подождите немного и попробуйте снова.",
    AUTH_MFA_INVALID_CODE: "Неверный код подтверждения",
    AUTH_CSRF_TOKEN_MISSING: "Просрочена форма подтверждения. Обновите страницу.",
    AUTH_CSRF_TOKEN_INVALID: "Просрочена форма подтверждения. Обновите страницу.",
    AUTH_PERMISSION_DENIED: "Недостаточно прав для этого действия",
    LOCALIZATION_LOCALE_NOT_ENABLED:
      "Эта локаль не включена на сайте (Настройки → Локализация). Используйте локаль default или включите мультиязычность.",
    AUTH_UNAUTHENTICATED: "Требуется вход в систему",
    AUTH_SESSION_INVALID: "Сессия истекла. Войдите заново.",
    NETWORK_UNREACHABLE: "Сервер недоступен. Проверьте подключение.",
    REVISION_STALE:
      "Черновик изменён кем-то другим. Обновите страницу, чтобы увидеть актуальную версию.",
    REVISION_NOT_WORKING: "Редактирование недоступно: ревизия уже готова к публикации",
    ROUTE_COLLISION: "Такой адрес уже занят другой страницей",
    ENTRY_NOT_FOUND: "Материал не найден",
    ENTRY_CYCLE: "Нельзя переместить материал внутрь его собственного раздела",
    ENTRY_ALREADY_EXISTS: "Материал с таким идентификатором уже существует",
    ENTRY_KIND_FORBIDDEN: "Эта операция недоступна для папки",
    FOLDER_NOT_EMPTY: "Сначала переместите или заархивируйте материалы внутри папки",
    NAV_SET_NOT_FOUND: "Набор навигации не найден",
    CONTENT_TYPE_UNKNOWN: "Неизвестный тип контента",
    MEDIA_ASSET_NOT_FOUND: "Медиафайл не найден",
    MEDIA_ARCHIVED: "Нельзя восстановить варианты архивного медиафайла",
    MEDIA_VARIANT_REGENERATION_UNSUPPORTED:
      "Варианты можно восстановить только для растровых изображений",
    MEDIA_PRESETS_UNAVAILABLE: "Пресеты активной темы сейчас недоступны",
    MEDIA_STORAGE_CONFIG: "Хранилище медиа не настроено",
  },
  en: {
    AUTH_INVALID_CREDENTIALS: "Incorrect email or password",
    AUTH_THROTTLED: "Too many sign-in attempts. Wait a moment and try again.",
    AUTH_MFA_INVALID_CODE: "Invalid confirmation code",
    AUTH_CSRF_TOKEN_MISSING: "The form has expired. Refresh the page.",
    AUTH_CSRF_TOKEN_INVALID: "The form has expired. Refresh the page.",
    AUTH_PERMISSION_DENIED: "You do not have permission for this action",
    LOCALIZATION_LOCALE_NOT_ENABLED:
      "This locale is not enabled on the site (Settings → Localization). Use the default locale or enable multilingual first.",
    AUTH_UNAUTHENTICATED: "Sign-in required",
    AUTH_SESSION_INVALID: "Your session has expired. Please sign in again.",
    NETWORK_UNREACHABLE: "Server unreachable. Check your connection.",
    REVISION_STALE: "The draft was changed by someone else. Refresh to see the latest version.",
    REVISION_NOT_WORKING: "Editing unavailable: this revision is ready to publish",
    ROUTE_COLLISION: "This address is already taken by another page",
    ENTRY_NOT_FOUND: "Entry not found",
    ENTRY_CYCLE: "An entry cannot be moved inside its own section",
    ENTRY_ALREADY_EXISTS: "An entry with this identifier already exists",
    ENTRY_KIND_FORBIDDEN: "This operation is not available for a folder",
    FOLDER_NOT_EMPTY: "Move or archive the folder's entries first",
    NAV_SET_NOT_FOUND: "Navigation set not found",
    CONTENT_TYPE_UNKNOWN: "Unknown content type",
    MEDIA_ASSET_NOT_FOUND: "Media asset not found",
    MEDIA_ARCHIVED: "Variants cannot be restored for an archived media asset",
    MEDIA_VARIANT_REGENERATION_UNSUPPORTED: "Only raster images support variant regeneration",
    MEDIA_PRESETS_UNAVAILABLE: "Active theme presets are currently unavailable",
    MEDIA_STORAGE_CONFIG: "Media storage is not configured",
  },
};

export function errorText(code: string): string | undefined {
  return errorMessages[getLocale()][code];
}

const subscribeLocale = (notify: () => void) => onLocaleChange(() => notify());

/** Re-render on locale switches; call once near the app root. */
export function useLocale(): AdminLocale {
  return useSyncExternalStore(subscribeLocale, getLocale);
}
