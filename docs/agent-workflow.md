# Agent workflow: from first connection to an editable site

Use this sequence for a new site. The [First Site guide](first-site.md) gives concrete commands and JSON examples. Adapt names/design to the task and read the linked contract before each operation.

1. Read [Installation](installation.md), [Requirements](requirements.md), and [Configuration](configuration.md). For an already installed CMS, obtain its approved origin, site key, environment, scoped token and actual version from the operator. Never seek database or unrestricted host access for normal authoring.
2. Read [Agent Skills](agent-skills.md), inspect the supplied Skills and compare their compatibility/scopes with `cms agent bootstrap --json`. Stop if the actual server does not satisfy the declared compatibility.
3. Read [Content Model](content-model.md) and the [Content Contract](content-contract.md). Discover existing types. Choose RichText v2 for prose and Block Document v1 for typed page composition according to each declared field policy. Validate/apply the supplied definitions before creating entries; honor any bounded operator reload and rediscover effective types.
4. Read [Themes](themes.md), then adapt the [theme starter](reference/theme-starter/README.md). Match templates to effective Content Types, validate and install the package, then activate its id through Admin or `POST /api/v1/theme/activate` with `theme.activate`. Persistent activation overrides `themes.renderDir`, which is a catalog/boot seed; ordinary activation does not require a Web restart.
5. Create forms before using their returned ids in form blocks. Upload managed media and discover derivatives; keep principal images optional when the type allows them. Build pages, parent relationships, navigation sets, homepage binding and layouts as separate concepts. Read [Forms](forms.md), [Media](media.md) and [Navigation](navigation.md).
6. Create content using documented REST/CLI/MCP. Follow [Publishing](publishing.md): fresh draft, compare-and-swap edits, validation, exact preview, seal, authorized publish, then check public route and eventual [Search](search.md). Never write content directly to PostgreSQL.
7. Read [SEO](seo.md); verify explicit image, own hero, inherited parent image, site default and the no-image case. Inspect public HTML and current derivatives.
8. Hand the result to a normal editor using [Admin](admin.md). The editor must be able to change RichText/table/media, save, preview, seal and publish another revision using declared content fields.

Use [Errors](errors.md) for typed failures. Record ids and generations, never credentials.
