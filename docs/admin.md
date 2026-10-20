# Admin: editing a site after agent delivery

Contract owner: Core Admin/editor, revision lifecycle and actor permissions.

## Editor account

The human editor signs in with an ordinary Admin user account, not a Service Account token. An operator provisions that user under **Users & Access → Users** and grants the role and site-scoped permissions needed to read/edit content, preview, seal and (if intended) publish, plus media read/write for image replacement. Site configuration, system recovery and reading/exporting form submissions are separate privileges. A login page or a 200 response is not authenticated acceptance.

The standard Web deployment serves Admin at `<authorized-https-origin>/admin/` (`/admin` redirects there). Open that entry and sign in with the operator-issued editor account, completing any required MFA. API-only deployments may omit the Admin bundle; a missing entry is an operator setup issue. Obtain the permitted external origin from the operator if a proxy changes access; do not infer another host or bypass its controls.

An authoring agent uses a separate Service Account access token with task-specific scopes, delivered through the approved secret channel. Provision it in **Users & Access → Service accounts**; the token is shown once. Do not give the agent the human editor password, OWNER bootstrap credential or `tokens.manage`. The Admin token wizard currently scopes permissions but does not expose site/environment token bindings. When those restrictions are required, use the documented [`create_access_token` REST operation](rest-api-map.md#create_access_token) with explicit `site_key` and `environment`; the operation requires an authenticated session and CSRF token. The site/environment headers on later requests select context but do not create those restrictions.

## Human continuation test

1. Log in over the supported HTTPS origin and open a news entry created by the agent. Verify title/body/media are declared editable fields, not hidden blocks or pre-rendered HTML.
2. Open/create the WORKING revision. Change a paragraph, use formatting and save. Confirm revision state and edit generation advance.
3. Insert a table, enter header/data cells, add a row and save. The persisted document must be RichText AST v2. Preview must show the table through Core rendering.
4. Replace the optional principal image with a Media Library asset; preserve meaningful alt text. A missing image remains a valid state where the Content Type allows it.
5. Preview the exact revision, resolve validation issues, seal and publish using the role’s authorized actions. Verify the actual public page and search projection.

No database edits, private helper scripts or repeat visits from the building agent may be required. If a type/template mismatch prevents editing or sealing, the site has not passed handoff even if its first public render looked correct.

## RichText toolbar

The toolbar uses compact icon buttons with translated accessible labels and tooltips on hover/focus. Toggle actions expose pressed state; unavailable actions are disabled. It is not a set of unlabeled glyphs.

Supported operations include bold, italic, inline code, level-two heading, bullet/numbered lists, blockquote, code block, horizontal rule, link, table, Media Library image, undo and redo. When the selection is inside a table, contextual controls add/delete rows and columns, toggle row/column header semantics, edit caption, insert text after the table and delete the table. Images can retain alt/caption through their dialog.

Pasted tables must respect supported rectangular structure and limits; merged cells, unsupported nesting or lossy structures are rejected instead of silently corrupted. A toolbar tooltip does not establish that every conceivable HTML formatting feature is supported. See [RichText](richtext.md).

## Analytics and provider checks

An operator with `analytics.manage` can configure Yandex Metrica, GA4 and Google Tag Manager in **Admin → Settings → Analytics**. Run the diagnostics action with `analytics.read`; settings updates use compare-and-swap generation. The API equivalents are `POST /api/v1/analytics/doctor`, `GET /api/v1/analytics/settings` and `PUT /api/v1/analytics/settings`; see the [API operations](api-reference.md) list for permissions.

Custom network-rule Add/Remove edits are drafts until you click **Save**. Saving a settings object with non-empty `networkRules` requires `analytics.network.manage`; clearing existing rules requires it too, including removal of the last rule. If `networkRules` stays empty, ordinary provider settings need only `analytics.manage`. Changes keep the existing generation check and audit behavior; there are no new request fields.

To run a Yandex Metrica counter check, enable **Allow counter checking in Yandex Metrica**, click **Save**, then reopen the check from Metrica. Keep Admin open; logging out is unnecessary. Site maintenance/technical mode must stay off because anonymous public requests receive HTTP 503. After the check, disable the switch and save again. This counter check is separate from site ownership verification in Webmaster or Search Console; the Analytics ownership link opens **Settings → Site ownership verification** at `/admin/#/settings?tab=verification`.

The Metrica diagnostic allowance is off by default. It adds `yastatic.net` to `script-src` only while the switch is enabled, and temporarily allows `style-src-attr 'unsafe-inline'` across the whole document. It does not add `'unsafe-inline'` to `script-src`; a query parameter alone does not enable either allowance. GTM Preview has its own optional debug mode, also off by default, for Preview/Tag Assistant CSP origins and its `data:` font source. These toggles do not enable arbitrary custom scripts or certify an external provider check.

## Troubleshooting

A 403 on mutation may indicate a missing permission or proxy/origin mismatch; do not disable CSRF/cookie safeguards. A generation conflict requires rereading the WORKING revision. Validation errors identify a JSON-pointer path; fix the declared content shape. See [Errors](errors.md) and [Security](security.md).

Admin Theme history cleanup offers preview, individual selection and irreversible-deletion confirmation; read-only users cannot apply. It is separate from installed-package uninstall. See [theme cleanup](themes.md).

## Optional personal-data tools

Open `/admin/#/interactions/privacy`, or the link in submission/quiz-run/lead details. privacy.manage permits preview, explicit reviewed action and receipt lookup; reading current source values for rectify also uses interactions.read/leads.read. OWNER has the new permission; other roles receive it explicitly. See [personal-data tools](personal-data-tools.md) for source closure, exact retry and recipient decisions. Use of the tool is the owner's choice, not a site activation/publishing requirement.

## Provider activation choices

The owner selects immediate (default), analytics_consent or marketing_consent per provider. Deferred categories isolate bootstrap and loader; granting one does not activate the other. `pcmsConsent` persists choices by site/origin/provider configuration. Revoking loaded managed tags persists denial and reloads the document, also handling cross-tab changes and storage failure; it cannot undo sent/in-flight requests, remove vendor cookies or control arbitrary GTM/theme code. The CMS does not force consent mode on immediate providers. Check the chosen behavior in the actual network; doctor is not vendor certification.

[Documentation index](index.md)
