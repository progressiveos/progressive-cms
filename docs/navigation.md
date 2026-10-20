# Navigation and breadcrumbs

Contract owner: Core navigation, Content Tree and public Theme/Liquid scope.

## Menus are independent from Content Tree

Discover `GET /api/v1/discovery/navigation/placements`. Required placements and allowed item depth/types come from the active theme. Create a set, add items using stable entry identity, seal the set, then bind it. Relative paths below use the API base and authentication context from [REST API](rest-api.md).

```http
POST /api/v1/navigation/sets
{"key":"main","title":"Main navigation"}

POST /api/v1/navigation/sets/<set-id>/items
{"type":"internal_entry","label":"Services","target":{"entry_id":"<services-entry-id>"},"at":0}

POST /api/v1/navigation/sets/<set-id>/seal
{}

PUT /api/v1/navigation/placements/header.primary
{"navigation_set_id":"<set-id>"}
```

Bind a mobile placement too if the manifest requires one. Inspect the discovery tree and `GET /api/v1/navigation/validate` after publication. Item types include internal_entry, external_url, anchor, group, separator and action. Use discovered item schemas, not assumed target properties for unrelated types.

Deleting a bound navigation set returns **HTTP 409** with `NAV_SET_BOUND`. Read the stable code, find its bindings and choose an authorized rebind/unbind operation. Do not retry the delete blindly or treat it as malformed input.

## Public breadcrumb contract

Entry routes receive `breadcrumbs`, either null or `{items:[{title,href},...]}`. Core derives the chain from the **Content Tree parent links**, not from a menu trail or URL segments. Set `parent_entry_id` when creating a child entry; use the supported move operation for an existing entry. Publishing a navigation menu does not create content parents.

Core reads ancestor labels from published revisions in the request locale. Missing/unpublished/untranslated ancestors are omitted; an unavailable href becomes an empty string and must render as text. A chain of one item yields null. Resolution failure degrades to no breadcrumbs, not a page failure.

```liquid
{% if breadcrumbs and breadcrumbs.items != empty %}
<nav aria-label="Breadcrumbs"><ol>
{% for crumb in breadcrumbs.items %}
  {% if forloop.last %}
  <li aria-current="page">{{ crumb.title }}</li>
  {% elsif crumb.href != empty %}
  <li><a href="{{ crumb.href }}">{{ crumb.title }}</a></li>
  {% else %}
  <li>{{ crumb.title }}</li>
  {% endif %}
{% endfor %}
</ol></nav>
{% endif %}
```

A banner combines a background image, H1, this breadcrumb component and CSS in the theme. There is no special Page Hero entity to create in Core. Test a root, child and deeper child, plus an unpublished ancestor and a page without an image.

[Documentation index](index.md)
