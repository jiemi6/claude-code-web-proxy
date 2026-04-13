#!/bin/bash
# Claude Code Web Proxy - Management Script
# Usage: ./deploy.sh {start|stop|restart|status|log|help}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="claude-code-web-proxy"
PID_FILE="$SCRIPT_DIR/.pid"
LOG_FILE="$SCRIPT_DIR/app.log"

# HOST defaults to the machine's LAN IPv4 (auto-detected by backend/server.js)
# if unset. Override to restrict (e.g. HOST=127.0.0.1) or expose publicly.
export HOST="${HOST:-}"
export PORT="${PORT:-8199}"

# Node.js version requirement
NODE_MAJOR_MIN=18

# ─── Helpers ──────────────────────────────────────────────────────────────────

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }

get_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
    rm -f "$PID_FILE"
  fi
  return 1
}

# ─── Environment Setup ──────────────────────────────────────────────────────

setup_node() {
  # Load nvm if available
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
  fi

  # Add common node paths
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$NVM_DIR/versions/node/$(ls "$NVM_DIR/versions/node/" 2>/dev/null | sort -V | tail -1)/bin:$PATH" 2>/dev/null

  # Check if node exists
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge "$NODE_MAJOR_MIN" ]; then
      return 0
    fi
    yellow "Node.js version too old ($(node -v)), need >= v${NODE_MAJOR_MIN}. Installing..."
  else
    yellow "Node.js not found. Installing via nvm..."
  fi

  install_node
}

install_node() {
  # Install nvm if not present
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    cyan "Installing nvm..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
    . "$NVM_DIR/nvm.sh"
  fi

  # Install latest LTS node
  cyan "Installing Node.js LTS..."
  nvm install --lts
  nvm use --lts

  if ! command -v node &>/dev/null; then
    red "Failed to install Node.js. Please install manually:"
    red "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
    red "  source ~/.nvm/nvm.sh && nvm install --lts"
    exit 1
  fi

  green "Node.js $(node -v) installed successfully."
}

ensure_deps() {
  cd "$SCRIPT_DIR"

  # Setup Node.js
  setup_node

  # Claude binary
  CLAUDE_PATH="$(command -v claude 2>/dev/null || true)"
  if [ -z "$CLAUDE_PATH" ]; then
    red "Error: 'claude' command not found. Please install Claude Code first."
    exit 1
  fi
  export CLAUDE_BIN="$CLAUDE_PATH"

  # Node modules
  if [ ! -d "node_modules" ]; then
    yellow "Installing dependencies..."
    npm install
  fi

  # Unset to avoid nesting detection
  unset CLAUDECODE
}

# ─── Commands ─────────────────────────────────────────────────────────────────

do_start() {
  local fg=false
  if [ "$1" = "--fg" ] || [ "$1" = "-f" ]; then
    fg=true
  fi

  if pid=$(get_pid); then
    yellow "$APP_NAME is already running (PID: $pid)"
    return 0
  fi

  ensure_deps

  if [ "$fg" = true ]; then
    green "Starting $APP_NAME in foreground on $HOST:$PORT ..."
    cyan "Claude binary: $CLAUDE_BIN"
    cyan "Node: $(node -v) ($(which node))"
    exec node backend/server.js
  else
    green "Starting $APP_NAME in background on $HOST:$PORT ..."
    cyan "Claude binary: $CLAUDE_BIN"
    cyan "Node: $(node -v) ($(which node))"
    cyan "Log file: $LOG_FILE"

    # Use full node path for nohup
    local node_bin
    node_bin="$(which node)"
    nohup "$node_bin" "$SCRIPT_DIR/backend/server.js" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    # Wait briefly and verify it started
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      green "$APP_NAME started (PID: $pid)"
      echo "  URL: http://$HOST:$PORT"
      echo "  Log: ./deploy.sh log"
    else
      red "Failed to start. Check log: $LOG_FILE"
      rm -f "$PID_FILE"
      tail -20 "$LOG_FILE"
      return 1
    fi
  fi
}

do_stop() {
  if pid=$(get_pid); then
    yellow "Stopping $APP_NAME (PID: $pid) ..."
    kill "$pid" 2>/dev/null

    # Wait up to 5 seconds for graceful shutdown
    for i in $(seq 1 10); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.5
    done

    # Force kill if still running
    if kill -0 "$pid" 2>/dev/null; then
      yellow "Force killing ..."
      kill -9 "$pid" 2>/dev/null
    fi

    rm -f "$PID_FILE"
    green "$APP_NAME stopped."
  else
    yellow "$APP_NAME is not running."
  fi
}

do_restart() {
  do_stop
  sleep 1
  do_start "$@"
}

do_status() {
  if pid=$(get_pid); then
    green "$APP_NAME is running (PID: $pid)"
    echo "  URL: http://$HOST:$PORT"
    echo "  Log: $LOG_FILE"
    echo "  Uptime: $(ps -p "$pid" -o etime= 2>/dev/null | xargs)"
    echo "  Memory: $(ps -p "$pid" -o rss= 2>/dev/null | awk '{printf "%.1f MB", $1/1024}')"
  else
    red "$APP_NAME is not running."
    return 1
  fi
}

do_log() {
  if [ ! -f "$LOG_FILE" ]; then
    yellow "No log file yet: $LOG_FILE"
    return 0
  fi

  local lines="${1:-50}"
  case "$lines" in
    -f|--follow|follow)
      cyan "Following $LOG_FILE (Ctrl+C to stop) ..."
      tail -f "$LOG_FILE"
      ;;
    *)
      tail -n "$lines" "$LOG_FILE"
      ;;
  esac
}

do_help() {
  cat <<EOF
$(cyan "$APP_NAME management script")

Usage: $0 <command> [options]

Commands:
  start [--fg]     Start the server (background by default, --fg for foreground)
  stop             Stop the server
  restart [--fg]   Restart the server
  status           Show server status (PID, uptime, memory)
  log [N|-f]       Show last N lines of log (default: 50), or -f to follow
  help             Show this help

Environment variables:
  HOST             Bind address (default: auto-detected LAN IPv4)
  PORT             Listen port  (default: 8199)

Examples:
  $0 start                  # Start in background
  $0 start --fg             # Start in foreground (for debugging)
  $0 log                    # Show last 50 lines
  $0 log 200                # Show last 200 lines
  $0 log -f                 # Follow log in real-time
  PORT=9000 $0 start        # Start on custom port
EOF
}

# ─── Main ─────────────────────────────────────────────────────────────────────

case "${1:-help}" in
  start)   do_start "$2" ;;
  stop)    do_stop ;;
  restart) do_restart "$2" ;;
  status)  do_status ;;
  log)     do_log "$2" ;;
  help|-h|--help) do_help ;;
  *)
    red "Unknown command: $1"
    do_help
    exit 1
    ;;
esac
