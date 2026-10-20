-- Extension projections retain their mount-relative path. Query composition
-- joins it to the current enabled mount, so disable/move and in-flight rebuilds
-- cannot expose stale URLs. Ordinary Entry documents keep their existing route.
ALTER TABLE search_documents ADD COLUMN extension_path text;

-- Preserve already indexed extension documents without requiring site agents
-- to reimport content or run a manual reindex. Accept the former default-locale
-- prefix as well as the corrected unprefixed form. Unmounted sources stay hidden.
WITH paths AS (
  SELECT d.epoch, d.entity_type, d.entity_id, d.context,
         substring(d.route FROM length(prefix.path) + 1) AS relative_path,
         CASE WHEN d.locale IN ('default', 'x-default') THEN l.default_locale ELSE d.locale END AS locale
  FROM search_documents d
  JOIN pcms_extension_route_mounts m
    ON m.extension_id = split_part(d.entity_type, '/', 1) AND m.retired_at IS NULL
  JOIN sites s ON s.id = m.site_id AND s.key = d.site_id
  CROSS JOIN pcms_site_localization l
  CROSS JOIN LATERAL (
    SELECT candidate.path FROM (VALUES
      ((CASE WHEN d.locale IN ('default', 'x-default', l.default_locale) THEN ''
             ELSE '/' || lower(split_part(d.locale, '-', 1)) END) || CASE WHEN m.mount_path = '/' THEN '' ELSE m.mount_path END),
      ((CASE WHEN d.locale IN ('default', 'x-default') THEN ''
             ELSE '/' || lower(split_part(d.locale, '-', 1)) END) || CASE WHEN m.mount_path = '/' THEN '' ELSE m.mount_path END)
    ) candidate(path)
    WHERE starts_with(d.route, candidate.path || '/')
    ORDER BY length(candidate.path) DESC LIMIT 1
  ) prefix
  WHERE l.id = 1 AND strpos(d.entity_type, '/') > 0
)
UPDATE search_documents d SET extension_path = paths.relative_path, locale = paths.locale
FROM paths
WHERE (d.epoch, d.entity_type, d.entity_id, d.context)
    = (paths.epoch, paths.entity_type, paths.entity_id, paths.context);
