# Company starter theme

A deliberately small public authoring example for the delivered company Content Types. It renders registered heading/text/form blocks and declared prose fields, published news/project feeds, menus and Content Tree breadcrumbs. The form script supports only the scalar/consent field set in the supplied contact definition. For a different schema use the declared field contract, including checkbox groups and controlled fields; do not silently coerce them. Card covers and a photographic banner are design work to add using discovered media presets, never guessed URLs.

Run `cms theme validate <this-directory> --cms-version "$PCMS_CORE_VERSION" --json`. Set PCMS_CORE_VERSION to server.cms_version from the target bootstrap. This explicit version checks the intended compatibility; it does not change or attest the installed Core version. For the theme package, keep theme.json at the package root. Activate an installed theme id with `POST /api/v1/theme/activate`; persisted activation selects the runtime theme and overrides the configured catalog/boot seed. Updating an already active same id uses the public update-active command. Use the supplied workflow for installation and activation details.

The fixtures/example.json file is synthetic Theme Contract authoring data required by the theme validator, not a private test harness.
