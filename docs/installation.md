# Installation

This procedure installs a fresh Progressive CMS host from an official release. It is a privileged operator task; it does not require an AI agent. Do not run the fresh-install command against a customer installation or use it as an update procedure.

## 1. Check the target

Read the exact [requirements](requirements.md). The accepted deployment target is Ubuntu 26.04 with systemd. Choose one proxy profile and decide whether PostgreSQL will run locally or on a separately prepared database host. For a public site, point DNS A/AAAA records at the public endpoint, confirm inbound TCP 80 and 443 reach that endpoint, prepare persistent media/database storage and a recovery-capable backup destination, and finish trusted TLS before sending credentials or enabling authoring. Remove an unused AAAA record rather than leaving IPv6 pointed elsewhere.

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
SITE_HOST='cms.example.com'
sudo bash "$INSTALLER" \
  --site-host "$SITE_HOST" \
  --profile local-nginx \
  --pg local \
  --artifact "$ARTIFACT" \
  --admin-email owner@example.com \
  --expect-version "$RELEASE_VERSION" \
  --yes
```

Back up the installed Nginx configuration. Install Certbot using its [current official Nginx instructions](https://certbot.eff.org/instructions?ws=nginx) for the host OS, then issue and install the public certificate and HTTP redirect:

```sh
sudo certbot --nginx --redirect -d "$SITE_HOST"
sudo certbot renew --dry-run
curl --fail --silent --show-error --output /dev/null "https://$SITE_HOST/health/ready"
curl --silent --show-error --output /dev/null --write-out 'HTTP %{http_code} → %{redirect_url}\n' --max-redirs 0 "http://$SITE_HOST/health/ready"
```

The HTTPS probe must validate the certificate chain and hostname; the HTTP probe must return a redirect to HTTPS. If the proxy is external, terminate TLS there with its supported certificate service and verify the public origin and upstream trust before login; do not install a second competing TLS terminator on the CMS host.

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

### Isolated QA without public DNS

This is only for a disposable, isolated `local-nginx` test target; never use a private test CA for a public site. Use the same reserved `.test` hostname as the installer `--site-host`, issue a short-lived test CA and leaf certificate whose SAN matches that hostname, and keep the leaf key root-only. Delete the CA private key after signing. Install the CA only in the disposable target or a dedicated test-client trust store. Do not disable certificate checks, change the host machine's `/etc/hosts`, or alter global DNS, proxy or Incus network settings.

Run as root inside the isolated target after installation. The example uses OpenSSL, Nginx and the existing application proxy snippet:

```sh
SITE_HOST='cms.example.test'
TLS_DIR='/etc/nginx/pcms-test-tls'
install -d -m 700 "$TLS_DIR"
openssl req -x509 -newkey rsa:3072 -nodes -days 7 \
  -keyout "$TLS_DIR/test-ca.key" -out "$TLS_DIR/test-ca.crt" \
  -subj '/CN=Progressive CMS isolated test CA' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.csr" \
  -subj "/CN=$SITE_HOST"
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n' "$SITE_HOST" > "$TLS_DIR/server.ext"
openssl x509 -req -in "$TLS_DIR/server.csr" \
  -CA "$TLS_DIR/test-ca.crt" -CAkey "$TLS_DIR/test-ca.key" -CAcreateserial \
  -out "$TLS_DIR/server.crt" -days 7 -sha256 -extfile "$TLS_DIR/server.ext"
chmod 600 "$TLS_DIR/server.key" "$TLS_DIR/test-ca.key"
rm "$TLS_DIR/test-ca.key" "$TLS_DIR/server.csr" "$TLS_DIR/server.ext" "$TLS_DIR/test-ca.srl"
install -m 644 "$TLS_DIR/test-ca.crt" /usr/local/share/ca-certificates/pcms-test-ca.crt
update-ca-certificates
if ! grep -Fq " $SITE_HOST" /etc/hosts; then printf '127.0.0.1 %s\n' "$SITE_HOST" >> /etc/hosts; fi
cat > /etc/nginx/sites-available/pcms-test-tls.conf <<NGINX
server {
    listen 443 ssl;
    server_name $SITE_HOST;
    ssl_certificate $TLS_DIR/server.crt;
    ssl_certificate_key $TLS_DIR/server.key;
    client_max_body_size 35m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        include /etc/nginx/snippets/progressive-cms-proxy.conf;
    }
}
NGINX
ln -sfn /etc/nginx/sites-available/pcms-test-tls.conf /etc/nginx/sites-enabled/pcms-test-tls.conf
nginx -t && systemctl reload nginx
curl --fail --resolve "$SITE_HOST:443:127.0.0.1" --cacert "$TLS_DIR/test-ca.crt" "https://$SITE_HOST/health/ready"
export NODE_EXTRA_CA_CERTS="$TLS_DIR/test-ca.crt"
export PCMS_API_URL="https://$SITE_HOST"
```

For a client outside the target, copy only `test-ca.crt` through the approved test channel and use `curl --resolve "$SITE_HOST:443:<target-private-ip>" --cacert test-ca.crt`; a browser needs the same host mapping and CA in a dedicated test profile. Do not add test trust to the host-wide store. The generated test vhost is HTTPS-only; keep owner and authoring requests on that origin.

## 5. Finish TLS and owner setup

The installer creates the bootstrap OWNER and writes its one-time password to `/root/owner-bootstrap.txt` with root-only permissions. Read that value through a secure operator session; do not paste it into an agent prompt, shell transcript, issue, or commit. Complete and verify TLS first, sign in at `https://<site-host>/admin`, and immediately change the bootstrap password. OWNER is for initial setup and privileged administration; never give its password or a `tokens.manage` credential to an authoring agent.

Run the local diagnostics as an operator:

```sh
sudo cms config validate --json
sudo cms doctor
```

Then verify HTTPS, DNS, the expected proxy trust, `cms agent bootstrap --json` for the connected authoring account, and public readiness at `/health/ready`. In Admin, open **Users & Access → Service accounts**, create a named account for the authoring task, and issue a short-lived token with only the scopes the task needs. Store the one-time token value in the approved secret channel. A Service Account token is the machine identity; it is not a browser login. The current token wizard does not expose the REST token's optional `site_key` and `environment` restrictions. If those hard boundaries are required, issue the token through the documented [`create_access_token` REST operation](rest-api-map.md#create_access_token), include both fields, and confirm them in the resulting token record. Never assume request headers create a token restriction. See [Agent Skills](agent-skills.md) and [Security](security.md).

## 6. Build the first editable site

Follow [First Site](first-site.md) or use the self-contained [Site Builder Skill](skills/progressive-cms-site-builder/SKILL.md). A fresh install has the built-in `folder` Content Type; declare page and article types through the documented schema API before creating those entries. If the schema response returns `restart_required`, have the operator perform the bounded Web and Worker restart and rediscover the effective types.

Install and activate the theme through the supported theme lifecycle operations. `themes.renderDir` is a catalog/boot seed; a persistent active theme takes precedence during rendering. Ordinary theme activation does not require changing `themes.renderDir` or restarting Web.

Use the normal draft → validate → preview → seal → authorized publish workflow. Verify the public route and that an editor can change and republish a revision in Admin. See [Operations](operations.md) for backup, update and recovery procedures.

[Documentation index](index.md)
