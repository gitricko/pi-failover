#!/usr/bin/env bash
# Integration test runner for pi-failover CI
# Runs the extension against mock OpenAI servers

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[integration]${NC} $*"; }
warn() { echo -e "${YELLOW}[integration]${NC} $*"; }
error() { echo -e "${RED}[integration]${NC} $*"; }

# Start mock servers
PRIMARY_PORT=18080
FALLBACK_PORT=18081

cleanup() {
  log "Cleaning up mock servers..."
  pkill -f "mock-openai-server.mjs.*--port=${PRIMARY_PORT}" 2>/dev/null || true
  pkill -f "mock-openai-server.mjs.*--port=${FALLBACK_PORT}" 2>/dev/null || true
  pkill -f "mock-openai-server.mjs.*--port=18082" 2>/dev/null || true
  pkill -f "mock-openai-server.mjs.*--port=18083" 2>/dev/null || true
}

trap cleanup EXIT

log "Building extension..."
cd "${PROJECT_ROOT}"
npm run build > /dev/null

log "Starting mock servers..."
node "${SCRIPT_DIR}/mock-openai-server.mjs" --port=${PRIMARY_PORT} --mode=success &
PRIMARY_PID=$!
node "${SCRIPT_DIR}/mock-openai-server.mjs" --port=${FALLBACK_PORT} --mode=fail &
FALLBACK_PID=$!

# Wait for servers to be ready
sleep 2

# Verify servers
for port in ${PRIMARY_PORT} ${FALLBACK_PORT}; do
  for i in {1..10}; do
    if curl -sf "http://127.0.0.1:${port}/health" > /dev/null; then
      log "Mock server on port ${port} ready"
      break
    fi
    sleep 0.5
  done
done

# Configure Pi
MODELS_JSON="${HOME}/.pi/agent/models.json"
mkdir -p "$(dirname "${MODELS_JSON}")"

cat > "${MODELS_JSON}" <<'EOF'
{
  "providers": {
    "ci-primary": {
      "baseUrl": "http://localhost:18080/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "models": [{ "id": "auto", "name": "Auto", "reasoning": false, "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 4096, "maxTokens": 2048 }],
      "fallback": {
        "chain": ["ci-fallback/auto"],
        "timeoutMs": 10000,
        "onlyPreFirstToken": true,
        "notifyOnSwitch": true
      }
    },
    "ci-fallback": {
      "baseUrl": "http://localhost:18081/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "models": [{ "id": "auto", "name": "Auto", "reasoning": false, "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 4096, "maxTokens": 2048 }]
    }
  }
}
EOF

log "Configured Pi with models.json"

# Test 1: Primary succeeds (no failover)
log "Test 1: Primary succeeds (no failover)"
cd /tmp
OUTPUT=$(DEBUG=pi-failover timeout 30 pi -p "test primary success" 2>&1 || true)
if echo "${OUTPUT}" | grep -q "first token from ci-primary"; then
  log "✅ PASS: Primary succeeded, no failover"
else
  error "❌ FAIL: Primary should have succeeded"
  echo "${OUTPUT}" | tail -20
  exit 1
fi

# Test 2: Primary fails -> fallback succeeds
log "Test 2: Primary fails, fallback succeeds"
curl -sf -X POST "http://127.0.0.1:${PRIMARY_PORT}/__admin/mode" -H "Content-Type: application/json" -d '{"mode":"fail"}' > /dev/null
log "Set primary to fail mode"

OUTPUT=$(DEBUG=pi-failover timeout 30 pi -p "test failover" 2>&1 || true)
if echo "${OUTPUT}" | grep -q "⚠ failover: ci-primary → ci-fallback/auto"; then
  log "✅ PASS: Failover triggered"
else
  error "❌ FAIL: Failover should have triggered"
  echo "${OUTPUT}" | tail -20
  exit 1
fi

if echo "${OUTPUT}" | grep -q "first token from ci-fallback"; then
  log "✅ PASS: Fallback succeeded"
else
  error "❌ FAIL: Fallback should have succeeded"
  echo "${OUTPUT}" | tail -20
  exit 1
fi

# Test 3: Both fail -> exhaustion
log "Test 3: Both fail -> exhaustion"
curl -sf -X POST "http://127.0.0.1:${FALLBACK_PORT}/__admin/mode" -H "Content-Type: application/json" -d '{"mode":"fail"}' > /dev/null
log "Set fallback to fail mode"

OUTPUT=$(DEBUG=pi-failover timeout 30 pi -p "test exhaustion" 2>&1 || true)
if echo "${OUTPUT}" | grep -q "all candidates exhausted\|all candidates failed\|exhausted"; then
  log "✅ PASS: Chain exhausted correctly"
else
  # Check for error message indicating all failed
  if echo "${OUTPUT}" | grep -q "ci-fallback.*fail\|Connection error\|Service unavailable"; then
    log "✅ PASS: All candidates failed (exhausted)"
  else
    error "❌ FAIL: Should have exhausted all candidates"
    echo "${OUTPUT}" | tail -20
    exit 1
  fi
fi

# Test 4: Primary timeout -> fallback
log "Test 4: Primary timeout -> fallback"
# Start a timeout server on port 18082
node "${SCRIPT_DIR}/mock-openai-server.mjs" --port=18082 --mode=timeout &
TIMEOUT_PID=$!
sleep 1

cat > "${MODELS_JSON}" <<'EOF'
{
  "providers": {
    "ci-timeout": {
      "baseUrl": "http://localhost:18082/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "models": [{ "id": "auto", "name": "Auto", "reasoning": false, "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 4096, "maxTokens": 2048 }],
      "fallback": {
        "chain": ["ci-fallback/auto"],
        "timeoutMs": 5000,
        "onlyPreFirstToken": true,
        "notifyOnSwitch": true
      }
    },
    "ci-fallback": {
      "baseUrl": "http://localhost:18081/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "models": [{ "id": "auto", "name": "Auto", "reasoning": false, "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 4096, "maxTokens": 2048 }]
    }
  }
}
EOF

# Switch fallback back to success
curl -sf -X POST "http://127.0.0.1:${FALLBACK_PORT}/__admin/mode" -H "Content-Type: application/json" -d '{"mode":"success"}' > /dev/null

OUTPUT=$(DEBUG=pi-failover timeout 30 pi -p "test timeout" 2>&1 || true)
if echo "${OUTPUT}" | grep -q "⚠ failover: ci-timeout → ci-fallback/auto"; then
  log "✅ PASS: Timeout triggered failover"
else
  error "❌ FAIL: Timeout should have triggered failover"
  echo "${OUTPUT}" | tail -20
  exit 1
fi

log "All integration tests passed! 🎉"