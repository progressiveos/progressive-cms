import { defineFragment } from "../fragment.js";

// Analytics & tagging screen (ADR-0016). Typed provider fields only — the
// screen has no arbitrary script/HTML surface by contract.
export const analytics = defineFragment(
  {
    "analytics.screen_title": "Аналитика и теги",
    "analytics.ownership_link":
      "Подтвердить владение сайтом в Яндекс Вебмастере или Google Search Console →",
    "analytics.enable": "Включить",
    "analytics.save_button": "Сохранить",
    "analytics.saved": "Настройки аналитики сохранены",
    "analytics.save_failed": "Не удалось сохранить настройки",
    "analytics.load_failed": "Не удалось загрузить настройки аналитики",
    "analytics.card_metrica": "Яндекс Метрика",
    "analytics.card_ga4": "Google Analytics 4",
    "analytics.card_gtm": "Google Tag Manager",
    "analytics.metrica_counter_id": "ID счётчика",
    "analytics.metrica_counter_hint": "Только цифры, 6–12 знаков",
    "analytics.metrica_counter_placeholder": "12345678",
    "analytics.metrica_clickmap": "Карта кликов",
    "analytics.metrica_tracklinks": "Внешние ссылки",
    "analytics.metrica_bounce": "Точный показатель отказов",
    "analytics.metrica_webvisor": "Вебвизор",
    "analytics.metrica_ecommerce": "Электронная коммерция",
    "analytics.webvisor_note":
      "Вебвизор также нужно разрешить в настройках самого счётчика Яндекс.Метрики. Поля форм защищены (ym-disable-keys), содержимое полей не попадает в записи.",
    "analytics.metrica_debug": "Разрешить проверку счётчика в Яндекс Метрике",
    "analytics.metrica_debug_note":
      "Включите этот переключатель, нажмите «Сохранить» вверху страницы и заново откройте проверку в Метрике. Выходить из админки не нужно. Технический режим сайта должен быть выключен: он закрывает сайт от Яндекса и других посетителей (HTTP 503). На время проверки разрешаются скрипты с yastatic.net и стилевые атрибуты во всём документе. После проверки выключите переключатель и сохраните.",
    "analytics.metrica_gtm_warning":
      "Метрика настроена вместе с GTM: если тот же счётчик развёрнут и внутри контейнера GTM, хиты могут дублироваться.",
    "analytics.ga4_id": "Measurement ID",
    "analytics.ga4_id_hint": "Формат G-XXXXXXXXXX; ID контейнера GTM вводится в карточке GTM",
    "analytics.ga4_id_placeholder": "G-XXXXXXXXXX",
    "analytics.ga4_gtm_warning":
      "Google Analytics подключён напрямую. Если тот же Measurement ID также настроен внутри GTM, просмотры или события могут отправляться дважды.",
    "analytics.gtm_id": "Container ID",
    "analytics.gtm_id_hint": "Формат GTM-XXXXXXX",
    "analytics.gtm_id_placeholder": "GTM-XXXXXXX",
    "analytics.gtm_security_note":
      "GTM способен загружать сторонний код; производительность и поведение тегов внутри внешнего контейнера контролируются владельцем контейнера. GTM Custom JavaScript, требующий unsafe-eval, при строгом CSP не поддерживается — используйте Custom Templates.",
    "analytics.gtm_debug": "GTM Preview (отладка Tag Assistant)",
    "analytics.gtm_debug_note":
      "Добавляет origin-ы консоли предпросмотра (tagmanager.google.com, gstatic, Google Fonts). Диагностический режим: выключайте вне сессий предпросмотра.",
    "analytics.network_rules_title": "Дополнительные сетевые разрешения для тегов",
    "analytics.network_rules_hint":
      "Контролируемый список сторонних origin (только https, wildcard — только крайний левый поддомен). Изменение требует отдельного права и попадает в аудит.",
    "analytics.network_rules_empty": "Правил пока нет",
    "analytics.network_rules_add": "Добавить правило",
    "analytics.rule_origin": "Origin",
    "analytics.rule_origin_hint": "Например https://*.vendor.example",
    "analytics.rule_origin_placeholder": "https://*.vendor.example",
    "analytics.rule_label": "Название",
    "analytics.rule_directives": "Разрешения",
    "analytics.rule_add_button": "Добавить",
    "analytics.rule_remove": "Удалить",
    "analytics.rule_remove_aria": "Удалить правило для {origin}",
    "analytics.rule_save_hint":
      "После добавления или удаления правила нажмите «Сохранить» вверху страницы. Разрешайте только необходимые направления запросов — все чекбоксы отмечать не нужно.",
    "analytics.doctor_button": "Проверить установку",
    "analytics.doctor_done": "Проверка завершена",
    "analytics.doctor_failed": "Проверка не выполнена",
    "analytics.doctor_results": "Результаты проверки",
    "analytics.status_disabled": "Отключено",
    "analytics.status_configured": "Настроено",
    "analytics.status_render_ok": "Публичный рендер: OK",
    "analytics.status_invalid": "Конфигурация неверна",
  },
  {
    "analytics.screen_title": "Analytics & tags",
    "analytics.ownership_link":
      "Verify site ownership in Yandex Webmaster or Google Search Console →",
    "analytics.enable": "Enable",
    "analytics.save_button": "Save",
    "analytics.saved": "Analytics settings saved",
    "analytics.save_failed": "Failed to save settings",
    "analytics.load_failed": "Failed to load analytics settings",
    "analytics.card_metrica": "Yandex Metrica",
    "analytics.card_ga4": "Google Analytics 4",
    "analytics.card_gtm": "Google Tag Manager",
    "analytics.metrica_counter_id": "Counter ID",
    "analytics.metrica_counter_hint": "Digits only, 6–12 characters",
    "analytics.metrica_counter_placeholder": "12345678",
    "analytics.metrica_clickmap": "Click map",
    "analytics.metrica_tracklinks": "Outbound links",
    "analytics.metrica_bounce": "Accurate bounce",
    "analytics.metrica_webvisor": "Webvisor",
    "analytics.metrica_ecommerce": "E-commerce",
    "analytics.webvisor_note":
      "Webvisor must also be enabled in the Yandex Metrica counter settings. Form fields are protected (ym-disable-keys); field values never enter recordings.",
    "analytics.metrica_debug": "Allow counter checking in Yandex Metrica",
    "analytics.metrica_debug_note":
      "Enable this switch, click Save at the top and reopen the check in Metrica. No Admin logout is needed. Site maintenance mode must be off: it blocks Yandex and other visitors (HTTP 503). Checker scripts from yastatic.net and style attributes throughout the document are allowed temporarily. Disable and save after checking.",
    "analytics.metrica_gtm_warning":
      "Metrica is configured alongside GTM: if the same counter is also deployed inside the GTM container, hits may double.",
    "analytics.ga4_id": "Measurement ID",
    "analytics.ga4_id_hint": "G-XXXXXXXXXX format; GTM container ids belong to the GTM card",
    "analytics.ga4_id_placeholder": "G-XXXXXXXXXX",
    "analytics.ga4_gtm_warning":
      "Google Analytics is connected directly. If the same Measurement ID is also configured inside GTM, views or events may be sent twice.",
    "analytics.gtm_id": "Container ID",
    "analytics.gtm_id_hint": "GTM-XXXXXXX format",
    "analytics.gtm_id_placeholder": "GTM-XXXXXXX",
    "analytics.gtm_security_note":
      "GTM can load third-party code; performance and behavior of tags inside the external container are the container owner's responsibility. GTM Custom JavaScript requiring unsafe-eval is unsupported under strict CSP — use Custom Templates.",
    "analytics.gtm_debug": "GTM Preview (Tag Assistant debugging)",
    "analytics.gtm_debug_note":
      "Adds the preview console origins (tagmanager.google.com, gstatic, Google Fonts). Diagnostic mode: turn off outside preview sessions.",
    "analytics.network_rules_title": "External tag network permissions",
    "analytics.network_rules_hint":
      "Controlled third-party origin allowlist (https only, wildcard leftmost subdomain only). Editing requires a dedicated permission and is audited.",
    "analytics.network_rules_empty": "No rules yet",
    "analytics.network_rules_add": "Add rule",
    "analytics.rule_origin": "Origin",
    "analytics.rule_origin_hint": "e.g. https://*.vendor.example",
    "analytics.rule_origin_placeholder": "https://*.vendor.example",
    "analytics.rule_label": "Label",
    "analytics.rule_directives": "Permissions",
    "analytics.rule_add_button": "Add",
    "analytics.rule_remove": "Remove",
    "analytics.rule_remove_aria": "Remove rule for {origin}",
    "analytics.rule_save_hint":
      "After adding or removing a rule, click Save at the top. Allow only the required request types; selecting every checkbox is unnecessary.",
    "analytics.doctor_button": "Check installation",
    "analytics.doctor_done": "Check complete",
    "analytics.doctor_failed": "Check failed",
    "analytics.doctor_results": "Check results",
    "analytics.status_disabled": "Disabled",
    "analytics.status_configured": "Configured",
    "analytics.status_render_ok": "Public render: OK",
    "analytics.status_invalid": "Invalid configuration",
  },
);
