#!/usr/bin/env bash
# Secret scanner - blocks a credential from ever being committed or shipped.
#
# This exists because a real admin key was once inlined into the shipped JS
# bundle and served publicly; it was caught by a MANUAL sweep, after deploy.
# A one-off sweep only catches the leak you already went looking for, so the
# sweep is now a standing gate.
#
#   scan-secrets.sh --staged     scan what is about to be committed (pre-commit)
#   scan-secrets.sh --tree       scan tracked files in the working tree
#   scan-secrets.sh --path DIR   scan a directory (e.g. a built bundle)
#
# Exit 1 on any finding. Findings print with the value REDACTED - this must
# never be the thing that writes a secret into a CI log.
set -uo pipefail

MODE="${1:---staged}"
TARGET="${2:-}"

# High-signal credential shapes. Deliberately NOT generic words like "token",
# which drown a real finding in field names (`openrouter_api_key` is a form
# field, not a secret) and train people to ignore the check.
PATTERNS=(
  'gk_[a-f0-9]{32,}'                       # this product's own API keys
  'sk-ant-[A-Za-z0-9_-]{20,}'              # Anthropic
  'sk-[A-Za-z0-9]{32,}'                    # OpenAI-style
  'sk-or-v1-[A-Za-z0-9]{20,}'              # OpenRouter
  'ghp_[A-Za-z0-9]{30,}'                   # GitHub PAT
  'gho_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{30,}'
  'AKIA[0-9A-Z]{16}'                       # AWS access key id
  'xox[baprs]-[A-Za-z0-9-]{10,}'           # Slack
  'AIza[0-9A-Za-z_-]{35}'                  # Google API key
  'eyJhbGciOi[A-Za-z0-9._-]{30,}'          # JWT
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'     # PEM private key
  '1//[0-9A-Za-z_-]{30,}'                  # Google OAuth refresh token
)

# Paths that legitimately contain credential-SHAPED strings: the scanner's own
# pattern list, lockfiles, and build output.

EXCLUDE_RX='(scan-secrets\.sh|\.git/|node_modules/|pnpm-lock\.yaml|package-lock\.json|/out/|\.min\.js$|/dist/)'

collect_files() {
  case "$MODE" in
    --staged) git diff --cached --name-only --diff-filter=ACM ;;
    --tree)   git ls-files ;;
    --path)   [ -n "$TARGET" ] || { echo "--path needs a directory" >&2; exit 2; }
              find "$TARGET" -type f ;;
    *)        echo "usage: scan-secrets.sh [--staged|--tree|--path DIR]" >&2; exit 2 ;;
  esac
}

# Values that are PUBLICLY PUBLISHED examples by the vendor itself, so they
# cannot be a real credential. Allowlisted by VALUE, not by file, so a genuine
# key sitting in the same file is still caught.
ALLOW_VALUES=(
  'AKIAIOSFODNN7EXAMPLE'   # AWS's own documented example access-key id
)

is_allowed() {
  local v="$1"
  for a in "${ALLOW_VALUES[@]}"; do [ "$v" = "$a" ] && return 0; done
  return 1
}

found=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  [[ "$f" =~ $EXCLUDE_RX ]] && continue
  # Skip binaries - grep -I would still read them, and a false hit in a PNG is noise.
  file --mime-encoding -b "$f" 2>/dev/null | grep -q binary && continue
  for pat in "${PATTERNS[@]}"; do
    # -o so we can inspect the MATCHED VALUE, not just the line - that is what
    # lets a published example be allowlisted without excusing the whole file.
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      line="${hit%%:*}"
      val="${hit#*:}"
      is_allowed "$val" && continue
      echo "  LEAK  $f:$line  matches /${pat}/  (value redacted)"
      found=1
    done < <(grep -noE "$pat" "$f" 2>/dev/null)
  done
done < <(collect_files)

if [ "$found" -ne 0 ]; then
  cat >&2 <<'MSG'

BLOCKED: a credential-shaped string was found.

If it is a real secret: remove it, rotate it (assume it is burned), and keep
it in an env file or the encrypted store - never in a tracked file or a
built bundle.

If it is genuinely NOT a secret (a fixture, an example, a pattern), make that
unambiguous - a placeholder that cannot be mistaken for a live value - or add
a narrow exclusion to EXCLUDE_RX in this script with a comment saying why.
MSG
  exit 1
fi

echo "secret scan clean ($MODE${TARGET:+ $TARGET})"
