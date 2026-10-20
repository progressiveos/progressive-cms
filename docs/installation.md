# Installation

This procedure installs a fresh Progressive CMS host from an official release. It is a privileged operator task; it does not require an AI agent. Do not run the fresh-install command against a customer installation or use it as an update procedure.

## 1. Check the target

Read the exact [requirements](requirements.md). The accepted deployment target is Ubuntu 26.04 with systemd. Choose one proxy profile and decide whether PostgreSQL will run locally or on a separately prepared database host. For a public site, prepare DNS, persistent media/database storage, a recovery-capable backup destination and a TLS plan before enabling authoring.

The installer needs root to provision packages, systemd units, configuration and secrets, database access and the owner account. Do not give an authoring agent root credentials, PostgreSQL credentials or unrestricted host access.

## 2. Download and verify the release

From the project's official GitHub Releases page, download the **installable release ZIP** and its matching `.sha256` sidecar. Do not use GitHub's automatically generated source archive. Save the pair in the same directory, then run:

```sh
ARTIFACT="$HOME/Downloads/progressive-cms-release.zip"
cd "$(dirname "$ARTIFACT")"
sha256sum -c "$(basename "$ARTIFACT").sha256"
unzip -Z1 "$ARTIFACT" | sed -n '1,40p'
```

Locate and read `build-metadata.json` from the archive to obtain its exact version and release id. Compare those values with the release page and set `RELEASE_VERSION` to the manifest's version; do not infer it from a source branch or a development package.

```sh
METADATA_PATH="$(unzip -Z1 "$ARTIFACT" | awk '/(^|\/)build-metadata\.json$/ { print; exit }')"
test -n "$METADATA_PATH"
unzip -p "$ARTIFACT" "$METADATA_PATH"
```

## 3. Locate the installer

Extract the release's deployment assets to a private temporary directory and inspect the installer's supported options:

```sh
WORK_DIR="$(mktemp -d)"
unzip -q "$ARTIFACT" '*/deploy/*' -d "$WORK_DIR"
INSTALLER="$(find "$WORK_DIR" -type f -path '*/deploy/scripts/install-release.sh' -print -quit)"
test -n "$INSTALLER"
sudo bash "$INSTALLER" --help
```

Keep the ZIP unchanged. The installer reads deployment templates adjacent to itself and installs the exact verified archive supplied with `--artifact`.

## 4. Install on a fresh host

Choose exactly one profile. Use `local-nginx` when Nginx and the site run on the same host. The installer configures the Nginx virtual host, but TLS is a separate Certbot step; complete it for the real DNS name before sending login credentials. Use `external-rp` when a separate reverse proxy terminates TLS. The application's `--http-host` must be reachable from that proxy, and `--trusted-proxy-edge` must name the immediate proxy peer Web actually sees. Never trust a public client-supplied forwarding header or use a wildcard trusted-proxy range.

For local Nginx with PostgreSQL on the same host:

```sh
RELEASE_VERSION='<version from build-metadata.json>'
sudo bash "$INSTALLER" \
  --site-host cms.example.com \
  --profile local-nginx \
  --pg local \
  --artifact "$ARTIFACT" \
  --admin-email owner@example.com \
  --expect-version "$RELEASE_VERSION" \
  --yes
```

For an external TLS reverse proxy with PostgreSQL on the application host:

```sh
RELEASE_VERSION='<version from build-metadata.json>'
sudo bash "$INSTALLER" \
  --site-host cms.example.com \
  --profile external-rp \
  --http-host 192.0.2.20 \
  --trusted-proxy-edge 198.51.100.7 \
  --pg local \
  --artifact "$ARTIFACT" \
  --admin-email owner@example.com \
  --expect-version "$RELEASE_VERSION" \
  --yes
```

The addresses in the example are documentation placeholders. Replace them with the private application listen address and the actual immediate proxy peer. For a remote PostgreSQL server, prepare its database and least-privilege application role first; use the installer's `--pg remote` options and a mode-restricted password file. Never place a database password in shell history or command arguments. The interactive installer asks for the same core choices if you omit `--yes` and the corresponding flags.

## 5. Finish TLS and owner setup

The installer creates the owner account and writes its one-time password to `/root/owner-bootstrap.txt` with root-only permissions. Read that value through a secure operator session; do not paste it into an agent prompt, shell transcript, issue, or commit. Complete TLS for the public hostname, sign in at `https://<site-host>/admin`, and immediately change the bootstrap password.

Run the local diagnostics as an operator:

```sh
sudo cms config validate --json
sudo cms doctor
```

Then verify HTTPS, DNS, the expected proxy trust, `cms agent bootstrap --json` for the connected authoring account, and public readiness at `/health/ready`. The owner account is for administration. Before an agent authors content, create a separate Service Account scoped to the intended site and environment with only the scopes required by the task. See [Agent Skills](agent-skills.md) and [Security](security.md).

## 6. Build the first editable site

Follow [First Site](first-site.md) or use the self-contained [Site Builder Skill](skills/progressive-cms-site-builder/SKILL.md). A fresh install has the built-in `folder` Content Type; declare page and article types through the documented schema API before creating those entries. If the schema response returns `restart_required`, have the operator perform the bounded Web and Worker restart and rediscover the effective types.

Install and activate the theme through the supported theme lifecycle operations. `themes.renderDir` is a catalog/boot seed; a persistent active theme takes precedence during rendering. Ordinary theme activation does not require changing `themes.renderDir` or restarting Web.

Use the normal draft → validate → preview → seal → authorized publish workflow. Verify the public route and that an editor can change and republish a revision in Admin. See [Operations](operations.md) for backup, update and recovery procedures.

[Documentation index](index.md)
