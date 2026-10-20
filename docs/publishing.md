# Draft, preview, seal, publish and rollback

Contract owner: Core revisions/publications. REST paths below are relative to `/api/v1`; use the target/authentication headers in [REST API](rest-api.md).

## Create and edit

`POST /entries` takes a content type, optional accepted template key and `payload`. [The news example](reference/examples/create-news.json) uses a declared RichText body. A parent section can be supplied as `parent_entry_id`. Record `entry_id` and `revision_id`; do not derive ids from routes.

To edit existing content:

```sh
cms content draft --entry <entry-id> --json
cms content patch --revision <working-revision-id> --file patch-news.json --expected-generation <generation> --json
```

Use [patch-news.json](reference/examples/patch-news.json) as the payload shape. Read the current revision first (`GET /revisions/<id>`) and use its actual `edit_generation`; a successful patch returns the new generation. A 409 conflict means reread/reconcile, not retry with a fabricated generation. `draft` may return an existing WORKING revision; check whether it was created and which base it uses.

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
