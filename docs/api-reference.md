# REST API operation reference

Contract owner: Core route registry. Paths are relative to `/api/v1`. Each operation retains its authoritative request/security schema in [OpenAPI JSON](reference/openapi-v1.json). Generic objects in OpenAPI are not complete domain examples; use the authored chapters and runtime discovery.

The [complete REST map](rest-api-map.md) explains all operations, reproduces complete declared input schemas and response construction, and covers optional extension operations and HTTP routes outside this registry.

| Method | Path | Operation | Permission |
|---|---|---|---|
| POST | `/access-tokens/{tokenId}/revoke` | `revoke_access_token` | `tokens.manage` |
| GET | `/actor` | `get_current_actor` | `see security schema` |
| GET | `/agent/bootstrap` | `get_agent_bootstrap` | `see security schema` |
| POST | `/analytics/doctor` | `analytics_doctor` | `analytics.read` |
| GET | `/analytics/providers` | `list_analytics_providers` | `analytics.read` |
| GET | `/analytics/settings` | `get_analytics_settings` | `analytics.read` |
| PUT | `/analytics/settings` | `update_analytics_settings` | `analytics.manage` |
| GET | `/audit` | `list_audit` | `audit.read` |
| POST | `/auth/invite/accept` | `auth_invite_accept` | `see security schema` |
| POST | `/auth/login` | `auth_login` | `see security schema` |
| POST | `/auth/logout` | `auth_logout` | `see security schema` |
| POST | `/auth/mfa` | `auth_mfa_complete` | `see security schema` |
| POST | `/auth/session/rotate` | `auth_rotate_session` | `see security schema` |
| GET | `/auth/sessions` | `auth_list_sessions` | `see security schema` |
| DELETE | `/auth/sessions/{sessionId}` | `auth_revoke_session` | `see security schema` |
| POST | `/blocks/validate` | `validate_block_props` | `content.read` |
| POST | `/bundles` | `submit_publication_bundle` | `content.create` |
| POST | `/bundles/pcpub` | `ingest_publication_bundle` | `content.create` |
| GET | `/bundles/pcpub/ingests` | `list_publication_bundle_ingests` | `see security schema` |
| GET | `/bundles/pcpub/ingests/{ingestId}` | `get_publication_bundle_ingest` | `see security schema` |
| GET | `/capabilities` | `get_capabilities` | `see security schema` |
| GET | `/changesets` | `list_changesets` | `publication.read` |
| POST | `/changesets` | `create_changeset` | `publication.plan` |
| GET | `/changesets/{changesetId}` | `get_changeset` | `publication.read` |
| POST | `/changesets/{changesetId}/apply` | `apply_changeset` | `publication.publish` |
| POST | `/changesets/{changesetId}/cancel` | `cancel_changeset` | `publication.plan` |
| POST | `/changesets/{changesetId}/items` | `add_changeset_item` | `publication.plan` |
| POST | `/changesets/{changesetId}/preflight` | `preflight_changeset` | `publication.plan` |
| GET | `/collections/{key}/items` | `list_collection_items` | `see security schema` |
| POST | `/content/richtext/convert` | `convert_rich_text` | `content.read` |
| POST | `/content/schema/apply` | `apply_content_schema` | `content_schema.apply` |
| GET | `/content/schema/overrides` | `list_content_schema_overrides` | `content_schema.read` |
| POST | `/content/schema/validate` | `validate_content_schema` | `content_schema.propose` |
| GET | `/diagnostics` | `get_diagnostics` | `site.validate` |
| GET | `/discovery/blocks` | `list_block_types` | `content.read` |
| GET | `/discovery/blocks/{typeId}` | `get_block_schema` | `content.read` |
| GET | `/discovery/content/collection-capabilities` | `get_collection_capabilities` | `content.read` |
| GET | `/discovery/content/field-types` | `list_field_types` | `content.read` |
| GET | `/discovery/content/icons` | `list_icon_catalog` | `content.read` |
| GET | `/discovery/content/templates` | `list_compatible_templates` | `content.read` |
| GET | `/discovery/content/tree` | `list_content_tree` | `content.read` |
| GET | `/discovery/content/types` | `list_content_types` | `content.read` |
| GET | `/discovery/content/types/{key}` | `get_content_type_schema` | `content.read` |
| GET | `/discovery/media/presets` | `list_media_presets` | `media.read` |
| GET | `/discovery/navigation/placements` | `list_placement_bindings` | `navigation.read` |
| GET | `/discovery/navigation/sets` | `list_navigation_sets` | `navigation.read` |
| GET | `/discovery/navigation/trees/{setRef}` | `get_navigation_tree` | `navigation.read` |
| GET | `/discovery/routing/check` | `check_route_available` | `site.validate` |
| GET | `/discovery/routing/policy` | `get_route_policy` | `navigation.read` |
| GET | `/discovery/routing/resolve-entry` | `resolve_entry_url` | `navigation.read` |
| GET | `/discovery/seo/metadata/{entryId}` | `resolve_seo_metadata` | `seo.read` |
| GET | `/discovery/seo/preview` | `preview_seo` | `seo.read` |
| GET | `/discovery/seo/schema` | `get_seo_schema` | `seo.read` |
| GET | `/discovery/seo/structured-data` | `preview_structured_data` | `seo.read` |
| GET | `/discovery/seo/validate` | `validate_seo` | `seo.validate` |
| GET | `/discovery/theme` | `get_theme_contract` | `theme.read` |
| GET | `/discovery/theme/templates` | `list_templates` | `theme.read` |
| POST | `/entries` | `create_draft` | `content.create` |
| POST | `/entries/{entryId}/archive` | `archive_entry` | `content.archive` |
| POST | `/entries/{entryId}/draft` | `create_working_draft` | `content.edit` |
| POST | `/entries/{entryId}/duplicate` | `duplicate_entry` | `content.create` |
| POST | `/entries/{entryId}/home` | `set_home_entry` | `navigation.edit` |
| POST | `/entries/{entryId}/identity-locale` | `reidentify_entry_locale` | `content.edit` |
| POST | `/entries/{entryId}/move` | `move_entry` | `content.edit` |
| POST | `/entries/{entryId}/restore` | `restore_entry` | `content.archive` |
| GET | `/entries/{entryId}/revisions` | `list_revisions` | `publication.read` |
| POST | `/entries/{entryId}/revisions/cleanup` | `cleanup_entry_revisions` | `content.edit` |
| GET | `/entries/{entryId}/route` | `get_entry_route` | `navigation.read` |
| POST | `/entries/{entryId}/route/change` | `change_entry_route` | `navigation.edit` |
| GET | `/entries/{entryId}/seo` | `get_entry_seo` | `seo.read` |
| PUT | `/entries/{entryId}/seo` | `update_entry_seo` | `seo.edit` |
| PATCH | `/entries/{entryId}/template` | `set_entry_template` | `content.edit` |
| GET | `/entries/{entryId}/translations` | `list_entry_translations` | `content.read` |
| POST | `/entries/{entryId}/translations` | `add_entry_translation` | `content.create` |
| GET | `/extensions` | `list_extensions` | `extensions.manage` |
| GET | `/extensions/capabilities` | `get_extension_capabilities` | `extensions.manage` |
| GET | `/extensions/compatibility` | `get_compatibility_report` | `extensions.manage` |
| GET | `/extensions/contracts` | `get_contract_versions` | `extensions.manage` |
| GET | `/extensions/deprecations` | `list_deprecations` | `extensions.manage` |
| GET | `/extensions/operations` | `list_all_extension_operations` | `see security schema` |
| GET | `/extensions/{extensionId}/compatibility` | `get_extension_compatibility` | `extensions.manage` |
| GET | `/extensions/{extensionId}/config` | `get_extension_config` | `extensions.manage` |
| PUT | `/extensions/{extensionId}/config` | `update_extension_config` | `extensions.manage` |
| POST | `/extensions/{extensionId}/disable` | `extension_disable` | `extensions.manage` |
| POST | `/extensions/{extensionId}/enable` | `extension_enable` | `extensions.manage` |
| POST | `/extensions/{extensionId}/install` | `extension_install` | `extensions.manage` |
| GET | `/extensions/{extensionId}/mount` | `extension_mount_get` | `extensions.manage` |
| PUT | `/extensions/{extensionId}/mount` | `extension_mount_set` | `extensions.manage` |
| GET | `/extensions/{extensionId}/operations` | `list_extension_operations` | `see security schema` |
| POST | `/extensions/{extensionId}/operations/{operationId}` | `invoke_extension_operation` | `see security schema` |
| DELETE | `/extensions/{extensionId}/secrets/{slot}` | `clear_extension_secret` | `extensions.manage` |
| PUT | `/extensions/{extensionId}/secrets/{slot}` | `set_extension_secret` | `extensions.manage` |
| POST | `/extensions/{extensionId}/uninstall` | `extension_uninstall` | `extensions.manage` |
| GET | `/external-identities/{namespace}/{externalId}` | `resolve_external_identity` | `content.read` |
| PUT | `/external-identities/{namespace}/{externalId}` | `bind_external_identity` | `content.edit` |
| GET | `/forms` | `list_forms` | `forms.read_definition` |
| POST | `/forms` | `create_form_definition` | `forms.manage_definition` |
| GET | `/forms/field-types` | `list_form_field_types` | `forms.read_definition` |
| GET | `/forms/{formId}` | `get_form_definition` | `forms.read_definition` |
| PUT | `/forms/{formId}` | `update_form_definition` | `forms.manage_definition` |
| GET | `/forms/{formId}/stats` | `get_form_stats` | `forms.read_definition` |
| GET | `/forms/{formId}/usage` | `get_form_usage` | `forms.read_definition` |
| GET | `/integrations/bindings` | `list_bindings` | `integrations.read` |
| POST | `/integrations/bindings` | `create_binding` | `integrations.configure` |
| PATCH | `/integrations/bindings/{bindingId}` | `update_binding` | `integrations.configure` |
| GET | `/integrations/connectors` | `list_connectors` | `integrations.read` |
| GET | `/integrations/connectors/{connectorType}` | `get_connector_schema` | `integrations.read` |
| GET | `/integrations/deliveries` | `list_deliveries` | `integrations.deliveries.read` |
| GET | `/integrations/deliveries/stats` | `get_delivery_stats` | `integrations.deliveries.read` |
| GET | `/integrations/deliveries/{deliveryId}` | `get_delivery` | `integrations.deliveries.read` |
| POST | `/integrations/deliveries/{deliveryId}/cancel` | `cancel_delivery` | `integrations.retry` |
| POST | `/integrations/deliveries/{deliveryId}/retry` | `retry_delivery` | `integrations.retry` |
| GET | `/integrations/inbound-events` | `list_inbound_events` | `integrations.inbound.read` |
| POST | `/integrations/inbound/{instanceId}` | `receive_inbound` | `see security schema` |
| GET | `/integrations/instances` | `list_integration_instances` | `integrations.read` |
| POST | `/integrations/instances` | `create_instance` | `integrations.configure` |
| PATCH | `/integrations/instances/{instanceId}` | `update_instance` | `integrations.configure` |
| DELETE | `/integrations/instances/{instanceId}/secrets/{key}` | `clear_instance_secret` | `integrations.secrets.manage` |
| PUT | `/integrations/instances/{instanceId}/secrets/{key}` | `set_instance_secret` | `integrations.secrets.manage` |
| POST | `/integrations/instances/{instanceId}/test` | `test_instance` | `integrations.test` |
| POST | `/interactions/export` | `export_interactions` | `interactions.export` |
| GET | `/interactions/leads` | `list_leads` | `leads.read` |
| GET | `/interactions/leads/{leadId}` | `get_lead` | `leads.read` |
| PATCH | `/interactions/leads/{leadId}` | `update_lead_status` | `leads.manage` |
| GET | `/interactions/quiz-runs` | `list_quiz_runs` | `interactions.read` |
| GET | `/interactions/quiz-runs/{runId}` | `get_quiz_run` | `interactions.read` |
| POST | `/interactions/privacy/apply` | `apply_interaction_privacy` | `privacy.manage` |
| GET | `/interactions/privacy/cases/{caseId}` | `get_interaction_privacy_case` | `privacy.manage` |
| POST | `/interactions/privacy/cases/{caseId}/deliveries/{deliveryId}/acknowledge` | `acknowledge_interaction_privacy` | `privacy.manage` |
| POST | `/interactions/privacy/preview` | `preview_interaction_privacy` | `privacy.manage` |
| GET | `/interactions/submissions` | `list_submissions` | `interactions.read` |
| GET | `/interactions/submissions/{submissionId}` | `get_submission` | `interactions.read` |
| PATCH | `/interactions/submissions/{submissionId}` | `update_submission_status` | `interactions.manage` |
| GET | `/localization` | `get_site_localization` | `site.configure` |
| PUT | `/localization` | `update_site_localization` | `site.configure` |
| GET | `/mail/settings` | `get_mail_settings` | `integrations.read` |
| PUT | `/mail/settings` | `update_mail_settings` | `integrations.configure` |
| POST | `/mail/test` | `test_mail_transport` | `integrations.test` |
| GET | `/maintenance` | `get_maintenance_state` | `site.maintenance` |
| PUT | `/maintenance` | `update_maintenance_state` | `site.maintenance` |
| GET | `/media` | `search_media` | `media.read` |
| POST | `/media` | `upload_media` | `media.write` |
| GET | `/media/by-hash/{sha256}` | `search_media_by_hash` | `media.read` |
| GET | `/media/folders` | `list_media_folders` | `media.read` |
| POST | `/media/folders` | `create_media_folder` | `media.write` |
| DELETE | `/media/folders/{folderId}` | `delete_media_folder` | `media.write` |
| PATCH | `/media/folders/{folderId}` | `update_media_folder` | `media.write` |
| POST | `/media/generations` | `create_media_generation` | `media.generate` |
| POST | `/media/generations/estimate` | `estimate_media_generation` | `media.generate` |
| GET | `/media/generations/{generationId}` | `get_media_generation` | `media.generate` |
| POST | `/media/generations/{generationId}/candidates/{candidateIndex}/accept` | `accept_generated_media` | `media.generate` |
| POST | `/media/import` | `import_media_url` | `media.import` |
| GET | `/media/providers` | `list_media_providers` | `media.read` |
| GET | `/media/providers/{providerId}` | `get_media_provider` | `media.read` |
| GET | `/media/providers/{providerId}/capabilities` | `get_media_provider_capabilities` | `media.read` |
| GET | `/media/providers/{providerId}/config` | `get_media_provider_config` | `media.providers.manage` |
| PUT | `/media/providers/{providerId}/config` | `update_media_provider_config` | `media.providers.manage` |
| GET | `/media/providers/{providerId}/models` | `list_media_provider_models` | `media.providers.manage` |
| GET | `/media/providers/{providerId}/models/{modelId}` | `get_media_provider_model` | `media.providers.manage` |
| DELETE | `/media/providers/{providerId}/secrets/{slot}` | `clear_media_provider_secret` | `media.providers.manage` |
| PUT | `/media/providers/{providerId}/secrets/{slot}` | `set_media_provider_secret` | `media.providers.manage` |
| POST | `/media/providers/{providerId}/test` | `test_media_provider` | `media.providers.manage` |
| POST | `/media/stock/import` | `import_stock_candidate` | `media.stock.import` |
| POST | `/media/stock/search` | `search_stock_media` | `media.stock.search` |
| GET | `/media/{mediaId}` | `get_media` | `media.read` |
| PATCH | `/media/{mediaId}` | `update_media_metadata` | `media.write` |
| POST | `/media/{mediaId}/archive` | `archive_media` | `media.archive` |
| GET | `/media/{mediaId}/file` | `get_media_file` | `media.read` |
| PATCH | `/media/{mediaId}/folder` | `move_media_asset` | `media.write` |
| GET | `/media/{mediaId}/usage` | `get_media_usage` | `media.read` |
| PUT | `/media/{mediaId}/version` | `replace_media_version` | `media.replace` |
| DELETE | `/navigation/placements/{placementKey}` | `unbind_navigation_placement` | `navigation.edit` |
| PUT | `/navigation/placements/{placementKey}` | `bind_navigation_placement` | `navigation.edit` |
| POST | `/navigation/sets` | `create_navigation_set` | `navigation.edit` |
| DELETE | `/navigation/sets/{setId}` | `delete_navigation_set` | `navigation.edit` |
| POST | `/navigation/sets/{setId}/items` | `insert_navigation_item` | `navigation.edit` |
| DELETE | `/navigation/sets/{setId}/items/{itemId}` | `delete_navigation_item` | `navigation.edit` |
| PATCH | `/navigation/sets/{setId}/items/{itemId}` | `update_navigation_item` | `navigation.edit` |
| POST | `/navigation/sets/{setId}/items/{itemId}/move` | `move_navigation_item` | `navigation.edit` |
| GET | `/navigation/sets/{setId}/overrides` | `list_navigation_overrides` | `navigation.read` |
| POST | `/navigation/sets/{setId}/overrides` | `add_navigation_override` | `navigation.edit` |
| DELETE | `/navigation/sets/{setId}/overrides/{overrideId}` | `remove_navigation_override` | `navigation.edit` |
| POST | `/navigation/sets/{setId}/seal` | `seal_navigation_set` | `navigation.publish` |
| GET | `/navigation/validate` | `validate_navigation` | `navigation.read` |
| GET | `/notifications/settings` | `get_notification_settings` | `integrations.read` |
| PUT | `/notifications/settings` | `update_notification_settings` | `integrations.configure` |
| GET | `/notifications/subscriptions` | `get_notification_subscriptions` | `signed-in user` |
| PUT | `/notifications/subscriptions` | `update_notification_subscriptions` | `signed-in user` |
| GET | `/openapi.json` | `get_openapi_document` | `see security schema` |
| GET | `/payments` | `list_payments` | `payments.read` |
| POST | `/payments` | `create_payment` | `payments.create` |
| GET | `/payments/callback/{providerInstanceId}` | `receive_payment_callback` | `see security schema` |
| GET | `/payments/inbound-events` | `list_payment_inbound_events` | `payments.events.read` |
| GET | `/payments/providers` | `list_payment_providers` | `payments.read` |
| GET | `/payments/providers/instances` | `list_payment_provider_instances` | `payments.read` |
| POST | `/payments/providers/instances` | `create_payment_provider_instance` | `payments.configure` |
| DELETE | `/payments/providers/instances/{instanceId}` | `delete_payment_provider_instance` | `payments.configure` |
| PATCH | `/payments/providers/instances/{instanceId}` | `update_payment_provider_instance` | `payments.configure` |
| POST | `/payments/providers/instances/{instanceId}/test` | `test_payment_provider_instance` | `payments.configure` |
| GET | `/payments/providers/{providerType}/capabilities` | `get_payment_provider_capabilities` | `payments.read` |
| GET | `/payments/{paymentId}` | `get_payment` | `payments.read` |
| POST | `/payments/{paymentId}/cancel` | `cancel_payment` | `payments.cancel` |
| GET | `/payments/{paymentId}/events` | `list_payment_events` | `payments.events.read` |
| POST | `/payments/{paymentId}/refund` | `refund_payment` | `payments.refund` |
| GET | `/payments/{paymentId}/refunds` | `list_payment_refund_intents` | `payments.read` |
| POST | `/plans` | `create_publication_plan` | `publication.plan` |
| POST | `/plans/{planId}/items/{itemId}/cancel` | `cancel_publication_item` | `publication.schedule` |
| POST | `/plans/{planId}/items/{itemId}/publish-now` | `publish_now` | `publication.publish` |
| POST | `/plans/{planId}/items/{itemId}/reschedule` | `reschedule_publication_item` | `publication.schedule` |
| POST | `/plans/{planId}/preview` | `preview_publication_plan` | `publication.plan` |
| POST | `/plans/{planId}/schedule` | `schedule_publication_plan` | `publication.schedule` |
| POST | `/previews` | `create_preview` | `preview.create` |
| POST | `/public/forms/{formId}/submit` | `submit_public_form` | `see security schema` |
| POST | `/public/quizzes/runs/{runId}/abandon` | `abandon_public_quiz` | `see security schema` |
| POST | `/public/quizzes/runs/{runId}/answer` | `answer_public_quiz` | `see security schema` |
| POST | `/public/quizzes/runs/{runId}/complete` | `complete_public_quiz` | `see security schema` |
| GET | `/public/quizzes/{quizId}/schema` | `get_quiz_public_schema` | `see security schema` |
| POST | `/public/quizzes/{quizId}/start` | `start_public_quiz` | `see security schema` |
| GET | `/publication/calendar` | `list_publication_calendar` | `publication.read` |
| GET | `/publication/history` | `list_publication_history` | `publication.read` |
| GET | `/publication/pending` | `list_pending_publications` | `publication.read` |
| POST | `/publications/publish` | `publish_revision` | `publication.publish` |
| POST | `/publications/rollback` | `rollback_publication` | `publication.rollback` |
| POST | `/publications/unpublish` | `unpublish_publication` | `publication.unpublish` |
| GET | `/publications/{entityType}/{entityId}` | `get_publication` | `publication.read` |
| GET | `/quizzes` | `list_quizzes` | `quizzes.read_definition` |
| POST | `/quizzes` | `create_quiz_definition` | `quizzes.manage_definition` |
| GET | `/quizzes/{quizId}` | `get_quiz_definition` | `quizzes.read_definition` |
| PUT | `/quizzes/{quizId}` | `update_quiz_definition` | `quizzes.manage_definition` |
| GET | `/quizzes/{quizId}/stats` | `get_quiz_stats` | `quizzes.read_definition` |
| GET | `/quizzes/{quizId}/usage` | `get_quiz_usage` | `quizzes.read_definition` |
| DELETE | `/registry/account-token` | `registry_account_token_clear` | `extensions.manage` |
| POST | `/registry/account-token` | `registry_account_token_set` | `extensions.manage` |
| POST | `/registry/apply-update` | `registry_apply_update` | `extensions.manage` |
| GET | `/registry/index` | `registry_index` | `see security schema` |
| POST | `/registry/install` | `registry_install_package` | `skills.manage` |
| GET | `/registry/instance` | `registry_instance_get` | `extensions.manage` |
| POST | `/registry/instance/confirm` | `registry_instance_confirm` | `extensions.manage` |
| GET | `/registry/instance/status` | `registry_instance_status` | `extensions.manage` |
| GET | `/registry/packages/{id}` | `registry_package_card` | `see security schema` |
| POST | `/registry/publish/{skillId}` | `registry_publish_skill` | `skills.manage` |
| POST | `/registry/release-upload` | `registry_release_upload` | `extensions.manage` |
| GET | `/registry/update-status` | `registry_update_status` | `extensions.manage` |
| GET | `/revisions/{fromId}/diff/{toId}` | `diff_revisions` | `publication.read` |
| DELETE | `/revisions/{revisionId}` | `delete_revision` | `content.edit` |
| GET | `/revisions/{revisionId}` | `get_revision` | `publication.read` |
| PATCH | `/revisions/{revisionId}` | `update_draft` | `content.edit` |
| POST | `/revisions/{revisionId}/seal` | `seal_revision` | `revision.seal` |
| POST | `/revisions/{revisionId}/validate` | `validate_revision` | `content.edit` |
| GET | `/roles` | `list_roles` | `roles.read` |
| POST | `/roles-admin` | `manage_custom_role` | `roles.manage` |
| POST | `/routing/redirect-imports/apply` | `apply_redirect_import` | `routing.redirects.import` |
| POST | `/routing/redirect-imports/validate` | `validate_redirect_import` | `routing.redirects.import` |
| GET | `/search` | `search_query` | `see security schema` |
| GET | `/search/admin` | `search_admin` | `search.admin` |
| GET | `/search/capabilities` | `get_search_capabilities` | `see security schema` |
| GET | `/search/reindex` | `list_search_reindex_runs` | `search.diagnostics` |
| POST | `/search/reindex` | `reindex_search` | `search.reindex` |
| GET | `/search/status` | `get_search_status` | `search.diagnostics` |
| POST | `/search/validate-document` | `validate_search_document` | `search.admin` |
| GET | `/seo/indexnow` | `get_indexnow_settings` | `seo.read` |
| PUT | `/seo/indexnow` | `update_indexnow_settings` | `seo.site_settings` |
| POST | `/seo/indexnow/check` | `check_indexnow` | `seo.site_settings` |
| POST | `/seo/indexnow/rotate-key` | `rotate_indexnow_key` | `seo.site_settings` |
| GET | `/seo/indexnow/status` | `get_indexnow_status` | `seo.read` |
| GET | `/server` | `get_server_info` | `see security schema` |
| GET | `/service-accounts` | `list_service_accounts` | `tokens.manage` |
| POST | `/service-accounts` | `create_service_account` | `tokens.manage` |
| DELETE | `/service-accounts/{accountId}` | `delete_service_account` | `tokens.manage` |
| POST | `/service-accounts/{accountId}/disable` | `disable_service_account` | `tokens.manage` |
| GET | `/service-accounts/{accountId}/tokens` | `list_access_tokens` | `tokens.manage` |
| POST | `/service-accounts/{accountId}/tokens` | `create_access_token` | `tokens.manage` |
| GET | `/settings/site-identity` | `get_site_identity` | `seo.read` |
| PUT | `/settings/site-identity` | `update_site_identity` | `seo.site_settings` |
| GET | `/site` | `get_site_info` | `see security schema` |
| GET | `/site/domains` | `list_site_domains` | `domains.manage` |
| POST | `/site/domains` | `add_site_domain` | `domains.manage` |
| DELETE | `/site/domains/{hostname}` | `remove_site_domain` | `domains.manage` |
| PATCH | `/site/domains/{hostname}` | `patch_site_domain` | `domains.manage` |
| GET | `/skills` | `list_skills` | `see security schema` |
| POST | `/skills/install` | `install_skill` | `skills.manage` |
| GET | `/skills/sample.zip` | `download_skill_sample` | `see security schema` |
| DELETE | `/skills/{id}` | `uninstall_skill` | `skills.manage` |
| POST | `/skills/{id}/disable` | `disable_skill` | `skills.manage` |
| POST | `/skills/{id}/enable` | `enable_skill` | `skills.manage` |
| GET | `/system/metrics` | `get_system_metrics` | `site.validate` |
| GET | `/system/status` | `get_system_status` | `site.validate` |
| POST | `/theme/activate` | `activate_theme` | `theme.activate` |
| PUT | `/theme/settings` | `save_theme_settings` | `theme.write` |
| POST | `/theme/settings/seal` | `seal_theme_settings` | `theme.write` |
| GET | `/theme/state` | `get_theme_state` | `theme.read` |
| GET | `/themes/active` | `get_served_theme` | `theme.read` |
| POST | `/themes/active/update` | `update_active_theme` | `theme.write` |
| POST | `/themes/install` | `install_theme` | `theme.write` |
| GET | `/themes/installed` | `list_themes_installed` | `theme.read` |
| POST | `/themes/revisions/cleanup` | `cleanup_theme_revisions` | `theme.read` preview / `theme.write` apply |
| GET | `/themes/revisions` | `list_theme_revisions` | `theme.read` |
| POST | `/themes/rollback` | `rollback_theme_revision` | `theme.write` |
| DELETE | `/themes/installed/{name}` | `uninstall_theme` | `theme.write` |
| POST | `/themes/validate` | `validate_theme` | `theme.validate` |
| POST | `/update/apply` | `update_apply` | `extensions.manage` |
| GET | `/update/preflight` | `get_update_preflight` | `extensions.manage` |
| POST | `/update/preflight` | `submit_update_preflight` | `extensions.manage` |
| GET | `/users` | `list_users` | `users.read` |
| POST | `/users` | `create_user` | `users.manage` |
| POST | `/users/direct` | `create_user_with_password` | `users.manage` |
| DELETE | `/users/{userId}` | `delete_user` | `users.manage` |
| PUT | `/users/{userId}` | `update_user` | `users.manage` |
| POST | `/users/{userId}/disable` | `disable_user` | `users.manage` |
| POST | `/users/{userId}/enable` | `enable_user` | `users.manage` |
| DELETE | `/users/{userId}/mfa` | `reset_user_mfa` | `users.manage` |
| PUT | `/users/{userId}/password` | `set_user_password` | `users.manage` |
| POST | `/users/{userId}/roles` | `assign_role` | `roles.manage` |
| DELETE | `/users/{userId}/roles/{roleKey}` | `remove_role` | `roles.manage` |
| POST | `/users/{userId}/sessions/revoke` | `revoke_user_sessions` | `users.manage` |

[Documentation index](index.md)
