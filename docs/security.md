# Security

Contract owner: Core auth, config and proxy boundary.

Use TLS, secure session cookies on public deployments, narrowly trusted reverse proxies, explicit origins and least-privilege accounts. Never trust forwarded host/protocol headers from arbitrary peers. A reachable public page does not prove authenticated mutations work.

Robots exclusions and `noindex` guide crawlers; they do not restrict access. Protect administrative or confidential resources with authentication and network controls. A public media URL is retrievable without CMS sign-in regardless of whether a content entry currently links to it. Do not upload confidential files to the public Media Library; see its [URL and cache contract](media.md#public-media-urls-and-privacy).

Public Search and collection feeds have bounded per-client-IP limits and report their bucket state in response headers; see [Search](search.md#public-rate-limit) and [collections](collections.md#public-rate-limit). Authentication throttles may also include `Retry-After`. These controls limit request rates; they do not make a public endpoint private.

The optional [security contact](configuration-reference.md#optional-public-security-contact) is supplied and renewed by the site owner. It must not point to a vendor or a placeholder after deployment.

For reporting a product vulnerability, use the private process in the public [security policy](SECURITY.md); do not open a public issue with exploit details.

Keep secret values in the configured secret store. Do not put credentials in themes, content, query strings, Git, diagnostics or copied shell arguments. Keep bootstrap credentials private and change the initial owner password. Separate content publishing, site configuration, operations and submission-data permissions.

Validate every untrusted payload, media upload and provider callback. Do not bypass validation/seal gates, disable protections to fix a theme, or mutate database records directly. Treat signed previews as sensitive links. See [Configuration](configuration.md) and [Agents](agents.md).

Optional [addressed personal-data tools](personal-data-tools.md) use privacy.manage, authenticated actor/site context and POST session CSRF. Previews and receipts can disclose sensitive record/delivery IDs; restrict them. Native Forms remains instance-scoped; these tools do not add per-record multi-site tenancy.

[Technical personal-data readiness Skill](skills/progressive-cms-152fz/SKILL.md) provides a focused agent workflow and acceptance evidence.

[Documentation index](index.md)
