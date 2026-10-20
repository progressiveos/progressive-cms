# Installation

Contract owner: Core installer.

Use an approved immutable release ZIP and its SHA-256 sidecar. Check the downloaded bytes before extracting anything. Inspect the ZIP inventory and locate its `deploy/scripts/install-release.sh`; do not assume an archive prefix from a previous release.

Run the installer on an authorized fresh host. Its interactive mode asks for domain, PostgreSQL mode, proxy profile, owner email and artifact path. The installer provisions configuration, secrets, systemd services, database migrations and an owner account. It is a privileged operation, not a command to run in a developer checkout.

New production configurations default `registry.baseUrl` to `https://my.p-cms.ru`; the installer accepts an explicit `--registry-url` override. Account/instance tokens remain secret slots. Updating an existing installation preserves its Registry and proxy configuration, so a new default does not repair an older endpoint automatically. For external reverse proxy installs, `--trusted-proxy-edge` must identify the actual immediate proxy peer seen by Web. The public site IP or an unverified forwarded header is not a substitute for that trust decision.

After installation, verify DNS/TLS, log in to Admin, change the bootstrap password and check configuration and runtime:

```sh
cms config validate --json
cms doctor
cms capabilities --json
```

`cms capabilities` reports the local compiled catalogue; use `cms agent bootstrap --json` for the connected actor and target. These commands describe installed-runtime checks; this documentation pass is not itself a fresh installation acceptance record. Follow [Configuration](configuration.md) before authoring a site.

## Install procedure and separate acceptance

Receive the exact release ZIP, independently pinned SHA-256, manifest and install instructions from Release Guardian. Run `sha256sum -c <artifact>.sha256` against the accepted sidecar, inventory the ZIP, then extract its installer into an isolated directory. Locate `deploy/scripts/install-release.sh` beneath the recorded archive prefix. Run the installer’s interactive mode on the authorized fresh host; choose local-nginx or external-rp and local/external PostgreSQL deliberately.

The native installer is privileged: it provisions packages, database roles, service account, configuration/secrets, migrations and services. Those permissions are not needed for ordinary CMS authoring. Do not run it against an existing customer instance as a documentation smoke test.

After installation, confirm the installed build metadata, `cms doctor`, login over HTTPS, changed bootstrap password, actual proxy trust, preview readiness, persistent media/quarantine and an operator-owned recovery path. An installed-CMS Journey and a clean-install rehearsal are different records. Source tests alone do not establish clean-install acceptance for the target release.

[Documentation index](index.md)
