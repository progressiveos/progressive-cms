# progressive-cms-content-agent

Version: 1.5.3. First-party content workflow adapted from upstream 1.5.0; see its manifest for compatibility.

Create, revise and publish structured content through scoped public interfaces.

## Entry conditions

Use only the operator-named QA/site environment and its scoped credentials. Read the [documentation index](../../index.md). Run `cms agent bootstrap --json`; inspect site, environment, actor permissions, contract versions, readiness and actual Core version. Check this manifest, not a remembered old Skill version. The manifest declares the supported minimum CMS and contract versions; compare those with the actual target.

This first-party Skill is included under `docs/skills/`, not through the community installer. Set `PCMS_SKILLS_DIR` to that directory; then `cms skills list`, `cms skills doc progressive-cms-content-agent --json` and `cms skills check progressive-cms-content-agent --json` use this distribution. Bootstrap may also list the separately shipped runtime Skills; that list is not proof this docs copy is the same version. See [delivery instructions](../../agent-skills.md).

## Canonical workflow

Read [the complete workflow and chapter map](references/workflow.md). Always declare types before content. Treat RichText AST v2 and Block Document v1 as separate formats, selected by declared field/policy. Before editing existing content, inspect its publication and exact revision through `cms content revision current <entry-id> --json`; use `show` for another revision. Use scoped REST/MCP/CLI; use `.pcpub` only when its supported version and explicit routes/asset references are confirmed by discovery.

Stop on missing required permissions, incompatible contracts, unconfigured preview/publication, or a Core defect. Never write SQL, modify Core/release files, read real leads/submissions, invent media URLs, or add invisible blocks. A Skill grants no permission. A theme/operator reload is an explicit setup boundary, never authority for arbitrary root access.

## Acceptance checklist

- Target, actual version, supplied Skill version and permissions recorded without credentials.
- Model/manifest/declared templates agree; optional media stays optional.
- All nested prose is AST v2; typed block envelopes keep version 1.
- Draft/CAS, validate, preview, seal, publish, public render and Search verified through public interfaces.
- Breadcrumbs and four SEO image cases verified from actual HTML.
- A normal editor can modify and republish content via Admin without private scripts.
- Responsive pages, form submission with synthetic data, and failure handling checked; unresolved gates reported honestly.
