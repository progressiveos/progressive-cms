---
name: progressive-cms-site-builder
description: Build or redesign an editable website on Progressive CMS from a brief, including content types, Liquid theme, navigation, forms, media, SEO and publishing. Use for creating a CMS-managed company site or landing pages through public CMS CLI, REST or discovered MCP tools.
metadata:
  author: Progressive CMS
  version: "1.3.1"
---

# Progressive CMS Site Builder

Turn the user's brief into a working, editable site. Start here; no architecture study or full documentation read is needed. All required references and starter assets are inside this folder.

Use an authorized CMS instance with its CLI, HTTP client or configured MCP connection. Local theme authoring validation needs the release CLI or an operator-provided validated package. The JSON manifest declares CMS compatibility; no private Core source checkout is required.

## Start

Obtain the intended pages/design/language, authorized CMS origin, site key, environment and scoped credentials. Confirm whether publication is included in the task. Reuse facts already provided; ask only for missing decisions. A deployed CMS and its operator-managed installation are prerequisites.

With `PCMS_API_URL`, `PCMS_API_TOKEN`, `PCMS_SITE_KEY` and `PCMS_ENVIRONMENT` supplied through the approved secret channel, start with:

```sh
cms agent bootstrap --json
cms capabilities --json
cms theme active --json
```

`cms capabilities` is a local compiled permission/contract catalogue. Use bootstrap (or authenticated REST `GET /api/v1/capabilities`) for the connected actor’s effective capabilities; do not confuse the two reports.

Read actual `server.cms_version`, target identity, contracts/scopes and preview readiness. Compare with [manifest.json](manifest.json); the Skill version and [documentation release](references/release.md) do not change the running CMS. If the CLI is unavailable, use the REST entry in [workflow](references/workflow.md), or discover the configured MCP tool catalogue. Never invent an MCP tool name.

## Build in this order

1. Read [workflow](references/workflow.md) for the executable path, then make a short page/content plan matching the brief.
2. Before creating content, read [content and theme](references/content-and-theme.md). Reuse discovered types or declare compatible types/bodyPolicy, then adapt the bundled Liquid theme in a new workspace.
3. Create form definitions before referencing them. Write real declared content, upload authorized media, create page parentage and menu bindings. Use returned IDs and generations.
4. Validate and preview each target revision, resolve blockers, seal, then publish if authorized. Complete [site and editor checks](references/checks.md) and report observed results and remaining blockers.

Load the [selected REST operation schemas](references/api-operations.json) only for the operation being performed. Assets include [Content Types](assets/examples/content-types.json), [assembled page](assets/examples/create-page.json), [news article](assets/examples/create-news.json), [contact form](assets/examples/contact-form.json) and [theme starter](assets/theme-starter/README.md). They are editable examples, not completed site content.

## Boundaries that affect the result

Keep prose editable in declared RichText v2 fields, assembled layouts in Block Document v1, and presentation in the theme. Do not turn articles into hidden blocks or store pre-rendered page HTML as content. Images may remain absent where the schema permits them.

Use fresh WORKING revisions and actual CAS generations; SEALED revisions are immutable. A 409 means reread and reconcile. Stop the dependent operation on a Core defect or missing permission; report the exact public operation and sanitized error. Do not repair Core/DB or bypass publication validation.

Use only the authorized site/environment. Theme activation, public publishing and schema reload need the permissions and authority for those actions. A schema response with `restart_required` is an operator reload boundary. The Skill grants no root/DB access, lead-export access or authority to deploy releases.

## Completion

Return public URLs, changed content/theme/form/navigation IDs, current Skill and CMS versions, performed checks and unresolved issues. A normal editor must be able to change the content and republish through Admin. Separate successful local validation from observed publication, form delivery and external provider acceptance. Never include credentials, signed preview URLs or real submissions in the report.
