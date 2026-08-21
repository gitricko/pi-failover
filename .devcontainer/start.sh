#!/bin/bash
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_NAME="$(basename -- "$SCRIPT_PATH")"

# Derive workspace root from script location (works in both Codespace and CI)
# In Codespace: $WORKSPACE is set by devcontainer.json
# In CI: derive from SCRIPT_DIR (which is .devcontainer/)
WORKSPACE_ROOT="${WORKSPACE:-$(dirname "$SCRIPT_DIR")}"

# ── Validate ALL critical dependencies ──────────────────────────────
# Every service binary, the skills directory, and the Mnemon seed file
# MUST exist. If any is missing, the system is incomplete — fail
# immediately with a clear error message before starting any services.
MISSING=()

# Check service binaries
for bin in modelrelay omniroute ollama pi mnemon; do
  if ! command -v "$bin" &>/dev/null; then
    MISSING+=("binary: $bin")
  fi
done


if [ ${#MISSING[@]} -gt 0 ]; then
  echo "[$SCRIPT_NAME] FATAL: Missing critical dependencies:"
  for item in "${MISSING[@]}"; do
    echo "  - $item"
  done
  echo "[$SCRIPT_NAME] All dependencies are required for Pi to function."
  exit 1
fi

echo
echo "*****   Starting Agent Services ....    *****"
echo
echo "    $(date)"

# 1. Starting modelrelay...
if pgrep -f modelrelay > /dev/null; then
  echo "[$SCRIPT_NAME] modelrelay is already running, skipping"
else
  echo "[$SCRIPT_NAME] Starting modelrelay in the background..."
  setsid /usr/local/bin/modelrelay >> /tmp/modelrelay.log 2>&1 &
fi

# 2. Starting omniroute...
if pgrep -f omniroute > /dev/null; then
  echo "[$SCRIPT_NAME] omniroute is already running, skipping"
else
  echo "[$SCRIPT_NAME] Starting omniroute in the background..."
  setsid /usr/local/bin/omniroute --no-open --log >> /tmp/omniroute.log 2>&1 &
fi

# 3. Starting ollama...
if pgrep -f ollama > /dev/null; then
  echo "[$SCRIPT_NAME] ollama is already running, skipping"
  ( sleep 60 && ollama pull nomic-embed-text >> /tmp/ollama-pull.log 2>&1 ) &
else
  echo "[$SCRIPT_NAME] Starting ollama in the background..."
  setsid /usr/local/bin/ollama serve >> /tmp/ollama.log 2>&1 &
  ( sleep 60 && ollama pull nomic-embed-text >> /tmp/ollama-pull.log 2>&1 ) &
fi

# 4. Starting Hermes Gateway and Dashboard

# Update mnemon provider if version changes (synced BEFORE gateway starts)
echo "[$SCRIPT_NAME] Checking mnemon provider..."
rm -rf /tmp/mnemon_repo
if git clone https://github.com/gitricko/hermes-plugin-mnemon /tmp/mnemon_repo; then
    if [ ! -d "$HOME/.hermes/plugins/mnemon" ] || ! diff -r -q -x __pycache__ "$HOME/.hermes/plugins/mnemon" "/tmp/mnemon_repo/mnemon" >/dev/null 2>&1; then
      echo "[$SCRIPT_NAME] Mnemon plugin is missing or out of date. Updating..."
      mkdir -p "$HOME/.hermes/plugins"
      rm -rf "$HOME/.hermes/plugins/mnemon"
      cp -r "/tmp/mnemon_repo/mnemon" "$HOME/.hermes/plugins/mnemon"
      echo "[$SCRIPT_NAME] Mnemon plugin updated successfully."
    else
      echo "[$SCRIPT_NAME] Mnemon plugin is up to date."
    fi
    rm -rf /tmp/mnemon_repo
else
  echo "[$SCRIPT_NAME] WARNING: Failed to clone gitricko/hermes-plugin-mnemon repository."
fi

# 5.6. Pi-agent LM config persistence — REPAIR GUARD ONLY.
# The pi crewmate (firstmate-bridge skill) needs ~/.pi/agent/{models,settings}.json
# pointed at the local OmniRoute relay. Those files are tracked under
# .devcontainer/pi-config/ so they survive rebuilds; this guard (re)links them.
# pi writes its own stub on first launch, so we replace a plain file but never
# clobber an existing symlink that already resolves to the tracked target.
PI_CONF_TRACKED="$WORKSPACE_ROOT/.devcontainer/pi-config"
PI_AGENT_DIR="$HOME/.pi/agent"
if [ -d "$PI_CONF_TRACKED" ]; then
  mkdir -p "$PI_AGENT_DIR"
  for f in models.json settings.json; do
    tracked="$PI_CONF_TRACKED/$f"
    [ -f "$tracked" ] || continue
    runtime="$PI_AGENT_DIR/$f"
    if [ "$(readlink -f "$runtime" 2>/dev/null)" != "$(readlink -f "$tracked")" ]; then
      rm -f "$runtime"
      ln -s "$tracked" "$runtime"
      echo "[$SCRIPT_NAME] Linked pi config: $runtime -> $tracked"
    fi
  done
fi
