# Content Agent — Media rules (PCMS-SKILL-T004)

## Identity and addressing

- Media is referenced by **Media Asset ID** — never by physical storage path
  and never by a hand-constructed derivative/transformation URL. Variants are
  produced by the CMS from the theme's media presets; constructing URLs like
  `/media/a/:id/v<n>/…` by hand is forbidden.
- Before uploading, search existing assets and **reuse** a correct one
  (`GET /media` with filters; `GET /media/:mediaId/usage` shows where an
  asset is already used). Duplicates only when no asset fits.

`GET /media` accepts `limit=1..100`. Walk all `next_cursor` pages when
reconciling an inventory; one page is not a full media export.

Physical blobs and logical assets are distinct. Ordinary `POST /media`
already creates a new logical ID even for byte-identical uploads, while
reusing the original blob by SHA-256 (`duplicate_blob=true`). Titles, alt,
captions, versions and references belong to each asset independently.
Do not use a SHA lookup to merge different source identities during migration.
No special clone opt-in is necessary.

For a retryable import, supply `Idempotency-Key: migration:<source-identity>`
(8..200 ASCII letters/digits/`.`/`_`/`:`/`-`). Retain the returned media ID in
the source mapping. The same key, bytes and upload headers replay the same
ID; changed bytes, filename, declared MIME or folder return
`409 IDEMPOTENCY_KEY_CONFLICT`. A concurrent pending call returns
`409 IDEMPOTENCY_IN_PROGRESS`; retry with backoff. Keys are scoped to actor,
site and environment, live for 24 hours and survive process restarts. Permission
and token constraints apply before replay as well. Retain a durable source map
for retries beyond that window. Uploading without a key retains existing
behavior: a new asset ID per accepted upload, no extra original byte copy.

## Ingest

- Upload binary: `POST /media` (size/pixel limits are server policy; respect
  the reported limits instead of pre-optimizing).
- Kinds: images, documents (pdf/docx/xlsx/pptx/json/txt/md/log/csv), **video
  (mp4/webm)** and **audio (mp3/m4a/ogg/wav/flac)** upload natively. Video/audio
  ceiling default 256 MiB per file (config `media.maxVideoUploadBytes` /
  `media.maxAudioUploadBytes`); the type decides the ceiling, so a failed
  `MEDIA_TOO_LARGE` on video does not mean documents are capped equally.
- Video in pages: block `video@1` with `provider: "upload"` + `media_asset_id`
  (poster optional), galleries of clips: `video_gallery@1`, audio/podcasts:
  `audio@1` (native uploaded file, theme player).
- Remote import: `POST /media/import` **requires `media.import`** and is
  executed by the CMS's SSRF-guarded fetcher — never fetch remote media
  yourself and re-upload it as a workaround, and never import from URLs the
  task cannot vouch for.
- Wait for the asset to be ready before referencing it; inspect metadata
  (`GET /media/:mediaId`) after ingest.
- If an image response contains `media_variant_failures`, the MediaAsset is
  saved but one or more active-theme derivatives are missing. An operator or
  agent with `media.write` can retry them with
  `POST /media/:mediaId/variants/regenerate` or MCP
  `cms_regenerate_media_variants`. The operation is idempotent, keeps the
  asset ID/source/version, and returns any per-preset failures still present.

## Media acquisition (when the capability exists)

- Discovery first: `GET /media/providers` (MCP:
  `cms_list_media_providers`) reports installed stock/generation providers
  and their `configured` state. Zero providers ⇒ use the upload/import path
  only; this is normal, not an error.
- Stock search: `POST /media/stock/search` with `query` (and optional
  `provider_id`, orientation/size intents). Candidates carry an opaque
  `candidate_ref` — treat it as a handle, never parse or store it as
  content.
- Import: `POST /media/stock/import` with the chosen `candidate_ref`. The
  result is a canonical MediaAsset (duplicate-safe: re-importing the same
  provider asset returns the existing asset).
- Generation (only when the task explicitly calls for generated imagery and
  your token holds `media.generate` — it is cost-bearing and not a default
  scope). Agent route, in order:
  1. `GET /media/providers` (MCP `cms_list_media_providers`) — pick a
     configured generation provider.
  2. `GET /media/providers/:id/capabilities` (MCP
     `cms_get_media_provider_capabilities`) — models with their size
     options (aspect + pixels), resolution tiers, limits, prices. Choose
     model + aspect/resolution from what is LISTED — never guess pixels.
  3. `POST /media/generations/estimate` (MCP
     `cms_estimate_media_generation`) — approximate price; surface it to
     the owner when non-trivial. Token-priced models return an explicit
     refusal, not a number.
  4. `POST /media/generations` (MCP `cms_generate_media`) — agents generate
     exactly ONE image per call (`count` is clamped to 1).
  5. Poll `GET /media/generations/:id` until `ready|failed`. Every
     candidate is ALREADY imported into the media library and carries
     `media_id` (plus prompt/model/seed/cost in provenance) — use the
     Media ID and wait for READY. `accept` is an optional replay path that
     returns the same asset. Never reference candidate preview URLs.
- All acquisition endpoints are provider-neutral; never call
  provider-specific APIs, never request provider configuration or keys
  (`media.providers.manage` is never an agent scope), and treat
  `PROVIDER_NOT_CONFIGURED` as a stop-and-report condition.
- Auto-imported generations accumulate in the library by design (paid
  content is never discarded); never bulk-delete generated assets —
  cleanup is an owner decision.
- The imported/accepted asset enters the ordinary pipeline: wait for READY,
  then reference the Media ID.

## Metadata

- Set usage-specific `alt` text where the context differs from the asset
  default; captions and source/credit fields when the type defines them.
- Alt text describes the image **in the context of this page** — factual,
  no SEO keyword stuffing.

## Discipline

- Deletion/archival of media is not part of normal content runs
  (`media.archive` is an operator decision).
- Never embed base64 data blobs in content payloads; reference the ID.
