// Namespaced catalog fragment with compile-time RU/EN key parity. Secondary
// screens carry their strings in per-domain fragments (i18n/dom/*.ts) so
// parallel sweeps never share a file; index.ts merges every fragment into the
// single dictionary — same t()/useLocale runtime, no second i18n engine.
export type CatalogFragment = {
  readonly ru: Record<string, string>;
  readonly en: Record<string, string>;
};

export function defineFragment<T extends Record<string, string>>(
  ru: T,
  en: { readonly [K in keyof T]: string },
): CatalogFragment {
  return { ru, en };
}
