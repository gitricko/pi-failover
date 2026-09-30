#!/usr/bin/env bash
# pi-failover host-package and version checker.
#
# Three checks:
#
#   1. Manifest hygiene (offline, deterministic). Host-provided packages must be
#      declared in peerDependencies with a "*" range and must NOT appear in
#      dependencies. This mirrors Pi's own collectExtensionPackageWarnings() in
#      pi-coding-agent/dist/core/resource-loader.js and guards against the bug in
#      issue #7 (npm installed a second copy of the host's packages).
#
#   2. Docs consistency (offline). The README "PI Agent vX" badge and the
#      Prerequisites "Pi CLI ... X+" line must match the devDependencies pin —
#      the version CI actually tests against. A mismatch is a repo bug.
#
#   3. Host version drift (network, advisory). Reports the pi version running in
#      this container, the version pinned in devDependencies, and the latest
#      published version. Never fails unless --strict is passed.
#
# Usage:
#   scripts/check-pi-version.sh            # guard fails, drift warns (CI default)
#   scripts/check-pi-version.sh --strict   # drift also fails (local pre-commit)
#
# Exit codes: 0 = ok (drift is advisory), 1 = violation or (strict) drift.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PACKAGE_JSON="${PROJECT_ROOT}/package.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[check-pi]${NC} $*"; }
info() { echo -e "${CYAN}[check-pi]${NC} $*"; }
warn() { echo -e "${YELLOW}[check-pi]${NC} $*"; }
error() { echo -e "${RED}[check-pi]${NC} $*"; }

STRICT=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) error "unknown argument: $arg"; exit 2 ;;
  esac
done

# Pi's own host-provided set: pi-coding-agent/dist/core/resource-loader.js
# HOST_PROVIDED_EXTENSION_PACKAGES.
HOST_PACKAGES=(
  "@earendil-works/pi-agent-core"
  "@earendil-works/pi-ai"
  "@earendil-works/pi-coding-agent"
  "@earendil-works/pi-tui"
  "@mariozechner/pi-agent-core"
  "@mariozechner/pi-ai"
  "@mariozechner/pi-coding-agent"
  "@mariozechner/pi-tui"
  "@sinclair/typebox"
  "typebox"
)

# Packages the extension imports types from; these must also be tracked in
# devDependencies so dev-time typecheck resolves against real host types.
TYPE_PACKAGES=(
  "@earendil-works/pi-ai"
  "@earendil-works/pi-coding-agent"
)

command -v python3 > /dev/null || { error "python3 is required"; exit 2; }

# --- helpers ----------------------------------------------------------------

jget() {
  # jget <python-expression over d> <file>
  python3 - "$2" <<PY
import json, sys
with open(sys.argv[1]) as fh:
    d = json.load(fh)
v = $1
print("" if v is None else v)
PY
}

npm_latest() {
  # Latest published version from dist-tags.latest, which excludes prereleases
  # (rc/beta/next/...) without any version filtering on our side.
  local pkg="$1"
  curl -fsSL -H "Accept: application/json" "https://registry.npmjs.org/${pkg}" 2> /dev/null \
    | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
tag = (d.get('dist-tags') or {}).get('latest')
print(tag or '')
" 2> /dev/null || true
}

# --- check 1: manifest hygiene ---------------------------------------------

check_manifest() {
  local violations=0

  if [ ! -f "${PACKAGE_JSON}" ]; then
    error "package.json not found at ${PACKAGE_JSON}"
    return 1
  fi

  # Host packages must not be in dependencies.
  local in_deps
  in_deps=$(python3 - "${PACKAGE_JSON}" "${HOST_PACKAGES[@]}" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    manifest = json.load(fh)
deps = manifest.get("dependencies")
if not isinstance(deps, dict):
    sys.exit(0)
host = set(sys.argv[2:])
print("\n".join(sorted(name for name in deps if name in host)))
PY
)
  if [ -n "${in_deps}" ]; then
    error "host-provided packages must NOT be in dependencies:"
    echo "${in_deps}" | sed 's/^/    /'
    error "move them to peerDependencies with a \"*\" range (see Pi docs/packages.md)"
    violations=$((violations + 1))
  fi

  # Host packages that are imported must be present as peerDependencies "*".
  local peers_bad
  peers_bad=$(python3 - "${PACKAGE_JSON}" "${TYPE_PACKAGES[@]}" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    manifest = json.load(fh)
peers = manifest.get("peerDependencies") or {}
bad = []
for name in sys.argv[2:]:
    if name not in peers:
        bad.append(f"{name}: missing from peerDependencies")
    elif peers[name] != "*":
        bad.append(f"{name}: peerDependencies is {peers[name]!r}, expected \"*\"")
print("\n".join(bad))
PY
)
  if [ -n "${peers_bad}" ]; then
    error "peerDependencies must declare host packages with a \"*\" range:"
    echo "${peers_bad}" | sed 's/^/    /'
    violations=$((violations + 1))
  fi

  # Type-only host packages must be devDependencies so tsc can resolve them.
  local dev_missing
  dev_missing=$(python3 - "${PACKAGE_JSON}" "${TYPE_PACKAGES[@]}" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    manifest = json.load(fh)
dev = manifest.get("devDependencies") or {}
print("\n".join(name for name in sys.argv[2:] if name not in dev))
PY
)
  if [ -n "${dev_missing}" ]; then
    error "host packages missing from devDependencies (dev-time typecheck would fail):"
    echo "${dev_missing}" | sed 's/^/    /'
    violations=$((violations + 1))
  fi

  if [ "${violations}" -eq 0 ]; then
    log "manifest check: PASS — host packages are peerDependencies \"*\" + devDependencies"
    return 0
  fi
  return 1
}

check_docs() {
  local readme="${PROJECT_ROOT}/README.md"
  local violations=0

  if [ ! -f "${readme}" ]; then
    warn "README.md not found; skipping documented host version check"
    return 0
  fi

  local dev_pca
  dev_pca=$(jget "d.get('devDependencies', {}).get('@earendil-works/pi-coding-agent')" "${PACKAGE_JSON}")
  [ -z "${dev_pca}" ] && return 0
  local pin="${dev_pca#\^}"
  pin="${pin#\~}"
  pin="${pin#=}"

  # Badge: "PI%20Agent-vX.Y.Z" (URL-escaped space in a shields.io badge label).
  local badge
  badge=$(grep -o 'PI%20Agent-v[0-9][0-9.]*' "${readme}" 2> /dev/null | head -1 | sed 's/.*-v//')
  if [ -n "${badge}" ] && [ "${badge}" != "${pin}" ]; then
    error "README badge says Pi Agent v${badge}, devDependencies pins ${pin}"
    error "update the badge to v${pin} (tested host version)"
    violations=$((violations + 1))
  fi

  # Prerequisites: "pi-coding-agent`) X.Y.Z+"
  local prereq
  prereq=$(grep -o 'pi-coding-agent`) *[0-9][0-9.]*+' "${readme}" 2> /dev/null | head -1 | grep -o '[0-9][0-9.]*' | tr -d '+')
  if [ -n "${prereq}" ] && [ "${prereq}" != "${pin}" ]; then
    error "README prerequisite says Pi ${prereq}+, devDependencies pins ${pin}"
    error "the minimum supported host must match the version we test against"
    violations=$((violations + 1))
  fi

  if [ "${violations}" -eq 0 ]; then
    log "docs check: PASS — README host version matches devDependencies (${pin})"
    return 0
  fi
  return 1
}

# --- check 2: version drift (advisory) --------------------------------------

check_drift() {
  local drift=0

  local dev_pia dev_pca latest_pia latest_pca running

  dev_pia=$(jget "d.get('devDependencies', {}).get('@earendil-works/pi-ai')" "${PACKAGE_JSON}")
  dev_pca=$(jget "d.get('devDependencies', {}).get('@earendil-works/pi-coding-agent')" "${PACKAGE_JSON}")

  running=""
  if command -v pi > /dev/null 2>&1; then
    running=$(pi --version 2> /dev/null | head -1 | tr -d '[:space:]' || true)
  fi

  info "pi-coding-agent"
  [ -n "${running}" ] && info "  running in this container : ${running}"
  info "  pinned in devDependencies : ${dev_pca:-<unset>}"
  latest_pca=$(npm_latest "@earendil-works/pi-coding-agent")
  info "  latest published          : ${latest_pca:-<unavailable>}"

  info "pi-ai"
  info "  pinned in devDependencies : ${dev_pia:-<unset>}"
  latest_pia=$(npm_latest "@earendil-works/pi-ai")
  info "  latest published          : ${latest_pia:-<unavailable>}"

  # Compare only the bare version against the latest dist-tag; ignore ranges.
  strip_range() {
    local v="$1"
    v="${v#\^}"
    v="${v#~}"
    v="${v#=}"
    echo "${v}"
  }

  for pair in "${dev_pca}:${latest_pca}" "${dev_pia}:${latest_pia}"; do
    pinned="${pair%%:*}"
    latest="${pair##*:}"
    if [ -z "${pinned}" ] || [ -z "${latest}" ]; then
      continue
    fi
    if [ "$(strip_range "${pinned}")" != "$(strip_range "${latest}")" ]; then
      drift=1
    fi
  done

  echo ""
  if [ "${drift}" -eq 0 ]; then
    log "drift check: devDependencies match the latest published version"
    return 0
  fi

  warn "drift check: devDependencies are BEHIND the latest published version"
  warn "this is advisory — it does not mean the extension is broken."
  warn "To pick up the new host version:"
  warn "  1. bump devDependencies (or let dependabot open the PR)"
  warn "  2. npm install && npm run build"
  warn "  3. npx tsc -p tsconfig.json --noEmit"
  warn "  4. ./scripts/integration-test.sh"
  warn "Peer dependencies stay at \"*\" — do NOT pin them to the host version."
  if [ "${STRICT}" -eq 1 ]; then
    return 1
  fi
  return 0
}

# --- main -------------------------------------------------------------------

echo ""
log "pi-failover host-package check"
echo ""

manifest_status=0
check_manifest || manifest_status=1

echo ""
docs_status=0
check_docs || docs_status=1

echo ""
drift_status=0
check_drift || drift_status=1

echo ""
if [ "${manifest_status}" -eq 0 ] && [ "${docs_status}" -eq 0 ] && [ "${drift_status}" -eq 0 ]; then
  log "all checks passed"
  exit 0
fi

if [ "${manifest_status}" -ne 0 ]; then
  error "manifest check FAILED (blocking)"
  exit 1
fi

if [ "${docs_status}" -ne 0 ]; then
  error "docs check FAILED (blocking)"
  exit 1
fi

error "drift check FAILED (--strict)"
exit 1
