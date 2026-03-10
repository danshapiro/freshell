#!/usr/bin/env bash
# Launch Freshell: pull upstream, build, start server in background.

set -euo pipefail

FRESHELL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FRESHELL_HOME="$HOME/.freshell"
LOG_FILE="$FRESHELL_HOME/logs/server.log"
URL_FILE="$FRESHELL_HOME/url"
PID_FILE="$FRESHELL_HOME/server.pid"

cd "$FRESHELL_DIR"

# Check for already-running server (verify PID is actually a node process from this project)
if [[ -f "$PID_FILE" ]]; then
  saved_pid="$(cat "$PID_FILE")"
  if kill -0 "$saved_pid" 2>/dev/null && ps -p "$saved_pid" -o args= 2>/dev/null | grep -q "dist/server/index.js"; then
    echo "freshell is already running (pid $saved_pid)"
    if [[ -f "$URL_FILE" ]]; then
      echo "  $(cat "$URL_FILE")"
    fi
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

# Pull latest from upstream (only on main)
current_branch="$(git branch --show-current)"
if [[ "$current_branch" == "main" ]]; then
  echo "Pulling latest from upstream..."
  if git remote get-url upstream >/dev/null 2>&1; then
    git fetch upstream
    if git merge-base --is-ancestor upstream/main HEAD 2>/dev/null; then
      echo "  Already up to date."
    elif git merge --ff-only upstream/main 2>/dev/null; then
      echo "  Merged upstream changes."
    else
      echo "  Local main has diverged from upstream. Resetting to upstream/main..."
      git reset --hard upstream/main
      echo "  Done."
    fi
  else
    echo "  No upstream remote, skipping pull."
  fi

  echo "Pushing to origin..."
  git push origin main 2>/dev/null && echo "  Done." || echo "  Push failed (non-fatal)."
else
  echo "Warning: on branch '$current_branch', skipping upstream pull. Switch to main for auto-update."
fi

# Build
echo "Building..."
npm run build

# Start server in background
echo "Starting server..."
mkdir -p "$(dirname "$LOG_FILE")"
rm -f "$URL_FILE"

NODE_ENV=production node dist/server/index.js > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Wait for the URL to appear in log output (up to 30s)
for i in $(seq 1 60); do
  if url_line=$(sed 's/\x1b\[[0-9;]*m//g' "$LOG_FILE" 2>/dev/null | grep -o 'http://[^ ]*token=[^ ]*' | head -1); then
    if [[ -n "$url_line" ]]; then
      echo "$url_line" > "$URL_FILE"
      echo ""
      echo "freshell is ready! (pid $SERVER_PID)"
      echo "  $url_line"
      exit 0
    fi
  fi
  # Also check if server died
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 0.5
done

echo "Server started (pid $SERVER_PID) but URL not detected within 30s."
echo "Check $LOG_FILE"
