# Draft, preview, seal, publish and rollback

Contract owner: Core revisions/publications. REST paths below are relative to `/api/v1`; use the target/authentication headers in [REST API](rest-api.md).

## Inspect the published version and draft base

Use `GET /publications/entry/<entry-id>` to read the current publication pointer, including `current_revision_id` and its publication `generation`. Then use `GET /revisions/<revision-id>` for the full revision. Both reads require `publication.read`; the full revision includes nullable `parent_revision_id`, the revision from which it was branched. This is revision provenance, not the current publication pointer. The bounded revision-history list omits this field, so fetch a revision by id when you need its base.

The CLI provides the same reads:

```sh
cms content revision current <entry-id> --json
cms content revision show <revision-id> --json
```

`current` returns `{ "publication": ..., "revision": ... }`; `show` returns one complete revision. Both require an API context and `publication.read`.

To create a draft from a specific revision, send `POST /entries/<entry-id>/draft` with `{"from_revision_id":"<revision-id>"}` or use `cms content draft --entry <entry-id> --from-revision <revision-id> --json`. This mutation requires `content.edit`; its `base_revision_id` records the chosen source and matches the created revision's `parent_revision_id`. An explicit `from_revision_id` must identify a SEALED revision of that same entry. A WORKING source returns HTTP 409 `REVISION_NOT_SEALED` and creates no revision. Missing and foreign revision ids return the same 404 response, so the API does not disclose whether another entry owns the id. If a WORKING draft already exists and the requested source is valid, Core returns it unchanged (`created: false`): this request does not rebase it. Check its existing base before editing or publishing.

## Create and edit

`POST /entries` takes a content type, optional accepted template key and `payload`. [The news example](reference/examples/create-news.json) uses a declared RichText body. A parent section can be supplied as `parent_entry_id`. Record `entry_id` and `revision_id`; do not derive ids from routes.

To edit existing content:

```sh
cms content draft --entry <entry-id> --json
cms content patch --revision <working-revision-id> --file patch-news.json --expected-generation <generation> --json
```

Use [patch-news.json](reference/examples/patch-news.json) as the payload shape. Read the current revision first and use its actual `edit_generation`; a successful patch returns the new generation. A 409 conflict means reread/reconcile, not retry with a fabricated generation.

## Validate and preview

```http
POST /api/v1/revisions/<revision-id>/validate
{}
```

Resolve blocking issues and inspect the exact target revision. `cms content preview --entity-id <entry-id> --revision <revision-id> --allow-draft --json` creates the supported preview result. Treat signed preview URLs as access-bearing data; do not publish them in logs. Inspect rendered content and resolved SEO before sealing.

```sh
cms content seal --revision <revision-id> --expected-generation <generation> --environment qa --yes --json
```

Sealing needs `revision.seal`; it does not itself publish. A sealed revision is immutable.

## Bulk/offline `.pcpub` packages

For a prepared `.pcpub` ZIP, first run `cms bundle validate <archive>` locally. This checks the archive against contracts available to that CLI; it does not prove that the target server accepts the package. Before applying it, send the raw archive to `POST /api/v1/bundles/pcpub?mode=validate` with the `.pcpub` media type. This target-side validation makes no writes and checks against the target's current Content Types, RichText rules and `bodyPolicy` before media is staged.

An entry may refer to a bundled asset as its social image:

```yaml
seo:
  social_image:
    asset_id: "bundle:assets/hero.png"
```

The asset must exist in the archive and be declared by the package. This `bundle:` reference is accepted only at `.pcpub`'s typed `seo.social_image.asset_id` field; the target resolves it to the same MediaAsset identity used by content fields that refer to that bundle asset. Ordinary `PUT /entries/<entry-id>/seo` still requires an existing MediaAsset id. Do not send `bundle:` references through ordinary SEO APIs or use them for other SEO fields.

Read every target validation diagnostic before applying. Each issue identifies a `code`, archive-relative `path` and `message`; invalid RichText or content hidden by the target Content Type's `bodyPolicy` is rejected before media staging. If an apply-time seal check still rejects the document, the ingest status reports `PCPUB_DOCUMENT_INVALID` and retains the original diagnostic codes, messages and archive paths in `safe_error_detail.diagnostics`. Fix the source document, repack, and validate again; do not ignore or reduce diagnostics to a count.

After a clean target validation, apply only when the requested content mutation is authorized: `cms bundle submit <archive> [--wait]`. Apply is asynchronous; poll the returned ingest status (or use `--wait`) and verify its terminal outcome and result. The worker refreshes media presets from the persistently active theme before each ingest; `themes.renderDir` is only the configured fallback directory. A completed result may include `media_variant_failures` (`media_id`, `preset`, `error`) when a derivative could not be generated; the ingest can still complete, so check these entries before treating every bundled image as ready. See [Media Library](media.md) for the derivative contract. A local validation pass or HTTP 202 does not mean the content was sealed or published.

## Publish explicitly

Read `GET /publications/entry/<entry-id>` for the actual generation. Direct `POST /publications/publish` requires an **existing live route**, even for a never-published identity. Without it, Core rejects with `PUBLICATION_ROUTE_MISSING`; first publication must coordinate the route in a ChangeSet.

For an existing live route:

```http
POST /api/v1/publications/publish
{"entity_type":"entry","entity_id":"<entry-id>","target_revision_id":"<sealed-revision-id>","expected_generation":0}
```

Replace zero with the observed publication generation (zero only if never published). For a new route, create a container with `POST /changesets`, body `{"title":"Publish approved page"}`. Add the sealed candidate through `POST /changesets/<id>/items`:

```json
{"entity_type":"entry","entity_id":"<entry-id>","intent":"PUBLISH","target_revision_id":"<sealed-revision-id>","expected_generation":0,"route_operation":{"kind":"set","site_id":"<actual-site-id>","path":"/approved-path/"}}
```

Use the actual target site id and approved unoccupied path; resolve locale/context for multilingual sites. Create/items/preflight require `publication.plan`; apply requires `publication.publish`. `POST /changesets/<id>/preflight`, inspect `ok` and issues, reconcile stale generations, then explicitly authorized `POST /changesets/<id>/apply`. Route and pointer move together. Confirm permissions, environment and task authorization before public mutation. Scheduling uses plans, separately from immediate ChangeSet apply.

## Verify and roll back

After publication, inspect the public route, body, breadcrumbs, head metadata, media and eventual search projection. A successful response is not an indexing guarantee. `POST /publications/rollback` is a publication operation with its own schema and generation checks; choose the accepted prior target and verify the same surfaces again. Content rollback is separate from restoring a database after a Core upgrade.

Never delete the current published revision during cleanup. `cms revisions cleanup` deletes other eligible SEALED history; inventory revisions and current pointers before requesting it. Do not use cleanup as part of an ordinary editing workflow.

[Documentation index](index.md)
