# THEME.md — Progressive Reference (`reference-theme-v1`)

Публичная тема Progressive CMS. Этот файл — инструкция для человека-разработчика:
как запустить, собрать, валидировать тему и как менять типовые вещи без знания CMS Core.

- Theme ID: `reference-theme-v1`, версия: `1.2.3`
- Theme Contract: `^1.0` (см. `docs/specs/Progressive_CMS_Theme_Contract_v1_Spec.md`)

## Как запустить / собрать / валидировать

```bash
npm ci                                                     # зависимости
npm run cms -- theme validate themes/reference-theme-v1 --json   # валидация темы
npm run cms -- site validate --theme themes/reference-theme-v1 --json  # совместимость с контентом
npm test                                                   # юнит- и рендер-тесты
```

Сборка не обязательна: тема работает из исходников. Прод-правило — фингерпринты
(`assets.fingerprint: true`), имена вида `theme.a1b2c3d4.css` считает контрактом
(`packages/themes` → `planAssetBuild`).

## Структура

```text
theme.json     — машинный манифест (шаблоны, компоненты, блоки, placements, пресеты, settings, assets)
templates/     — шаблоны страниц (Liquid)
components/    — повторно используемые фрагменты (header, footer, breadcrumbs, button)
blocks/        — рендереры 19 Content-блоков (17 обязательных + video_gallery, audio)
tokens/        — дизайн-токены (JSON) → CSS custom properties
assets/        — css/js/img (только публичные; никаких Admin-бандлов)
fixtures/      — фикстуры для рендер-тестов и превью
```

## Design tokens

Источник: `tokens/base.json`, ключи вида `color.primary`, `space.m`.
Рендер в CSS custom properties: `--color-primary`, `--space-m` (детерминированно, сортировка по имени).

Публичные токены (переименование = breaking change, зафиксировано в THEME.md):
`--color-primary, --color-accent, --color-text, --color-text-muted, --color-surface,
--color-surface-muted, --color-border, --color-success, --color-warning,
--font-body, --font-heading, --font-size-s|m|l|xl, --space-2xs|xs|s|m|l|xl,
--radius-s|m|round, --shadow-card, --layout-container-max, --layout-header-height,
--bp-tablet, --bp-desktop, --z-header, --z-lightbox`.

Implementation-токены (могут меняться в minor-релизах): помечены `"public": false`.

## Theme Settings

Настройки админки (типизированные, см. `settings_schema` в `theme.json`):

| Ключ | Тип | По умолчанию | Токен |
|---|---|---|---|
| `primary_color` | color | `#0f62fe` | `--color-primary` |
| `accent_color` | color | `#ff7ab6` | `--color-accent` |
| `header_variant` | enum | `default` | — |
| `sticky_header` | boolean | `true` | — |
| `container_width` | number | `1200` | `--layout-container-max` |
| `logo` | media | `assets/img/logo.svg` | `--logo-url` |
| `footer_text` | string | `""` | — |

Settings переопределяют токены; дефолты живут в `theme.json` и `tokens/base.json`.

## Templates, components, blocks

- Templates: `page-default`, `page-hero`, `service-default`, `service-premium`,
  `case-default`, `article-default`, `news-default`, `error-404`.
  Content Type ≠ Template: `service@1` обслуживают `service-default` и `service-premium`,
  выбор за Entry (`template_key`), совместимость объявлена в манифесте.
- Components: `header`, `footer`, `breadcrumbs`, `button` — подключаются
  `{% include 'components/….liquid' %}`.
- Blocks: по файлу на блок в `blocks/`; mapping `type@version` — в манифесте.
  `cta` поддерживает варианты `inline`, `wide`, `accent`.
  Неподдерживаемый блок/вариант = ошибка валидации (в превью — плейсхолдер).
- `layout.default` = `extension-layout` оборачивает содержимое Extension views
  в обычную оболочку сайта. Шаблон-override и package base template содержат
  только контент; Core передаёт его в компонент как SafeHtml `content_html`.
  Layout владеет `<html>`, `head_html`, header, footer и theme assets.

## Navigation placements

| Placement | Контекст | max_depth | Типы |
|---|---|---|---|
| `header.primary` | desktop | 3 | internal_entry, external_url, group |
| `header.compact` | tablet | 1 | internal_entry, external_url |
| `header.mobile` | mobile | 3 | internal_entry, group, separator |
| `header.utility` | вспомогательная | 1 | internal_entry, external_url, action |
| `footer.primary` | подвал | 2 | internal_entry, group |
| `footer.legal` | юр. ссылки | 1 | internal_entry, external_url |

CSS-брейкпоинты (тема): `--bp-tablet: 768px`, `--bp-desktop: 1080px`.
Один Navigation Set можно назначить нескольким placements.

## Media presets

`hero` 1600×900 eager · `card` 800×600 · `thumbnail` 96×96 · `gallery` 1200×900 · `social-display` 1200×630.
Тема НЕ строит URL с `?w=&h=` — она получает готовые derivatives из Media View Model (M05).

## Globals

Шаблоны объявляют зависимости (`globals: ["contacts"]`) — их отсутствие ловит
`cms site validate` до публикации.

## Assets и JS

Публичный JS (`assets/js/theme.js`): мобильное меню, лайтбокс, клиентский
калькулятор (whitelist-парсер, без `eval`). Запрещены: секреты, service-токены,
`eval`/`new Function`, сторонние скрипты без CSP-декларации.
CSP строит CMS из `assets.csp` темы (разрешён только `https://` и `'self'`).

## Forms integration boundary

`form`/`quiz` блоки и CTA `action=form` появятся в M12 (Forms, Quizzes & Leads):
тема получает Form View Model и рендерит её; собственных обработчиков форм у темы нет.

## Preview

Превью кандидатной темы без активации: `createThemePreview` из `@pcms/themes`
(см. `tests/themes/preview.test.ts`); подписанные preview-URL придут с Preview-подсистемой.

## Common-change recipes

**Как изменить основной цвет.** Admin: Theme Settings → `primary_color` (если нужен
другой дефолт — поменять `default` в `theme.json` и `color.primary` в `tokens/base.json`).

**Как изменить размер/стиль кнопки.** `assets/css/theme.css` → `.btn` (радиус — токен
`--radius-round`, цвет — `--color-primary`); правится в одном месте.

**Как заменить логотип.** Заменить `assets/img/logo.svg` или задать setting `logo`
(media) — шапка подхватит `--logo-url`.

**Как изменить header.** Разметка — `components/header.liquid`, поведение (мобильное
меню) — `assets/js/theme.js` (`initMenuToggles`), вид — `.site-header*` в CSS,
вариант/липкость — settings `header_variant`, `sticky_header`.

**Как изменить footer.** `components/footer.liquid` + `.site-footer` в CSS;
пункты берутся из placements `footer.primary`/`footer.legal` (контент, не тема);
текст — setting `footer_text`.

**Как передвинуть CTA в template.** Перенести вызов `{{ blocks_html }}`/секцию CTA
в `templates/*.liquid`; порядок блоков приходит из контента, позиционирование — CSS.

**Как изменить карточку услуги.** Ветка `features` в `templates/service-default.liquid`
и стили `.block-related .card` / `.block-timeline`; разметка читается без сборки.

**Как добавить template variant.** 1) скопировать шаблон в `templates/`; 2) добавить
запись в `templates[]` манифеста с `accepts_content_types`; 3) прогнать
`cms theme validate` + рендер-тест. Новая запись обратимо совместима (minor).

**Как проверить mobile menu.** `npm test` (placement-тесты), затем Playwright-смоук
(T023): viewport 375×812, клик по «Меню», `aria-expanded` переключается, навигация видима.

## Release

SemVer: patch — багфиксы презентации; minor — новые компоненты/варианты (обратно
совместимо); major — поломка контрактов (settings keys, public tokens, template keys).

## Известные ограничения

- Карта — «каркас» без провайдера (подключение провайдера — решение сайта, M05/M13).
- Видео YouTube рендерится facade-iframe с `youtube-nocookie` (задекларировано в CSP).
- Мультиязычность контента появляется с Routing/i18n (M04+), тема locale-agnostic.
- `form`/`quiz` рендереры появятся в M12.

## Human-maintainability checklist (acceptance, spec §61)

Тема проходит gate, если любое типовое изменение делается без: правок Core,
знания SQL, реверс-инжиниринга бандла, обязательного LLM, правок compiled-артефактов.

| Хочу изменить | Где | Что трогать нельзя |
|---|---|---|
| Цвет | Theme Settings / `tokens/base.json` | templates |
| Кнопку | `.btn` в `assets/css/theme.css`, `components/button.liquid` | Core |
| Логотип | setting `logo` / `assets/img/logo.svg` | header-разметку |
| Header | `components/header.liquid` + CSS + settings | Content schema |
| Footer | `components/footer.liquid`, placements `footer.*` | Core |
| Карточку услуги | `templates/service-default.liquid` (ветка features) | блоки |
| CTA в шаблоне | порядок блоков в контенте / CSS | манифест блоков |
| Новый template variant | `templates/` + `theme.json → templates[]` + validate | чужие шаблоны |
| Mobile menu | `assets/js/theme.js → initMenuToggles`, CSS | placements contract |

Проверка после любого изменения:

```bash
npm run cms -- theme validate themes/reference-theme-v1 --json
npm test -- tests/themes/reference-theme.test.ts
npm run test:browser
```

## Поиск по сайту

Ссылка «Поиск» находится в header. Полную страницу задаёт
`templates/search.liquid` (manifest id `search`), форму и карточки —
`components/search-result.liquid`. Форма доступна без JS. Любое изменение
расположения/оформления делайте в этих файлах; для формы в другом месте
используйте GET `/search/` с input `q`.

Карточка получает `item.fields` (все опубликованные поля), `item.seo`,
summary/snippet/даты и `media[item.fields.hero_image].presets.thumbnail`.
Выбирайте нужные поля явно. Пагинация использует `search.next_url`.
Полный контракт: [PUBLIC-SITE-SEARCH.md](../../docs/handoff/PUBLIC-SITE-SEARCH.md).
