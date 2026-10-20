# Security

Contract owner: Core auth, config and proxy boundary.

Use TLS, secure session cookies on public deployments, narrowly trusted reverse proxies, explicit origins and least-privilege accounts. Never trust forwarded host/protocol headers from arbitrary peers. A reachable public page does not prove authenticated mutations work.

Keep secret values in the configured secret store. Do not put credentials in themes, content, query strings, Git, diagnostics or copied shell arguments. Keep bootstrap credentials private and change the initial owner password. Separate content publishing, site configuration, operations and submission-data permissions.

Validate every untrusted payload, media upload and provider callback. Do not bypass validation/seal gates, disable protections to fix a theme, or mutate database records directly. Treat signed previews as sensitive links. See [Configuration](configuration.md) and [Agents](agents.md).

Optional [addressed personal-data tools](personal-data-tools.md) use privacy.manage, authenticated actor/site context and POST session CSRF. Previews and receipts can disclose sensitive record/delivery IDs; restrict them. Native Forms remains instance-scoped; these tools do not add per-record multi-site tenancy.

[Technical personal-data readiness Skill](skills/progressive-cms-152fz/SKILL.md) provides a focused agent workflow and acceptance evidence.

[Documentation index](index.md)
