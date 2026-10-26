# Complete CLI map

This map covers every command family dispatched by `cms`, including subcommands omitted by the top-level help, local operator recovery and commands contributed through bundled helpers. Syntax and behavior were checked against `packages/cli/src/main.ts`, `framework.ts`, `api-client.ts` and every command module. The source-derived appendix records every parsed flag and selector, so an author can detect additions at the next release. Current product release: [release-version.txt](release-version.txt).

Use [First Site](first-site.md) for the sequence and the [REST map](rest-api-map.md) for full request schemas of remote commands. A command listed here is an implemented dispatch branch, not a claim that every invocation succeeds: confirmed parser limitations are stated explicitly. The [MCP map](mcp-map.md) lists actual tool names rather than guessed CLI equivalents.

## Notation, context and output

`<value>` is required; `[value]` or `[--flag]` is optional. Replace placeholders before running. Each command is written separately; alternatives are not hidden behind `list|get|edit`. `--json` is supported by the command families below unless a limitation is stated. It selects machine output, but the shape is command-specific: some commands return the application body directly, others add `ok`, and older local commands have their own result shape.

Modes: **API** calls the running instance; **local** reads/writes local files; **DB** connects directly through local configuration; **external** contacts the named third-party source. API operations enforce server permissions shown in the REST map. Local/DB commands require authorized operator access to that installation; a remote API token does not turn them into remote commands.

| Global input | Meaning |
|---|---|
| `--json` | Deterministic machine stdout; inspect the payload as well as the exit status. |
| `--site <key>` | Remote `X-PCMS-Site`; overrides `PCMS_SITE_KEY`. It is consumed by the global parser before modern command handlers run. |
| `--environment <env>` | Remote `X-PCMS-Environment`; overrides `PCMS_ENVIRONMENT`. Where `requireTargetSafety` is used, the flag itself must be explicit; the environment variable alone is not confirmation. |
| `--yes` | Confirmation only for commands whose implementation checks it. It is not a universal dry-run/apply switch. |
| `--config <path>` | Local config when the handler consumes global options, or when a legacy parser accepts it. Without an explicit path, the config loader uses `PCMS_CONFIG_FILE`, then `./config/pcms.json`. |
| `--profile <name>` | Selects `pcms.<name>.json` only in modern local commands using `configLoadOptions`; an explicit `--config` wins. It does not change the remote URL or establish authorization. Legacy families do not generally accept it. |
| `PCMS_API_URL` | Instance origin, without `/api/v1`; required by API commands. |
| `PCMS_API_TOKEN` | Service token through environment, never an argv flag. |
| `PCMS_SITE_KEY`, `PCMS_ENVIRONMENT` | Required remote target context when not supplied by flags. |

For legacy `config`, `db`, `schema`, local `theme`, `site`, `nav`, `route`, `user`, `session` and `token` commands, keep the command/subcommand first and place accepted flags after them. The dispatcher falls back to the original argv; leading global flags can prevent legacy dispatch. Unknown flags are not uniformly rejected by every command: do not interpret silence as support.

Framework exits: **0** success; **1** unexpected; **2** usage/configuration; **3** validation; **4** conflict; **5** authorization; **6** not found; **7** transient dependency. Legacy recovery/navigation/configuration/schema/site commands retain their own 0/1/2 behavior. `.pcpub` submit and Skill package validation also have special outcomes described below. `cms --help` currently prints the summary and exits 2; it is not a complete per-command help system.

## Discovery, configuration and maintenance

| Command | Purpose, input and result | Mode and effects |
|---|---|---|
| `cms agent bootstrap` | Returns actual site/environment, actor/scopes, product and subsystem versions, capabilities, Skills, preview/domain readiness. Start here. | API, discovery. |
| `cms capabilities` | Returns the **local compiled** permission registry, theme/block/bundle versions and limits. This is not the connected actor's effective capabilities. Use bootstrap or REST `/capabilities` for that. | Local, no target probe. |
| `cms info` | Reads local config; summarizes DB address/user, HTTP binding and configured subsystems without secret values. Does not prove DB connectivity or report the running remote release. | Local config. |
| `cms doctor` | Checks local installation/configuration, DB and composed subsystems, storage and runtime dependencies. Returns named checks, warnings/failures; can perform diagnostics/provider probes. | Local/DB and configured dependencies; not remote `/diagnostics`. |
| `cms config validate [--config <path>]` | Parses/validates configuration and secret-reference declarations; returns validation diagnostics. | Local; exits 0 valid, 1 invalid/runtime failure, 2 usage. |
| `cms db migrate [--check] [--config <path>]` | `--check` reports pending migrations, exits 1 when pending. Without it applies pending migrations explicitly. | DB mutation without `--yes`; operator-only. |
| `cms maintenance status` | Reads current public maintenance state. | API. |
| `cms maintenance enable --environment <env> --yes [--title <text>] [--message <text>] [--promo-label <text>] [--promo-url <url>] [--retry-after <seconds>]` | Enables the public maintenance response; optional fields update its copy/link/retry delay. `--retry-after` must be integer seconds. | API mutation, `site.maintenance`, explicit target/confirmation. |
| `cms maintenance disable --environment <env> --yes` | Disables public maintenance. | API mutation, same safety gate. |

## Content types, drafts and previews

| Command | Purpose, input and result | Mode and effects |
|---|---|---|
| `cms content schema list` | Effective Content Type descriptors. Bare `cms content schema` also takes this branch. Uses API when API client context resolves; otherwise locally loads configured types/blocks. | API-first/local fallback; fallback is not proof of remote state. |
| `cms content schema show <key>` | Effective schema, fields and `bodyPolicy` for a type; same API-first/local behavior. | Discovery. |
| `cms content schema validate --file <definitions.json>` | Validates a bare definitions array or `{ "contentTypes": [...] }`; reports issues, additive diff and violations without applying. | API, `content_schema.propose`. |
| `cms content schema apply --file <definitions.json> --environment <env> --yes` | Applies permitted additive changes; returns affected-entry counts and `restart_required`. Honor that flag before relying on newly registered types. | API mutation, `content_schema.apply`. |
| `cms content validate <payload.json>` | Validates `{content_type, payload:{fields,blocks}}` against **local** configured registries at publish level, including block documents when selected by the type. Returns issues, exits 3 on invalid content. | Local config, no remote validation. |
| `cms content import <bundle.json>` | Reads the application JSON bundle and posts `/bundles` with `mode: apply`; returns changeset/publication result. This is not `.pcpub` ingest. | API mutation; no CLI `--yes` gate. |
| `cms content create --file <payload.json>` | Posts the complete create-entry request, including `content_type` and payload; returns `entry_id`, `revision_id`, generation and base. Creates WORKING content, not publication. | API mutation, `content.create`. |
| `cms content draft --entry <entry-id> [--from-revision <revision-id>]` | Opens/reuses a working draft; optionally starts from a selected sealed revision. Returns revision id, base and whether it was created. | API mutation, `content.edit`. |
| `cms content patch --revision <revision-id> --file <payload.json> --expected-generation <N>` | Sends file's `payload`, or the file object itself, as the full payload with `expected_edit_generation`. Returns the new generation. Read current generation first. | API CAS mutation. |
| `cms content seal --revision <revision-id> --environment <env> --yes [--expected-generation <N>]` | Validates and seals immutable revision content; returns revision id/hash. Does not publish. | API mutation, explicit target/confirmation. |
| `cms content revision delete <revision-id> --environment <env> --yes` | Deletes an eligible revision through the sanctioned application operation. Published/protected revisions remain subject to Core invariants. | API destructive operation. |
| `cms content preview --entity-id <entry-id> --revision <revision-id> [--entity-type <type>] [--allow-draft]` | Creates an expiring signed revision preview; default entity type is `entry`. Returns `preview_path`; does not assign a public URL. | API, preview authority required. |
| `cms schema list [--file <definitions.json>]` | Lists definitions in a local file; default is the shipped reference corpus, not the site's effective remote schema. | Local. |
| `cms schema show <key> [--version <N>] [--file <definitions.json>]` | Reads one type/version from the local definitions file. | Local. |
| `cms schema validate <key> --payload <payload.json> [--level draft|publish] [--version <N>] [--file <definitions.json>]` | Validates local field payload against a selected definition/version; default level is draft. Returns errors/warnings; exits 1 for invalid payload. | Local; does not apply schema or edit entries. |
| `cms entries route change <entry-id> --to-path <path> [--reason <text>] [--yes]` | Without `--yes`, reads the current route and exits 2 for review. With it, changes canonical route and associated redirect behavior. | API mutation; confirmation required, no `requireTargetSafety` environment-flag gate. |
| `cms entries identity-locale <entry-id> --locale <tag> --environment <env> --yes` | Repairs identity locale and working revisions transactionally; retains id, payloads, routes, pointers, generations and sealed history. Refuses unsupported locales and translation-group members. | API mutation, explicit target. |
| `cms revisions cleanup --entry <entry-id> --environment <env> --yes` | Deletes eligible SEALED history except the published revision. Inspect content/history before authorized cleanup. | API destructive operation, explicit target. |

The shared parser for create/draft/patch/seal/preview recognizes `--file`, `--entry`, `--from-revision`, `--revision`, `--expected-generation`, `--entity-id`, `--entity-type`, `--allow-draft`. Only the flags used by each branch above affect that operation; an accepted but unused shared flag does not add a feature. For complete create/patch body examples see [First Site](first-site.md) and [publishing](publishing.md).

## Publication

All commands below use the API. A changeset is the first-publication path when a route must also be created. Preview/preflight are checks, not publication. Use [publishing](publishing.md) for request JSON and lifecycle invariants.

| Command | Purpose and result | Safety |
|---|---|---|
| `cms publication calendar` | Current publication calendar. No CLI date-window flags are implemented. | Read. |
| `cms publication changesets` | Lists changesets. | Read. |
| `cms publication changeset <changeset-id>` | Reads one changeset and its items. | Read. |
| `cms publication preflight <changeset-id>` | Reports readiness/issues. Human output can exit 0 even if `ok` is false; inspect the report. | Check, no apply. |
| `cms publication apply <changeset-id> --environment <env> --yes` | Atomically applies the approved changeset. | Mutation, explicit target. |
| `cms publication cancel <changeset-id> --environment <env> --yes` | Cancels an eligible changeset. | Mutation, explicit target. |
| `cms publication publish-now <plan-id> <item-id> --environment <env> --yes` | Cancels the pending schedule and publishes the selected plan item once. | Mutation, explicit target. |
| `cms publication plan preview <plan-id> --request <request.json>` | Posts the complete schedule spec/overrides for preview. File must contain a JSON object; exactly one `--request <file>` pair is accepted after the plan id. | Check. |
| `cms publication plan schedule <plan-id> --request <request.json> --environment <env> --yes` | Applies the schedule spec/overrides after preview. | Mutation, explicit target. |

Bare `cms publication` is dispatched with an empty subcommand by the current main dispatcher and prints usage; use the explicit `changesets` command. Creating changesets/plans, adding items, direct publish, rollback and unpublish have REST/MCP surfaces; do not invent CLI verbs for them.

## Media, SEO and search

| Command | Purpose, options and result | Mode and effects |
|---|---|---|
| `cms media list [--limit <N>] [--cursor <cursor>]` | Bounded media search page, returns `items`, `next_cursor`, `has_more`. API page size is at most 100; `--limit` can aggregate bounded API pages. | API when either API URL/token is set; invalid remote context fails. DB only when both are absent. |
| `cms media list --all [--cursor <cursor>]` | Follows all pages; failures report partial data instead of claiming completeness. `--all` and `--limit` are exclusive. | Same transport selection. |
| `cms media get <media-id>` | Asset/version/variant diagnostic view. | Same remote/DB selection as media list. |
| `cms media usage <media-id>` | Inbound references; inspect before archive. | API only. |
| `cms media archive <media-id> [--yes]` | Without confirmation returns usage and exits 2. With it refuses referenced media (`MEDIA_IN_USE`, exit 4), otherwise archives and returns usage/result. | API mutation; no environment-flag safety gate. |
| `cms media update <media-id> [--focal-x <0..1>] [--focal-y <0..1>]` | Requires at least one finite coordinate; updates focal point and recrops core derivatives. | API mutation; no upload CLI. |
| `cms seo validate <entry-id>` | Publish-level SEO report for one entry; exits 3 for error-severity issues. | API, JSON result even without `--json`. |
| `cms seo validate --entry <entry-id>` | Flag-form equivalent of single-entry SEO audit. | API. |
| `cms seo validate --all` | Pages content tree, skips folders, audits entries; returns completeness, partial failures and issue counts. | API; inspect `complete`/`partial`. |
| `cms search query <query> [--locale <tag>] [--limit <N>]` | Public search through the configured API, with positive integer limit. CLI exposes these two filters; additional REST filters/cursors require REST/MCP. | API read. |
| `cms search status` | Index health/version and reindex progress. | API read. |
| `cms search reindex --environment <env> --yes [--resume]` | Starts/restarts shadow-epoch indexing; `--resume` is forwarded as `{resume:true}`. | API heavy mutation. |

## Themes and local site checks

| Command | Purpose, input and result | Mode and effects |
|---|---|---|
| `cms theme validate <directory> [--cms-version <version>]` | Validates theme manifest, file/layout/assets contract and supplied compatibility target. Explicit version checks a package against that version; it does not attest the running instance. | Local files, no DB. |
| `cms theme active` | Reports actual in-memory theme used by the running renderer. Prefer this over reading configuration. | API read. |
| `cms theme export --output <file.pcTheme> [--json]` | Downloads the package the renderer actually serves, pins it to `theme_generation`, verifies the descriptor SHA-256 and writes atomically. | API read, theme.read. |
| `cms theme upload <file.pcTheme> [--json]` | Stages package bytes and returns actor/site/environment-bound `package_ref`, SHA-256 and one-hour expiration. The reference is not a capability. | API mutation, theme.write. |
| `cms theme validate-package <package-ref> [--json]` | Validates the staged package and candidate render stack without installing, activating or changing settings. | API validation, theme.validate. |
| `cms theme update-active <package.pcTheme> [--expected-generation <N>] --environment <env> --yes` | Applies raw local ZIP bytes to the same active id at a newer installed-head version. Optional lifecycle CAS rejects a stale basis; preserves settings/generation and retains confirmed revisions. It does not apply a staged `package_ref`. | API mutation, theme.write + theme.activate. |
| `cms theme cleanup [--dry-run] [--keep-last <5..100>] [--older-than-days <1..36500>]` | Previews up to 100 eligible old/pending snapshots, default keep-last 5 / age 1 day. Requires theme.read; inspect has_more and candidate IDs. | API read-only preview despite POST. |
| `cms theme cleanup --apply --environment <env> --yes [--keep-last <5..100>] [--older-than-days <1..36500>]` | Previews, then sends exactly those IDs + theme_generation; theme.write. Protected active/last-good/latest/recent/recovery snapshots survive. No silent stale retry; partial physical removal returns ok=false, pending IDs, exit 7. Irreversible old asset/rollback removal. | API destructive operation; explicit target/confirmation. |
| `cms theme list` | Reads installed themes using the local configured path. Its `active` flag is derived from the legacy render-path target and is not authoritative for persistent runtime activation. | Local files/config. |
| `cms theme install <package.pcTheme> --environment <env> --yes` | Uploads through REST lifecycle; requires PCMS_API_URL/TOKEN and explicit site/environment context, theme.write. Does not bypass active-package protection. | API mutation, explicit target/confirmation. |
| `cms theme uninstall <theme-id> --environment <env> --yes` | Removes an inactive installed catalog package through REST; server protects active theme. Retained revisions remain. Same API context as install. | API mutation, theme.write, explicit target/confirmation. |
| `cms site validate [--theme <directory>] [--content <corpus.json>]` | Validates a **local theme against a local content corpus**; defaults are `themes/reference-theme-v1` and `fixtures/content/reference-content-types.json`. It does not inspect active remote pages. If the default corpus is absent, it reports a skipped content pass and exits 0. Pass an explicit real corpus and read diagnostics. | Local; no runtime-site acceptance. |

Theme history: `cms theme revisions --json` reads active/newest confirmed snapshots and theme_generation (up to 100); `cms theme rollback <revision-id> --expected-generation <N> --environment <env> --yes --json` selects a compatible retained site snapshot. CAS is theme_generation, not settings_generation. Requires theme.write + theme.activate; stale generation is 409. No restart/reinstall. Explicit history cleanup is now available separately and is irreversible. See [themes](themes.md).

To apply a staged reference from `cms theme upload`, use REST `POST /api/v1/themes/active/update` with `package_ref` and `expected_generation`, or MCP `cms_update_active_theme`; this CLI currently has no staged-reference apply command. On `503 THEME_PACKAGE_STORE_BUSY`, follow the stop-all-sharing-Web / remove-only-lock / restart sequence in [Themes](themes.md).

## Navigation, routes and domains

| Command | Purpose, options and result | Mode and effects |
|---|---|---|
| `cms nav inspect [--theme <directory>] [--config <path>] [--profile <name>]` | Reads installation-scoped navigation sets/bindings/placements. Unsupported `--site` is rejected. | DB/local theme read. |
| `cms nav check [--theme <directory>] [--config <path>] [--profile <name>]` | Checks installation-scoped bindings/stale overrides; issues exit 1. Unsupported `--site` is rejected. | DB read. |
| `cms route inspect [--site <key>] [--config <path>]` | Reads routes, redirects, domains and route policy for the selected site; absent site can yield an empty snapshot. | DB read. |
| `cms route check [--site <key>] [--config <path>]` | Checks redirect graph and route-policy shape; exits 1 on issues. | DB read. |
| `cms domains list` | Reads domain bindings using API context. | API, `domains.manage`. |
| `cms domains add --hostname <host> [--primary] [--locale <tag>] [--scheme https|http] [--redirect redirect|serve] [--site <key>]` | Adds normalized binding; bare `--primary` is forwarded. First binding becomes primary. | API mutation, no --yes gate. |
| `cms domains primary --hostname <host>` | Atomically makes an existing binding primary. | API mutation, `domains.manage`. |
| `cms domains remove --hostname <host>` | Removes a binding; Core refuses removal of the last one and promotes a replacement if needed. | API mutation, no `--yes` gate. |

Navigation/route forward explicit config/profile to the loader. Navigation remains installation-scoped and rejects `--site`; route uses its supported site selector. `route` accepts `--theme` but does not use it. Domains forwards the selected site in both context and its request query; cross-check the bound target.

## Forms, quizzes and interactions

All operations use the API and enforce the REST permissions. List/get are definition discovery, not definition authoring; create/version definitions through REST. Interaction payloads/leads can contain personal data.

| Command | Purpose and current constraints |
|---|---|
| `cms forms list [--status ACTIVE|ARCHIVED]` | Lists definitions with the supplied status filter. Missing status value is rejected before HTTP. |
| `cms forms get <form-id>` | Reads current immutable definition/version. |
| `cms quizzes list [--status ACTIVE|ARCHIVED]` | Lists quiz definitions with supplied status filter; missing value is rejected before HTTP. |
| `cms quizzes get <quiz-id>` | Reads current quiz definition with steps/branching/scoring/outcomes. |
| `cms interactions submissions [--limit <N>]` | Bounded submission history; supplied limit reaches HTTP, missing value is rejected. Other filters/cursors use REST. |
| `cms interactions runs [--limit <N>]` | Bounded quiz-run history; limit is forwarded and missing value rejected. |
| `cms interactions leads [--limit <N>]` | Bounded lead history, leads.read; limit is forwarded and missing value rejected. |
| `cms interactions lead-status <lead-id> <NEW|VIEWED|PROCESSED|ARCHIVED|SPAM>` | Updates lead lifecycle, emits domain event atomically; requires `leads.manage`. No CLI confirmation gate. |
| `cms interactions export <submissions|quiz_runs|leads> [--format csv|json]` | Audited export with export-specific permission. Default CSV is returned as text by REST, while the common CLI client only parses JSON, so the CLI loses the CSV body. Use REST download for CSV, or request JSON and inspect result. |

### Optional addressed personal-data tools

The owner chooses whether to use these tools; ordinary CMS work does not require a case. All require privacy.manage and the configured instance/site/environment context. Preview changes nothing; apply/ack require explicit environment and confirmation. For source/lead scope, exact retry, consent/retention independence and external-copy limits, see [personal-data tools](personal-data-tools.md).

| Command | Purpose / boundary |
|---|---|
| `cms interactions privacy-preview <request.json> --json` | Previews block/unblock/rectify/erase for one submission, quiz run or provenance lead. Returns closure, expected_token and known/possible external copies. |
| `cms interactions privacy-apply <apply.json> --environment <env> --yes --json` | Applies the reviewed complete operation plus token/request_id; it does not automatically apply a previous preview. Retain exact body/request ID for retry and case lookup. |
| `cms interactions privacy-get <case-id> --json` | Reads receipt, separate local_state/external_state and followups. Case ID equals the apply request ID. |
| `cms interactions privacy-ack <case-id> <delivery-id> <decision.json> --environment <env> --yes --json` | Records acknowledged or owner_exception plus optional opaque evidence_ref; no remote recipient call or automatic export/backup deletion. Closed decisions are immutable. |

## Integrations, secrets, mail and payments

| Command | Purpose and result | Mode and effects |
|---|---|---|
| `cms integrations connectors` | Connector catalogue. | API read. |
| `cms integrations instances` | Configured instances, secret-reference names only. | API read. |
| `cms integrations bindings` | Event-to-action bindings. | API read. |
| `cms integrations deliveries [status]` | Delivery history, optional status query. | API read. |
| `cms integrations delivery <delivery-id>` | Delivery with attempt history. | API read. |
| `cms integrations inbound` | Inbound event metadata. | API read. |
| `cms integrations instance-test <instance-id>` | Privileged connection test; can contact provider, audited. | API probe. |
| `cms integrations retry <delivery-id>` | Retries a failed delivery. | API mutation, no CLI `--yes` gate. |
| `cms integrations secrets init [--config <path>] [--secret-dir <directory>]` | Provisions the local runtime secret-encryption key/config references; idempotent when already configured. It creates local secret/config files, not a remote secret value. | Local operator mutation; protect resulting files. |
| `cms mail test [--to <address>]` | Probes configured mail transport. Supplying `--to` sends a real test email. Inspect authorization and address before using it. | API; external side effect when address supplied. |
| `cms payments providers` | Registered provider types and secret requirements. | API read. |
| `cms payments instances` | Configured provider instances. | API read. |
| `cms payments capabilities <provider-type>` | Provider cancel/refund/idempotency/sync capabilities. | API read. |
| `cms payments list [status]` | Payment list with optional status filter. | API read. |
| `cms payments get <payment-id>` | One payment's normalized/provider state. | API read. |
| `cms payments events <payment-id>` | Append-only timeline. | API read. |
| `cms payments cancel <payment-id>` | Cancels an eligible payment; requires `payments.cancel`. | API financial mutation, no CLI confirmation gate. |
| `cms payments refund <payment-id> [amount]` | Omitted amount means full refund. Supplied amount must be finite and positive; invalid/nonfinite/nonpositive values return typed PAYMENT_REQUEST_INVALID with zero HTTP requests. | API financial mutation, payments.refund, no CLI confirmation gate. |

## Extensions, Skills, registry and updates

| Command | Purpose and result | Mode and effects |
|---|---|---|
| `cms extensions list` | Deployed extension state/capabilities/compatibility. | API read. |
| `cms extensions compatibility <extension-id>` | One extension's compatibility issues. | API read. |
| `cms extensions install <extension-id> [--check] [--extension-config <json-object>]` | Activates deployed trusted artifact, not download. Explicit --extension-config is unambiguous; legacy object-valued --config is accepted, file-valued global --config selects CMS config. --check reads compatibility. | API mutation without --check. |
| `cms extensions enable <extension-id> [--check]` | Enables installed extension, or reads compatibility with `--check`. | API mutation/check. |
| `cms extensions disable <extension-id> [--check]` | Disables extension; active dependent checks apply. `--check` currently only lists extensions, not a disable-specific impact simulation. | API mutation/check. |
| `cms extensions uninstall <extension-id> [--check] [--confirmation <id>]` | Removes executable state subject to data-policy confirmation. `--check` reads compatibility, not a guarantee of uninstall safety. | API destructive operation. |
| `cms contracts versions` | Independent contract-version report from the running instance. | API read. |
| `cms deprecations list` | Machine-readable deprecations/replacements/removal metadata. | API read. |
| `cms skills list` | Lists installed **first-party** Skill manifests and load problems from local `PCMS_SKILLS_DIR`, release-relative Skills root, or development `./skills`. Community listing is available through REST. | Local read. |
| `cms skills show <skill-id>` | First-party manifest, requirements and recommended/dangerous scopes. Missing id exits 4. | Local read. |
| `cms skills doc <skill-id> [relative-file.md]` | Prints supplied instructions; default `SKILL.md`. Only contained `.md`/`.txt` paths are accepted. JSON output has id/file/content. | Local read. |
| `cms skills check <skill-id>` | Compares first-party manifest against remote bootstrap contracts/actor permissions. Inspect evaluation result/issues, not only exit code. | Local manifests + API read. |
| `cms skills validate <package.pcskill>` | Fail-closed package validation; caught package errors return `{ok:false,code,message}` and nonzero exit. | Local validation. |
| `cms skills install <package.pcskill> [--source <url>] [--dir <directory>]` | Installs community package with id/permission validation; source is provenance, not download. Package errors exit nonzero. | Local mutation. |
| `cms skills uninstall <skill-id> [--dir <directory>]` | Removes community Skill; root precedence: --dir > PCMS_COMMUNITY_SKILLS_DIR > config.skills.communityDir > cwd fallback. | Local destructive operation. |
| `cms skills disable <skill-id>` | Writes local `.pcms-disabled` marker; hides community Skill. | Local mutation. |
| `cms skills enable <skill-id>` | Removes local disabled marker. | Local mutation. |
| `cms registry status` | Reads instance binding/registry status. | API read; instance identity read can initialize a binding code server-side. |
| `cms registry releases` | Lists engine releases from the configured registry catalog. | API/external read. |
| `cms registry apply --version <version> --environment <env> --yes` | Downloads/validates/applies a strictly newer release through normal orchestrator. Lost connection is not proof of failure; inspect update status/running version. | API deployment mutation. |
| `cms update check --manifest <manifest.json>` | Sends explicit target manifest to update preflight, no apply/migrations. | API check. |
| `cms update apply --manifest <manifest.json> --environment <env> --yes` | Applies through standard orchestration; passes manifest version as backup confirmation. Fails closed when deployment adapter is unavailable. | API deployment mutation. |
| `cms observations show [--config <path>] [--file <path>]` | Prints agent observations file; default derived from installation state location. | Local read. |
| `cms observations append --text <text> [--config <path>] [--file <path>]` | Appends an observation for the update report. | Local file mutation. |
| `cms observations clear [--config <path>] [--file <path>]` | Clears observations. | Local file mutation. |

Bare `cms skills` currently reaches usage because the dispatcher inserts an empty subcommand; use `skills list`. Contracts/deprecations handlers do not validate their subcommand strictly; use the documented canonical forms. Community operations use `--dir`, environment, configured `skills.communityDir`, then cwd fallback, in that order. They do not install the native agent Skill into a host agent's discovery directory; see [Agent Skills](agent-skills.md).

## Publication bundles, migration and design inputs

| Command | Purpose, options and result | Mode and effects |
|---|---|---|
| `cms bundle validate <archive-or-workspace>` | Validates a `.pcpub` archive or source workspace and locally available content/block contracts; external-entry validation is explicitly `not_checked_on_server`. Inspect `ok` and the exit status: invalid archive validation also exits nonzero in JSON mode. | Local validation. |
| `cms bundle pack <workspace-directory> --out <bundle.pcpub>` | Packs workspace deterministically; returns bundle identity, archive path/hash and entry/asset counts. Packing does not perform server validation or publish content. | Local file creation. |
| `cms bundle inspect <bundle.pcpub>` | Reads manifest/entry counts and archive metadata. | Local read. |
| `cms bundle submit <bundle.pcpub> [--wait]` | Uploads raw `.pcpub`; idempotency header derives from bundle id. Without wait returns async ingest identity; with wait polls up to ten minutes. Terminal outcome/validation/conflict have bundle-specific exits, not the framework's universal meaning. No `--yes` gate. | API content mutation. |
| `cms bundle status <ingest-id>` | Reads ingest stage/outcome/issues/links. | API read. |
| `cms migrate modx3 [--endpoint <agent-url>] [--export <export.json>] [--out-dir <directory>]` | Requires endpoint or saved export. Endpoint uses `PCMS_MIGRATE_TOKEN`. Default output `./migration-out`; creates report, redirects CSV, sitemap comparison and bundle workspace, not published target content. `--site-base`/`--limit-override` appear in old usage but are not parsed. | External/local import preparation. |
| `cms migrate wordpress --endpoint <site-url> [--out-dir <directory>] [--include-drafts]` | Fetches WordPress REST data with `WP_USER`/`WP_APP_PASSWORD`; default output `./migration-wp`. Generates migration files/workspace. | External/local files; source read, target not published. |
| `cms migrate tilda --sitemap <url> [--site-base <origin>] [--out-dir <directory>]` | Reads sitemap/pages without a Tilda account; default output `./migration-tilda`. | External/local preparation. |
| `cms migrate tilda --dir <unpacked-export-directory> [--site-base <origin>] [--out-dir <directory>]` | Reads an unpacked Tilda export rather than fetching sitemap. | Local preparation. |
| `cms migrate bitrix --endpoint <agent.php-url> --iblock <id> --section-url-template <template> --element-url-template <template> [--out-dir <directory>]` | Uses `PCMS_MIGRATE_TOKEN`, URL placeholders `#CODE#`, `#SECTION_CODE#`, `#ID#`, `#SECTION_PATH#`; output `./migration-bitrix`. Experimental importer needs separate real-source validation before use. | External/local preparation. |
| `cms redirects validate --csv <file>` | Parses CSV, sends atomic redirect import dry-run; returns per-row/graph diagnostics without applying. Accepted columns/semantics are in REST request schema and routing guide. | API validation. |
| `cms redirects apply --csv <file> --yes [--site <key>]` | Applies validated redirect batch atomically; confirmation and site reach the request. Run validate first. | API mutation. |
| `cms figma pull --url <design-url> [--out-dir <directory>] [--frames <N>]` | Uses `FIGMA_TOKEN`; default 12 frames, output `./figma-out`: `tokens.css`, `frames/*.png`, `report.json`. Produces design references, not an installed/published CMS theme. | External Figma requests + local files. |
| `cms research search <query> [--engine yandex|google] [--limit <N>] [--region <region>] [--language <language>] [--device desktop|mobile]` | Discovers the extension providing `research.search`; returns SERP results. Quote the positional query; the advertised `--query` form is position-sensitive because the handler skips its operand. | API → optional external provider. |
| `cms research fetch <url> [--out <file.md>] [--max-chars <N>] [--http-only] [--links]` | SSRF-safe page/PDF extraction through discovered extension. `--out` **appends** marked Markdown to the file and returns compact metadata. Without it, JSON includes Markdown; human output stays compact. Advertised `--include-content` is not consumed and has no effect. Remote text is untrusted data. | API/external + optional local file write. |
| `cms research status` | Reads the discovered research extension's public configuration and secret-presence metadata; requires extension management access in addition to capability discovery. | API read, not a global independent research daemon status. |

## Local identity recovery

These commands operate on the configured DB, outside the HTTP surface. Restrict them to authorized local operators. Passwords are read from stdin; never pass a password on argv. Flags `--config <path>` and `--json` are accepted after each command. Recovery has legacy exits 0 success, 1 failure, 2 usage.

| Command | Effect and input |
|---|---|
| `cms user create-owner --email <email> --name <display-name>` | Bootstraps the first OWNER; password on stdin, password policy applies. |
| `cms user reset-password --email <email>` | Password on stdin; resets verifier and revokes all sessions, audited. |
| `cms user disable --email <email>` | Disables account and revokes sessions; last-OWNER invariant applies. |
| `cms user disable-mfa --email <email>` | Disables TOTP and revokes sessions; local recovery, not a normal agent workflow. |
| `cms session revoke-all --email <email>` | Revokes all sessions belonging to the selected user. |
| `cms token revoke --token-id <token-uuid>` | Revokes one service-account access token. |

## Source-derived parser inventory

The following appendix records selectors, literal flags, environment keys and HTTP calls from every imported command implementation and shared dispatcher/client. It is an audit aid, not an instruction to use every flag in every command. Conditions and call expressions are reproduced completely, without shortening. The explanations above describe operand ordering, effective behavior and known gaps that a literal help string cannot establish.

<!-- interface-map:start -->
Audited implementation files: **40**. Paths are relative to the supplied source tree; consumers do not need that tree to use the commands.

### packages/cli/src/api-client.ts

Literal parsed flags: none.

Environment keys read directly: `PCMS_API_TOKEN`, `PCMS_API_URL`, `PCMS_ENVIRONMENT`, `PCMS_SITE_KEY`.

HTTP client calls (source expressions, including complete request construction):
```javascript
fetch(`${client.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${client.token}`,
        ...requestOptions ? { "idempotency-key": requestOptions.idempotencyKey } : {},
        "x-pcms-site": client.siteKey,
        "x-pcms-environment": client.environment,
        ...body === void 0 ? {} : { "content-type": binary ? "application/octet-stream" : "application/json" }
      },
      ...body === void 0 ? {} : { body: binary ? Uint8Array.from(body) : JSON.stringify(body) }
    })

fetch(`${client.baseUrl}/api/v1${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${client.token}`,
        "x-pcms-site": client.siteKey,
        "x-pcms-environment": client.environment
      }
    })
```

### packages/cli/src/commands/agent.ts

Literal parsed flags: none.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
subcommand !== "bootstrap"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(clientOrThrow(options, env), "GET", "/agent/bootstrap")
```

### packages/cli/src/commands/bundle.ts

Literal parsed flags: `--out`, `--wait`.

Environment keys read directly: `PCMS_CONFIG_FILE`.

Command/operand selection conditions:
```javascript
subcommand === "inspect"
subcommand === "pack"
subcommand === "status"
subcommand === "submit"
subcommand === "validate"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
fetch(
        `${client.baseUrl}/api/v1/bundles/pcpub/ingests/${encodeURIComponent(operand)}`,
        { headers: { authorization: `Bearer ${client.token}` } }
      )

fetch(`${client.baseUrl}/api/v1/bundles/pcpub/ingests/${ingestId}`, {
      headers: {
        authorization: `Bearer ${client.token}`,
        ...client.siteKey === void 0 ? {} : { "x-pcms-site": client.siteKey },
        ...client.environment === void 0 ? {} : { "x-pcms-environment": client.environment }
      }
    })

fetch(`${client.baseUrl}/api/v1/bundles/pcpub`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${client.token}`,
        "content-type": PCPUB_MIME,
        "idempotency-key": `pcpub:${bundleId}`,
        ...client.siteKey === void 0 ? {} : { "x-pcms-site": client.siteKey },
        ...client.environment === void 0 ? {} : { "x-pcms-environment": client.environment }
      },
      body: new Uint8Array(bytes)
    })
```

### packages/cli/src/commands/config-validate.ts

Literal parsed flags: `--config`, `--json`.

Environment keys read directly: none; shared loaders may read configuration/environment.

### packages/cli/src/commands/content.ts

Literal parsed flags: `--allow-draft`, `--entity-id`, `--entity-type`, `--entry`, `--expected-generation`, `--file`, `--from-revision`, `--revision`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
operand === "apply"
operand === "delete"
operand === "list"
operand === "show"
operand === "validate"
subcommand === "create"
subcommand === "draft"
subcommand === "import"
subcommand === "patch"
subcommand === "preview"
subcommand === "revision"
subcommand === "schema"
subcommand === "seal"
subcommand === "validate"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
        client,
        "DELETE",
        `/revisions/${encodeURIComponent(revisionId)}`
      )

apiCall(client, "GET", "/discovery/content/types")

apiCall(client, "GET", `/discovery/content/types/${key}`)

apiCall(client, "PATCH", `/revisions/${flags.revision}`, {
        payload: document.payload ?? document,
        expected_edit_generation: Number(flags.generation)
      })

apiCall(client, "POST", "/bundles", {
        ...bundle,
        mode: "apply"
      })

apiCall(client, "POST", "/entries", document)

apiCall(client, "POST", "/previews", {
        scope: {
          kind: "revision",
          entity_type: flags.entityType ?? "entry",
          entity_id: flags.entityId,
          revision_id: flags.revision,
          ...flags.allowDraft === true ? { allow_draft: true } : {}
        }
      })

apiCall(client, "POST", `/content/schema/${operand}`, { definitions })

apiCall(client, "POST", `/entries/${flags.entry}/draft`, {
        ...flags.fromRevision === void 0 ? {} : { from_revision_id: flags.fromRevision }
      })

apiCall(client, "POST", `/revisions/${flags.revision}/seal`, {
        ...flags.generation === void 0 ? {} : { expected_edit_generation: Number(flags.generation) }
      })
```

### packages/cli/src/commands/db-migrate.ts

Literal parsed flags: `--check`, `--config`, `--json`.

Environment keys read directly: none; shared loaders may read configuration/environment.

### packages/cli/src/commands/diagnostics.ts

Literal parsed flags: none.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
operation.capability === "research.search"
```

### packages/cli/src/commands/domains.ts

Literal parsed flags: `--hostname`, `--locale`, `--primary`, `--redirect`, `--scheme`.

Environment keys read directly: `PCMS_SITE_KEY`.

Command/operand selection conditions:
```javascript
subcommand !== "add"
subcommand !== "list"
subcommand !== "primary"
subcommand !== "remove"
subcommand === "add"
subcommand === "list"
subcommand === "primary"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
        client,
        "PATCH",
        `/site/domains/${encodeURIComponent(hostname)}${siteQuery}`,
        { is_primary: true }
      )

apiCall(
      client,
      "DELETE",
      `/site/domains/${encodeURIComponent(hostname)}${siteQuery}`
    )

apiCall(client, "GET", `/site/domains${siteQuery}`)

apiCall(client, "POST", `/site/domains${siteQuery}`, body)
```

### packages/cli/src/commands/entries.ts

Literal parsed flags: `--locale`, `--reason`, `--to-path`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
args[1] === "change"
subcommand !== "identity-locale"
subcommand === "route"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
      clientOrThrow(options, env),
      "POST",
      `/entries/${encodeURIComponent(entryId)}/identity-locale`,
      { locale }
    )

apiCall(client, "GET", endpoint)

apiCall(client, "POST", `${endpoint}/change`, {
        to_path: path,
        ...values["--reason"] === void 0 ? {} : { reason: values["--reason"] }
      })
```

### packages/cli/src/commands/extensions.ts

Literal parsed flags: `--check`, `--confirmation`, `--extension-config`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
case "compatibility"
case "disable"
case "enable"
case "install"
case "list"
case "uninstall"
operand === ""
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(client, "GET", path)

apiCall(client, "POST", path, body === void 0 ? {} : body)

get(client, "/extensions")

get(client, "/extensions/contracts")

get(client, "/extensions/deprecations")

get(client, `/extensions/${encodeURIComponent(operand)}/compatibility`)

post(client, `/extensions/${encodeURIComponent(operand)}/disable`, {})

post(client, `/extensions/${encodeURIComponent(operand)}/enable`, {})

post(client, `/extensions/${encodeURIComponent(operand)}/install`, {
            ...config === void 0 ? {} : { config }
          })

post(client, `/extensions/${encodeURIComponent(operand)}/uninstall`, {
          ...confirmationFlag >= 0 && rest[confirmationFlag + 1] !== void 0 ? { confirmation: rest[confirmationFlag + 1] } : {}
        })
```

### packages/cli/src/commands/figma.ts

Literal parsed flags: `--frames`, `--out-dir`, `--url`.

Environment keys read directly: `FIGMA_TOKEN`.

Command/operand selection conditions:
```javascript
args[0] !== "pull"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
fetch(
        `https://api.figma.com/v1/images/${fileKey}?ids=${ids}&format=png&scale=2`,
        { headers }
      )

fetch(`https://api.figma.com/v1/files/${fileKey}`, { headers })

fetch(imageUrl)
```

### packages/cli/src/commands/forms.ts

Literal parsed flags: `--format`, `--limit`, `--status`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
family === "forms"
family === "interactions"
family === "quizzes"
operand === ""
subcommand === "export"
subcommand === "get"
subcommand === "lead-status"
subcommand === "leads"
subcommand === "list"
subcommand === "runs"
subcommand === "submissions"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
          clientOrThrow(options, env),
          "GET",
          `${family === "forms" ? "/forms" : "/quizzes"}${status === void 0 ? "" : `?status=${encodeURIComponent(status)}`}`
        )

apiCall(
          clientOrThrow(options, env),
          "GET",
          family === "forms" ? `/forms/${operand}` : `/quizzes/${operand}`
        )

apiCall(
          clientOrThrow(options, env),
          "PATCH",
          `/interactions/leads/${leadId}`,
          {
            status
          }
        )

apiCall(
          clientOrThrow(options, env),
          "POST",
          "/interactions/export",
          {
            entity,
            format
          }
        )

apiCall(clientOrThrow(options, env), "GET", `${path}${query}`)
```

### packages/cli/src/commands/integrations.ts

Literal parsed flags: none.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
case "bindings"
case "connectors"
case "deliveries"
case "delivery"
case "inbound"
case "instance-test"
case "instances"
case "retry"
operand === ""
operation !== "init"
subcommand === "secrets"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(client, "GET", path)

apiCall(client, "POST", `/integrations/deliveries/${operand}/retry`)

apiCall(client, "POST", `/integrations/instances/${operand}/test`)

get(
          operand === void 0 || operand === "" ? "/integrations/deliveries" : `/integrations/deliveries?status=${encodeURIComponent(operand)}`
        )

get("/integrations/bindings")

get("/integrations/connectors")

get("/integrations/inbound-events")

get("/integrations/instances")

get(`/integrations/deliveries/${operand}`)
```

### packages/cli/src/commands/interaction-privacy.ts

Literal parsed flags: none.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
command === "privacy-ack"
command === "privacy-apply"
command === "privacy-get"
command === "privacy-preview"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(client, command === "privacy-get" ? "GET" : "POST", path, body)
```

### packages/cli/src/commands/mail.ts

Literal parsed flags: `--to`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
args[0] !== "test"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(client, "POST", "/mail/test", to === void 0 ? {} : { to })
```

### packages/cli/src/commands/maintenance.ts

Literal parsed flags: `--message`, `--promo-label`, `--promo-url`, `--retry-after`, `--title`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
subcommand !== "disable"
subcommand !== "enable"
subcommand !== "status"
subcommand === "disable"
subcommand === "status"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(client, "GET", "/maintenance")

apiCall(client, "PUT", "/maintenance", body)

apiCall(client, "PUT", "/maintenance", { enabled: false })
```

### packages/cli/src/commands/media-publication.ts

Literal parsed flags: `--all`, `--cursor`, `--focal-x`, `--focal-y`, `--limit`, `--request`.

Environment keys read directly: `PCMS_API_TOKEN`, `PCMS_API_URL`.

Command/operand selection conditions:
```javascript
action !== "preview"
action !== "schedule"
args[1] === "schedule"
operand === ""
subcommand !== "get"
subcommand !== "list"
subcommand === "apply"
subcommand === "archive"
subcommand === "calendar"
subcommand === "cancel"
subcommand === "changeset"
subcommand === "changesets"
subcommand === "get"
subcommand === "list"
subcommand === "plan"
subcommand === "preflight"
subcommand === "publish-now"
subcommand === "update"
subcommand === "usage"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
        client,
        "POST",
        `/plans/${encodeURIComponent(planId)}/${action}`,
        request
      )

apiCall(
        client,
        "POST",
        `/plans/${operand}/items/${operand2}/publish-now`,
        {}
      )

apiCall(client, "GET", "/changesets")

apiCall(client, "GET", "/publication/calendar")

apiCall(client, "GET", `${path}/usage`)

apiCall(client, "GET", `/changesets/${operand}`)

apiCall(client, "GET", `/media/${encodeURIComponent(operand)}`)

apiCall(client, "GET", `/media?${query}`)

apiCall(client, "POST", `${path}/archive`)

apiCall(client, "POST", `/changesets/${operand}/apply`, {})

apiCall(client, "POST", `/changesets/${operand}/cancel`, {})

apiCall(client, "POST", `/changesets/${operand}/preflight`)

apiCall(clientOrThrow(options, env), "PATCH", `/media/${operand}`, {
        ...focalX === void 0 ? {} : { focal_x: focalX },
        ...focalY === void 0 ? {} : { focal_y: focalY }
      })
```

### packages/cli/src/commands/migrate.ts

Literal parsed flags: `--dir`, `--element-url-template`, `--endpoint`, `--export`, `--iblock`, `--include-drafts`, `--out-dir`, `--section-url-template`, `--site-base`, `--sitemap`.

Environment keys read directly: `PCMS_MIGRATE_TOKEN`, `WP_APP_PASSWORD`, `WP_USER`.

Command/operand selection conditions:
```javascript
args[0] !== "modx3"
args[0] === "bitrix"
args[0] === "tilda"
args[0] === "wordpress"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
fetch(
        `${base}wp-json/wp/v2/pages?per_page=100&page=${page}&statuses%5B0%5D=publish&statuses%5B1%5D=trash${includeDrafts ? "&statuses%5B2%5D=draft&statuses%5B3%5D=private" : ""}`,
        { headers: jsonHeaders }
      )

fetch(`${base}wp-json/wp/v2/media?per_page=100&page=${mediaPage}`, {
        headers: jsonHeaders
      })

fetch(loc)

fetch(sitemapUrl)

fetch(url, { headers: { "x-pcms-agent-token": token } })

fetch(url, { redirect: "follow" })
```

### packages/cli/src/commands/nav-route.ts

Literal parsed flags: `--config`, `--json`, `--site`, `--theme`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
subcommand !== "check"
subcommand !== "inspect"
subcommand === "inspect"
```

### packages/cli/src/commands/observations.ts

Literal parsed flags: `--file`, `--text`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
subcommand === "append"
subcommand === "clear"
subcommand === "show"
```

### packages/cli/src/commands/payments.ts

Literal parsed flags: none.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
case "cancel"
case "capabilities"
case "events"
case "get"
case "instances"
case "list"
case "providers"
case "refund"
operand === ""
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(client, "GET", path)

apiCall(client, "POST", `/payments/${operand}/cancel`)

apiCall(client, "POST", `/payments/${operand}/refund`, {
          ...amount === void 0 ? {} : { amount }
        })

get(
          operand === void 0 || operand === "" ? "/payments" : `/payments?status=${encodeURIComponent(operand)}`
        )

get("/payments/providers")

get("/payments/providers/instances")

get(`/payments/${operand}/events`)

get(`/payments/${operand}`)

get(`/payments/providers/${encodeURIComponent(operand)}/capabilities`)
```

### packages/cli/src/commands/redirects.ts

Literal parsed flags: `--csv`, `--site`, `--yes`.

Environment keys read directly: `PCMS_SITE_KEY`.

Command/operand selection conditions:
```javascript
args[0] !== "apply"
args[0] !== "validate"
args[0] === "apply"
args[0] === "validate"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
      client,
      "POST",
      args[0] === "validate" ? "/routing/redirect-imports/validate" : "/routing/redirect-imports/apply",
      { ...site === void 0 ? {} : { site }, rows }
    )
```

### packages/cli/src/commands/registry.ts

Literal parsed flags: `--version`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
subcommand !== "apply"
subcommand !== "releases"
subcommand !== "status"
subcommand === "releases"
subcommand === "status"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
        client,
        "GET",
        `/registry/instance/status?instance_code=${encodeURIComponent(
          String(instance.body.instance_code ?? "")
        )}`
      )

apiCall(client, "GET", "/registry/index")

apiCall(client, "GET", "/registry/instance")

apiCall(client, "POST", "/registry/apply-update", {
      version: version.trim()
    })
```

### packages/cli/src/commands/research.ts

Literal parsed flags: `--device`, `--engine`, `--http-only`, `--language`, `--limit`, `--links`, `--max-chars`, `--out`, `--query`, `--region`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
subcommand === "fetch"
subcommand === "search"
subcommand === "status"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
        client,
        "POST",
        `/extensions/${encodeURIComponent(researchExtension)}/operations/fetch`,
        body
      )

apiCall(
        client,
        "POST",
        `/extensions/${encodeURIComponent(researchExtension)}/operations/search`,
        body
      )

apiCall(client, "GET", "/extensions")

apiCall(client, "GET", "/extensions/operations")
```

### packages/cli/src/commands/revisions.ts

Literal parsed flags: `--entry`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
subcommand !== "cleanup"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
      clientOrThrow(options, env),
      "POST",
      `/entries/${encodeURIComponent(entry)}/revisions/cleanup`,
      {}
    )
```

### packages/cli/src/commands/schema.ts

Literal parsed flags: `--file`, `--json`, `--level`, `--payload`, `--version`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
case "list"
case "show"
case "validate"
```

### packages/cli/src/commands/search.ts

Literal parsed flags: `--limit`, `--locale`, `--resume`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
operand === ""
subcommand === "query"
subcommand === "reindex"
subcommand === "status"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
        clientOrThrow(options, env),
        "GET",
        `/search?${query.toString()}`
      )

apiCall(
        clientOrThrow(options, env),
        "POST",
        "/search/reindex",
        resume ? { resume: true } : {}
      )

apiCall(clientOrThrow(options, env), "GET", "/search/status")
```

### packages/cli/src/commands/secrets-init.ts

Literal parsed flags: `--json`, `--secret-dir`.

Environment keys read directly: none; shared loaders may read configuration/environment.

### packages/cli/src/commands/seo.ts

Literal parsed flags: `--all`, `--entry`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
args[0] !== "validate"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
        client,
        "GET",
        `/discovery/seo/validate?entry_id=${encodeURIComponent(entry)}`
      )

apiCall(
        client,
        "GET",
        `/discovery/seo/validate?entry_id=${encodeURIComponent(id)}`
      )

apiCall(client, "GET", `/discovery/content/tree?${query}`)
```

### packages/cli/src/commands/site-validate.ts

Literal parsed flags: `--content`, `--json`, `--theme`.

Environment keys read directly: none; shared loaders may read configuration/environment.

### packages/cli/src/commands/skills.ts

Literal parsed flags: `--dir`, `--source`.

Environment keys read directly: `PCMS_COMMUNITY_SKILLS_DIR`, `PCMS_CONFIG_FILE`, `PCMS_SKILLS_DIR`.

Command/operand selection conditions:
```javascript
subcommand === "check"
subcommand === "disable"
subcommand === "doc"
subcommand === "enable"
subcommand === "install"
subcommand === "list"
subcommand === "show"
subcommand === "uninstall"
subcommand === "validate"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(clientOrThrow(options, env), "GET", "/agent/bootstrap")
```

### packages/cli/src/commands/theme-cleanup.ts

Literal parsed flags: `--apply`, `--dry-run`, `--keep-last`, `--older-than-days`.

Environment keys read directly: none; shared loaders may read configuration/environment.

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(client, "POST", path, {
        dry_run: false,
        keep_last: keepLast,
        older_than_days: days,
        expected_generation: preview.theme_generation,
        revision_ids: preview.candidates.map((r) => r.revision_id)
      })

apiCall(client, "POST", path, {
      dry_run: true,
      keep_last: keepLast,
      older_than_days: days
    })
```

### packages/cli/src/commands/theme-manage.ts

Literal parsed flags: `--json`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
subcommand === "list"
```

### packages/cli/src/commands/theme-package.ts

Literal parsed flags: `--expected-generation`, `--json`, `--output`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
subcommand === "export"
subcommand === "upload"
subcommand === "validate-package"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
        client,
        "POST",
        `/themes/packages/${encodeURIComponent(ref)}/validate`
      )

apiCall(client, "GET", "/themes/source")

apiCall(client, "POST", "/themes/packages", bytes)
```

### packages/cli/src/commands/theme-update.ts

Literal parsed flags: `--expected-generation`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
command === "active"
command === "install"
command === "revisions"
command === "rollback"
command === "uninstall"
command === "update-active"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(
      client,
      "DELETE",
      `/themes/installed/${encodeURIComponent(file ?? "")}`
    )

apiCall(
      client,
      "POST",
      command === "install" ? "/themes/install" : `/themes/active/update${casFlag === void 0 ? "" : `?expected_generation=${casFlag}`}`,
      readFileSync(file ?? "")
    )

apiCall(client, "GET", "/themes/active")

apiCall(client, "GET", "/themes/revisions")

apiCall(client, "POST", "/themes/rollback", {
      revision_id: file,
      expected_generation: Number(rest[1])
    })
```

### packages/cli/src/commands/theme-validate.ts

Literal parsed flags: `--cms-version`, `--json`.

Environment keys read directly: none; shared loaders may read configuration/environment.

### packages/cli/src/commands/update.ts

Literal parsed flags: `--manifest`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
args[0] !== "apply"
args[0] !== "check"
args[0] === "check"
```

HTTP client calls (source expressions, including complete request construction):
```javascript
apiCall(client, "POST", "/update/apply", {
      manifest: manifestDocument,
      // Backup acknowledgment: the orchestrator compares this against the
      // target version when backup_required is set (Extensions §25).
      backup_confirmation: JSON.parse(readFileSync(manifestPath, "utf8")).version
    })

apiCall(client, "POST", "/update/preflight", {
        manifest: manifestDocument
      })
```

### packages/cli/src/commands/user-admin.ts

Literal parsed flags: `--config`, `--email`, `--json`, `--name`, `--token-id`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
case "create-owner"
case "disable"
case "disable-mfa"
case "reset-password"
subcommand !== "revoke"
subcommand !== "revoke-all"
```

### packages/cli/src/framework.ts

Literal parsed flags: `--config`, `--environment`, `--json`, `--profile`, `--site`, `--yes`.

Environment keys read directly: none; shared loaders may read configuration/environment.

### packages/cli/src/main.ts

Literal parsed flags: `--config`, `--json`, `--site`.

Environment keys read directly: none; shared loaders may read configuration/environment.

Command/operand selection conditions:
```javascript
command === "agent"
command === "bundle"
command === "capabilities"
command === "config"
command === "content"
command === "contracts"
command === "db"
command === "deprecations"
command === "doctor"
command === "domains"
command === "entries"
command === "extensions"
command === "figma"
command === "forms"
command === "info"
command === "integrations"
command === "interactions"
command === "mail"
command === "maintenance"
command === "media"
command === "migrate"
command === "nav"
command === "observations"
command === "payments"
command === "publication"
command === "quizzes"
command === "redirects"
command === "registry"
command === "research"
command === "revisions"
command === "route"
command === "schema"
command === "search"
command === "seo"
command === "session"
command === "site"
command === "skills"
command === "theme"
command === "token"
command === "update"
command === "user"
subcommand === "active"
subcommand === "cleanup"
subcommand === "export"
subcommand === "install"
subcommand === "list"
subcommand === "migrate"
subcommand === "revisions"
subcommand === "rollback"
subcommand === "uninstall"
subcommand === "update-active"
subcommand === "upload"
subcommand === "validate"
subcommand === "validate-package"
```
<!-- interface-map:end -->

[Documentation index](index.md) · [CLI guide](cli.md) · [REST map](rest-api-map.md) · [MCP map](mcp-map.md)
