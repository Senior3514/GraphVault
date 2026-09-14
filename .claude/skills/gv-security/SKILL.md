---
name: gv-security
description: >-
  Adversarially audit and fix security vulnerabilities in GraphVault's server and
  shared code - SSRF, credential leakage, broken authorization, input validation,
  and abuse of public endpoints. Use before shipping any server/proxy/auth change,
  when reviewing storage proxies / AI BFF / snapshot store / inbox tokens, when
  asked to "do a security review / pentest this / check for vulns", or as a
  periodic background sweep. Write a demonstrating test for every real finding.
---

# Security hunt & fix

GraphVault is security- and data-sensitive. This skill thinks like an attacker
against the server surface and proves each finding.

## Surfaces to scrutinize

- `apps/server/src/services/**` - WebDAV/S3/Azure/GCS proxies, AI BFF, clip.
- `apps/server/src/routes/**` - auth, vaults, sync, config, snapshots, inbox.
- `apps/server/src/services/ssrf.ts` (`guardedFetch`) - the egress boundary.
- `packages/shared/src/**` - zod schemas (the input-validation boundary).

## Threat checklist

- **SSRF**: every outbound fetch goes through `guardedFetch` (DNS-pinned, blocks
  loopback/RFC-1918/link-local/CGNAT/IPv6-ULA/cloud-metadata, re-checks on each
  redirect hop, unwraps IPv4-mapped IPv6). Streaming preserves the pin. No raw
  `fetch` to user-supplied hosts.
- **Path traversal**: proxy path params are decoded by the framework - guard
  against literal AND percent-/double-encoded `..` (decode iteratively until
  stable, reject `%2e`/`%252e`). Apply at both the schema and service layers.
- **Credential non-disclosure**: secrets are AES-256-GCM at rest with per-user
  HKDF keys; config GETs return only non-secret status (`keySet`, never the key);
  keys are redacted from logs and error messages.
- **Authorization**: every vault/blob/config/snapshot route enforces
  `requireOwned`; cross-user access returns 403; sync enforces device binding.
- **Public-endpoint abuse**: snapshot store off by default; size/count caps,
  TTL sweep, delete-token stored only as a hash with constant-time compare,
  strict id format; inbox tokens hashed + vault-scoped + rate-limited.
- **Input validation**: all external input parsed by shared zod schemas; size
  caps on bodies/uploads; rendered Markdown sanitized via DOMPurify.

## Method

1. For each *real* vuln, write a test that **demonstrates exploitability first**
   (it fails), then apply the fix (it passes). Belt-and-suspenders where cheap.
2. Confirm solid areas explicitly instead of inventing findings.
3. No secrets in code/logs/README. Verify with gv-gauntlet; land with gv-ship.
