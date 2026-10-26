# Edit a served theme remotely

Use the package cycle when the agent can call the CMS API but has no SSH or server-file access. Keep the package on the agent's machine; the server only stages, validates and applies the uploaded `.pcTheme`. Check the connected target's discovered routes/tools before starting: older compatible installations may not expose this later package-cycle contract.

## Read and export the served basis

Read the theme that the renderer actually serves and its lifecycle generation:

```sh
cms theme active --json
cms theme export --output ./site.pcTheme --json
```

Export requires `theme.read`. It reads one served snapshot, returns the theme id, served and installed-head versions, revision id, `theme_generation`, SHA-256 and size, downloads with that generation and verifies the bytes before an atomic local write. It is read-only and does not create a revision/baseline. Edit locally, keep the same id for an active update and increase the version above `installed_head_version` (not merely `served_version`).

MCP `cms_get_active_theme` returns the served identity/generation. `cms_export_theme` returns only the descriptor; download archive bytes with REST `GET /api/v1/themes/source/package?expected_generation=N` and verify the `X-PCMS-Package-SHA256` header against the descriptor.

## Stage and validate

```sh
cms theme upload ./site.pcTheme --json
cms theme validate-package <package-ref> --json
```

Upload requires `theme.write` and returns an opaque `package_ref`, digest and expiration time (one hour). The reference is not a capability: every request is bound to the actor, site and environment that uploaded it. Validation requires `theme.validate`; it checks identity, version, digest and typed diagnostics, and builds/discards a candidate render stack when a renderer is available. It does not install, activate or change settings.

## Apply with compare-and-swap

Apply the staged package with REST or MCP; the CLI has no staged-reference apply command. Read `theme_generation` immediately before applying and pass that exact value, not `settings_generation`:

```http
POST /api/v1/themes/active/update
Content-Type: application/json

{"package_ref":"<package-ref>","expected_generation":12}
```

Replace the example generation with the value just read from `cms theme active`. The operation needs both `theme.write` and `theme.activate`. MCP equivalent: `cms_update_active_theme({package_ref, expected_generation})`. CAS is checked under the lifecycle lock; a stale generation returns 409 `THEME_REVISION_STALE` and changes nothing. After an ambiguous network response, re-read `cms theme active --json` before retrying. The direct CLI form `cms theme update-active ./site.pcTheme --expected-generation N --environment <env> --yes --json` sends raw package bytes without staging; it remains available when that is the chosen workflow.

For a different theme id, stage and validate the package, install it as an inactive catalog candidate (`cms_install_theme_package` or the corresponding REST operation), then activate with the freshly read `expected_generation`. Installation alone never activates.

REST operations and schemas are in [api-operations.json](api-operations.json). The complete CLI, REST and MCP surface maps are included with the public documentation release.

## Recover a crashed staged upload

If staging/validation/apply returns retryable 503 `THEME_PACKAGE_STORE_BUSY`, retrying or restarting one Web process does not clear the lock. The store uses a cross-process lock to preserve package quotas and never breaks a stale lock automatically.

1. Stop **every Web process sharing this themes root** and wait until they have exited.
2. Remove only `<themes root>/.pcms-theme-packages/.lock`. Keep staged `.pcTheme` files and their `.json` receipts; they expire on their own TTL.
3. Start the Web processes again, then retry the operation. Re-upload if the staged reference has expired.

Do not remove the lock while any process sharing the root can accept uploads. Do not edit theme revisions, active state, catalog or database rows as a workaround.
