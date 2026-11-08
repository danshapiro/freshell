#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "APPROVED" ]]; then
  cat >&2 <<'MESSAGE'
Freshell is still running; no restart was performed.

Restarting the Freshell server briefly disconnects live terminals and agent
sessions, so this action requires direct human approval. If you are an agent,
ask your human to reply with the literal word APPROVED. Do not infer approval
from a deployment request, earlier conversation, automation, or another agent.

The human is the ultimate authority for this machine and may intentionally
overrule this operational safeguard. Once the human directly says APPROVED,
run this activation command again with APPROVED as its argument.
MESSAGE
  exit 64
fi

state_dir=/home/dan/.local/state/garageserver-setup/freshell-config-migration-20260824
triage_script="$state_dir/triage-freshell-config.py"
prepared_config="$state_dir/config.triaged.json"
prepared_env="$state_dir/env.prepared"
prepared_unit="$state_dir/freshell-rust.service.prepared"
active_config=/home/dan/.freshell/config.json
active_env=/home/dan/code/freshell/.env
active_unit=/home/dan/.config/systemd/user/freshell-rust.service
service=freshell-rust.service
log_file="$state_dir/migration.jsonl"
backup_dir="$state_dir/backup-$(date -u +%Y%m%dT%H%M%SZ)"
rollback_needed=0

umask 077

log_json() {
  python3 - "$log_file" "$1" "$2" "$3" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, severity, event, detail = sys.argv[1:]
record = {
    "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "severity": severity,
    "event": event,
    "detail": detail,
}
with open(path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, separators=(",", ":")) + "\n")
PY
}

rollback() {
  local exit_code=$?
  if [[ "$rollback_needed" == 1 ]]; then
    log_json error activation_failed "exit_code=$exit_code;rolling_back"
    install -m 600 "$backup_dir/config.json" "$active_config"
    install -m 600 "$backup_dir/freshell.env" "$active_env"
    install -m 644 "$backup_dir/freshell-rust.service" "$active_unit"
    systemctl --user daemon-reload
    systemctl --user start "$service" || true
    log_json warning rollback_completed previous_files_restored
  fi
  exit "$exit_code"
}
trap rollback EXIT

log_json info activation_started approved_lan_and_config_migration

"$triage_script" >"$state_dir/triage-activation-summary.json"
python3 -m json.tool "$prepared_config" >/dev/null
python3 -m json.tool "$state_dir/triage-summary.json" >/dev/null
grep -q '^AUTH_TOKEN=.' "$prepared_env"
grep -q '^ALLOWED_ORIGINS=.*http://garageserver.local:3001' "$prepared_env"
grep -q '^Environment=FRESHELL_BIND_HOST=0.0.0.0$' "$prepared_unit"

install -d -m 700 "$backup_dir"
cp -a "$active_config" "$backup_dir/config.json"
cp -a "$active_env" "$backup_dir/freshell.env"
cp -a "$active_unit" "$backup_dir/freshell-rust.service"
chmod 600 "$backup_dir/config.json" "$backup_dir/freshell.env" "$backup_dir/freshell-rust.service"

rollback_needed=1
systemctl --user stop "$service"
install -m 600 "$prepared_config" "$active_config"
install -m 600 "$prepared_env" "$active_env"
install -m 644 "$prepared_unit" "$active_unit"
systemctl --user daemon-reload
systemctl --user start "$service"

for _ in $(seq 1 40); do
  if curl --silent --show-error --fail --max-time 2 \
      http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl --silent --show-error --fail --max-time 5 \
  http://127.0.0.1:3001/api/health >/dev/null

token="$(sed -n 's/^AUTH_TOKEN=//p' "$active_env")"
python3 - "$token" <<'PY'
import json
import sys
from urllib.request import Request, urlopen

token = sys.argv[1]
request = Request(
    "http://127.0.0.1:3001/api/settings",
    headers={"x-auth-token": token},
)
with urlopen(request, timeout=10) as response:
    settings = json.load(response)
if settings.get("network", {}).get("host") != "0.0.0.0":
    raise SystemExit("authenticated settings did not report the LAN bind host")
PY
unset token

ss -ltnH | awk '$4 == "0.0.0.0:3001" { found=1 } END { exit !found }'
sudo -n ufw status | grep -Fq '3001/tcp on enp0s31f6'
systemctl --user is-active --quiet "$service"
systemctl --user is-enabled --quiet "$service"

rollback_needed=0
log_json info activation_completed lan_listener_and_migrated_config_verified
trap - EXIT

printf 'service=active enabled=enabled\n'
printf 'listener=0.0.0.0:3001\n'
printf 'url=http://garageserver.local:3001\n'
printf 'backup_dir=%s\n' "$backup_dir"
printf 'config_sha256=%s\n' "$(sha256sum "$active_config" | cut -d' ' -f1)"
printf 'triage_report=%s\n' "$state_dir/triage.jsonl"
