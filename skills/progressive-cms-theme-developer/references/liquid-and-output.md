# Liquid: движок, фильтры и семантика вывода

Источник истины: `packages/themes/src/engine/liquid.ts` (контракт Theme
Contract §4/§20/§72). Этот файл переносит знания из исходников в доки —
тема пишется вчистую по нему, без доступа к коду движка.

## Постура движка

- **Автоэкранирование безусловно**: каждый `{{ … }}` проходит
  `stringifyOutput` — обычные строки экранируются, «доверенный HTML»
  (SafeHtml) печатается как есть.
- **Фильтров `raw` и `escape` НЕТ** (удалены из движка). Доверенный HTML
  попадает в шаблон только как SafeHtml-значения, подготовленные рендерерами
  (`body_html`, `tokens_css`).
- `strictFilters: true` — неизвестный фильтр = ошибка рендера. Полный список
  встроенных фильтров — документация LiquidJS; из него изъяты `raw`/`escape`,
  а `date` переопределён CMS (формат ниже).
- `strictVariables: false` — отсутствующие переменные/поля не падают,
  печатаются пустотой; для подстановок используйте `| default: "…"`.
- `ownPropertyOnly: true` — доступ к чужим свойствам прототипа
  (`x.constructor` и т.п.) заблокирован.
- Бюджеты: `renderLimit` 1000 мс на рендер — тяжёлые циклы не проходят.

## Head страницы: `{{ head_html }}` — JSON-LD и защищённые метаданные

Core владеет защищённой секцией head: title, core meta (description, OG,
twitter), canonical, alternates (hreflang), robots, favicon-иконки, JSON-LD
и theme-слоты. В шаблон она приходит **одной доверенной переменной**

```liquid
{{ head_html }}
```

— уже SafeHtml (собирается `assembleHeadHtml` на стороне Core). Это
единственный штатный канал для JSON-LD: `{{ head.json_ld }}` — массив обычных
строк и печатью через `{{ … }}` превращается в `{&quot;@type&quot;:…}`
(внутри `<script>` HTML entities не декодируются — JSON ломается; фильтров
`raw`/`escape` нет). `assembleHeadHtml` экранирует атрибуты и текст,
а в JSON-LD экранирует `</` → `<\/` (валидный JSON-эскейп), поэтому
`</script>` в данных не закрывает тег и не создаёт исполняемый скрипт.

Типовой `<head>` темы:

```liquid
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  {{ head_html }}
  <link rel="stylesheet" href="/themes/<id>/assets/css/theme.css">
  <style>{{ tokens_css }}</style>
</head>
```

Не дублируйте title/canonical/robots поверх `{{ head_html }}` — будет по
два экземпляра. Тема по-прежнему может читать отдельные поля (`head.title`,
`head.robots` — значение безопасно печатается в атрибуте) для своих нужд,
но канонический рендер секции — `{{ head_html }}`.

## Семантика вывода (главный источник ошибок)

1. `{{ entry.fields.body }}` для `rich_text`-поля печатает структуру данных
   экранированным текстом, а не HTML. HTML даёт подготовленное поле
   контекста: `{{ body_html }}` — оно уже SafeHtml (рендер
   `renderRichText` на стороне движка). Аналогично `{{ tokens_css }}`.
2. **Ловушка `newline_to_br`**: фильтры выполняются ДО автоэкранирования,
   поэтому `{{ text | newline_to_br }}` печатает `<br>` как ВИДИМЫЙ текст
   (экранированный). Рабочие приёмы:
   - собирать абзацы без HTML: `{% for para in text | split: "\n\n" %}` +
     `<p>{{ para }}</p>`;
   - либо носить в контексте SafeHtml-переменную (как `body_html`).
3. Строковые поля (string/slug/enum/**icon**) — печатаются как текст;
   `{{ entry.fields.feature_icon }}` внутри `class="…"` — штатный путь.

## Частые фильтры (разрешены)

`default`, `append`, `prepend`, `capitalize`, `upcase`, `downcase`, `truncate`,
`truncatewords`, `split`, `join`, `first`, `last`, `size`, `map`, `where`,
`uniq`, `sort`, `reverse`, `slice`, `compact`, `concat`, `round`, `abs`, `ceil`,
`floor`, `plus`, `minus`, `times`, `divided_by`, `modulo`, `date`, `strip`,
`lstrip`, `rstrip`, `strip_html`, `strip_newlines`, `replace`, `replace_first`,
`remove`, `remove_last`, `newline_to_br` (см. ловушку выше), `url_encode`,
`url_decode`, `json` (полезно для отладки контекста).

Изъяты: `raw`, `escape`.

## `date`: формат Progressive CMS

Фильтр CMS принимает `Date` или строку даты (рекомендуется ISO 8601) и
форматирует её в **UTC**. Без аргумента используется `dd.MM.yyyy`.
Поддерживаются только токены `yyyy` (год), `yy` (две цифры года), `MM`
(месяц), `dd` (день), `HH` (час 00–23), `mm` (минуты). Регистр важен:
`MM` — месяц, `mm` — минуты. Остальные символы остаются буквальным текстом.

```liquid
{{ entry.fields.published_at | date }}
{{ entry.fields.published_at | date: "dd.MM.yyyy" }}
{{ entry.fields.published_at | date: "yyyy-MM-dd HH:mm" }}
```

Для `2026-10-01T09:05:00Z` результаты: `01.10.2026`, `01.10.2026`,
`2026-10-01 09:05`. Upstream Liquid/strftime-форматы `%d.%m.%Y` здесь
не поддерживаются: они выводятся буквально. Пустые, нераспознаваемые строки
и значения других типов возвращаются без изменения; обычное
автоэкранирование вывода сохраняется.

## Rich text: картинки и `<field>_html`

- **Любое** rich_text-поле записи отдаёт SafeHtml-двойника:
  `{{ entry.fields.solution_html }}` (как `body_html`). Печать сырого поля
  (`{{ entry.fields.solution }}`) даёт дамп AST.
- **Image-нода** в AST v1: markdown `![alt](src)` отдельной строкой (alt
  обязателен, src — https или site-relative `/media/a/…`), рендерится в
  `<img src alt title>`. В админском редакторе — кнопка «Изображение»
  (URL или из медиатеки, src = публичный URL варианта).

## Варианты блоков из темы

`theme.json → block_renderers[].variants` — единственный источник вариантов:
контентная валидация принимает только объявленные темой варианты, discovery
показывает объединение (`GET /discovery/blocks/:typeId?version=N` →
`allowedVariants`). До 0.1.104 объявленные варианты отвергались
(BLOCK_VARIANT_UNSUPPORTED).

## Поля типа `icon` (для агентов)

`icon` — необязательный частый тип: строка вида `fa-solid fa-shield-halved`
(стиль + имя, классы Font Awesome). Валидация — формат, НЕ членство;
каталог — рекомендательные данные: `GET /api/v1/discovery/content/icons`.
Смена версии FA не ломает валидацию (имена открытые); каталог в админке
рисует пикер (input + datalist). Альтернатива без привязки к FA — `enum`:
тогда набор значений задаёт схема контент-типа.
