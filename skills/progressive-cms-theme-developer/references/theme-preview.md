# Preview темы-кандидата (без переключения активной темы)

Проверить альтернативную тему на настоящем контенте (запечатанная ревизия или
WORKING-черновик) без смены активной темы, `themes.renderDir`, настроек и
публикаций. Релиз **0.1.130+** (до него механизма не было — `capabilities.
themes.preview` обещал, но контракт не существовал).

## Контракт

1. Установить тему-кандидата (`.pcTheme` через Admin «Установленные темы» или
   `cms theme install`) — preview работает только по УСТАНОВЛЕННОМУ theme id
   (каталог sibling активной темы в `themes/`).
2. Выписать подписанный токен с выбором темы:

```bash
curl -X POST "$PCMS_API_URL/api/v1/previews" \
  -H "Authorization: Bearer $PCMS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "scope": {
          "kind": "revision",
          "entity_type": "entry",
          "entity_id": "01a0…",
          "revision_id": "01a0…",
          "allow_draft": true
        },
        "theme": "pcms-site-v2"
      }'
# 201 { token, preview_path: "/preview?token=…" }
```

- `theme` — необязательное поле; без него рендер идёт активной темой (как
  раньше). Права: `preview.create` (+`content.edit` при `allow_draft`).
- `changeset`-скоуп тоже принимает `theme`, но changeset-preview остаётся
  JSON-состоянием (`GET /preview`), страницу в теме рендерит только
  `revision`-скоуп; с 0.1.137 служебные страницы имеют `service`-скоуп.

3. Открыть страницу в теме-кандидате:

```
GET /preview/page?token=<token>
```

HTML рендерится темой `theme` из токена: шаблоны, блоки, токены/CSS и CSP —
кандидатские; ассеты отдаются с `/themes/<themeId>/assets/…` (публичный
эндпоинт ассетов теперь обслуживает ЛЮБУЮ установленную тему, containment
`assets/` сохранён). Токен подписан, имеет TTL, ответ всегда
`noindex/nofollow/no-store`; миграции/указатели/настройки не затрагиваются,
рестарт web не нужен (стек кандидата строится лениво и кэшируется).

4. Ошибки: `PREVIEW_THEME_INVALID` (404) — тема не установлена/манифест
   невалиден; `REVISION_NOT_SEALED` (409) — черновик без `allow_draft`.

## Служебные шаблоны (0.1.137+)

Тот же `POST /api/v1/previews`, право `preview.create`:

```json
{
  "scope": { "kind": "service", "template": "search", "locale": "ru-RU" },
  "theme": "pcms-site-v2"
}
```

Ответ: `201 {token, preview_path: "/preview/page?token=…"}`. Открыть
`preview_path`, затем добавить `&q=запрос`: пустая строка, результаты и
отсутствие результатов проходят обычный search pipeline (публикации,
индекс, лимиты, полные result metadata). `locale` необязателен: без него
используется default locale; указанный locale подписан в токене.

Для 404 заменить `template` на `error-404`. Успешный HTML preview 404
возвращает **HTTP 404**, search — **HTTP 200**. Это не ошибка токена:
ошибки токена/темы возвращают JSON с `error.code`. Отсутствие нужного
служебного шаблона — `409 PREVIEW_RENDER_UNAVAILABLE` (search также
поддерживает legacy `search-result` component).

Все служебные preview имеют `noindex, nofollow`, `private, no-store`,
`no-referrer`, тот же TTL и candidate CSP/tokens/settings/assets stack.
Поисковая форма и ссылки ведут на live: следующий запрос для проверки
кандидата формировать снова через `preview_path` с `q`; параллельная
навигация не создаётся. Переустановка темы под тем же ID перестраивает
стек для старых и новых токенов.

## Границы (честно)

- Preview рендерит ОДНУ страницу. Ссылки навигации ведут на живой сайт
  (активная тема) — предпросмотр не создаёт параллельной навигации.
- Настройки темы-кандидата берутся из её дефолтов (значения из Admin
  применимы только к активной теме).
- `GET /preview` (JSON-состояние) в поле `theme` возвращает, какая тема
  подписана в токене.

## Регрессии

- `tests/publication/preview.test.ts` — токен несёт/возвращает `theme`.
- `tests/apps/site-render.test.ts` — «preview renders a candidate theme»:
  одна и та же ревизия рендерится активной темой без `theme` и кандидатом
  с ним; неизвестная тема и traversal — типизированный 404.
