# Site and editor checks

Check the requested site rather than a fixed demo inventory. Record public routes and IDs without secrets.

- Confirm homepage, required pages, parentage and menus. Test desktop/mobile navigation, visible focus, readable responsive content and the requested viewports. Deep breadcrumbs follow Content Tree parents.
- Inspect public HTML after publication: real body, one authoritative title/description/canonical, robots, working managed derivatives and links. Check `/robots.txt` and `/sitemap.xml`. Search projection is eventual; inspect `cms search status` or `GET /api/v1/search/status` where permitted. If the initial index reports `reindex_required:true` or a version mismatch, ask an authorized operator with `search.reindex` to run `cms search reindex --environment "$PCMS_ENVIRONMENT" --yes` (REST `POST /api/v1/search/reindex` with `{"resume":false}` or MCP `cms_reindex_search({"resume":false})`); wait for completion and verify a distinctive published query. Do not add this heavy permission to the authoring token or reindex after ordinary edits.
- Check social images for explicit override, own hero, eligible parent and site fallback, plus no image. Draft-only ancestors must not supply a live image.
- Submit the actual contact form using synthetic values at `POST /api/v1/public/forms/<form-id>/submit`, JSON `values`, boolean consent. Let an authorized operator confirm delivery. Submission success is separate from downstream delivery; do not read real submissions.
- A normal editor logs in at `/admin/`, opens an agent-created entry, edits prose/table/media, saves WORKING, previews, seals and publishes. Missing editable fields or a need for private scripts blocks handoff.

The following provider checks are optional and require the target to expose the relevant feature. The manifest's historical CMS minimum covers base site authoring, not every later optional UI. Do not treat an absent provider screen as a failed base workflow or invent an unsupported operation.

Ownership in Webmaster/Search Console and a Metrica counter check differ. Ownership uses **Settings → Site ownership verification** at `/admin/#/settings?tab=verification`, also linked from Analytics: obtain real provider tag/file → enter and Save → return to provider and Verify. The provider confirms ownership; CMS serves the proof. DNS is an operator/provider action.

For Metrica, enable **Allow counter checking in Yandex Metrica** → Save → reopen the provider check → disable/Save afterwards. No Admin logout is needed. Keep maintenance off: anonymous visitors/checkers get HTTP 503 while it is enabled. Temporary debug mode adds the `yastatic.net` script origin and document-wide inline style-attribute allowance; it never adds inline-script allowance. Report external acceptance separately.

On 409, reread generation and reconcile. On 403, identify the exact scope/origin constraint without disabling safeguards. Preserve typed errors and sanitized request ids. Stop dependent work on a Core defect; do not change Core/DB/migrations/release files or unrelated production settings.

Report executed/observed checks and unverified ones separately. Local validation, published behavior, editor continuation and external-provider confirmation are different evidence.
