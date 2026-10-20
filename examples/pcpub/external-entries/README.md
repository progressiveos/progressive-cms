# DEV example: declared published entry references

Use a disposable DEV site with the reference `page` type and first-party
blocks. Never run the fixture preparation against production. A developer
fixture (or operator with explicit DEV publication permission) prepares the
separate target workspace first; the content agent receives only its path.

```bash
cms agent bootstrap --json
# Require capabilities.pcpub.external_entries.supported=true and version 2.
# DEV fixture preparation: requires publication.publish + publication.plan.
cms bundle pack examples/pcpub/external-entries-target --out /tmp/target.pcpub --json
cms bundle submit /tmp/target.pcpub --wait --environment development --yes --json
# Agent authoring: mode none; no publication.publish required.
cms bundle validate examples/pcpub/external-entries --json
cms bundle pack examples/pcpub/external-entries --out /tmp/external.pcpub --json
cms bundle inspect /tmp/external.pcpub --json
cms bundle submit /tmp/external.pcpub --wait --environment development --yes --json
```

Configure CLI/API using the existing config and secret channels. The source
needs content.create, content.read, media.write and publication.plan for its
route proposals. `main` references a published external path and a sibling;
images use bundled assets. Local validate/pack/inspect remain offline and
cannot prove that the target exists. Server ingest checks it before media
staging and again before candidates, returning `result.external_entries`.
The example produces sealed candidates, not public pages. Preview the
returned revision/ChangeSet; apply only with separate DEV authorization.
After such apply, verify `/content-agent-demo/` and
`/content-agent-demo-sibling/` under your DEV origin. The target remains at
`/blog/existing-article/` without new revisions or generations.

Updating an existing source still requires its own target_entry_id and
base_revision_id. External target UUIDs are never manually inserted into
PCMD. On a server without the capability, use discovery to obtain target
Entry IDs and the existing interactive/UUID workflow; do not send v2.
