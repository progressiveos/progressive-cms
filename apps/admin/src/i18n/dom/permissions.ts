import { defineFragment } from "../fragment.js";

// Swept domain fragment: permission help. One tooltip per registry key —
// what the scope grants, when it matters and how it bites (owner directive
// 2026-09-28: an operator must never have to guess what a checkbox does).
// Keys mirror packages/auth permission registry 1:1 (`perm.` + key); the
// TokenWizard falls back to the registry summary for keys a future registry
// append adds before this fragment is swept.

/** Preset labels, one per AGENT_SCOPE_PRESETS key. */
const PRESETS = {
  "access.preset_site_development": "Пресет: разработка сайта с нуля",
  "access.preset_content_work": "Пресет: работа над контентом",
  "access.preset_theme_work": "Пресет: работа над темой",
  "access.preset_integrations_work": "Пресет: интеграции и уведомления",
  "access.preset_readonly_diagnostics": "Пресет: только чтение и диагностика",
  "access.preset_all": "Пресет: все разрешения",
  "access.preset_hint": "Пресет — стартовая точка; потом можно добавить или снять галочки",
} as const;

const RU = {
  // Content
  "perm.content.read":
    "Видеть материалы и черновики, их истории версий. База для любой работы с сайтом; само по себе безопасно.",
  "perm.content.create":
    "Создавать новые материалы. Черновики не видны посетителям, поэтому безопасно.",
  "perm.content.edit":
    "Менять тексты, блоки и поля материалов. Правка опубликованной страницы сразу меняет черновик — публикация отдельный шаг.",
  "perm.content.archive":
    "Убирать материалы в архив (не удалять). Опасности почти нет: архив возвращается.",
  "perm.preview.create":
    "Открывать предпросмотр неопубликованных страниц по секретной ссылке. Ссылки не индексируются; безопасно.",
  "perm.content_schema.read":
    "Видеть типы контента и схему блоков. Нужно, чтобы агент понимал структуру страниц.",
  "perm.content_schema.propose":
    "Предлагать изменения схемы контента (новые блоки, поля). Не вступает в силу без применения.",
  "perm.content_schema.apply":
    "Применять изменения схемы контента. Опасно умеренно: неверная схема ломает рендер страниц, но откатывается.",
  // Media
  "perm.media.read": "Видеть медиатеку и пути файлов. Безопасно.",
  "perm.media.write":
    "Загружать и редактировать файлы в медиатеке. Тратит место; испортить сайт не может.",
  "perm.media.replace":
    "Заменять файл существующего изображения на новый. Осторожно: замена мгновенно видна на живом сайте.",
  "perm.media.archive":
    "Убирать файлы в архив. Не удаляет файл, но страница, ссылающаяся на архив, может потерять картинку.",
  "perm.media.import": "Импортировать медиа из внешних источников по URL. Тратит место и трафик.",
  "perm.media.providers.manage":
    "Настраивать стоковые и генеративные провайдеры медиа (ключи — write-only, прочитать нельзя). Опасно умеренно: неверный ключ = нерабочая генерация.",
  "perm.media.stock.search": "Искать стоковые фото (Pexels и т.п.). Расходует лимиты провайдера.",
  "perm.media.stock.import":
    "Скачивать найденные стоковые фото в медиатеку. Расходует лимиты провайдера.",
  "perm.media.generate":
    "Запускать генерацию картинок ИИ. Расходует деньги на балансах провайдеров — выдавать осознанно.",
  // Research
  "perm.research.search":
    "Искать в интернете через поискового провайдера (XMLStock). Расходует баланс.",
  "perm.research.fetch":
    "Скачивать публичные веб-страницы через безопасный загрузчик (SSRF-защита включена).",
  "perm.research.manage":
    "Менять конфигурацию веб-исследований: провайдер, прокси, лимиты. Выдавать только агентам, которым доверяете сеть.",
  // Navigation
  "perm.navigation.read": "Видеть меню навигации. Безопасно.",
  "perm.navigation.edit": "Менять пункты меню. Изменения попадают на сайт после публикации.",
  "perm.navigation.publish": "Публиковать меню. Сразу меняет навигацию живого сайта.",
  // SEO
  "perm.seo.read": "Видеть SEO-метаданные страниц. Безопасно.",
  "perm.seo.edit":
    "Менять title/description/og-данные. Ошибки снижают позиции в поиске, но легко откатить.",
  "perm.seo.validate": "Запускать SEO-проверки. Безопасно.",
  "perm.seo.canonical_override":
    "Переопределять канонические URL страниц. Опасно для SEO: неверный канонический адрес путает поисковики.",
  "perm.seo.site_settings":
    "Менять общесайтовые SEO-настройки (карта сайта, роботы). Влияет на весь сайт сразу.",
  // Publication
  "perm.publication.read": "Видеть версии, планы и статус публикаций. Безопасно.",
  "perm.revision.seal":
    "Запечатывать версии материалов (защита от правок). Обратимо администратором.",
  "perm.publication.plan":
    "Формировать планы публикаций (что и куда изменится). На сайт не влияет до публикации.",
  "perm.publication.schedule":
    "Назначать отложенную публикацию. Живой сайт меняется в назначенный момент.",
  "perm.publication.publish":
    "Публиковать на живой сайт. Это главный рычаг агента: посетители увидят всё, что он решил опубликовать. Выдавать агентам, которым доверяете контент.",
  "perm.publication.unpublish":
    "Снимать страницы с публикации. Живой сайт сразу скрывает материал.",
  "perm.publication.rollback":
    "Откатывать публикации к прошлым версиям. Мощно и опасно: откат затрагивает всё в плане публикации.",
  // Themes
  "perm.theme.read": "Видеть исходники темы и её настройки. Безопасно.",
  "perm.theme.write":
    "Менять исходники и конфиг темы. До активации/публикации живой сайт не задет.",
  "perm.theme.validate": "Проверять тему валидатором. Безопасно.",
  "perm.theme.preview": "Рендерить предпросмотр темы. Безопасно.",
  "perm.theme.activate":
    "Включать тему на сайте. Опасно: живой сайт мгновенно переключается на новую тему.",
  // Users, roles, tokens
  "perm.users.read":
    "Видеть список сотрудников и их роли. Персональные данные; выдавать только администраторам.",
  "perm.users.manage":
    "Приглашать, отключать сотрудников, сбрасывать MFA. Опасно: позволяет заблокировать доступ людям.",
  "perm.roles.read": "Видеть роли и их права. Безопасно.",
  "perm.roles.manage":
    "Назначать роли и создавать свои. Опасно: позволяет повысить права (себе и другим).",
  "perm.tokens.manage":
    "Создавать сервисные аккаунты и выпускать токены. Опасно: агент с этим правом сможет сам выпускать себе новые токены. Агентам не выдавать.",
  // Extensions & site
  "perm.extensions.manage":
    "Устанавливать, включать и выключать расширения. Опасно умеренно: расширение получает доступ к событиям и данным сайта.",
  "perm.site.configure":
    "Менять настройки сайта (название, языки, поведение). Влияет на весь сайт.",
  "perm.site.validate": "Запускать полную проверку сайта. Безопасно и полезно любому агенту.",
  "perm.site.maintenance":
    "Включать и выключать режим обслуживания. Опасно: сайт закрывается для посетителей.",
  "perm.site.maintenance.bypass":
    "Видеть настоящий сайт, когда он закрыт на обслуживание. Для работы во время регламентных работ.",
  "perm.domains.manage": "Управлять доменами сайта. Опасно: неверный домен ломает доступ и SEO.",
  "perm.embed.trusted":
    "Вставлять внешний контент (iframe/видео) как доверенный. Опасно умеренно: доверенный внешний код виден посетителям.",
  // Audit
  "perm.audit.read":
    "Читать журнал аудита и событий безопасности. Нужен агенту для самопроверки; данные чувствительные умеренно.",
  // Search
  "perm.search.admin":
    "Пользоваться административным поиском по контенту, медиа и навигации. Безопасно.",
  "perm.search.reindex":
    "Запускать полную переиндексацию поиска. Тяжёлая операция на больших сайтах.",
  "perm.search.diagnostics": "Видеть статус поискового индекса и диагностику. Безопасно.",
  // Forms & quizzes
  "perm.forms.read_definition":
    "Видеть определения форм (структуру, без ответов посетителей). Безопасно.",
  "perm.forms.manage_definition":
    "Создавать и менять формы. Ошибочная форма может молча терять лиды — проверяйте доставку.",
  "perm.quizzes.read_definition": "Видеть определения квизов. Безопасно.",
  "perm.quizzes.manage_definition":
    "Создавать и менять квизы. Аналогично формам: проверяйте после правок.",
  // Interactions & leads (PII)
  "perm.interactions.read":
    "Видеть события посетителей (квизы, формы). Персональные данные — выдавать осознанно.",
  "perm.interactions.manage": "Менять записи взаимодействий. Персональные данные.",
  "perm.interactions.export":
    "Выгружать данные взаимодействий наружу. Опасно: массовый вывоз персональных данных.",
  "perm.leads.read":
    "Видеть лиды: контакты, телефоны, переписку. Персональные данные — только доверенным агентам.",
  "perm.leads.manage": "Менять и обрабатывать лиды. Персональные данные.",
  "perm.leads.export": "Выгружать лиды наружу. Опасно: массовый вывоз персональных данных.",
  // Integrations
  "perm.integrations.read": "Видеть каталог коннекторов, связи и статусы. Безопасно.",
  "perm.integrations.configure":
    "Создавать и менять подключения (HQ, SMTP, Telegram и т.д.). Секреты write-only: значения не читаются назад.",
  "perm.integrations.test":
    "Отправлять тестовые доставки. Может отправить настоящее письмо/сообщение в тестовый канал.",
  "perm.integrations.deliveries.read":
    "Читать журнал доставок и ошибки. Нужен агенту для самодиагностики; может содержать фрагменты данных лидов.",
  "perm.integrations.retry":
    "Повторять неудавшиеся доставки. Отправляет сообщение повторно во внешний сервис.",
  "perm.integrations.inbound.read":
    "Читать входящие payload-ы интеграций. Может содержать персональные данные.",
  "perm.integrations.secrets.manage":
    "Записывать секреты коннекторов (ключи, пароли). Write-only: записать можно, прочитать нельзя. Дырки в безопасности это не создаёт.",
  // Payments
  "perm.payments.read": "Видеть платежи. Финансовые данные; выдавать осознанно.",
  "perm.payments.create": "Создавать платежи (ссылки на оплату). Не списывает деньги.",
  "perm.payments.configure":
    "Настраивать платёжных провайдеров. Ключи write-only; неверный конфиг ломает оплату.",
  "perm.payments.cancel": "Отменять платежи. Влияет на заказы клиентов.",
  "perm.payments.refund":
    "Делать возвраты денег. Самое опасное финансовое право — агентам не выдавать без явного решения.",
  "perm.payments.events.read": "Читать журнал событий платежей. Финансовые данные умеренно.",
} as const;

const EN: { readonly [K in keyof typeof RU]: string } = {
  "perm.content.read":
    "See entries, drafts and their version history. The base for any site work; safe on its own.",
  "perm.content.create": "Create new entries. Drafts are invisible to visitors, so this is safe.",
  "perm.content.edit":
    "Edit entry texts, blocks and fields. Editing a published page changes its draft — publishing stays a separate step.",
  "perm.content.archive":
    "Move entries to the archive (no deletion). Nearly harmless: archives are reversible.",
  "perm.preview.create":
    "Open preview links for unpublished pages via secret URLs. Not indexable; safe.",
  "perm.content_schema.read":
    "See content types and the block schema. Lets an agent understand page structure.",
  "perm.content_schema.propose":
    "Propose content schema changes (new blocks, fields). Takes no effect until applied.",
  "perm.content_schema.apply":
    "Apply content schema changes. Moderately risky: a wrong schema breaks page rendering, but it is revertible.",
  "perm.media.read": "Browse the media library and file paths. Safe.",
  "perm.media.write": "Upload and edit library files. Uses storage; cannot break the site.",
  "perm.media.replace":
    "Replace an existing image binary. Careful: a replacement is instantly live.",
  "perm.media.archive":
    "Archive library files. Does not delete, but pages referencing an archived asset lose the image.",
  "perm.media.import": "Import media from external URLs. Uses storage and bandwidth.",
  "perm.media.providers.manage":
    "Configure stock and generative media providers (keys are write-only). Moderately risky: a wrong key means broken generation.",
  "perm.media.stock.search": "Search stock photo providers (Pexels etc.). Consumes provider quota.",
  "perm.media.stock.import":
    "Download found stock photos into the library. Consumes provider quota.",
  "perm.media.generate":
    "Run AI image generation. Spends money on provider balances — grant deliberately.",
  "perm.research.search": "Search the Web via the research provider (XMLStock). Consumes balance.",
  "perm.research.fetch": "Fetch public Web pages through the safe fetcher (SSRF protection on).",
  "perm.research.manage":
    "Change research configuration: provider, proxy, limits. Grant only to network-trusted agents.",
  "perm.navigation.read": "See navigation sets. Safe.",
  "perm.navigation.edit": "Edit menu items. Changes reach the site on publish.",
  "perm.navigation.publish": "Publish navigation. Instantly changes the live site menu.",
  "perm.seo.read": "See page SEO metadata. Safe.",
  "perm.seo.edit": "Edit title/description/OG data. Mistakes hurt rankings but revert easily.",
  "perm.seo.validate": "Run SEO checks. Safe.",
  "perm.seo.canonical_override":
    "Override page canonical URLs. SEO-hazardous: a wrong canonical confuses search engines.",
  "perm.seo.site_settings":
    "Change site-wide SEO settings (sitemap, robots). Affects the whole site at once.",
  "perm.publication.read": "See revisions, plans and publication state. Safe.",
  "perm.revision.seal": "Seal entry revisions (edit protection). Revertible by an administrator.",
  "perm.publication.plan":
    "Build publication plans (what changes where). No site effect until published.",
  "perm.publication.schedule":
    "Schedule delayed publications. The live site changes at the scheduled moment.",
  "perm.publication.publish":
    "Publish to the live site. The agent's main lever: visitors see whatever it publishes. Grant to agents you trust with content.",
  "perm.publication.unpublish":
    "Unpublish live content. The live site hides the entry immediately.",
  "perm.publication.rollback":
    "Roll publications back to earlier versions. Powerful and hazardous: a rollback affects everything in the plan.",
  "perm.theme.read": "See theme sources and configuration. Safe.",
  "perm.theme.write":
    "Edit theme sources and config. The live site is untouched until activation/publish.",
  "perm.theme.validate": "Validate themes. Safe.",
  "perm.theme.preview": "Render theme previews. Safe.",
  "perm.theme.activate":
    "Activate a theme for the site. Hazardous: the live site switches immediately.",
  "perm.users.read": "List admin users and their roles. Personal data; administrators only.",
  "perm.users.manage": "Invite, disable users, reset MFA. Hazardous: can lock people out.",
  "perm.roles.read": "See roles and their permissions. Safe.",
  "perm.roles.manage":
    "Assign roles and create custom ones. Hazardous: enables privilege escalation.",
  "perm.tokens.manage":
    "Create service accounts and issue tokens. Hazardous: an agent holding this can mint its own tokens. Never grant to agents.",
  "perm.extensions.manage":
    "Install, enable and remove extensions. Moderately risky: an extension sees site events and data.",
  "perm.site.configure": "Change site settings (name, languages, behavior). Site-wide effect.",
  "perm.site.validate": "Run site-wide validation. Safe and useful for any agent.",
  "perm.site.maintenance": "Toggle maintenance mode. Hazardous: closes the site to visitors.",
  "perm.site.maintenance.bypass":
    "See the real site while maintenance mode is on. For working during maintenance windows.",
  "perm.domains.manage": "Manage site domains. Hazardous: a wrong domain breaks access and SEO.",
  "perm.embed.trusted":
    "Embed external content as trusted (iframe/video). Moderately risky: visitors see trusted external code.",
  "perm.audit.read":
    "Read the audit and security event log. Good for agent self-checks; mildly sensitive data.",
  "perm.search.admin": "Use admin search across content, media and navigation. Safe.",
  "perm.search.reindex": "Start full search index rebuilds. Heavy on large sites.",
  "perm.search.diagnostics": "See search index status and diagnostics. Safe.",
  "perm.forms.read_definition": "See form definitions (structure, not visitor answers). Safe.",
  "perm.forms.manage_definition":
    "Create and edit forms. A broken form can silently lose leads — verify delivery.",
  "perm.quizzes.read_definition": "See quiz definitions. Safe.",
  "perm.quizzes.manage_definition": "Create and edit quizzes. Same as forms: verify after edits.",
  "perm.interactions.read":
    "See visitor interaction events (quizzes, forms). Personal data — grant deliberately.",
  "perm.interactions.manage": "Edit interaction records. Personal data.",
  "perm.interactions.export": "Export interaction data. Hazardous: bulk export of personal data.",
  "perm.leads.read": "See leads: contacts, phones, messages. Personal data — trusted agents only.",
  "perm.leads.manage": "Manage lead records. Personal data.",
  "perm.leads.export": "Export lead data. Hazardous: bulk export of personal data.",
  "perm.integrations.read": "See the connector catalog, bindings and status. Safe.",
  "perm.integrations.configure":
    "Create and edit connections (HQ, SMTP, Telegram etc.). Secrets are write-only: values never read back.",
  "perm.integrations.test": "Send test deliveries. May deliver a real message to a test channel.",
  "perm.integrations.deliveries.read":
    "Read delivery logs and errors. Agent self-diagnostics; may contain lead data fragments.",
  "perm.integrations.retry":
    "Retry failed deliveries. Sends the message to the external service again.",
  "perm.integrations.inbound.read": "Read inbound integration payloads. May contain personal data.",
  "perm.integrations.secrets.manage":
    "Write connector secrets (keys, passwords). Write-only: can set, cannot read. Not a security hole.",
  "perm.payments.read": "See payments. Financial data; grant deliberately.",
  "perm.payments.create": "Create payments (payment links). Moves no money.",
  "perm.payments.configure":
    "Configure payment providers. Keys are write-only; a wrong config breaks checkout.",
  "perm.payments.cancel": "Cancel payments. Affects customer orders.",
  "perm.payments.refund":
    "Refund money. The most hazardous financial scope — never grant to agents without an explicit decision.",
  "perm.payments.events.read": "Read payment event logs. Mildly financial data.",
};

const EN_PRESETS: { readonly [K in keyof typeof PRESETS]: string } = {
  "access.preset_site_development": "Preset: site development from scratch",
  "access.preset_content_work": "Preset: content work",
  "access.preset_theme_work": "Preset: theme work",
  "access.preset_integrations_work": "Preset: integrations and notifications",
  "access.preset_readonly_diagnostics": "Preset: read-only and diagnostics",
  "access.preset_all": "Preset: all permissions",
  "access.preset_hint": "A preset is a starting point; tick or untick anything afterwards",
};

export const permissions = defineFragment({ ...PRESETS, ...RU }, { ...EN_PRESETS, ...EN });
