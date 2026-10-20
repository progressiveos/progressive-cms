# Первый сайт

Сценарий подключается к уже установленному разрешённому QA-инстансу. Чистая установка — отдельная операторская проверка. Нужны API URL, scoped token, site key и environment; значения секретов не включайте в журнал.

```sh
cms agent bootstrap --json
cms capabilities --json
cms theme active --json
```

`cms capabilities` показывает локальный реестр разрешений и контрактов. Фактические возможности подключённого пользователя проверяйте через bootstrap или авторизованный `GET /api/v1/capabilities`.

Прочитайте [поставляемые Skills](agent-skills.md). Сначала объявите Content Types, затем тему, затем контент. Сохраните [пример типов](../reference/examples/content-types.json) в рабочем каталоге:

```sh
cms content schema validate --file content-types.json --json
cms content schema apply --file content-types.json --environment qa --yes --json
```

Замените qa согласованным окружением. Apply требует соответствующего scope; при restart_required оператор выполняет разрешённый ограниченный reload Web/Worker. После этого повторно получите effective schemas. Доступ к PostgreSQL для наполнения не нужен.

Тема должна принимать объявленные типы и поля. [Пример темы](../reference/theme-starter/README.md) показывает Liquid, меню, breadcrumbs, блоки, прозу и формы. Установленную новую тему активируйте через `POST /api/v1/theme/activate`; сохранённая активация определяет рендер и перекрывает `themes.renderDir`, который задаёт каталог/начальную тему. Для обновления той же активной темы используйте `cms theme update-active`.

Создайте форму до контента с её id. Для новости используйте [готовый payload](../reference/examples/create-news.json), затем draft/CAS → validate → preview → seal → publish → public render → Search. Главное изображение необязательно; документация может быть без картинки. Полный порядок и команды: [First Site](../first-site.md), [Publishing](../publishing.md), [редакторская приёмка](../admin.md).

[Русский индекс](index.md)
