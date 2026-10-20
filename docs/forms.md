# Forms

Contract owner: Core forms and interactions.

Create a form definition with declared fields and settings, then reference its stable id from a form block. Edits create immutable definition versions. Publish the content that presents the form and test the public submission workflow.

The owner selects consent and retention policy; the CMS does not require consent on every form or a privacy case for normal operation. Consent fields, when selected, require `consent_key` plus consent text or a policy reference. Submissions snapshot consent facts. Configure a honeypot and server-side abuse controls; a hidden field alone is not authorization. The public submit transport validates values and may return `FORM_RATE_LIMITED` on rapid retries.

Treat submissions/leads as personal data and grant read/export permissions separately from definition management. An agent building a form does not need permission to read real leads. Verify delivery with an authorized operator and synthetic test values, never by dumping production submissions.

## Complete example and public transport

The delivered [contact definition](reference/examples/contact-form.json) shows all fields/settings for a scalar name/email/message/consent form. Read `GET /api/v1/forms/field-types`, then submit that definition with `POST /api/v1/forms` under forms.manage_definition. Record the returned stable form id and use it in a registered `form` block's `form_definition_id`; never keep a placeholder id in published content.

The public endpoint is `POST /api/v1/public/forms/<form-id>/submit`, with a JSON body containing `values`. Consent is a boolean, not the FormData string "true". Preserve the configured honeypot key and controlled fields; richer schemas need typed conversion for checkbox groups and numeric values. The [starter renderer](reference/theme-starter/blocks/form.liquid) and script handle only the example's supported scalar/consent field set.

Use synthetic requests and have an authorized operator verify delivery. Public submission success is separate from provider delivery; an agent must not obtain lead-read/export scope just to demonstrate a form. Consent wording is an example for configuration, not a legal assessment.

## Retention and addressed actions

`settings.retention.mode` is retain/anonymize/delete. Retain deliberately keeps data indefinitely, even with after_days; selected anonymize/delete policies run for ACTIVE and ARCHIVED definitions via the Worker sweep. Verify its execution; this is not recipient/export/backup erasure.

Optional [addressed personal-data tools](personal-data-tools.md) provide preview/token/request identity, block/unblock/rectify/erase, local-copy propagation and recipient followups. They require separately delegated privacy.manage and updated Web/all Workers. Native Forms keeps its existing instance scope, not per-record tenancy.

[Technical personal-data readiness Skill](skills/progressive-cms-152fz/SKILL.md) provides a focused agent workflow and acceptance evidence.

[Documentation index](index.md)
