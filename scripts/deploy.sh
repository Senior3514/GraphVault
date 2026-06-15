#!/usr/bin/env bash
# scripts/deploy.sh — One-command production deploy for GraphVault.
#
# Run from the repository root:
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh
#
# What it does:
#   1. Checks that Docker and docker compose are available.
#   2. Creates .env from docker/env.example if .env does not exist.
#   3. Validates that the required production variables are set.
#   4. Brings up the full TLS stack (server + postgres + caddy) in the background.
#   5. Prints the health-check URL and next steps.
#
# Exit codes: 0 = success, non-zero = something needs fixing.

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf '\033[0;32m[deploy]\033[0m %s\n' "$*"; }
warn()  { printf '\033[0;33m[deploy]\033[0m %s\n' "$*" >&2; }
error() { printf '\033[0;31m[deploy]\033[0m %s\n' "$*" >&2; }
die()   { error "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Resolve repo root (the script can be called from anywhere).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

info "GraphVault production deployer"
info "Repository root: ${REPO_ROOT}"

# ---------------------------------------------------------------------------
# 1. Pre-flight: Docker and compose plugin.
# ---------------------------------------------------------------------------
info "Checking prerequisites..."

if ! command -v docker >/dev/null 2>&1; then
    die "Docker is not installed or not in PATH. Install it from https://docs.docker.com/get-docker/"
fi

DOCKER_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
if [ -z "${DOCKER_VERSION}" ]; then
    die "Docker daemon is not running. Start it with:  sudo systemctl start docker"
fi
info "Docker ${DOCKER_VERSION} found."

if ! docker compose version >/dev/null 2>&1; then
    die "Docker Compose plugin (v2) not found. Run: sudo apt-get install docker-compose-plugin"
fi
COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || echo 'unknown')"
info "Docker Compose ${COMPOSE_VERSION} found."

# ---------------------------------------------------------------------------
# 2. Bootstrap .env if absent.
# ---------------------------------------------------------------------------
ENV_FILE="${REPO_ROOT}/.env"
ENV_EXAMPLE="${REPO_ROOT}/docker/env.example"

if [ ! -f "${ENV_FILE}" ]; then
    warn ".env not found — copying docker/env.example to .env"
    cp "${ENV_EXAMPLE}" "${ENV_FILE}"
    printf '\n'
    warn "IMPORTANT: Before re-running this script, open .env and set:"
    warn "  DOMAIN                   — your public hostname (e.g. notes.example.com)"
    warn "  ACME_EMAIL               — Let's Encrypt e-mail (e.g. you@example.com)"
    warn "  POSTGRES_PASSWORD        — a strong random password"
    warn "  GRAPHVAULT_CORS_ORIGIN   — your web-client origin (e.g. https://notes.example.com)"
    warn "  GRAPHVAULT_ENCRYPTION_KEY— base64 32-byte key:"
    warn "    node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    warn "  (Back up GRAPHVAULT_ENCRYPTION_KEY separately — losing it makes encrypted blobs unrecoverable)"
    printf '\n'
    die ".env created. Edit it, then re-run this script."
fi

info ".env found."

# ---------------------------------------------------------------------------
# 3. Validate required production variables.
# ---------------------------------------------------------------------------
info "Validating required variables in .env..."

# Source .env safely (skip comment/blank lines, no subshells needed).
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

MISSING=()

check_var() {
    local var_name="$1"
    local value="${!var_name:-}"
    if [ -z "${value}" ]; then
        MISSING+=("${var_name}")
    fi
}

check_var DOMAIN
check_var ACME_EMAIL
check_var POSTGRES_PASSWORD

# Warn (don't block) on insecure defaults.
if [ "${POSTGRES_PASSWORD:-}" = "change-me-to-a-strong-password" ] || \
   [ "${POSTGRES_PASSWORD:-}" = "graphvault" ]; then
    warn "POSTGRES_PASSWORD is set to an insecure default. Please change it."
fi

if [ "${GRAPHVAULT_CORS_ORIGIN:-*}" = "*" ]; then
    warn "GRAPHVAULT_CORS_ORIGIN is '*' (open). Set it to your web-client origin in production."
fi

if [ -z "${GRAPHVAULT_ENCRYPTION_KEY:-}" ]; then
    warn "GRAPHVAULT_ENCRYPTION_KEY is unset. WebDAV/S3/AI credentials will be lost on restart."
    warn "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
fi

if [ "${#MISSING[@]}" -gt 0 ]; then
    error "The following required variables are not set in .env:"
    for v in "${MISSING[@]}"; do
        error "  ${v}"
    done
    die "Set them in .env and re-run."
fi

info "All required variables present."

# ---------------------------------------------------------------------------
# 4. Build and start the production stack.
# ---------------------------------------------------------------------------
info "Bringing up the production stack (this may take a few minutes on first run)..."
docker compose \
    -f "${REPO_ROOT}/docker-compose.yml" \
    -f "${REPO_ROOT}/docker-compose.prod.yml" \
    up -d --build

info "Stack is up. Waiting for the server health check..."

# Poll /v1/health (via Docker network, loopback approach: exec into server).
MAX_WAIT=60
WAITED=0
until docker compose \
        -f "${REPO_ROOT}/docker-compose.yml" \
        -f "${REPO_ROOT}/docker-compose.prod.yml" \
        exec -T server \
        node -e "fetch('http://127.0.0.1:4000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
        >/dev/null 2>&1; do
    if [ "${WAITED}" -ge "${MAX_WAIT}" ]; then
        warn "Server did not become healthy within ${MAX_WAIT}s."
        warn "Check logs: docker compose -f docker-compose.yml -f docker-compose.prod.yml logs server"
        break
    fi
    printf '.'
    sleep 2
    WAITED=$((WAITED + 2))
done
printf '\n'

# ---------------------------------------------------------------------------
# 5. Print verification info.
# ---------------------------------------------------------------------------
printf '\n'
info "Deployment complete."
printf '\n'
printf '  Health check URL:  https://%s/v1/health\n' "${DOMAIN}"
printf '  Server info URL:   https://%s/v1/server-info\n' "${DOMAIN}"
printf '\n'
printf 'Next steps:\n'
printf '  1. Verify TLS:    ./scripts/verify-deploy.sh\n'
printf '  2. Register user: curl -X POST https://%s/v1/auth/register \\\n' "${DOMAIN}"
printf '                      -H '"'"'Content-Type: application/json'"'"' \\\n'
printf '                      -d '"'"'{"email":"you@example.com","password":"strong-passphrase","deviceName":"laptop"}'"'"'\n'
printf '  3. See docs/deployment.md for backup and upgrade procedures.\n'
printf '\n'
info "Run logs:  docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f"
