# Перенос сайта со старого движка — 2-URL pipeline

Поддержанные источники: **MODX 3.0/3.2** (агент), **WordPress** (нативный
REST + Application Passwords, агент не нужен), **Tilda** (sitemap-краулинг
без аккаунта или export-zip), **1C-Bitrix** (агент, experimental).
Общее ядро у всех одно: URL-план (301/410, §61 сохранение адресов) +
`.pcpub`-воркспейс (контент HTML→markdown, картинки в bundle assets).

Цель формата: развёрнутый Progressive CMS + адрес старого сайта — этого
достаточно, чтобы старый сайт появился на новом движке. Никакой ручной
аналитики и CSV руками.

## Быстрый старт по движкам

```bash
# MODX 3.x — агент на источнике:
PCMS_MIGRATE_TOKEN=… cms migrate modx3 --endpoint https://old.example/pcms-agent.php --out-dir ./mig

# WordPress — нативный REST, Application Password (WP 5.6+):
WP_USER=… WP_APP_PASSWORD=… cms migrate wordpress --endpoint https://old.example/ --out-dir ./mig

# Tilda — без аккаунта (sitemap-краулинг):
cms migrate tilda --sitemap https://site.tilda.ws/sitemap.xml --out-dir ./mig
#   или export-zip из админки Tilda, распаковать:
# cms migrate tilda --dir ./export --site-base https://site.tilda.ws/ --out-dir ./mig

# 1C-Bitrix (experimental) — агент на источнике + SEF-шаблоны URL:
PCMS_MIGRATE_TOKEN=… cms migrate bitrix --endpoint https://old.example/pcms-agent.php \
  --iblock 12 --section-url-template '/{SECTION_PATH}/' \
  --element-url-template '/{SECTION_PATH}/{CODE}/' --out-dir ./mig
```

Скриншоты страниц источника (референс дизайна для темы) — отдельная фаза
после переноса контента: браузерный рендер уже есть в web-research
расширении; пайплайн «скриншот → тема» в разработке.

## Состав тулкита

| Часть | Где | Что делает |
|---|---|---|
| MODX-агент | `extensions/progressive-site-migration/agent/modx3/pcms-agent.php` (+README) | один PHP-файл в web-корень старого сайта; бутстрап modX API (креды БД наружу не уходят); read-only выгрузка: ресурсы+TV (MIGX-JSON насквозь), медиа, content types, extras-детект (MIGX/Gallery/SEO Suite), история редиректов SEO Suite |
| Приёмник | `cms migrate modx3` | одна команда строит весь перенос: URL-план + `.pcpub`-воркспейс + сводка |
| Импорт URL-плана | `cms redirects validate|apply` | 301/410 с защитами (§33/§60), атомарно |
| Публикация контента | `cms bundle validate|pack|submit` | стандартный `.pcpub` конвейер |

Permissions агента: `routing.redirects.import` (план), `media.import`
(картинки), `content.create` (bundle ingest). У preset'ов
`site_development`/`content_work` и роли DEVELOPER — есть.

## Порядок работы (полный цикл)

### 1. Установить агент на старом сайте

Скопировать `pcms-agent.php` в web-корень MODX, вписать
`PCMS_AGENT_TOKEN` (длинная случайная строка), опционально IP-allowlist.
Только HTTPS. После миграции — удалить. Инструкция рядом с файлом
(`agent/modx3/README.md`).

### 2. Одна команда

```bash
PCMS_MIGRATE_TOKEN=<токен агента> \
cms migrate modx3 --endpoint https://old-site.example/pcms-agent.php \
  --out-dir ./migration-out
```

Вариант: `--export export.json` (если экспорт агента сохранён в файл).
Токен — только через окружение, не argv.

Выход под `--out-dir`:

- `redirects.csv` — план URL: удалённые ресурсы → 410, переименованные
  (`--map modx_id,new_path`) и история SEO Suite → 301;
- `canonical.csv` — план «старый URL = канонический путь» (spec §61):
  живые страницы сохраняют свои адреса, редирект им не нужен;
- `bundle/` — `.pcpub`-воркспейс: `content/*.pcmd` (`route.path` = старый
  URI, контент HTML→markdown через turndown, картинки выцеплены в
  image-блоки `bundle:assets/…`), `assets/` (скачанные изображения),
  `publication.yaml`;
- `migx.json` — сырые MIGX-TV по ресурсам (фаза 2 маппинга в блоки);
- `summary.json` — сводка + готовые next-step команды.

### 3. Проверить план и применить URL-план

```bash
cms redirects validate --csv ./migration-out/redirects.csv [--site <key>]   # dry-run
cms redirects apply    --csv ./migration-out/redirects.csv --yes            # атомарно
```

Валидатор отклонит: открытые редиректы (абсолютные/`javascript:`), циклы и
цепи >3 хопов (по батчу **вместе с историей**), конфликты с живыми
маршрутами, повторный импорт активного источника. Отчёт построчный;
apply атомарен. Ошибки отчёта → exit 1 с payload'ом.

### 4. Опубликовать контент

```bash
cms bundle validate ./migration-out/bundle
cms bundle pack     ./migration-out/bundle --out ./migration-out/migrate.pcpub
cms bundle submit   ./migration-out/migrate.pcpub --environment <env> --yes
```

`external_id` записей = `modx-<id>` — повторный прогон идемпотентен.
`route.path` сохраняет старые URI — это и есть SEO-перенос: канонические
адреса не меняются, поисковики ничего не теряют.

### 5. Отчёт владельцу

Проверить публично: старые URL отдают 200 (сохранённые) / 301 / 410;
картинки в медиатеке; выборочно 2–3 страницы глазами (signed preview).

## Если источник SEO-кривой (дубли, без canonical)

План **не читает canonical источника** в принципе. Вместо доверия — аудит:
`DUPLICATE_URI`, `CASE_VARIANT` (`/About.html` vs `/about.html`),
`NORMALIZED_COLLISION` (`/about.html` vs `/about/`), `QUERY_URI` (FURL были
выключены — включить в MODX и переэкспортировать). Всё warnings, план не
портится; выживший вариант выбирается явно через `--map`. Граф-безопасность
гарантирует валидатор независимо от кривизны источника. Дубли контента —
решение фазы переноса: в bundle едут выбранные записи, прочие закрываются
через `--map`.

## Картинки

«API источника» не нужен — файлы отдаются по HTTP. Механизм:
`.pcpub`-assets как `import_url` (серверный SSRF-safe pull при инжесте) или
`media_id`; точечно — `POST /media/import` / MCP `cms_import_media_url`
(permission `media.import`). Дедуп по sha256: та же картинка из десяти
статей = один ассет. Агент перечисляет (`<img src>` уже извлечён
конвейером) и решает; вытягивание всегда делает движок.

## Особенности движков

- **WordPress**: статусы — publish → документ, trash → 410, draft/private
  пропускаются (счётчик в summary; `--include-drafts` тащит черновики как
  документы). `media-manifest.csv` — полная инвентаризация медиатеки.
  Тема оформления не переносится — только контент и URL.
- **Tilda**: страницы — div-«t-records»; turndown даёт честный текст без
  вёрстки. Режим `--sitemap` не требует аккаунта; export-zip (платные планы)
  полнее. Скриншоты/дизайн — отдельная фаза.
- **1C-Bitrix (experimental)**: URL собираются из операторских SEF-шаблонов
  (`#CODE#/#SECTION_CODE#/#ID#/#SECTION_PATH#`) — сверь с настройками
  компонента на живом сайте. Инфоблоки только; прочие сущности — позже.

## Честные границы v1

- MIGX-вёрстка рендерится шаблонами MODX и в БД не лежит: такие страницы
  переносятся своим прямым контентом, MIGX-данные — в `migx.json`; маппинг
  в PCMS-блоки — фаза 2, по ресурсам.
- Image-блоки идут после текстового блока, не в исходных позициях HTML.
- `modWebLink`/`modSymLink` и не-web контексты не переносятся; нестандартные
  `class_key` пропускаются с предупреждением.
- Редиректы `index.php?id=N` путями не выражаются — уровень edge-RP.

Подробности модели URI и формата экспорта:
`docs/migration/modx3-site-migration.md`.
