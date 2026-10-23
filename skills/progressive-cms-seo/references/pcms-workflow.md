# Практический путь в PCMS

Все ссылки локальны для Skill. [Выбранные схемы API](api-operations.json) сохраняют реальные request/security envelopes; generic object не является разрешением придумать поля. API пути ниже относительны к `/api/v1`; Bearer, site и environment передаются в заголовках, токены — через secret/environment. Cookie-клиенты добавляют CSRF для мутаций.

## Инвентарь и чтение

1. `/agent/bootstrap`, `/capabilities`, `/site`, `/localization`, `/discovery/content/types`, `/discovery/theme`. Фактический production origin определяется domain binding/route policy, не hostname догадкой.
2. Постранично `/discovery/content/tree` с `limit` и `cursor`; учитывай `has_more`/следующий курсор, не останавливайся после первой сотни. Различай folder и entry, опубликованные/рабочие состояния. Добавь sitemap и живые ссылки: дерево не включает автоматически все system/extension/query URL.
3. Для entry: `/entries/<id>/seo`, `/entries/<id>/route`, `/publications/entry/<id>` и `/revisions/<id>` по scopes. Для effective SEO: `/discovery/seo/metadata/<id>`, `/discovery/seo/preview?entry_id=<id>`, `/discovery/seo/structured-data?entry_id=<id>`, `/discovery/seo/validate?entry_id=<id>`.
4. `cms seo validate <id>` / `cms seo validate --all` пригодны как часть аудита; проверяй `complete`, `partial`, issue severity и failures. Это не crawler, не проверка H1/всего HTML/внешней индексации. `cms site validate` проверяет локальный corpus и может skip с exit 0 — не принимай его за production SEO gate.

## Правка SEO

SEO document отдельный от content payload. Поддерживаемые ключи: `seo_title`, `meta_description`, `canonical_override`, `robots_policy`, `social_title`, `social_description`, `social_image`, `structured_data_type_hint`. `social_image` — `{asset_id, version?}`, не произвольный URL. Сохраняй существующие значения и корректную семантику null/fallback; не обнуляй весь document только для title.

Для обычного `PUT /entries/<id>/seo` указывай существующий MediaAsset id. Исключение существует только в `.pcpub`: если изображение включено и объявлено в пакете, `seo.social_image.asset_id` может содержать `bundle:assets/<archive-path>`. На target эта ссылка разрешается в идентичность того же MediaAsset, что и ссылки полей контента. Не используй `bundle:` в обычном SEO API или других SEO-полях.

`GET /entries/<id>/seo` возвращает `{document: <object|null>}`. При null начни с восьми поддерживаемых полей со значениями null/fallback, затем задай утверждённые значения; существующий object сохраняй полностью. `PUT /entries/<id>/seo` — **полная замена** `{document: ...}`, не patch: пропущенные ключи становятся null/fallback. Возьми все восемь перечисленных полей текущего документа, измени только нужные и отправь полный сохранённый набор. Например, на уровне клиентского кода (не готовая команда CLI):

```javascript
const document = { ...currentDocument, seo_title: approvedTitle,
  meta_description: approvedDescription };
// PUT /entries/<id>/seo, JSON body: { document }
```

Здесь `currentDocument` — объект из прочитанного ответа, не весь HTTP envelope. Не добавляй неизвестные поля. Нужен `seo.edit`, а ненулевой `canonical_override` требует также `seo.canonical_override`. У SEO document нет CAS/expected_generation: согласуй отсутствие параллельного редактирования, перечитай перед записью и после неё. Не обещай атомарную защиту от гонки. SEO сохраняется отдельно от revisions и может сразу изменить публичный head: это разрешённая публичная мутация, а не WORKING draft. При ошибке materialization social image перечитай состояние: document мог уже сохраниться.

Для H1 и основного текста прочитай реально опубликованную revision и схему Content Type, открой working draft, измени соответствующее `fields`/RichText/blocks с `expected_edit_generation`, проверь/preview/seal и выполни разрешённую публикацию. Не патчь SEALED. BodyPolicy решает формат; не превращай редактируемую статью в raw HTML для заголовка. Fallback из content зависит от опубликованной revision; отдельный SEO document не имеет такого draft-барьера. Сравни именно опубликованный HTML после изменения.

Core владеет protected head и композицией JSON-LD. Не добавляй дубли title/meta/canonical/OG через Liquid. Если нужный тип JSON-LD или site setting не поддержан реальным контрактом, это Core/продуктовый блокер, а не приглашение внедрить произвольную схему. Site Identity тоже сохраняется полной заменой без CAS: прочитай, сохрани все текущие поля, согласуй отсутствие параллельной записи, перечитай результат; не теряй ownership proofs при смене favicon/brand defaults.

## URLs, навигация, социальные изображения

`GET /entries/<id>/route` — текущий путь/история; изменение только после согласования redirect impact, `POST /entries/<id>/route/change` с `to_path`/reason. Availability check ничего не резервирует. CLI route-change без `--yes` показывает review и отказывает в изменении; `cms redirects validate --csv <file>` предшествует разрешённому `cms redirects apply --csv <file> --yes`. Проверяй ответ и фактический target; не используй обходной SQL.

Новая первая публикация без live route идёт через changeset с route operation → preflight → apply; direct publish требует существующий live route и `expected_generation`. Content rollback, theme rollback и восстановление БД — разные процедуры.

Реальное наследование social image: explicit `social_image` → собственное published `hero_image` → ближайший подходящий **Content Tree** parent в locale → site default. Меню/URL не определяют родителя. Проверяй `og-v1` managed derivative (1200×630), MIME, доступность и alt. Draft-only ancestor не должен менять live OG. Фото не обязательно на юридической/текстовой странице; реальный site fallback допустим, фиктивные asset ids — нет.

## Theme changes и безопасная проверка

Сначала локальная проверка пакета с CMS version из bootstrap, затем разрешённый `cms theme update-active <package> --environment <env> --yes --json` для того же id. Для другого id — `cms theme install <file.pcTheme> --environment <env> --yes --json` (нужны API/site/environment и theme.write), затем activate без перезапуска. После ответа/сетевого обрыва прочитай served state, не делай вывод по одному HTTP статусу.

История/rollback — дополнительные возможности установленного сервера: сначала проверь фактическое наличие API/CLI, минимальная версия manifest не гарантирует каждый последующий lifecycle delta. Если операции нет — сообщи ограничение, не имитируй откат.

`GET /themes/active` возвращает `revision_id`, `theme_generation` дополнительно к версии/настройкам. `GET /themes/revisions` или `cms theme revisions --json`: active + newest, до 100. Разрешённый откат: `cms theme rollback <revision-id> --expected-generation <theme_generation> --environment <env> --yes --json`. CAS не равен settings_generation; incompatible retained snapshot отвергается. Update-active после отката сравнивает версию с installed package head, не старой active version.

Чтение истории доступно через MCP, а preview/apply cleanup — через MCP/Admin; MCP rollback остаётся недоступным. Очистка не является SEO-оптимизацией и необратимо ломает старые revision asset URLs (см. отдельный раздел ниже). Тема pin-ит обычные HTML asset URL к `/themes/<id>/revisions/<uuid>/assets/...`; CSS-relative наследует base. Opaque JS/absolute CSS остаются на active alias: открытая старая вкладка не полностью frozen. После изменения/отката проверяй фактические CSS/JS/images/SRI/CSP, raw head и страницы с обоими вариантами пути.

## Поисковые сервисы и финальный smoke

Для Google/Yandex ownership используй только предоставленные владельцем proof через Site Identity/штатную Admin вкладку; provider confirmation проверяется отдельно. Не включай Metrica debug/analytics автоматически ради индексации. IndexNow: `/seo/indexnow`, status/check/key rotation только по разрешённому сценарию и scopes, без отправки всего сайта каждую минуту.

После разрешённой публикации: публичный URL → raw head/main/H1 → browser/mobile → canonical/robots/sitemap/links/media → нужные JSON-LD → CMS validator → доступные Search Console/Webmaster проверки. Search projection PCMS — собственный поиск, не внешний индекс Google/Yandex. Никакого «PASS у Google» из `cms search status`.

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
