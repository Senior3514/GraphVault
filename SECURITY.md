# Security Policy

GraphVault is a privacy- and data-integrity-sensitive application. We take
security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
suspected vulnerability.

- Email: **<TODO: security@your-domain>** (or use GitHub's
  [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  if enabled on the repository).
- Include: a description, steps to reproduce, affected version/commit, and impact.
- We aim to acknowledge within 72 hours and to provide a remediation timeline
  after triage.

Please give us a reasonable window to fix the issue before public disclosure.

## Supported versions

GraphVault is pre-1.0; security fixes target the latest `main`. Pin to a released
tag for stability and update promptly when fixes ship.

## Scope & posture

GraphVault's security model is documented in
[`docs/security-model.md`](docs/security-model.md). Highlights:

- **Local-first, zero telemetry** by default — note content stays on the device
  unless the user explicitly enables a sync server or AI/connector provider.
- **Credentials never live in the browser** — sync auth uses device-bound bearer
  tokens; AI, WebDAV, and S3 credentials are held and encrypted (AES-256-GCM,
  per-user HKDF) on the user's self-hosted server, proxied server-side.
- **Untrusted input is validated** — imports guard against zip-slip / path
  traversal / oversized archives; the URL clipper has an SSRF guard; rendered
  Markdown is sanitized with DOMPurify.
- **Optional at-rest vault encryption** (passphrase-derived AES-256-GCM).

In scope: the web client, the sync/proxy server, the engine, the CLI/MCP, and
the import/connector parsers. Out of scope: third-party providers the user opts
into, and self-hosting misconfiguration (we document the secure defaults).
