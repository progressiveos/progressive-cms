# SEO и изображения

Фактическая цепочка social image:

```text
social_image → собственный hero_image → ближайший подходящий родительский раздел → site default_social_image
```

Родитель определяется Content Tree через parent_entry_id, а не меню или URL. Проверяется ближайший предок с опубликованной ревизией в нужной локали: его явный social_image приоритетнее hero_image из published payload. Неопубликованный предок пропускается. Обход ограничен и защищён от циклов.

Это вычисление при чтении: изображение не записывается в дочерние документы. Наследуется только social image; title, description, canonical, robots и другие SEO-поля остаются собственными. Provenance родительского изображения — parent_section_image. Если подходящего источника нет, используется site default; без него изображение отсутствует.

hero_image — необязательное объявленное MediaAsset-поле. Баннер страницы — композиция темы из изображения, H1, breadcrumbs и CSS, а не отдельная Core-сущность Page Hero. OG preview и карточка материала имеют собственные правила выбора производных.

Проверьте четыре независимых случая и реальный HTML: title, description, canonical, og:image, twitter:image, robots, sitemap и JSON-LD. OG использует Core derivative og-v1 1200×630 JPEG. Preview: `GET /api/v1/discovery/seo/preview?entry_id=<entry-id>`; validation: `GET /api/v1/discovery/seo/validate?entry_id=<entry-id>`. Нужны соответствующие scopes.

[Полная глава](../seo.md) · [Русский индекс](index.md)
