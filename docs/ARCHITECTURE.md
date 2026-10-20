# Architecture

Progressive CMS is a self-hosted TypeScript application backed by PostgreSQL. A normal deployment includes the Web application, browser-based Admin, background Worker and the `cms` command-line interface. Agents can use the same documented capabilities through REST, CLI or an MCP connection; an AI provider is not required to run the CMS or edit a site in Admin.

## Main parts

- **Web** serves the REST API, public routes, Admin assets, previews, media and generated discovery/OpenAPI responses.
- **Admin** is the browser interface for site owners and editors. It uses the same permission checks and public application contracts as other clients.
- **Worker** processes background work such as publication/search jobs and other queued tasks. Its health and queue state are checked separately from public page delivery.
- **PostgreSQL** stores CMS configuration, content definitions, versioned entries, publication state, routes, jobs and audit data.
- **Themes** are validated Liquid packages that control presentation. They do not define private database storage or bypass the declared Content Types.
- **Extensions** are separately versioned packages that use the public Extension SDK. Trusted server extensions execute with application privileges; install only packages whose source and publisher you trust.
- **CLI, REST and MCP** are client surfaces over supported CMS operations. Discover the actual server version, permissions and optional capabilities before using them.

## Content and rendering

Content Types define the fields editors may manage. RichText v2 stores structured prose; Block Document v1 composes registered blocks into page layouts. Themes render these declared models into public HTML. Revisions move through draft, validation, preview, seal and publication steps; a public URL is bound through the publishing workflow rather than inferred from a slug.

Content Tree parentage, navigation sets and route bindings are separate concepts. Parentage supplies breadcrumbs and can affect inherited SEO imagery; navigation placements decide which links appear in a theme. Search indexing and scheduled/background work are asynchronous and depend on the Worker.

## Trust boundaries

The operator provisions the host, PostgreSQL, TLS, secrets, backups and system services. Agents and other clients receive scoped site/environment credentials, and server-side permissions remain authoritative. The CMS does not require unrestricted database access for normal content work. Publishing, schema changes, theme activation, maintenance and personal-data actions require their corresponding permission and owner authorization.

The public API maps and the installed server's discovery documents describe the available interfaces. Optional Extensions and installed release composition can add capabilities, so source-tree presence alone does not prove a capability is active on a site.

Continue with [Installation](installation.md), [First Site](first-site.md), and the [REST, CLI and MCP maps](index.md#contracts-and-tasks).
