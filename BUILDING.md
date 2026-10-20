# Build from public source

Use Node.js >=24.21.0 <25 and npm >=11.6.0 on Linux. Clone progressiveos/progressive-cms and progressiveos/progressive-cms-extensions into sibling directories with those exact basenames. Fetch the extension package tags.

```sh
npm ci
npm run prepare:extensions
npm run typecheck
npm run build
```

The supply step builds only version-pinned extension tags and verifies both archive and content digests. The Extensions packer preserves canonical Git file modes, independent of the caller umask; do not regenerate the trusted lock to compensate for a packaging mismatch. Shop, Registry credentials and private repositories are unnecessary.

For tests, configure PCMS_TEST_DATABASE_URL in a private .env using a disposable PostgreSQL server with CREATEDB permission; npm test creates and removes isolated test databases. Run npm run format:check, npm run lint and npm test. Browser smoke uses npm run test:browser.

Build a development ZIP with npm run release -- --require-clean --docs-dir docs --out "$HOME/dev-builds". This does not publish or install a release. A release ZIP contains production dependencies; source tests and development tools are not runtime payload. See docs for the native installer.
