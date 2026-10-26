# CLI reference and target context

Contract owner: Core CLI dispatcher and command families. [Captured help](reference/cli-help.txt) is a baseline summary, supplemented here because it omits some supported workflows.

For every dispatched command, full options, actual transport and confirmed parser limitations, use the [complete CLI map](cli-map.md).

## Local versus API transports

Offline/operator commands use config resolution `--config` → `PCMS_CONFIG_FILE` → `./config/pcms.json`. API commands use `PCMS_API_URL`, `PCMS_API_TOKEN`, `PCMS_SITE_KEY`, `PCMS_ENVIRONMENT`; `--site`/`--environment` override context. Do not guess a tenant from a token or URL. `--json` gives machine output on stdout, with diagnostics on stderr.

| Purpose | Supported invocation | Boundary |
|---|---|---|
| Config/health | `cms config validate --config <file> --json`; `cms doctor`; `cms info` | Authorized installed operator environment; doctor may need config/DB |
| Agent discovery | `cms agent bootstrap --json`; `cms capabilities --json` | Bootstrap inspects the actual target/contracts/readiness; capabilities is the local compiled permission/contract registry |
| Effective schemas | `cms content schema list --json`; `cms content schema show <key> --json` | API-first when configured; inspect applied overrides |
| Schema change | `cms content schema validate --file <definitions.json> --json`; `cms content schema apply --file <definitions.json> --environment <env> --yes --json` | Propose/apply scopes; honor restart_required |
| Create/draft | `cms content create --file <payload.json> --json`; `cms content draft --entry <id> --json` | Content identity/WORKING revision, not publication |
| CAS patch | `cms content patch --revision <id> --file <payload.json> --expected-generation <N> --json` | Read current edit_generation first |
| Preview/seal | `cms content preview --entity-id <entry-id> --revision <id> --allow-draft --json`; `cms content seal --revision <id> --expected-generation <N> --environment <env> --yes --json` | Preview capability and revision.seal; sealed is immutable |
| Theme package cycle | `cms theme active --json`; `cms theme export --output <file.pcTheme>`; `cms theme upload <file.pcTheme>`; `cms theme validate-package <package-ref>`; `cms theme update-active <file.pcTheme> --expected-generation <N> --environment <env> --yes` | Export uses the served theme and verifies its digest; upload stages for one hour; validation does not mutate. CLI applies raw local bytes, not a staged reference; use REST or MCP to apply a `package_ref` with `theme_generation` CAS. |
| Theme validation | `cms theme validate <dir> --cms-version <version> --json` | Explicit version tests a manifest, does not attest actual installed version |
| Site validation | `cms site validate --theme <dir> --content <corpus.json> --json` | Local theme/content-corpus compatibility only; absent default corpus can yield a skipped pass with exit 0; inspect the report |
| Delivered Skills | `cms skills list --json`; `cms skills show <id> --json`; `cms skills doc <id> --json`; `cms skills check <id> --json` | Use the delivered PCMS_SKILLS_DIR; check consults connected bootstrap |
| Media | `cms media list --limit 20 --json`; `cms media get <id> --json`; `cms media usage <id> --json` | Cursor/all semantics; inspect usage before archival |
| Search | `cms search query <query>`; `cms search status`; `cms search reindex --environment <env> --yes` | Reindex is a mutation; confirm actual syntax/discovery for options |
| Upgrade | `cms update check --manifest <file>`; `cms update apply --manifest <file>` | Installed operator and approved artifact/backup gates |

Framework exit codes: 0 success, 1 unexpected, 2 usage/config, 3 validation, 4 conflict, 5 authorization, 6 missing, 7 transient. Older local recovery commands have independently pinned behavior. `cms --help` emits usage and exits 2 in the inspected source; do not treat that as a runtime outage.

For full request examples use [First Site](first-site.md) and [Publishing](publishing.md). Long-running bulk content can use the delivered `.pcpub` contract, but do not invent archive front matter, asset identities or routes from a terse help line.

[Documentation index](index.md)
