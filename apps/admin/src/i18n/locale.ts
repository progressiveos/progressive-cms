// Admin UI locale engine (redesign spec §6): ru | en, persisted in
// localStorage, browser-locale fallback. This switch controls the Admin
// chrome only — content language of the site is a separate concern.
// Browser globals are reached through guarded structural views of
// globalThis so the module also typechecks/runs DOM-free (node tests
// exercise resolution logic).
export type AdminLocale = "ru" | "en";

const KEY = "pcms.admin.locale";
const VALUES: readonly AdminLocale[] = ["ru", "en"];

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
interface DocumentLike {
  documentElement: { lang: string };
}
interface NavigatorLike {
  languages?: readonly string[];
  language?: string;
}

const globals = globalThis as {
  localStorage?: StorageLike;
  document?: DocumentLike;
  navigator?: NavigatorLike;
  window?: unknown;
};

type Listener = (locale: AdminLocale) => void;
const listeners = new Set<Listener>();
let current: AdminLocale = resolve();

function resolve(): AdminLocale {
  const storage = globals.localStorage;
  if (storage !== undefined) {
    try {
      const stored = storage.getItem(KEY);
      if (stored !== null && (VALUES as readonly string[]).includes(stored)) {
        return stored as AdminLocale;
      }
    } catch {
      // storage unavailable — fall through to browser locale
    }
  }
  const languages =
    globals.window === undefined ? undefined : (globals.navigator?.languages ?? undefined);
  const candidates =
    languages ??
    (globals.window === undefined || globals.navigator?.language === undefined
      ? []
      : [globals.navigator.language]);
  for (const language of candidates) {
    const normalized = language.slice(0, 2).toLowerCase();
    if (normalized === "en") return "en";
    if (normalized === "ru") return "ru";
  }
  return "ru";
}

export function getLocale(): AdminLocale {
  return current;
}

export function setLocale(locale: AdminLocale): void {
  current = locale;
  const storage = globals.localStorage;
  if (storage !== undefined) {
    try {
      storage.setItem(KEY, locale);
    } catch {
      // non-fatal: locale still applies for this session
    }
  }
  const document = globals.document;
  if (document !== undefined) {
    document.documentElement.lang = locale;
  }
  for (const listener of listeners) listener(locale);
}

/** Subscribe to locale changes; does not fire immediately. */
export function onLocaleChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const document = globals.document;
if (document !== undefined) {
  document.documentElement.lang = current;
}
