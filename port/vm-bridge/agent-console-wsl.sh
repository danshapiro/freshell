#!/usr/bin/env bash
# agent-console-wsl.sh -- file-driven command bridge for a write-sandboxed Amplifier agent.
#
# WHY THIS EXISTS: the 2026-07-08 agent session runs on the TauriDebugVM (Windows),
# where the amplifier `bash` tool is dead (C:\Windows\System32\bash.exe is the WSL
# launcher and the VM has NO WSL distro installed) and the agent's write sandbox is
# limited to this worktree. The agent therefore has file I/O but no command execution.
# This watcher runs ON DANDESKTOP (WSL2, the real build host). It executes command
# files the agent writes into port/vm-bridge/inbox-wsl/ and writes results to
# port/vm-bridge/outbox-wsl/, giving the agent full access to the proven build/test
# environment (cargo, node, playwright, git, WSLg) documented in port/HANDOFF.md.
#
# START (on DANDESKTOP, in WSL):
#   bash ~/code/freshell/.worktrees/rust-tauri-port/port/vm-bridge/agent-console-wsl.sh
# STOP: Ctrl-C. Stop it whenever the agent session is over.
#
# SECURITY NOTE: this executes arbitrary shell commands dropped into inbox-wsl/.
# Run it only while deliberately supervising an agent session on this repo.
#
# Protocol:
#   request : inbox-wsl/<id>.cmd   (plain text, executed with bash -lc)
#   response: outbox-wsl/<id>.out  (echoed command, merged stdout+stderr, ---RC=n--- trailer)
#   liveness: alive-wsl.txt        (ISO timestamp, rewritten every loop)

set -u
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INBOX="$BASE/inbox-wsl"
OUTBOX="$BASE/outbox-wsl"
mkdir -p "$INBOX" "$OUTBOX"
# SECURITY (F1, 2026-07-10 review): NEVER execute inbox files that predate this
# watcher (they could have arrived via git or an earlier session). Quarantine
# them un-executed; a human may inspect and re-drop them deliberately.
if [ -n "$(ls -A "$INBOX" 2>/dev/null)" ]; then
  QDIR="$BASE/quarantine-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$QDIR"
  mv "$INBOX"/* "$QDIR"/ 2>/dev/null
  echo "agent-console-wsl: quarantined pre-existing inbox file(s) to $QDIR (NOT executed)" >&2
fi
echo "agent-console-wsl: watching $INBOX (Ctrl-C to stop)"
while true; do
  date -Is > "$BASE/alive-wsl.txt" 2>/dev/null
  for f in "$INBOX"/*.cmd; do
    [ -e "$f" ] || continue
    id="$(basename "$f" .cmd)"
    cmd="$(cat "$f")"
    rm -f "$f"
    {
      printf '$ %s\n' "$cmd"
      bash -lc "$cmd" 2>&1
      printf -- '---RC=%s---\n' "$?"
    } > "$OUTBOX/$id.out" 2>&1
    echo "agent-console-wsl: ran $id"
  done
  sleep 1
done
