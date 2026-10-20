// Presentation labels for known theme-setting keys (G-UI-1 precedent, same
// class as field-utils): theme manifests carry author-language labels as
// DATA; the Admin overlays localized labels for the settings it knows and
// falls back to the manifest value. Data layer — exempt from check:i18n.
import { getLocale } from "../../i18n/locale.js";

interface SettingLike {
  readonly key: string;
  readonly label?: string;
}

const LABELS: Readonly<Record<string, { readonly ru: string; readonly en: string }>> = {
  primary_color: { ru: "Основной цвет", en: "Primary color" },
  accent_color: { ru: "Акцентный цвет", en: "Accent color" },
  header_variant: { ru: "Вариант шапки", en: "Header variant" },
  sticky_header: { ru: "Прилипающая шапка", en: "Sticky header" },
  container_width: { ru: "Ширина контейнера", en: "Container width" },
  logo: { ru: "Логотип", en: "Logo" },
  lead_form_id: { ru: "ID формы обращения", en: "Contact form ID" },
  footer_text: { ru: "Текст в подвале", en: "Footer text" },
};

/** Localized label for a theme setting; manifest label is the fallback. */
export function themeSettingLabel(setting: SettingLike): string {
  const localized = LABELS[setting.key];
  if (localized !== undefined) {
    return localized[getLocale()] ?? setting.label ?? setting.key;
  }
  return setting.label ?? setting.key;
}
