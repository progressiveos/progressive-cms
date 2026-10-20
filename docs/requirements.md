# Requirements

Contract owner: Core operations.

The accepted release manifest declares Node.js `>=24.21.0 <25` and npm `>=11.6.0`. The install candidate reported Node.js 24.22.0 and npm 11.19.1. Do not infer runtime requirements from the installer merely checking Node major 24; read the manifest shipped with the exact release.

The native installer uses Ubuntu/Debian package tooling and systemd. It supports local PostgreSQL or an explicitly configured external database, and `local-nginx` or `external-rp` proxy profiles. Ubuntu 26.04 is the accepted deployment target; other OS/architecture combinations require their own acceptance. The release-candidate migration matrix passed on PostgreSQL 14.24, 15.19, 16.15, 17.11 and 18.6. These are tested versions, not a claim that every minor release or operating-system combination has been accepted. Nginx is required only for the `local-nginx` profile; no minimum version is published here.

Provide DNS, TLS termination, persistent database/media/quarantine storage, a secret store, and a separate recoverable backup destination. See [Security](security.md).

## Evidence boundary

The exact installation candidate was accepted on Ubuntu 26.04.1 with PostgreSQL 18.6; the migration matrix also passed on the versions above. Nginx is required only for the local proxy profile; an external reverse proxy uses its own approved TLS configuration. Confirm the exact release's platform/architecture metadata and native dependencies before installation.

A content agent uses ordinary scoped API credentials. Installation/provisioning is a distinct operator action. A new installation begins with the built-in `folder` Content Type; declare any additional types through the supported schema API and honor `restart_required`. Persistent theme activation uses the supported theme lifecycle API; it does not require changing `themes.renderDir` or restarting Web.

[Documentation index](index.md)
