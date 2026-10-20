# Progressive CMS

**Build agency-quality websites with AI agents. Own the result.**

Turn a business brief, design references, and content into a complete, custom website. AI agents can set up Progressive CMS, build themes and pages, organize navigation, prepare SEO, validate changes, and publish the result.

You guide the work and review the output. Once the site is live, you can maintain it through a full CMS Admin interface — with or without an AI agent.

[Get started](#quickstart) · [Build your first site](docs/first-site.md) · [AI agent workflow](docs/agent-workflow.md) · [Documentation](docs/index.md)

*Open source · Self-hosted · Public Beta*

## A different cost model for website production

Much of the repetitive work traditionally done by hand can be performed by AI agents using model inference. Teams can focus their time on creative direction, business requirements, and quality control.

**No per-site CMS license fees. Agent-assisted development shifts much of the production effort toward model usage, infrastructure, creative direction, and human review.** Production costs vary with complexity, model choice, source materials, and human review. The result depends on the brief, the agent's work, and your review; no fixed cost or level of quality is guaranteed by a prompt.

## Your website. Your infrastructure. Your control.

Progressive CMS runs on your own Linux server. Your content, database, media, and themes remain under your control. The resulting website is a normal, editable CMS project that you can operate, modify, and maintain independently.

Developers can build custom themes and integrations. Studios can use agents across website production and hand clients an editable CMS. Business owners retain the site, its source and its data, with freedom to choose who maintains it.

## From brief to published website

1. **Define the site:** provide business goals, page structure, design references, language, and source materials.
2. **Install the CMS:** use the native installer on your authorized server, configure the domain and HTTPS, and create scoped credentials for authoring.
3. **Build the design and content:** create a Liquid theme, editable pages, media, forms, and navigation through the documented CMS tools.
4. **Review the result:** check content, previews, SEO, links, and responsive layouts before publication.
5. **Publish and maintain:** publish through the CMS, then continue editing in Admin or through an authorized agent.

The [First Site guide](docs/first-site.md) covers the authoring sequence on an installed instance. Initial server provisioning is a separate operator workflow.

## Quickstart

### With an AI agent

Give your agent the [installation guide](docs/installation.md), [requirements](docs/requirements.md), and [Operator Skill](skills/progressive-cms-operator/SKILL.md). Authorize the intended server and installation explicitly. Installation requires administrative privileges; ordinary content authoring uses scoped CMS credentials.

Once the CMS is installed, give the agent your brief and the [Site Builder Skill](skills/progressive-cms-site-builder/SKILL.md). Follow the [agent workflow](docs/agent-workflow.md) to discover the installed contracts, create editable content, validate it, and publish only within the authorized scope.

```sh
cms agent bootstrap --json
```

This command is the discovery entry point after configuring the instance URL, site/environment context, and credentials. See [Agent Skills](docs/agent-skills.md) for setup. Choose your own agent and model; ordinary Admin editing requires no AI subscription.

### Install and manage it yourself

1. Get the official ZIP and SHA-256 sidecar from [GitHub Releases](https://github.com/progressiveos/progressive-cms/releases).
2. Verify the checksum and follow the [installation guide](docs/installation.md). Choose local Nginx or an external reverse proxy, and configure HTTPS.
3. Sign in to Admin, change the bootstrap password, and check the installation with `cms doctor`.
4. Follow [First Site](docs/first-site.md) for the content model, theme, navigation, and publishing workflow. Use Admin for ongoing content editing.

The current installation target is Ubuntu 26.04 with systemd, Node.js 24, and PostgreSQL. Read the [exact requirements](docs/requirements.md) before provisioning. See [BUILDING.md](BUILDING.md) if you want to build from source instead of installing an official archive.

## Technical capabilities

| Area | Capabilities and reference |
|---|---|
| Content | [Typed content models](docs/content-model.md), visual [RichText with tables and images](docs/richtext.md), and [Block Documents](docs/blocks.md) for structured page composition. |
| Publishing | [Drafts, revisions, CAS editing, preview, sealing, publication, and scheduling](docs/publishing.md). |
| Design | [Liquid themes](docs/themes.md), live theme activation/settings, revision history and rollback; [navigation and breadcrumbs](docs/navigation.md). |
| Media and forms | [Managed media and derivatives](docs/media.md), [forms and submissions](docs/forms.md). |
| Discovery | [Search and reindex](docs/search.md), [SEO metadata, canonical URLs, sitemaps, pagination and ownership verification](docs/seo.md). |
| Automation | [REST API](docs/rest-api.md), [CLI](docs/cli.md), [MCP](docs/agents.md), and supplied [Agent Skills](docs/agent-skills.md). |
| Access control | [Roles, permissions, sessions, and scoped Service Accounts](docs/security.md). Agents remain subject to server-side permissions. |
| Extensions | [Public Extension SDK 2.0](docs/extensions.md) for independent packages; optional capabilities are installed deliberately. |

## Complete interface references

The full interface maps are published with the source and versioned alongside each release. Use the guide for a workflow, then the map for exact commands, operations, arguments, permissions, and error behavior.

| Interface | Task guide | Complete reference |
|---|---|---|
| REST API | [REST guide](docs/rest-api.md) | [Full REST operation map](docs/rest-api-map.md) |
| CLI | [CLI guide](docs/cli.md) | [Full commands and options map](docs/cli-map.md) |
| MCP | [MCP guide](docs/agents.md) | [Full tools and protocol map](docs/mcp-map.md) |
| API schema | [API reference](docs/api-reference.md) | [OpenAPI JSON](docs/reference/openapi-v1.json) |

Inspect the installed instance's discovery and OpenAPI when using optional extensions: its active capabilities can differ from the standard release. The maps document their schema and transport limitations explicitly.

## Architecture and development

Progressive CMS is a TypeScript modular monolith with a Web application, Admin UI, background Worker, CLI, and PostgreSQL. Themes control presentation through Liquid; content remains in versioned CMS documents. A CMS installation does not require a particular AI provider.

Core includes the [public Extension SDK](packages/extensions/src/sdk.ts). The [official Extensions source](https://github.com/progressiveos/progressive-cms-extensions) is a separate repository; source builds verify pinned package versions and digests. Independent extensions may use their own licenses, including commercial licenses. Trusted server extensions execute with application privileges: install only code you trust.

See [BUILDING.md](BUILDING.md), the [extension development guide](docs/extensions.md), and the [documentation index](docs/index.md). English is the primary documentation language; [Russian documentation](docs/ru/index.md) is a partial translation.

## Release status and updates

This is **Progressive CMS 1.0 Public Beta**. Interfaces and operational workflows may still need refinement. Evaluate it for your workload and keep recoverable backups before upgrading.

The first Public Beta uses technical version **`1.0.0-rc.29`**. The `rc` identifier preserves the existing Registry version contract and upgrade order for earlier installations. This is a beta prerelease, not stable 1.0.0.

Every official release has a source tag and an entry in [GitHub Releases](https://github.com/progressiveos/progressive-cms/releases), with the **installable ZIP, SHA-256 checksum, release manifest, and release notes**. GitHub's generated source archives serve a different purpose from the installable ZIP. Previous release entries, tags, and archives remain available; new versions do not overwrite old artifacts.

The official Registry provides the same release artifact for native update workflows. See [Operations](docs/operations.md) for updates and recovery. Publication does not automatically update your website.

## Community and contributions

Report reproducible problems through [GitHub Issues](https://github.com/progressiveos/progressive-cms/issues). Include the installed version, expected and actual behavior, and minimal reproduction steps. Remove credentials and personal data from logs and exports. Do not disclose exploitable security issues in public issues.

Pull requests are welcome for review under Apache-2.0 with a DCO 1.1 sign-off; no CLA is required. Contributions are reviewed for correctness, product scope, and maintenance cost. Progressive OS maintains the product direction and official release process.

## License and attribution

Progressive CMS is an original product of Progressive OS, licensed under [Apache License 2.0](LICENSE). Commercial use and modification are permitted, with no per-site CMS license fee or required promotional credit on your website.

See [NOTICE](NOTICE), [third-party notices](THIRD_PARTY_NOTICES.md), and the [trademark policy](TRADEMARKS.md). Dependencies and bundled third-party assets retain their own licenses.

[Progressive CMS](https://p-cms.com) · [Русский сайт](https://p-cms.ru)
