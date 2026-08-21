#!/bin/bash

PI_AGENT_VERSION=0.84.2
OMNIROUTE_VERSION=3.8.49
MODELRELAY_VERSION=1.18.0
OLLAMA_VERSION=0.32.9
MNEMON_VERSION=0.1.17

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_NAME="$(basename -- "$SCRIPT_PATH")"

# Smart copy: only copies if files differ or destination doesn't exist
smart_copy() {
  if ! cmp -s "$1" "$2" 2>/dev/null; then
    cp "$1" "$2"
    echo "✓ Updated $(basename "$2")"
  else
    echo "✓ $(basename "$2") already in sync"
  fi
}

echo
echo "*****   Installing/Setup Agent Services ....    *****"
echo 


# Install Pi-agent for firstmate-bridge crewmate harness
echo "[$SCRIPT_NAME] Installing Pi-agent..."
if command -v pi &>/dev/null; then
  echo "[$SCRIPT_NAME] pi already installed: $(pi --version 2>&1 | head -1)"
else
  sudo npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_AGENT_VERSION}
  echo "[$SCRIPT_NAME] pi-agent installed"
fi

# Install the Ollama binary from the official image
curl -fsSL https://ollama.com/install.sh | sh

echo "[$SCRIPT_NAME] Checking ollama..."
if command -v ollama &>/dev/null; then
  if pgrep -f ollama > /dev/null; then
    echo "[$SCRIPT_NAME] ollama is already running, skipping"
    ( sleep 60 && ollama pull nomic-embed-text >> /tmp/ollama-pull.log 2>&1 ) &
  else
    echo "[$SCRIPT_NAME] Starting ollama in the background..."
    setsid /usr/local/bin/ollama serve >> /tmp/ollama.log 2>&1 &
    ( sleep 60 && ollama pull nomic-embed-text >> /tmp/ollama-pull.log 2>&1 ) &
  fi
else
  echo "[$SCRIPT_NAME] ollama not found, skipping start"
fi

# Install modelrelay globally
# sudo npm install -g modelrelay@${MODELRELAY_VERSION} && \
sudo npm install github:gitricko/modelrelay -g --prefix /usr/local/lib/modelrelay
sudo ln -sf /usr/local/lib/modelrelay/bin/modelrelay /usr/local/bin/modelrelay
sudo npm cache clean --force

echo "[$SCRIPT_NAME] Checking modelrelay..."
if command -v modelrelay &>/dev/null; then
  if pgrep -f modelrelay > /dev/null; then
    echo "[$SCRIPT_NAME] modelrelay is already running, skipping"
  else
    echo "[$SCRIPT_NAME] Starting modelrelay in the background..."
    modelrelay --disable
    setsid /usr/local/bin/modelrelay >> /tmp/modelrelay.log 2>&1 &
  fi
else
  echo "[$SCRIPT_NAME] modelrelay not found, skipping start"
fi

# Install TailScale
sudo mkdir -p /var/run/tailscale /var/lib/tailscale && sudo curl -fsSL https://tailscale.com/install.sh | sh && sudo rm -rf /var/lib/apt/lists/*

# Install mnemon
MNEMON_ARCH=amd64
curl -sL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${MNEMON_ARCH}.tar.gz" -o /tmp/mnemon.tar.gz
tar xzf /tmp/mnemon.tar.gz -C /tmp
sudo cp /tmp/mnemon /usr/local/bin/mnemon
sudo chmod +x /usr/local/bin/mnemon
rm -rf /tmp/mnemon.tar.gz /tmp/mnemon

# integrate mnemon into claude-code
# mnemon setup --yes --global  --target claude-code

# Install OmniRoute and start automatically when desktop loads
sudo npm install omniroute@${OMNIROUTE_VERSION} -g --prefix /usr/local/lib/omniroute
sudo ln -sf /usr/local/lib/omniroute/bin/omniroute /usr/local/bin/omniroute
sudo npm cache clean --force

echo "[$SCRIPT_NAME] Checking omniroute..."
if command -v omniroute &>/dev/null; then
  if pgrep -f omniroute > /dev/null; then
    echo "[$SCRIPT_NAME] omniroute is already running, skipping"
  else
    echo "[$SCRIPT_NAME] Starting omniroute in the background..."
    setsid /usr/local/bin/omniroute >> /tmp/omniroute.log 2>&1 &
  fi
else
    echo "[$SCRIPT_NAME] omniroute not found, skipping start"
fi

# Preconfigure Omniroute
#   Wait for OmniRoute to be ready
MAX_ATTEMPTS=120
for ((attempt=1; attempt<=MAX_ATTEMPTS; attempt++)); do
    echo "[$SCRIPT_NAME] Waiting for OmniRoute to be ready (attempt $attempt/$MAX_ATTEMPTS)..."
    
    if curl -s --max-time 3 -o /dev/null -w "%{http_code}" http://localhost:20128/v1/models | grep -q "200"; then
        break
    fi
    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
        echo "[$SCRIPT_NAME] Error: OmniRoute failed to start after $MAX_ATTEMPTS attempts."
        exit 1
    fi
    sleep 1
done


# Switch OmniRoute to not require login for now, can enable later
echo "[$SCRIPT_NAME] Switching OmniRoute to not require login..."
python3 -c "
import sqlite3
conn = sqlite3.connect('$HOME/.omniroute/storage.sqlite')
conn.execute('UPDATE key_value SET value = ? WHERE key = ?', ('false', 'requireLogin'))
conn.commit()
conn.close()
"

# 1. Create auto-fastest combo
while ! omniroute combo create auto-fastest --strategy auto ; do
    echo "[$SCRIPT_NAME] omniroute still not ready yet, retrying..."
    sleep 3
done
echo "[$SCRIPT_NAME] OmniRoute Combo auto-fastest created!"

# 2. Get the combo ID (skip the banner line from CLI output)
COMBO_ID=$(omniroute combo list --json | grep -v "📋" | \
python3 -c "import sys,json; d=json.load(sys.stdin); print([c['id'] for c in d['combos'] if c['name']=='auto-fastest'][0])")

# 3. Add models + config via API
curl -s -X PUT "http://localhost:20128/api/combos/$COMBO_ID" \
-H "Content-Type: application/json" \
-d '{
    "models": ["oc/deepseek-v4-flash-free","oc/big-pickle","opencode-zen/deepseek-v4-flash-free","opencode-zen/hy3-free","opencode-zen/mimo-v2.5-free","opencode-zen/north-mini-code-free","opencode-zen/nemotron-3-ultra-free","opencode-zen/big-pickle"],
    "strategy": "auto",
    "config": {
    "maxRetries": 2,
    "retryDelayMs": 1000,
    "timeoutMs": 120000,
    "healthCheckEnabled": true
    }
}'

echo "[$SCRIPT_NAME] OmniRoute initialization complete!"

