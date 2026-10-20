# Официальные источники SEO

Сверено **2026-10-19**. Перепроверь изменяющиеся требования и eligibility перед каждым выполнением, особенно rich results, indexing API и Webmaster capabilities. Сохраняй фактическую дату просмотра в отчёте. Ни дата Skill, ни номер CMS не подтверждают будущую актуальность.

| ID | Источник | Применение |
|---|---|---|
| G1 | [Google SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide?hl=en) | Обход, структура, содержание, titles/descriptions, отсутствие гарантированного ранжирования. |
| G2 | [Google: title links](https://developers.google.com/search/docs/appearance/title-link?hl=en) | Основной заголовок, заметные повторяющиеся headings, шаблонные/устаревшие title и причины переписывания. Не задаёт единую числовую длину или универсальный запрет нескольких H1. |
| G3 | [Google: duplicate URLs and canonical](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) | Согласованные сигналы canonical, redirect, sitemap; canonical не запрет индексации и не гарантия выбранного URL. |
| G4 | [Google: robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/intro) | Robots не авторизация; disallow и noindex решают разные задачи. |
| G5 | [Google: build a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap?hl=en) | Canonical URL, достоверный lastmod, лимиты файлов/индексы. |
| G6 | [Google: localized versions](https://developers.google.com/search/docs/specialty/international/localized-versions) | Hreflang, reciprocal/self references, отдельные URL и языки. |
| G7 | [Google: pagination/incremental loading](https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading?hl=en) | Уникальные URL пагинации, self canonical, доступные ссылки вместо единственного scroll/button. |
| G8 | [Google: crawlable links](https://developers.google.com/search/docs/crawling-indexing/links-crawlable?hl=en) | Обычные href/анкоры и полезная перелинковка. |
| G9 | [Google Search spam policies](https://developers.google.com/search/docs/essentials/spam-policies?hl=en) | Клоакинг, hidden text, link abuse, scaled content abuse, недопустимые «оптимизации». |
| G10 | [Google image SEO](https://developers.google.com/search/docs/appearance/google-images) | Alt, доступные изображения, responsive images, filenames/context, подходящие previews. |
| G11 | [Google structured data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies?hl=en) | Фактическое содержимое, eligibility, rich-result ограничения и отсутствие гарантии показа. |
| G12 | [Google JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) | HTML/rendering, метаданные, robots, ресурсная доступность, soft 404. |
| G13 | [Google mobile-first indexing](https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing?hl=en) | Равный основной контент, metadata/structured data и мобильные ресурсы. |
| G14 | [Google Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals) | Полевые метрики и связь с пользовательским опытом без обещания позиции. |
| G15 | [web.dev: Web Vitals](https://web.dev/articles/vitals?hl=en) | LCP/INP/CLS, good thresholds и 75-й перцентиль; лаборатория отличается от поля. |
| Y1 | [Яндекс: как поиск и посетители видят страницы](https://yandex.ru/support/webmaster/ru/robot-workings/vision) | Контент/заголовки, metadata, микроразметка, favicon, JS, мобильность/скорость. |
| Y2 | [Яндекс: канонический адрес](https://yandex.ru/support/webmaster/ru/robot-workings/canonical) | Выбор canonical, дубли и согласование сигналов. |
| Y3 | [Яндекс: robots.txt](https://yandex.ru/support/webmaster/ru/controlling-robot/robots-txt) | Синтаксис, robot-specific правила и sitemap. |
| Y4 | [Яндекс: Clean-param](https://yandex.ru/support/webmaster/ru/robot-workings/clean-param) | Удаление из обхода незначимых параметров, не содержательных фильтров; Google не обязан применять директиву. |
| Y5 | [Яндекс: description и сниппет](https://yandex.ru/support/webmaster/ru/indexing-options/description) | Описание и фактическое формирование сниппета. Для title используй G2 и общий обзор Y1; недоступную страницу title не выдавай за прочитанный источник. |
| I1 | [IndexNow protocol](https://www.indexnow.org/documentation) | Host/key, уведомление участвующих поисковиков об изменении, отсутствие гарантии индексации. |
| O1 | [Open Graph protocol](https://ogp.me/) | Карточка, тип/url/image и structured properties. OG не обязательный ranking factor. |

Матрица объединяет рекомендации этих документов с проверяемыми инженерными решениями. Один основной видимый H1, полезная description и конкретная политика параметров отмечаются как принятая политика сайта там, где источник не устанавливает универсальный запрет/обязательство. Для неподдерживаемого отраслевого типа открой профильную официальную документацию на этапе применимости, не добавляй выдуманные требования из чужого чеклиста.
