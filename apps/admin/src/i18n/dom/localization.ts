// Opt-in multilingual Admin UX (progressive disclosure): translations strip
// in the entry editor + the Settings "Languages" card. Everything renders
// only when the site localization mode is multilingual — a single-language
// editor never sees locale noise. RU byte-stable for the browser corpus.
import { defineFragment } from "../fragment.js";

export const localization = defineFragment(
  {
    "localization.add_translation": "Добавить перевод",
    "localization.translations": "Языковые версии",
    "localization.locale_label": "Язык",
    "localization.copy_source": "Скопировать содержимое исходного языка как черновик",
    "localization.empty_source_copy": "Пустой черновик",
    "localization.create": "Создать",
    "localization.created_toast": "Черновик перевода {locale} создан",
    "localization.locales_title": "Языки",
    "localization.mode": "Режим языков",
    "localization.mode_single": "Один язык",
    "localization.mode_multiple": "Несколько языков",
    "localization.default_locale": "Язык по умолчанию",
    "localization.enabled_locales": "Включённые языки (через запятую, BCP 47)",
    "localization.default_prefix_note":
      "Язык по умолчанию не получает префикс в адресах; остальные — /en/ и т.п.",
    "localization.saved_toast": "Настройки языков сохранены",
    "localization.enabled_locales_display": "Включённые языки",
  },
  {
    "localization.add_translation": "Add translation",
    "localization.translations": "Translations",
    "localization.locale_label": "Language",
    "localization.copy_source": "Copy the source-language content as a draft",
    "localization.empty_source_copy": "Empty draft",
    "localization.create": "Create",
    "localization.created_toast": "Draft translation {locale} created",
    "localization.locales_title": "Languages",
    "localization.mode": "Language mode",
    "localization.mode_single": "Single language",
    "localization.mode_multiple": "Multiple languages",
    "localization.default_locale": "Default language",
    "localization.enabled_locales": "Enabled languages (comma-separated, BCP 47)",
    "localization.default_prefix_note":
      "The default language has no URL prefix; secondary ones use /en/ and so on.",
    "localization.saved_toast": "Language settings saved",
    "localization.enabled_locales_display": "Enabled languages",
  },
);
