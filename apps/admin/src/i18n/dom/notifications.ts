import { defineFragment } from "../fragment.js";

// Notifications v1 (owner brief 2026-10-07): event e-mail to site users —
// per-category recipient routing, MODX-style per-form overrides, per-user
// subscriptions (ЛК) with immediate/digest cadence.
export const notifications = defineFragment(
  {
    "notifications.screen_title": "Уведомления",
    "notifications.screen_hint":
      "Кому уходят письма о лидах, ответах форм, квизах и системных событиях. Получатели — пользователи сайта; каждый администратор дополнительно управляет своими подписками в меню аккаунта.",
    "notifications.site_name_label": "Название сайта в письмах",
    "notifications.site_name_hint": "Подпись в шапке фирменного шаблона письма.",
    "notifications.cat_leads": "Лиды",
    "notifications.cat_forms": "Ответы форм",
    "notifications.cat_quizzes": "Квизы",
    "notifications.cat_system": "Системные события",
    "notifications.cat_system_hint":
      "Получатели — администраторы (владелец, админы, разработчики): итоги обновлений, сбои доставок интеграций, техрежим. Список настраивается их подписками в меню аккаунта.",
    "notifications.recipients_label": "Получатели",
    "notifications.recipients_hint":
      "Отметьте пользователей сайта — каждому придёт письмо на его e-mail из учётной записи.",
    "notifications.recipients_empty": "Активных пользователей с e-mail нет.",
    "notifications.forms_override_title": "Свои получатели по формам",
    "notifications.forms_override_hint":
      "Форма со своим списком шлёт ответы и лиды только ему (например, отделу); остальные формы — по общему списку «Ответы форм».",
    "notifications.forms_empty": "Форм пока нет.",
    "notifications.override_toggle": "Своя рассылка для этой формы",
    "notifications.save": "Сохранить",
    "notifications.saved": "Настройки уведомлений сохранены",
    "notifications.save_failed": "Не удалось сохранить настройки уведомлений",
    "notifications.load_failed": "Не удалось загрузить настройки уведомлений",
    "notifications.prefs_title": "Уведомления",
    "notifications.prefs_hint":
      "Что присылать вам на e-mail из учётной записи. По умолчанию включено всё, доставка — немедленно.",
    "notifications.prefs_language": "Язык писем",
    "notifications.prefs_language_ru": "Русский",
    "notifications.prefs_language_en": "English",
    "notifications.prefs_digest_label": "Частота",
    "notifications.prefs_digest_immediate": "Немедленно",
    "notifications.prefs_digest_1h": "Раз в час",
    "notifications.prefs_digest_3h": "Раз в 3 часа",
    "notifications.prefs_digest_6h": "Раз в 6 часов",
    "notifications.prefs_digest_12h": "Раз в 12 часов",
    "notifications.prefs_saved": "Подписки сохранены",
    "notifications.prefs_failed": "Не удалось сохранить подписки",
    "notifications.prefs_user_only":
      "Подписки настраиваются в аккаунте пользователя (не сервисного токена).",
  },
  {
    "notifications.screen_title": "Notifications",
    "notifications.screen_hint":
      "Who gets e-mail about leads, form submissions, quizzes and system events. Recipients are site users; every admin additionally tunes their own subscriptions in the account menu.",
    "notifications.site_name_label": "Site name in e-mails",
    "notifications.site_name_hint": "Signature in the branded template header.",
    "notifications.cat_leads": "Leads",
    "notifications.cat_forms": "Form submissions",
    "notifications.cat_quizzes": "Quizzes",
    "notifications.cat_system": "System events",
    "notifications.cat_system_hint":
      "Recipients are admins (owner, admins, developers): update outcomes, integration delivery failures, maintenance mode. Each admin's account-menu subscriptions decide who exactly.",
    "notifications.recipients_label": "Recipients",
    "notifications.recipients_hint":
      "Check site users — each receives e-mail at their account address.",
    "notifications.recipients_empty": "No active users with an e-mail.",
    "notifications.forms_override_title": "Per-form recipients",
    "notifications.forms_override_hint":
      "A form with its own list sends submissions and leads only there (e.g. a department inbox); other forms follow the general “Form submissions” list.",
    "notifications.forms_empty": "No forms yet.",
    "notifications.override_toggle": "Custom routing for this form",
    "notifications.save": "Save",
    "notifications.saved": "Notification settings saved",
    "notifications.save_failed": "Failed to save notification settings",
    "notifications.load_failed": "Failed to load notification settings",
    "notifications.prefs_title": "Notifications",
    "notifications.prefs_hint":
      "What to e-mail to your account address. Everything is enabled and delivered immediately by default.",
    "notifications.prefs_language": "E-mail language",
    "notifications.prefs_language_ru": "Russian",
    "notifications.prefs_language_en": "English",
    "notifications.prefs_digest_label": "Cadence",
    "notifications.prefs_digest_immediate": "Immediately",
    "notifications.prefs_digest_1h": "Hourly",
    "notifications.prefs_digest_3h": "Every 3 hours",
    "notifications.prefs_digest_6h": "Every 6 hours",
    "notifications.prefs_digest_12h": "Every 12 hours",
    "notifications.prefs_saved": "Subscriptions saved",
    "notifications.prefs_failed": "Failed to save subscriptions",
    "notifications.prefs_user_only": "Subscriptions apply to user accounts (not service tokens).",
  },
);
