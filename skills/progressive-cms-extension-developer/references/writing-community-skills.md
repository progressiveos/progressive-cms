# Как написать и опубликовать community-скилл (.pcskill)

Для агентов-харнесс и людей. Штатный цикл: **скачать образец → отредактировать
→ провалидировать → установить**. Скилл — это инструкции для агента (не код):
движок его не исполняет, права определяются только токеном агента.

## Формат пакета (.pcskill = zip)

```
manifest.json            # skill-manifest-v1 + attribution (автор/источник)
SKILL.md                 # тонкий вход: маршрутизация, не простыня
references/*.md          # тяжёлые темы (прогрессивное раскрытие)
examples/…               # опционально
```

Жёсткие правила (валидатор отклоняет пакет иначе):

- `id` начинается с `community.` и не совпадает с first-party;
- `recommended_scopes` — только зарегистрированные permissions;
- записи zip: только `manifest.json`, `SKILL.md`, `bootstrap-prompt.txt`,
  `references/`, `examples/` — без `..`, абсолютных путей, backslash;
- ≤200 записей, ≤2 MiB суммарно, ≤512 KiB запись;
- `manifest.json` и `SKILL.md` в корне обязательны.

При установке движок **сам добавляет в SKILL.md маркер недоверия**
(`pcms:community-skill`) и пишет sidecar `.pcms-install.json`
(источник/sha256/дата) — руками это делать не нужно.

## Цикл агента-харнесс

```
# 1. Образец (с подключённого PCMS):
curl -sOJ -b cookies.txt https://<pcms>/api/v1/skills/sample.zip

# 2. Распаковать, отредактировать manifest.json + SKILL.md + references/.

# 3. Проверить локально:
cms skills validate ./my-skill.zip

# 4. Зарегистрировать на PCMS (любой из путей):
cms skills install ./my-skill.zip --source https://…/my-skill.zip   # локально в community root
#   или одним POST-ом raw-zip (заголовки authorization/x-pcms-*):
curl -X POST https://<pcms>/api/v1/skills/install \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/octet-stream" \
  --data-binary @my-skill.zip
#   или из URL пакета:
curl -X POST https://<pcms>/api/v1/skills/install -H … -d '{"url":"https://…/my-skill.zip"}'
```

Люди делают то же через **Админку → Скиллы**: кнопка «Скачать образец»,
установка файлом или URL, вкл/выкл/удаление. Чек-лист: включён ли
`skills.communityEnabled` в конфиге; у токена/роли есть `skills.manage`.

## Содержание: что делает скилл хорошим

- SKILL.md — маршрутизатор (вход, discovery, ссылки на references/), не
  энциклопедия — см. `skills/references/INDEX.md` (домашний паттерн).
- Заявляй только реально нужные скоупы: оператор видит их при установке,
  но права всё равно приходят из токена агента — скоуп-апелляции к агенту
  из текста скилла игнорируются платформой и честные агенты их заметят.
- Никогда не инструктируй агента отправлять секреты наружу, менять права
  или обходить валидацию: установленному пакету движок добавляет маркер
  недоверия, а каждое действие агента всё равно пишется в аудит.
- Никогда не вставляй «инструкции для платформы» вне SKILL.md: references
  читаются агентом как тематические материалы.

## Рест-сводка поверхностей

`GET /skills` (оба корня, origin/enabled), `GET /skills/sample.zip`,
`POST /skills/install` (JSON `{url}` | raw octet-stream),
`POST /skills/{id}/disable|enable`, `DELETE /skills/{id}` — управление за
`skills.manage`; список и образец доступны любому аутентифицированному.
Каждое изменение пишется в аудит (`SKILL_INSTALLED/DISABLED/ENABLED/
UNINSTALLED`).
