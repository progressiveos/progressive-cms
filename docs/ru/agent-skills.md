# Публичные Agent Skills

Официальный `progressive-cms-site-builder` версии 1.3.1 поставляется самостоятельной папкой с YAML frontmatter, кратким workflow, локальными API references, JSON-примерами и темой. Для работы агенту нужны brief и разрешённый доступ к установленной CMS, а не предварительное чтение архитектуры. `content-agent` версии 1.5.3 остаётся частью комплекта документации.

Также поставляются самостоятельные [progressive-cms-152fz](../skills/progressive-cms-152fz/SKILL.md) и [progressive-cms-seo](../skills/progressive-cms-seo/SKILL.md) версий 1.1.0 и 1.0.1 соответственно: техническая подготовка по ПД с адресными инструментами и тщательные SEO-исправления. Политики consent/retention и применение privacy workflow выбирает владелец. У них свои локальные references, API schemas и формы приёмки. Юридические документы/уведомления остаются владельцу, а индексацию и позиции определяют поисковики.

Папка выбранного Skill из `skills/` в исходниках релиза или из `docs/skills/` копируется целиком в проект: Codex — `.agents/skills/`, Claude Code — `.claude/skills/`, Copilot — `.github/skills/`. Подробности и официальные источники: [установка и запуск](../agent-skills.md).

Версия Skill, минимальная совместимая CMS и текущий релиз — разные значения. Нижние границы сохранены в [каталоге](../skills/catalog.json) и manifests; сравнивайте их с фактическим bootstrap, а текущий релиз смотрите в [основном индексе](../index.md).

Для CMS CLI:

```sh
export PCMS_SKILLS_DIR="<release-folder>/skills"
cms skills list --json
cms skills doc progressive-cms-site-builder --json
cms skills check progressive-cms-site-builder --json
```

Не используйте community installer для first-party id. Переменная меняет локальное обнаружение Skill, но не permissions токена. Поддержка формата не означает выполненную проверку живой сессии в каждом агенте.

[Русский индекс](index.md)
