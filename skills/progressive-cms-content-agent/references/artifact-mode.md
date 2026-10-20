# Content Agent — Artifact mode (.pcpub)

Use when: a substantial new article, multiple entries, a migration/bulk
import, or work with many local assets. Skip for small edits (interactive
mode is cheaper).

## 0. Hard rules

- The USER never picks the transport; you do — and you say which one you
  picked and why in one line.
- Author **PCMD** (Markdown + YAML front matter + `:::block type@version`
  fences). Never hand-assemble CMS-internal JSON. Rich-text props
  (`rich_text`, FAQ `answer`) accept MARKDOWN strings.
- Block ids are derived by the CMS — never invent them.
- `id:<media_asset_id>` references are update-only; bundled assets use
  `bundle:assets/<path>`; sibling documents use `ref:<external_id>`.
- No provider/proxy/network configuration — that is never your scope.
  A broken provider is a typed error in your report, not something you fix.

## 1. Targeted discovery (once)

`GET /capabilities` (or `cms agent bootstrap --json`) → read `pcpub`
(pcpub/pcmd versions, bundle limits, accepted asset MIME, supported block
versions) and the ONE content type + block schemas the article needs.
Fail early if a required block version is unsupported on the target —
the ingest fails closed anyway (`PCPUB_COMPAT_*`).

## 2. Local workspace

```text
my-article/
├── publication.yaml      # changeset_title + publication.mode (none|now)
├── content/*.pcmd        # one document per entry (create|update)
├── assets/               # images (any acquisition path; provenance in PCMD? — no: provenance rides the packer/manifest)
├── research/             # sources — packed as provenance artifacts, never published
├── review/               # factual-review notes — same
└── .pcms/                # your scratch — NEVER packed
```

Update documents carry `target_entry_id` + `base_revision_id` (the revision
you based your edit on). A stale base ⇒ outcome `conflict`, public
untouched: re-read the live revision, rebase, re-pack (new bundle_id).

## 3. Validate → pack → submit

```bash
cms bundle validate ./my-article --json      # offline structure + configured schemas
cms bundle pack ./my-article --out article.pcpub --json
cms bundle inspect article.pcpub --json
cms bundle submit article.pcpub --wait --json
```

- A retry after a transport failure reuses the SAME packed bytes and
  `bundle_id` (the ledger deduplicates; a different payload under the same
  id is a `409`). Changed workspace ⇒ repack ⇒ new bundle_id.
- `submit --wait` resolves when the ingest reaches a terminal outcome:
  `sealed`/`published` (done), `conflict` (rebase), `rejected`/`failed`
  (fix the typed diagnostics; never disable validation).

## 4. Verify

Fetch the created entries (REST/MCP), confirm revisions/media/changeset
links from the ingest result, preview if available, and report ids +
outcome + diagnostics exactly as returned.

## 5. Published targets by path (optional `.pcpub` v2)

Read bootstrap `capabilities.pcpub.external_entries.supported` (must be true)
and `pcpub_versions` (must include 2), then the relevant content/block schemas.
Also available in GET /capabilities → pcpub. `content.read` is
required in addition to the ordinary create/edit/media/publication gates.
A missing capability means use existing routing/content discovery, obtain
Entry IDs and author via the existing interactive/UUID workflow. Do not send
v2 to a strict v1 server. The skill's baseline compatibility remains v1.

```yaml
# publication.yaml
changeset_title: "Подборка материалов"
publication:
  mode: none
external_entries:
  existing-article:
    path: /blog/existing-article/
    locale: default
```

```markdown
---
pcmd_version: 1
operation: create
external_id: main
content_type: page
fields:
  title: Подборка материалов
route:
  path: /content-agent-demo/
---
:::block image@1
media_id: "bundle:assets/hero.png"
alt_override: "Иллюстрация подборки"
:::

:::block related_content@1
mode: manual
title: Связанные материалы
entry_ids: ["ref:existing-article", "ref:sibling"]
:::
```

Add `content/sibling.pcmd`:

```markdown
---
pcmd_version: 1
operation: create
external_id: sibling
content_type: page
fields:
  title: Внутрипакетный материал
route:
  path: /content-agent-demo-sibling/
---
:::block image@1
media_id: "bundle:assets/hero.png"
alt_override: "Иллюстрация материала"
:::
```

Put the actual image at assets/hero.png. This exact workspace is checked by
the real packer in `examples/pcpub/external-entries`; its README explains how
a developer prepares the published target on a disposable DEV site.
No manual UUID of the external target is needed. For an update, the SOURCE
still needs operation:update, target_entry_id and base_revision_id (CAS).
`ref:sibling` remains an internal ref, bundled media remains a media ref.
Only schema-declared Entry refs become external Entry UUIDs; arbitrary text
and media properties never become Entry IDs. `result.external_entries`
retains the checked alias → entry_id mapping; targets are not ChangeSet items.

The alias grammar matches PCMD external_id; aliases cannot collide with
documents or reserved m0/m1/... tokens. Values have exactly path + locale;
locale is mandatory (default = base publication context). Only canonical
absolute paths inside the bound site are accepted: no host/scheme, query,
fragment, traversal or redirects. `/` uses the site's home binding. Active
canonical entry routes only; the entry must be non-archived and published in
the declared context. Local read/validate/pack/inspect are offline and report
`external_entries_validation: not_checked_on_server`; target existence is
checked by the server (also in ?mode=validate with content.read).

| Diagnostic | Correction |
|---|---|
| PCPUB_EXTERNAL_ENTRY_INVALID | Fix mapping keys/alias or use the exact canonical path under the site's policy. |
| PCPUB_EXTERNAL_ENTRY_NOT_FOUND | Check the bound site, home binding and active canonical Entry route; redirects/retired routes do not resolve. |
| PCPUB_EXTERNAL_ENTRY_UNPUBLISHED | Have an authorized editor publish the target first, or remove the ref. |
| PCPUB_EXTERNAL_ENTRY_LOCALE_UNKNOWN | Discover an enabled publication context; use default for the base language. |
| PCPUB_AUTH_INSUFFICIENT_SCOPE | Report the missing scope; do not bypass it. |
| PCPUB_CONFLICT_EXTERNAL_ENTRY_CHANGED | Re-read the route, review the intended target and repack with a new bundle_id. |
| PCPUB_CONFLICT_STALE_BASE | Re-read the source's live revision, reconcile and repack; public state remains untouched. |

Normal target errors are rejected before media staging and candidates. A
late target conflict creates no candidates/ChangeSet, but earlier media
staging may already have succeeded (the existing media GC handles orphans).
Retry unchanged bytes/bundle_id returns the stored mapping and result;
changing external_entries changes the digest and requires a new bundle_id.
No external_entries in a package → legacy v1, with no added empty field.
