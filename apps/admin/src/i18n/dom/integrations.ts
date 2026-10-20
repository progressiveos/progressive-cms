// Integrations Hub fragment (SMTP runtime credentials + connector
// instances/bindings/deliveries/inbound + owner UX pass: human connection
// creation, bindings and delivery statuses). The ConnectionsTab secret
// editor keys (PCMS-OPS-T131) and mail_settings_* live in the base catalog.
import { defineFragment } from "../fragment.js";

export const integrations = defineFragment(
  {
    // SMTP TLS modes: human labels + hints (owner rule: protocol enums stay
    // internal; the port hint teaches the conventional port per mode).
    "integrations.mode_smtps": "TLS с самого начала (обычно порт 465)",
    "integrations.mode_starttls": "STARTTLS — рекомендуется (обычно порт 587)",
    "integrations.mode_plain": "Без шифрования (обычно порт 25)",
    "integrations.mode_smtps_hint": "Защищённое соединение с самого начала соединения.",
    "integrations.mode_starttls_hint": "Рекомендуется: соединение шифруется командой STARTTLS.",
    "integrations.mode_plain_hint": "Без шифрования — только для локальных релеев.",
    "integrations.secret_store_missing":
      "Безопасное хранилище секретов не настроено. Обратитесь к администратору сервера.",
    "integrations.field_on": "вкл",
    "integrations.field_off": "выкл",
    // Connections
    "integrations.connect_section_title": "Подключение внешних систем",
    "integrations.connect_section_text":
      "Здесь подключаются каналы, по которым CMS общается с внешними миром: Progressive HQ — приём заявок с форм и квизов в CRM (подписанный запрос, защита от дублей); почта — отправка писем; Telegram и Nextcloud Talk — уведомления в чат; webhook — вызов вашего сервиса по событию. Чтобы подключить: нажмите «Подключить», выберите тип, заполните поля — у каждого поля есть подсказка, что это и где взять значение. Секреты вводятся один раз, хранятся зашифрованно и больше не показываются. Отключение — переключателем на карточке подключения.",
    "integrations.connect_button": "Подключить",
    "integrations.edit_connection": "Изменить",
    "integrations.edit_connection_hint":
      "Изменить название и параметры подключения; секреты меняются отдельно в этом же окне.",
    "integrations.edit_connection_title": "Изменение подключения: ",
    "integrations.connection_updated": "Подключение обновлено",
    "integrations.edit_secrets_hint":
      "Значения секретов не показываются. Введите новое значение только в поле секрета, который нужно заменить.",
    "integrations.secret_already_set": "Секрет задан. Введите новое значение только для замены.",
    "integrations.secret_replace_placeholder": "•••••••• (заменить)",
    "integrations.save_connection": "Сохранить",
    "integrations.desc.progressive-hq":
      "Отправляет заявки с форм и квизов сайта в Progressive HQ: лид приходит в CRM как Intake-запись с полным текстом заявки. Нужен endpoint и секрет из админки HQ.",
    "integrations.desc.email":
      "Отправка писем через SMTP-транспорт (уведомления и шаблонные письма).",
    "integrations.desc.telegram": "Отправка сообщений в Telegram-чат через бота (уведомления).",
    "integrations.desc.nextcloud-talk": "Сообщения в Nextcloud Talk (уведомления команде).",
    "integrations.desc.webhook-http":
      "HTTP-вызов вашего сервиса по событию: URL, метод и заголовки настраиваются.",
    "integrations.desc.bitrix24":
      "Создаёт лиды в Bitrix24 CRM через входящий вебхук (crm.lead.add). Код вебхука хранится зашифрованно. Нужен входящий вебхук с правами crm.",
    "integrations.desc.amocrm":
      "Создаёт сделку с контактом в AmoCRM одним запросом (leads/complex). Нужен долгосрочный токен доступа из UI amoCRM.",
    "integrations.desc.hubspot":
      "Создаёт контакт и связанную сделку в HubSpot (API v3). Нужен private app token со scope crm.objects.contacts.write и crm.objects.deals.write.",
    "integrations.desc.pipedrive":
      "Создаёт персону и сделку в Pipedrive (API v1); персона ищется по email/телефону перед созданием. Нужен api_token из Settings → Personal → API.",
    "integrations.desc.zoho-crm":
      "Создаёт контакт и связанную сделку в Zoho CRM (REST v3). Нужны refresh token (scope ZohoCRM.modules.CREATE), client id и client secret; регион — zoho.com/zoho.eu/…",
    "integrations.desc.sharecrm":
      "Создаёт лид в ShareCRM/纷享销客 (FXiaoKe) через открытую платформу v2. Нужны appId, appSecret и постоянный код авторизации (永久授权码) из консоли приложения.",
    "integrations.desc.salesforce":
      "Создаёт Lead в Salesforce через REST API (Connected App, client-credentials). Нужны consumer key/secret; лиды дедуплицируются точным поиском по email.",
    "integrations.f.hq.base_url": "Адрес HQ",
    "integrations.f.hq.base_url_hint":
      "Адрес сервера Progressive HQ, который выдал endpoint и секрет (например, https://hq.domkes.ru).",
    "integrations.f.hq.slug": "Slug источника",
    "integrations.f.hq.slug_hint":
      "Имя inbound-endpoint'а, созданного в админке HQ (входит в URL приёма).",
    "integrations.f.hq.source_site": "Имя сайта",
    "integrations.f.hq.source_site_hint":
      "Короткое имя сайта латиницей (например, my-site) — без https://. Попадает в ID событий и в источник заявки в HQ.",
    "integrations.f.hq.timeout_ms": "Таймаут запроса, мс",
    "integrations.f.hq.timeout_ms_hint":
      "Сколько ждать ответа HQ. 15000 (15 секунд) — разумное значение по умолчанию.",
    "integrations.f.hq.signing_secret": "Секрет подписи",
    "integrations.f.hq.signing_secret_hint":
      "Секрет endpoint'а из админки HQ — показывается один раз при создании. Вводится здесь один раз, хранится зашифрованно. Потеряли — перевыпустите в HQ Admin.",
    "integrations.f.hq.send_attribution": "Передавать атрибуцию (UTM) в HQ",
    "integrations.f.hq.send_attribution_hint":
      "Добавляет к заявке источник рекламы (UTM, страница входа), сохранённый на сайте. Включать только после того, как HQ начнёт принимать это поле (иначе HQ отклонит заявку).",
    "integrations.f.email.from": "Адрес отправителя",
    "integrations.f.email.from_hint":
      "От чьего имени уходят письма, например notifications@ваш-домен.",
    "registry.upload_any_instance_hint":
      "Работает на любом инстансе — привязка к реестру не требуется. Хотите автоматически получать релизы и обновлять их — зарегистрируйте инстанс на my.p-cms.ru (код инстанса: {code}).",
    "registry.upload_any_instance_hint_nocode":
      "Работает на любом инстансе — привязка к реестру не требуется. Хотите автоматически получать релизы и обновлять их — зарегистрируйте инстанс на my.p-cms.ru.",
    "integrations.f.email.reply_to": "Reply-To",
    "integrations.f.email.reply_to_hint":
      "Куда придут ответы, если отличается от адреса отправителя.",
    "integrations.f.email.transport": "Секрет почтового транспорта",
    "integrations.f.email.transport_hint": "Учётные данные SMTP-транспорта из конфигурации почты.",
    "integrations.f.tg.chat": "Chat ID по умолчанию",
    "integrations.f.tg.chat_hint": "Куда бот пишет по умолчанию, если событие не указало чат явно.",
    "integrations.f.tg.preview": "Превью ссылок",
    "integrations.f.tg.preview_hint": "Показывать ли в Telegram превью ссылок из сообщения.",
    "integrations.f.tg.token": "Токен бота",
    "integrations.f.tg.token_hint":
      "Токен от @BotFather. Хранится зашифрованно и больше не показывается.",
    "integrations.f.talk.base_url": "Адрес Nextcloud",
    "integrations.f.talk.base_url_hint": "Адрес сервера Nextcloud с включённым Talk.",
    "integrations.f.talk.room": "Токен комнаты",
    "integrations.f.talk.room_hint": "Токен чата Talk из его URL.",
    "integrations.f.wh.url": "URL приёмника",
    "integrations.f.wh.url_hint": "Адрес вашего сервиса, который примет событие.",
    "integrations.f.wh.method": "HTTP-метод",
    "integrations.f.wh.method_hint": "Каким методом вызывать приёмник.",
    "integrations.f.wh.timeout": "Таймаут запроса, мс",
    "integrations.f.wh.timeout_hint": "Сколько ждать ответа приёмника.",
    "integrations.f.b24.portal": "Адрес портала Bitrix24",
    "integrations.f.b24.portal_hint":
      "Адрес вашего портала, например https://company.bitrix24.ru (без /rest/).",
    "integrations.f.b24.user": "ID пользователя",
    "integrations.f.b24.user_hint":
      "Числовой ID пользователя, под которым создан входящий вебхук (виден в самом URL вебхука).",
    "integrations.f.b24.code": "Код входящего вебхука",
    "integrations.f.b24.code_hint":
      "Секретная часть URL входящего вебхука (Разработчикам → Другое → Входящий вебхук, права crm). Хранится зашифрованно.",
    "integrations.f.b24.timeout": "Таймаут запроса, мс",
    "integrations.f.b24.timeout_hint": "Сколько ждать ответа Bitrix24.",
    "integrations.f.amo.domain": "Домен AmoCRM",
    "integrations.f.amo.domain_hint": "Домен вашего аккаунта, например company.amocrm.ru.",
    "integrations.f.amo.pipeline": "ID воронки (необязательно)",
    "integrations.f.amo.pipeline_hint":
      "Если указать, сделки создаются в этой воронке; иначе — по умолчанию аккаунта.",
    "integrations.f.amo.presentation": "ID поля «Заявка с сайта» (необязательно)",
    "integrations.f.amo.presentation_hint":
      "ID текстового поля сделки для полного текста заявки (создайте поле в AmoCRM и впишите ID). Без него отправляются только имя и контакты.",
    "integrations.f.amo.timeout": "Таймаут запроса, мс",
    "integrations.f.amo.timeout_hint": "Сколько ждать ответа AmoCRM.",
    "integrations.f.amo.token": "Долгосрочный токен",
    "integrations.f.amo.token_hint":
      "Долгосрочный токен доступа из UI amoCRM (Настройки → Интеграции → ваш канал). Хранится зашифрованно.",
    "integrations.create_connection_title": "Новое подключение",
    "integrations.connection_type_label": "Тип",
    "integrations.connection_name_label": "Название",
    "integrations.connection_config_title": "Параметры",
    "integrations.connection_secrets_title": "Секреты (хранятся зашифрованно)",
    "integrations.connection_save_test": "Сохранить и проверить",
    "integrations.connection_created": "Подключение создано",
    "integrations.connection_test_ok": "Проверка пройдена",
    "integrations.connection_test_failed": "Проверка не пройдена",
    "integrations.connection_config_json_invalid": "Сложное поле должно содержать корректный JSON.",
    "integrations.instances_empty_title": "Пока нет настроенных подключений",
    "integrations.instances_empty_hint":
      "Нажмите «Подключить», чтобы создать первое подключение: Telegram, Nextcloud Talk, Webhook, Progressive HQ.",
    "integrations.state_enabled": "включено",
    "integrations.state_disabled": "выключено",
    "integrations.secret_refs": "секреты:",
    "integrations.secret_refs_note": "(ссылки, не значения)",
    "integrations.no_secrets": "без секретов",
    "integrations.test": "Проверить",
    "integrations.error_fallback": "ошибка",
    // Events and bindings (human labels; technical names stay secondary)
    "integrations.event_lead_created": "Когда создан лид",
    "integrations.event_form_submitted": "Когда отправлена форма",
    "integrations.event_quiz_completed": "Когда завершён квиз",
    "integrations.event_quiz_started": "Когда начат квиз",
    "integrations.event_quiz_abandoned": "Когда брошен квиз",
    "integrations.event_lead_status_changed": "Когда изменён статус лида",
    "integrations.event_payment_status_changed": "Когда изменён статус платежа",
    "integrations.notify_lead_created": "Новый лид с сайта",
    "integrations.notify_form_submitted": "Новая отправка формы",
    "integrations.notify_quiz_completed": "Квиз завершён",
    "integrations.notify_generic": "Событие: {event}",
    "integrations.add_binding": "+ Привязка",
    "integrations.binding_create_title": "Новая привязка",
    "integrations.binding_when": "Когда",
    "integrations.binding_where": "Куда",
    "integrations.binding_email_destination": "Адрес получателя",
    "integrations.binding_created": "Привязка создана",
    "integrations.binding_no_default_action":
      "Для этой пары событие→подключение нет типового действия — настройте привязку через API/MCP.",
    "integrations.binding_action_preview": "Действие",
    "integrations.bindings_empty_title": "Привязок нет",
    "integrations.bindings_empty_hint":
      "Привязка соединяет событие (например, «Когда создан лид») с подключением.",
    "integrations.binding_enabled": "включена",
    "integrations.binding_disabled": "выключена",
    "integrations.actions_count": "действий:",
    // Deliveries
    "integrations.delivery_status_succeeded": "Доставлено",
    "integrations.delivery_status_pending": "Ожидает отправки",
    "integrations.delivery_status_processing": "Доставляется",
    "integrations.delivery_status_failed_retryable": "Ошибка — будет повтор",
    "integrations.delivery_status_failed_permanent": "Ошибка — без повтора",
    "integrations.delivery_status_cancelled": "Отменено",
    "integrations.inbound_status_received": "Получено",
    "integrations.inbound_status_processed": "Обработано",
    "integrations.inbound_status_failed": "Ошибка",
    "integrations.external_id": "ID во внешней системе",
    "integrations.deliveries_empty_hint":
      "Каждое исходящее действие получает запись доставки с полной историей попыток.",
    "integrations.attempts": "попытки:",
    "integrations.attempts_history": "История попыток",
    "integrations.retry": "Повторить",
    "integrations.attempt": "Попытка",
    "integrations.inbound_empty_title": "Входящих событий нет",
    "integrations.inbound_empty_hint":
      "Провайдерские колбэки проходят проверку подписи и дедупликацию до обработки.",
    "integrations.tab_connections": "Соединения",
    "integrations.tab_bindings": "Привязки",
    "integrations.tab_deliveries": "Доставки",
    "integrations.tab_failures": "Сбои / Повторы",
    "integrations.tab_inbound": "Входящие события",
    "integrations.deliveries_empty_failures": "Сбоев нет",
    "integrations.deliveries_empty_none": "Доставок пока нет",
    "integrations.inbound_no_type": "без типа",
    "integrations.tab_failures_aria": "Сбои",
    "integrations.title": "Интеграции",
    "integrations.denied_title": "Недостаточно прав",
    "integrations.denied_hint": "Требуется integrations.read.",
    "integrations.sections_label": "Разделы интеграций",
  },
  {
    "integrations.mode_smtps": "Implicit TLS (usually port 465)",
    "integrations.mode_starttls": "STARTTLS — recommended (usually port 587)",
    "integrations.mode_plain": "No encryption (usually port 25)",
    "integrations.mode_smtps_hint": "The connection is TLS-protected from the start.",
    "integrations.mode_starttls_hint": "Recommended: the connection upgrades via STARTTLS.",
    "integrations.mode_plain_hint": "No encryption — local relays only.",
    "integrations.secret_store_missing":
      "The secure secret store is not configured. Contact the server administrator.",
    "integrations.field_on": "on",
    "integrations.field_off": "off",
    "integrations.connect_section_title": "Connect external systems",
    "integrations.connect_section_text":
      "These are the channels CMS uses to talk to the outside world: Progressive HQ — site form and quiz submissions arrive in the CRM as signed, deduplicated intakes; email — outbound mail; Telegram and Nextcloud Talk — chat notifications; webhook — call your own service on events. To connect: press Connect, pick a type, fill in the fields — every field has a hint explaining what it is and where the value comes from. Secrets are entered once, stored encrypted, never shown again. Disconnect with the toggle on the connection card.",
    "integrations.connect_button": "Connect",
    "integrations.edit_connection": "Edit",
    "integrations.edit_connection_hint":
      "Edit the connection name and parameters; secrets are replaced separately in this dialog.",
    "integrations.edit_connection_title": "Edit connection: ",
    "integrations.connection_updated": "Connection updated",
    "integrations.edit_secrets_hint":
      "Secret values are never shown. Enter a new value only for the secret you want to replace.",
    "integrations.secret_already_set": "Secret is set. Enter a new value only to replace it.",
    "integrations.secret_replace_placeholder": "•••••••• (replace)",
    "integrations.save_connection": "Save",
    "integrations.desc.progressive-hq":
      "Delivers site form and quiz submissions to Progressive HQ: the lead arrives in the CRM as an Intake record with the full readable submission. Needs an endpoint and secret from the HQ admin.",
    "integrations.desc.email":
      "Sends email through the SMTP transport (notifications and template mail).",
    "integrations.desc.telegram":
      "Posts messages to a Telegram chat through a bot (notifications).",
    "integrations.desc.nextcloud-talk": "Posts to Nextcloud Talk (team notifications).",
    "integrations.desc.webhook-http":
      "HTTP call to your own service on an event: URL, method and headers are configurable.",
    "integrations.desc.bitrix24":
      "Creates leads in Bitrix24 CRM through an incoming webhook (crm.lead.add). The webhook code is stored encrypted. Needs an incoming webhook with crm rights.",
    "integrations.desc.amocrm":
      "Creates a deal with contact in AmoCRM in one call (leads/complex). Needs a long-lived access token from the amoCRM UI.",
    "integrations.desc.hubspot":
      "Creates a HubSpot contact and an associated deal (API v3). Needs a private app token with crm.objects.contacts.write and crm.objects.deals.write scopes.",
    "integrations.desc.pipedrive":
      "Creates a person and a deal in Pipedrive (API v1); the person is deduped by email/phone search first. Needs the api_token from Settings → Personal → API.",
    "integrations.desc.zoho-crm":
      "Creates a contact and an associated deal in Zoho CRM (REST v3). Needs a refresh token (ZohoCRM.modules.CREATE scope), client id and client secret; region — zoho.com/zoho.eu/…",
    "integrations.desc.sharecrm":
      "Creates a lead in ShareCRM (纷享销客/FXiaoKe) through the open platform v2 API. Needs appId, appSecret and the permanent authorization code from the app console.",
    "integrations.desc.salesforce":
      "Creates a Salesforce Lead through the REST API (Connected App, client-credentials flow). Needs the consumer key/secret; leads are deduped by an exact-email query.",
    "integrations.f.hq.base_url": "HQ address",
    "integrations.f.hq.base_url_hint":
      "Address of the Progressive HQ server that issued the endpoint and secret (e.g. https://hq.domkes.ru).",
    "integrations.f.hq.slug": "Source slug",
    "integrations.f.hq.slug_hint":
      "Name of the inbound endpoint created in the HQ admin (part of the intake URL).",
    "integrations.f.hq.source_site": "Site name",
    "integrations.f.hq.source_site_hint":
      "Short latin site name (e.g. my-site) — no https://. Becomes part of event IDs and the acquisition source in HQ.",
    "integrations.f.hq.timeout_ms": "Request timeout, ms",
    "integrations.f.hq.timeout_ms_hint":
      "How long to wait for the HQ response. 15000 (15 seconds) is a sensible default.",
    "integrations.f.hq.send_attribution": "Send attribution (UTM) to HQ",
    "integrations.f.hq.send_attribution_hint":
      "Attaches the ad source (UTM, landing path) captured on the site to each lead. Enable only after the HQ starts accepting this field (otherwise HQ rejects the intake).",
    "integrations.f.hq.signing_secret": "Signing secret",
    "integrations.f.hq.signing_secret_hint":
      "The endpoint secret from the HQ admin — shown once at creation. Enter it here once; it is stored encrypted. Lost it? Rotate in the HQ admin.",
    "integrations.f.email.from": "From address",
    "integrations.f.email.from_hint":
      "The address mail is sent from, e.g. notifications@your-domain.",
    "registry.upload_any_instance_hint":
      "Works on any instance — registry binding is not required. To receive releases and update automatically, register the instance at my.p-cms.ru (instance code: {code}).",
    "registry.upload_any_instance_hint_nocode":
      "Works on any instance — registry binding is not required. To receive releases and update automatically, register the instance at my.p-cms.ru.",
    "integrations.f.email.reply_to": "Reply-To",
    "integrations.f.email.reply_to_hint": "Where replies land, if different from the sender.",
    "integrations.f.email.transport": "Mail transport secret",
    "integrations.f.email.transport_hint":
      "SMTP transport credentials from the mail configuration.",
    "integrations.f.tg.chat": "Default chat ID",
    "integrations.f.tg.chat_hint": "Where the bot posts when an event does not name a chat.",
    "integrations.f.tg.preview": "Link previews",
    "integrations.f.tg.preview_hint": "Whether Telegram shows link previews for posted messages.",
    "integrations.f.tg.token": "Bot token",
    "integrations.f.tg.token_hint":
      "The token from @BotFather. Stored encrypted, never shown again.",
    "integrations.f.talk.base_url": "Nextcloud address",
    "integrations.f.talk.base_url_hint": "Address of the Nextcloud server with Talk enabled.",
    "integrations.f.talk.room": "Room token",
    "integrations.f.talk.room_hint": "The Talk chat token from its URL.",
    "integrations.f.wh.url": "Receiver URL",
    "integrations.f.wh.url_hint": "Address of your service that accepts the event.",
    "integrations.f.wh.method": "HTTP method",
    "integrations.f.wh.method_hint": "How the receiver is called.",
    "integrations.f.wh.timeout": "Request timeout, ms",
    "integrations.f.wh.timeout_hint": "How long to wait for the receiver.",
    "integrations.f.b24.portal": "Bitrix24 portal address",
    "integrations.f.b24.portal_hint":
      "Your portal address, e.g. https://company.bitrix24.ru (no /rest/).",
    "integrations.f.b24.user": "User ID",
    "integrations.f.b24.user_hint":
      "Numeric ID of the user the incoming webhook was created under (visible in the webhook URL).",
    "integrations.f.b24.code": "Incoming webhook code",
    "integrations.f.b24.code_hint":
      "Secret part of the incoming webhook URL (Developer resources → Other → Incoming webhook, crm rights). Stored encrypted.",
    "integrations.f.b24.timeout": "Request timeout, ms",
    "integrations.f.b24.timeout_hint": "How long to wait for Bitrix24.",
    "integrations.f.amo.domain": "AmoCRM domain",
    "integrations.f.amo.domain_hint": "Your account domain, e.g. company.amocrm.ru.",
    "integrations.f.amo.pipeline": "Pipeline ID (optional)",
    "integrations.f.amo.pipeline_hint":
      "If set, deals are created in this pipeline; otherwise the account default.",
    "integrations.f.amo.presentation": "«Site request» field ID (optional)",
    "integrations.f.amo.presentation_hint":
      "ID of a deal text field where the full readable submission is stored (create the field in AmoCRM and enter its ID). Without it only the name and contacts are sent.",
    "integrations.f.amo.timeout": "Request timeout, ms",
    "integrations.f.amo.timeout_hint": "How long to wait for AmoCRM.",
    "integrations.f.amo.token": "Long-lived token",
    "integrations.f.amo.token_hint":
      "Long-lived access token from the amoCRM UI (Settings → Integrations → your channel). Stored encrypted.",
    "integrations.create_connection_title": "New connection",
    "integrations.connection_type_label": "Type",
    "integrations.connection_name_label": "Name",
    "integrations.connection_config_title": "Settings",
    "integrations.connection_secrets_title": "Secrets (stored encrypted)",
    "integrations.connection_save_test": "Save and test",
    "integrations.connection_created": "Connection created",
    "integrations.connection_test_ok": "Test passed",
    "integrations.connection_test_failed": "Test failed",
    "integrations.connection_config_json_invalid": "Complex fields must contain valid JSON.",
    "integrations.instances_empty_title": "No connections configured yet",
    "integrations.instances_empty_hint":
      "Press “+ Add connection” to create the first one: Telegram, Nextcloud Talk, Webhook, Progressive HQ.",
    "integrations.state_enabled": "enabled",
    "integrations.state_disabled": "disabled",
    "integrations.secret_refs": "secrets:",
    "integrations.secret_refs_note": "(references, not values)",
    "integrations.no_secrets": "no secrets",
    "integrations.test": "Test",
    "integrations.error_fallback": "error",
    "integrations.event_lead_created": "When a lead is created",
    "integrations.event_form_submitted": "When a form is submitted",
    "integrations.event_quiz_completed": "When a quiz is completed",
    "integrations.event_quiz_started": "When a quiz is started",
    "integrations.event_quiz_abandoned": "When a quiz is abandoned",
    "integrations.event_lead_status_changed": "When a lead status changes",
    "integrations.event_payment_status_changed": "When a payment status changes",
    "integrations.notify_lead_created": "New lead from the site",
    "integrations.notify_form_submitted": "New form submission",
    "integrations.notify_quiz_completed": "Quiz completed",
    "integrations.notify_generic": "Event: {event}",
    "integrations.add_binding": "+ Add binding",
    "integrations.binding_create_title": "New binding",
    "integrations.binding_when": "When",
    "integrations.binding_where": "Where",
    "integrations.binding_email_destination": "Recipient address",
    "integrations.binding_created": "Binding created",
    "integrations.binding_no_default_action":
      "This event→connection pair has no default action — configure the binding via API/MCP.",
    "integrations.binding_action_preview": "Action",
    "integrations.bindings_empty_title": "No bindings yet",
    "integrations.bindings_empty_hint":
      "A binding connects an event (for example “When a lead is created”) to a connection.",
    "integrations.binding_enabled": "enabled",
    "integrations.binding_disabled": "disabled",
    "integrations.actions_count": "actions:",
    "integrations.delivery_status_succeeded": "Delivered",
    "integrations.delivery_status_pending": "Waiting to send",
    "integrations.delivery_status_processing": "Delivering",
    "integrations.delivery_status_failed_retryable": "Failed — will retry",
    "integrations.delivery_status_failed_permanent": "Failed — no retry",
    "integrations.delivery_status_cancelled": "Cancelled",
    "integrations.inbound_status_received": "Received",
    "integrations.inbound_status_processed": "Processed",
    "integrations.inbound_status_failed": "Failed",
    "integrations.external_id": "External ID",
    "integrations.deliveries_empty_hint":
      "Every outbound action gets a delivery record with the full attempt history.",
    "integrations.attempts": "attempts:",
    "integrations.attempts_history": "Attempt history",
    "integrations.retry": "Retry",
    "integrations.attempt": "Attempt",
    "integrations.inbound_empty_title": "No inbound events",
    "integrations.inbound_empty_hint":
      "Provider callbacks pass signature verification and deduplication before processing.",
    "integrations.tab_connections": "Connections",
    "integrations.tab_bindings": "Bindings",
    "integrations.tab_deliveries": "Deliveries",
    "integrations.tab_failures": "Failures / Retries",
    "integrations.tab_inbound": "Inbound events",
    "integrations.deliveries_empty_failures": "No failures",
    "integrations.deliveries_empty_none": "No deliveries yet",
    "integrations.inbound_no_type": "no type",
    "integrations.tab_failures_aria": "Failures",
    "integrations.title": "Integrations",
    "integrations.denied_title": "Insufficient permissions",
    "integrations.denied_hint": "integrations.read is required.",
    "integrations.sections_label": "Integration sections",
  },
);
