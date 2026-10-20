# Действия на Progressive CMS

Все необходимые ссылки находятся внутри Skill. API origin — без `/api/v1`; запросы несут Bearer из secret/environment, `X-PCMS-Site`, `X-PCMS-Environment`. Для cookie-мутаций нужен CSRF. Полные выбранные схемы: [api-operations.json](api-operations.json). Готовый запрос не даёт полномочий на чужой сайт.

## 1. Прочитать состояние

`cms agent bootstrap --json` — цель/версия/scopes; `cms capabilities` — только локальный скомпилированный каталог. Через разрешённый REST прочитай `/agent/bootstrap`, `/capabilities`, `/forms`, `/quizzes`, `/analytics/settings`, `/analytics/providers`, `/settings/site-identity`, `/themes/active`. Интеграции — `/integrations/instances` при отдельном read scope; не проси доступ к реальным submissions/leads для конфигурации форм.

Список MCP-инструментов не даёт разрешений. В актуальном Core protected tools проходят доверенный authorizeTool (permission + site) до binding; отсутствие authorizer закрывает доступ. Старый установленный сервер может не иметь этого исправления: проверь минимальными синтетическими отрицательными тестами ограничение ненужного REST/MCP-доступа, не чтением чужих реальных заявок.

## 2. Формы: полная версия, серверная проверка, срок

`GET /forms/<id>` возвращает identity + текущую версию. `PUT /forms/<id>` принимает очередную **полную** версию, не частичный патч поля. Сохрани schema/поле/settings из ответа, исправь только необходимые части и не потеряй интеграции/lead policy. Аналогично квизам; используй их собственную схему.

Тип `consent` поддерживает `required`, `consent_key`, `consent_text`, `policy_reference`. Структурный пример одного поля:

```json
{
  "key": "pd_request",
  "type": "consent",
  "label": "Согласие на обработку данных обращения",
  "required": true,
  "consent_key": "request_reply",
  "consent_text": "ЗДЕСЬ РАЗМЕЩАЕТСЯ ТОЧНЫЙ УТВЕРЖДЁННЫЙ ВЛАДЕЛЬЦЕМ ТЕКСТ",
  "policy_reference": "/privacy/approved-version/"
}
```

Этот пример нельзя публиковать с placeholder. `required:true` выбирай только для утверждённого consent-основания, не для любой формы по умолчанию. При обычной отправке `values.pd_request` — boolean; строка FormData `"true"` не заменяет его. Сервер сохраняет consent_key, field_key, accepted, accepted_at, text, policy_reference и schema_version. Он не сохраняет автоматически содержимое изменяемой страницы по policy_reference и не подтверждает рекламное согласие другим флагом.

`settings.retention` имеет `mode: retain | anonymize | delete`, `after_days`. **`retain` означает бессрочное удержание даже при указанном after_days**; не копируй этот демонстрационный режим как исполнение утверждённого срока. `delete` удаляет взаимодействие и связанные provenance leads; `anonymize` очищает часть данных, но не является юридическим заключением об обезличивании всего контура.

Worker планирует `forms.retention-sweep` ежедневно. Выбранные anonymize/delete обрабатывают **ACTIVE и ARCHIVED** definitions; архивирование не отменяет политику. `retain` остаётся намеренным бессрочным хранением, это выбор владельца. Проверяй Worker и накопившиеся данные на разрешённой синтетике; sweep не доказывает удаление внешних/экспортированных/backup копий.

Для выбранных владельцем адресных операций теперь есть поддерживаемые block/unblock/rectify/erase с preview, CAS token, request id, receipt и recipient followups. Пошаговый [публичный контракт инструментов](personal-data-tools.md) полностью включён в этот Skill. Перед применением нужны обновлённые Web **и все Workers**, migration 0005_interaction_privacy и явно выданный privacy.manage. Это не обязательный этап обычной CMS-работы, не per-record tenancy и не автоматическое обнаружение всех данных человека. Превью/receipt могут содержать чувствительные IDs; не выгружай их без необходимости. Если доступна только старая установленная версия, сообщи, какие операции фактически отсутствуют, вместо прямого SQL.

Синтетический POST `/public/forms/<id>/submit` проверяет приём, но не доказывает законность основания, неизменяемость внешнего документа или завершение доставки/удаления. Отдельно проверь отрицательную отправку с отсутствующим/false обязательным consent.

## 3. Analytics: безопасное исходное состояние

`GET /analytics/settings` → read/modify/write через `PUT /analytics/settings` с `settings` и `expected_generation`. Сохрани остальные ключи и networkRules. `POST /analytics/doctor` — диагностика, а не проверка consent. У providers есть `enabled`, `activationPolicy` (`immediate`, `analytics_consent`, `marketing_consent`).

Политика провайдера — выбор владельца: `immediate` (default) работает независимо от consent API, `analytics_consent` и `marketing_consent` откладывают **и bootstrap/инициализацию, и loader** до разрешения своей категории. Core не требует consent-политику всех провайдеров для запуска сайта. Не меняй выбранный владельцем режим только ради формального checklist; если задание требует consent-гейтинга, реализуй именно этот режим и проверь сеть.

`window.pcmsConsent.getState()` → копия `{analytics:boolean,marketing:boolean}`. `grant("analytics"|"marketing")` активирует только свою категорию; `revoke(category)` сохраняет отказ. Событие `pcms:consent` содержит detail.category и копию detail.state. Выбор хранится по siteKey/origin/config провайдеров; изменение набора/настроек сбрасывает grants. При read-only storage старый grant не восстанавливается: новый выбор действует лишь в текущем документе, следующий визит требует нового выбора.

Если отозванный тег уже загружен, Core останавливает свои дальнейшие сигналы и перезагружает документ, сохраняя другие разрешённые категории. Cross-tab revoke/clear также учитывается; при storage-сбое временный `_pcms_consent_revoke` переносит отказ и удаляется после успешного сохранения. Это не удаление cookies поставщика, не отмена отправленных/in-flight запросов и не управление произвольными тегами внутри GTM/собственного JS/CMP. Проверь fresh/return visit, одну категорию, отзыв загруженного тега, другую вкладку и storage failure. Статические settings/doctor не заменяют сетевой результат и не являются vendor certification.

Проверенная обработка событий может сохранять href tel/mailto/CTA в dataLayer. Удали пользовательские адреса, токены и ПД из таких href/параметров; не считай маскирование form inputs достаточным для URL. Webvisor/clickmaps/debug mode не включай «для проверки SEO». При сохранении отключённого provider проверь сеть: старый GTM/iframe из темы/CDN может продолжать работать независимо от CMS.

## 4. Изменить тему и откатить при необходимости

Новая тема: проверенный пакет → `POST /themes/install` → `POST /theme/activate`. Для обновления того же id: `cms theme update-active <file> --environment <env> --yes --json`. Подготовка/подтверждение идут через journal; после прерванного ответа прочитай фактически served state и lifecycle generation, не копируй файлы вручную.

Сначала проверь наличие history/rollback на фактическом сервере: baseline manifest не обещает все последующие возможности. При отсутствии — сообщи ограничение.

`cms theme revisions --json` / `GET /themes/revisions` возвращают `theme_generation` и сохранённые подтверждённые ревизии (active + newest, максимум 100). Согласованный откат: `cms theme rollback <revision-id> --expected-generation <theme_generation> --environment <env> --yes --json`, или POST `/themes/rollback` с `revision_id`, `expected_generation`. Это не `settings_generation` и не Content revision. Чтение истории доступно через MCP, а preview/apply cleanup — через MCP и Admin; MCP rollback остаётся недоступным. Cleanup — отдельное необратимое действие ниже, не часть удаления ПД.

Откат может вернуть старые внешние ресурсы/настройки. Сразу повтори privacy smoke для сети/форм: предыдущая версия не обязательно соответствует новой политике. Установленный package head и active revision различаются; после отката update-active всё ещё требует версию выше установленного head.

## 5. Завершение

Не превращай техническую задачу в чтение всех реальных заявок. Для серверной проверки доступа, retention, местонахождения, восстановления и утверждённого профиля ИБ получи минимальное обезличенное операторское доказательство или разрешённый тестовый контур. В [акте](../assets/acceptance.md) отдели выполненные изменения, открытые Core/инфраструктурные ограничения и список юридических действий владельца.

## Изменение существующей страницы

Прочитай `/discovery/content/types` (при необходимости `/discovery/content/types/<key>`), опубликованный pointer `/publications/entry/<entry-id>` и revision. Сохраняй тип, template, родителя и unrelated fields. `bodyPolicy=rich_text` использует зарегистрированное RichText-поле (AST document schema_version 2); `block_document` — payload.blocks с envelope v1 и зарегистрированными блоками; `none` не получает скрытое тело. Не подменяй эти модели друг другом ради H1/юридического текста. Изменение темы — локальный пакет через разрешённый lifecycle, не правка Core.

```sh
cms content draft --entry <entry-id> --json
cms content patch --revision <working-id> --file <full-payload.json> --expected-generation <edit_generation> --json
cms content preview --entity-id <entry-id> --revision <working-id> --allow-draft --json
cms content seal --revision <working-id> --expected-generation <fresh-edit_generation> --environment <env> --yes --json
```

Draft может переиспользовать WORKING. Перед patch прочитай `GET /revisions/<working-id>` и сохрани полный payload; после 409 перечитай/согласуй, не угадывай generation. Перед seal: `POST /revisions/<id>/validate` с `{}` и проверка именно этой preview. SEALED неизменяем; seal не публикует. Публикация при существующем live route — `POST /publications/publish` с `entity_type:"entry"`, `entity_id`, `target_revision_id`, **фактическим publication expected_generation** из чтения. Это другая generation. Выполняй только разрешённую публичную мутацию, затем проверь реальный URL/HTML. Preview URL не раскрывай.

### Если утверждённый документ ещё не имеет страницы/маршрута

Создай entry через `POST /entries` по обнаруженной схеме и подходящему шаблону, используя только утверждённый текст. Сохрани entry/revision ids, проверь/preview/seal. Direct publish без live route вернёт `PUBLICATION_ROUTE_MISSING`: нужна ChangeSet с route operation. `POST /changesets` с `{ "title": "Publish approved page" }`, затем в возвращённый id `POST /changesets/<id>/items`:

```json
{
  "entity_type": "entry",
  "entity_id": "<created-entry-id>",
  "intent": "PUBLISH",
  "target_revision_id": "<sealed-revision-id>",
  "expected_generation": 0,
  "route_operation": {"kind": "set", "site_id": "<actual-site-id>", "path": "/approved-document/"}
}
```

Ноль применим только к действительно never-published identity; path и site_id — согласованные значения целевого сайта, не литералы примера. Для мультиязычного сайта согласуй publication context и route locale. `POST /changesets/<id>/preflight` → исправить issues/проверить ok → разрешённый `POST /changesets/<id>/apply`. Создание/items/preflight требуют `publication.plan`, apply — `publication.publish`. Ничего не публикуй при отсутствующем тексте/основании/правах. Не создавай новый маршрут поверх занятого и не заменяй этот путь SQL или выдуманной CLI-командой.

### Очистка истории темы — отдельное необратимое действие

MCP `cms_list_theme_revisions` теперь читает историю; `cms_cleanup_theme_revisions` выполняет preview/apply. Admin: **Theme → Theme history cleanup / Очистка истории тем**, `/admin/#/theme`, preview → выбор отдельных ревизий → подтверждение. MCP rollback по-прежнему отсутствует. Uninstall installed package и cleanup history — разные операции; автоматической очистки подтверждённой истории нет.

Не запускай cleanup как обычную privacy/SEO-оптимизацию: нужны отдельное разрешение на уничтожение snapshots и просмотр кандидатов. Это не удаление ПД по заявлению субъекта. **Удаление необратимо:** rollback и старые revision asset URL перестают работать, в том числе у давно открытых страниц. Active renderer/settings/catalog, content и routes не меняются.

CLI: `cms theme cleanup --dry-run --json`; разрешённое применение — `cms theme cleanup --apply --environment <env> --yes --json`. CLI сам делает preview и отправляет ровно его IDs + theme_generation. По умолчанию только preview. Опции: `--keep-last 5..100` (default 5), `--older-than-days 1..36500` (default 1). Не повторяй после stale автоматически. Партия максимум 100; `has_more` требует следующей просмотренной партии.

REST POST `/themes/revisions/cleanup`, preview требует theme.read, apply theme.write; cookie CSRF нужен и для POST preview. MCP использует те же поля и условные permissions (mutation annotation остаётся true):

```json
{"dry_run":true,"keep_last":5,"older_than_days":1}
```

```json
{"dry_run":false,"expected_generation":0,"revision_ids":["<selected-revision-uuid>"],"keep_last":5,"older_than_days":1}
```

Ноль замени фактической **theme_generation** из preview, не settings_generation. Выбирай только показанные site-scoped IDs, никаких путей. Защищены active, previous-good, newest keep_last confirmed, использованные недавно (минимум сутки) и PREPARED references. Политика может лишь усилить защиту. Protected/stale — 409 THEME_REVISION_PROTECTED/THEME_REVISION_STALE, missing/foreign — 404, invalid — 400; вся неподходящая партия отклоняется до начала.

Ответ: ok/dry_run/theme_generation/keep_last/older_than_days/retained_count (до запроса), candidates[{revision_id,theme_id,package_version,last_used_at,pending_cleanup}], removed/pending/has_more. Physical failure даёт HTTP 200 с ok=false, pending IDs, CLI exit 7; это не PASS. Preview снова покажет pending, либо повтори те же IDs с актуальной допустимой generation. Уже завершённый retry не дублирует audit.

Общий lifecycle lock и атомарные DB marker/audit предшествуют удалению файлов. Pruned revisions исключены из rollback/history/assets даже при pending retry; маленькие journal/FK metadata остаются. Migration 0004_theme_revision_cleanup применяется штатным Core update, без theme/content/config migration. Не удаляй файлы/маркеры вручную. Перед использованием проверь наличие контракта у установленной CMS: baseline minimum Skill не гарантирует все последующие добавления.
