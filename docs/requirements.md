# Requirements

Contract owner: Core operations.

The inspected source declares Node.js `>=24.21.0 <25` and npm `>=11.6.0`. Do not infer runtime requirements from the installer merely checking Node major 24. The final release manifest must agree with these bounds.

The native installer uses Ubuntu/Debian package tooling and systemd. It supports local PostgreSQL or an explicitly configured external database, and `local-nginx` or `external-rp` proxy profiles. Ubuntu 26.04 is the current deployment target; other OS/architecture combinations require their own acceptance. A tested PostgreSQL or Nginx minimum version has not been established for this documentation candidate.

Provide DNS, TLS termination, persistent database/media/quarantine storage, a secret store, and a separate recoverable backup destination. See [Security](security.md).

## Evidence boundary

Core-dev reports PostgreSQL 18.6 exercised for the baseline handoff recorded in [compatibility history](compatibility.md); this is a tested version, not proof that every older/newer PostgreSQL is supported. Native installer tooling assumes the selected Ubuntu/systemd environment. Nginx is required only for its local proxy profile; an external reverse proxy uses its own approved TLS configuration. Confirm the release's platform/architecture metadata and native dependencies before installation.

A content agent uses ordinary scoped API credentials. Installation/provisioning is a distinct operator action. For Journey QA on a prepared instance, agree on bounded schema reload and initial theme activation rather than supplying root/DB access.

[Documentation index](index.md)
