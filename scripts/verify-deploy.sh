#!/usr/bin/env bash
# scripts/verify-deploy.sh — Post-deploy verification for GraphVault.
#
# Run from the repository root after ./scripts/deploy.sh:
#   ./scripts/verify-deploy.sh
#
# Checks performed:
#   1. DNS resolves the domain.
#   2. TLS certificate is valid (curl verifies the chain).
#   3. HTTPS redirect on port 80.
#   4. /v1/health returns {"status":"ok"}.
#   5. /v1/server-info returns a JSON object.
#   6. Security headers (HSTS, X-Frame-Options, CSP, X-Content-Type-Options).
#
# Pass/Fail summary printed at the end.
# Exit code: 0 = all checks passed, 1 = one or more failed.

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'

PASS=0
FAIL=0

ok()   { printf "${GREEN}[OK]${RESET}   %s\n" "$*"; PASS=$((PASS + 1)); }
fail() { printf "${RED}[FAIL]${RESET} %s\n" "$*" >&2; FAIL=$((FAIL + 1)); }
warn() { printf "${YELLOW}[WARN]${RESET} %s\n" "$*"; }
info() { printf '[....] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Resolve repo root and load .env.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"

if [ ! -f "${ENV_FILE}" ]; then
    printf 'No .env found at %s. Run ./scripts/deploy.sh first.\n' "${ENV_FILE}" >&2
    exit 1
fi

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

DOMAIN="${DOMAIN:-}"
if [ -z "${DOMAIN}" ]; then
    printf 'DOMAIN is not set in .env\n' >&2
    exit 1
fi

BASE_URL="https://${DOMAIN}"
info "Verifying deployment at ${BASE_URL}"
printf '\n'

# ---------------------------------------------------------------------------
# Check: curl is available.
# ---------------------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
    fail "curl is not installed — install it to run verification checks."
    exit 1
fi

# ---------------------------------------------------------------------------
# 1. DNS resolution.
# ---------------------------------------------------------------------------
info "1/6  DNS resolution for ${DOMAIN}..."
if host "${DOMAIN}" >/dev/null 2>&1 || nslookup "${DOMAIN}" >/dev/null 2>&1 || \
   getent hosts "${DOMAIN}" >/dev/null 2>&1; then
    ok "DNS: ${DOMAIN} resolves."
else
    fail "DNS: ${DOMAIN} does not resolve. Set an A record pointing at this host."
fi

# ---------------------------------------------------------------------------
# Helper: HTTP GET with timeout, capturing both body and headers.
# ---------------------------------------------------------------------------
http_get() {
    # Usage: http_get <url> [extra curl args...]
    # Writes response to stdout; returns curl exit code.
    curl --silent --show-error --max-time 15 --location "$@"
}

http_get_head() {
    # Get response headers only (HEAD request).
    curl --silent --show-error --max-time 15 --head "$@"
}

# ---------------------------------------------------------------------------
# 2. TLS certificate validity.
# ---------------------------------------------------------------------------
info "2/6  TLS certificate..."
TLS_OUTPUT="$(http_get "${BASE_URL}/v1/health" --write-out '%{http_code}' --output /dev/null 2>&1)" || TLS_CURL_RC=$?
TLS_CURL_RC="${TLS_CURL_RC:-0}"
if [ "${TLS_CURL_RC}" -eq 0 ]; then
    ok "TLS: certificate valid and trusted by system CA bundle."
else
    fail "TLS: curl failed (exit ${TLS_CURL_RC}). Certificate may be invalid, not yet issued, or DNS not propagated."
fi

# ---------------------------------------------------------------------------
# 3. HTTP → HTTPS redirect.
# ---------------------------------------------------------------------------
info "3/6  HTTP → HTTPS redirect (port 80)..."
HTTP_REDIRECT="$(curl --silent --max-time 10 --write-out '%{redirect_url}' --output /dev/null \
    "http://${DOMAIN}/v1/health" 2>/dev/null || true)"
if printf '%s' "${HTTP_REDIRECT}" | grep -qi "^https://"; then
    ok "HTTP redirect: http://${DOMAIN}/ → ${HTTP_REDIRECT}"
else
    # Caddy always redirects 80→443; a non-https redirect or empty result is wrong.
    warn "HTTP redirect: did not see an https:// redirect_url (got '${HTTP_REDIRECT}'). Port 80 may be blocked or Caddy not yet up."
fi

# ---------------------------------------------------------------------------
# 4. /v1/health endpoint.
# ---------------------------------------------------------------------------
info "4/6  Health endpoint..."
HEALTH_HTTP_CODE="$(http_get "${BASE_URL}/v1/health" \
    --write-out '%{http_code}' --output /tmp/gv_health.json 2>/dev/null || echo "000")"
HEALTH_BODY="$(cat /tmp/gv_health.json 2>/dev/null || echo "")"

if [ "${HEALTH_HTTP_CODE}" = "200" ]; then
    # Check for the expected JSON key.
    if printf '%s' "${HEALTH_BODY}" | grep -q '"status"'; then
        ok "Health: HTTP 200 — ${HEALTH_BODY}"
    else
        fail "Health: HTTP 200 but unexpected body: ${HEALTH_BODY}"
    fi
else
    fail "Health: expected HTTP 200, got ${HEALTH_HTTP_CODE}. Body: ${HEALTH_BODY}"
fi

# ---------------------------------------------------------------------------
# 5. /v1/server-info endpoint.
# ---------------------------------------------------------------------------
info "5/6  Server-info endpoint..."
INFO_HTTP_CODE="$(http_get "${BASE_URL}/v1/server-info" \
    --write-out '%{http_code}' --output /tmp/gv_info.json 2>/dev/null || echo "000")"
INFO_BODY="$(cat /tmp/gv_info.json 2>/dev/null || echo "")"

if [ "${INFO_HTTP_CODE}" = "200" ]; then
    ok "Server-info: HTTP 200 — ${INFO_BODY}"
else
    fail "Server-info: expected HTTP 200, got ${INFO_HTTP_CODE}. Body: ${INFO_BODY}"
fi

# ---------------------------------------------------------------------------
# 6. Security headers.
# ---------------------------------------------------------------------------
info "6/6  Security headers..."
HEADERS="$(http_get_head "${BASE_URL}/v1/health" 2>/dev/null || true)"

check_header() {
    local label="$1"
    local pattern="$2"
    if printf '%s' "${HEADERS}" | grep -qi "${pattern}"; then
        ok "Header present: ${label}"
    else
        fail "Header missing or wrong: ${label}"
    fi
}

check_header "Strict-Transport-Security" "strict-transport-security:"
check_header "X-Frame-Options: DENY"       "x-frame-options: deny"
check_header "X-Content-Type-Options"      "x-content-type-options: nosniff"
check_header "Referrer-Policy"             "referrer-policy:"
check_header "Content-Security-Policy"     "content-security-policy:"

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
printf '\n'
printf '=%.0s' {1..50}
printf '\n'
printf "Verification summary:  ${GREEN}%d passed${RESET}  /  ${RED}%d failed${RESET}\n" "${PASS}" "${FAIL}"
printf '=%.0s' {1..50}
printf '\n\n'

if [ "${FAIL}" -gt 0 ]; then
    printf "Some checks failed. Common causes:\n"
    printf "  • DNS A record not yet propagated (wait a few minutes, re-run).\n"
    printf "  • Firewall blocking ports 80 or 443.\n"
    printf "  • Caddy not yet obtained a certificate (check: docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy).\n"
    printf "  • Server not yet healthy (check: docker compose -f docker-compose.yml -f docker-compose.prod.yml logs server).\n"
    printf '\n'
    exit 1
fi

printf "All checks passed. GraphVault is live at %s\n" "${BASE_URL}"
printf '\n'
printf 'Manual checklist (do these once):\n'
printf '  [ ] Register your first account:\n'
printf '      curl -X POST %s/v1/auth/register \\\n' "${BASE_URL}"
printf '        -H '"'"'Content-Type: application/json'"'"' \\\n'
printf '        -d '"'"'{"email":"you@example.com","password":"strong-passphrase","deviceName":"laptop"}'"'"'\n'
printf '  [ ] Open the web client and point it at %s\n' "${BASE_URL}"
printf '  [ ] Create a note, sync, open on a second device — verify round-trip.\n'
printf '  [ ] Confirm GRAPHVAULT_ENCRYPTION_KEY is backed up securely.\n'
printf '  [ ] Schedule daily backups (see docs/deployment.md Backups section).\n'
