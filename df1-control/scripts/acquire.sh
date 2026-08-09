#!/usr/bin/env bash
# df1 resource-lane lease manager. Mechanism over instruction: workers cannot
# run Playwright/heavy cargo/docker/broad-suite phases without holding the
# matching lease, so parallel-campaign resource caps hold without central
# oversight.
#
# Usage:
#   acquire.sh <lane> <holder-id>                 non-blocking; exit 0 granted, 3 denied
#   acquire.sh <lane> <holder-id> --wait [secs]   poll until granted (exit 0) or timeout (exit 4)
#   acquire.sh release <lane> <holder-id>
#   acquire.sh heartbeat <lane> <holder-id>       refresh an held lease
#   acquire.sh reap                               drop all stale leases
#   acquire.sh status                             print lane occupancy
#
# Lanes (caps env-overridable):
#   agent     DF1_CAP_AGENT=32     total swarm workers
#   provision DF1_CAP_PROVISION=2  npm ci + first cargo build (disk/CPU burst)
#   cargo     DF1_CAP_CARGO=3      heavy cargo builds/tests
#   pw        DF1_CAP_PW=4         Playwright e2e (chromium + owned servers; RAM-bound)
#   sandbox   DF1_CAP_SANDBOX=2    destructive docker suites (scripts/sandbox-test.sh)
#   gate      DF1_CAP_GATE=1       coordinated repo suite (the repo coordinator also serializes)
#
# System guards (env-overridable): pw/provision/cargo additionally require
#   MemAvailable >= DF1_MIN_MEM_AVAIL_GB (default 4)
#   load1        <= DF1_MAX_LOAD1      (default 40)
# provision additionally requires
#   disk free on / >= DF1_MIN_DISK_FREE_GB (default 100)
#
# A lease is a directory $DF1_HOME/leases/<lane>/<holder> containing:
#   hb   - last heartbeat epoch (staleness: > DF1_LEASE_TTL_SEC, default 900s)
#   info - freeform "pid cmd cwd" line written at grant time (for reaper forensics)
set -u
DF1_HOME="${DF1_HOME:-$HOME/.freshell/df1}"
LEASES="$DF1_HOME/leases"
TTL="${DF1_LEASE_TTL_SEC:-900}"
MIN_MEM_GB="${DF1_MIN_MEM_AVAIL_GB:-4}"
MAX_LOAD1="${DF1_MAX_LOAD1:-40}"
MIN_DISK_GB="${DF1_MIN_DISK_FREE_GB:-100}"
mkdir -p "$LEASES"

cap_for() {
  case "$1" in
    agent)     echo "${DF1_CAP_AGENT:-32}" ;;
    provision) echo "${DF1_CAP_PROVISION:-2}" ;;
    cargo)     echo "${DF1_CAP_CARGO:-3}" ;;
    pw)        echo "${DF1_CAP_PW:-4}" ;;
    sandbox)   echo "${DF1_CAP_SANDBOX:-2}" ;;
    gate)      echo "${DF1_CAP_GATE:-1}" ;;
    *) return 1 ;;
  esac
}

now() { date +%s; }

reap() {
  local lane holder hb age
  for lane in agent provision cargo pw sandbox gate; do
    [ -d "$LEASES/$lane" ] || continue
    for holder in "$LEASES/$lane"/*; do
      [ -d "$holder" ] || continue
      hb=$(cat "$holder/hb" 2>/dev/null || echo 0)
      age=$(( $(now) - hb ))
      if [ "$age" -gt "$TTL" ]; then
        rm -rf "$holder"
        echo "$(date -Is) REAPED stale lease lane=$lane holder=$(basename "$holder") age=${age}s" >> "$DF1_HOME/events/launches.jsonl"
      fi
    done
  done
}

occupancy() { reap; ls "$LEASES/$1" 2>/dev/null | wc -l; }

mem_avail_gb() { awk '/MemAvailable/ {printf "%d", $2/1048576}' /proc/meminfo; }
load1() { cut -d' ' -f1 /proc/loadavg; }
disk_free_gb() { df --output=avail -BG / | tail -1 | tr -dc '0-9'; }

system_ok_for() {
  case "$1" in
    pw|provision|cargo)
      local mem; mem=$(mem_avail_gb)
      if [ "$mem" -lt "$MIN_MEM_GB" ]; then echo "deny: MemAvailable ${mem}G < ${MIN_MEM_GB}G"; return 1; fi
      local l1; l1=$(load1); l1=${l1%.*}
      if [ "$l1" -gt "$MAX_LOAD1" ]; then echo "deny: load1 ${l1} > ${MAX_LOAD1}"; return 1; fi
      ;;
  esac
  if [ "$1" = "provision" ]; then
    local d; d=$(disk_free_gb)
    if [ "$d" -lt "$MIN_DISK_GB" ]; then echo "deny: disk free ${d}G < ${MIN_DISK_GB}G"; return 1; fi
  fi
  return 0
}

grant() {
  local lane="$1" holder="$2"
  mkdir -p "$LEASES/$lane"
  if mkdir "$LEASES/$lane/$holder" 2>/dev/null; then
    now > "$LEASES/$lane/$holder/hb"
    echo "pid=$$ cmd=${BASH_COMMAND:-acquire} cwd=$PWD" > "$LEASES/$lane/$holder/info"
    echo "$(date -Is) {\"event\":\"LEASE_GRANT\",\"lane\":\"$lane\",\"holder\":\"$holder\"}" >> "$DF1_HOME/events/launches.jsonl"
    echo "granted lane=$lane holder=$holder ($(occupancy "$lane")/$(cap_for "$lane"))"
    return 0
  fi
  return 1
}

cmd="${1:-help}"
case "$cmd" in
  agent|provision|cargo|pw|sandbox|gate)
    lane="$cmd"; holder="${2:?holder required}"; wait_secs=0
    [ "${3:-}" = "--wait" ] && wait_secs="${4:-600}"
    deadline=$(( $(now) + wait_secs ))
    while :; do
      reason=$(system_ok_for "$lane") || { 
        if [ "$wait_secs" -gt 0 ]; then sleep $((5 + RANDOM % 10));
          [ "$(now)" -lt "$deadline" ] && continue || { echo "timeout waiting ($reason)"; exit 4; }
        else echo "$reason"; exit 3; fi; }
      occ=$(occupancy "$lane"); cap=$(cap_for "$lane")
      if [ "$occ" -lt "$cap" ] || [ -d "$LEASES/$lane/$holder" ]; then
        if grant "$lane" "$holder"; then exit 0; fi
      fi
      if [ "$wait_secs" -gt 0 ] && [ "$(now)" -lt "$deadline" ]; then
        sleep $((5 + RANDOM % 10))
      else
        [ "$wait_secs" -gt 0 ] && { echo "timeout waiting for lane=$lane ($occ/$cap)"; exit 4; }
        echo "deny: lane=$lane full ($occ/$cap)"; exit 3
      fi
    done
    ;;
  release)
    lane="${2:?}"; holder="${3:?}"
    rm -rf "$LEASES/$lane/$holder"
    echo "$(date -Is) {\"event\":\"LEASE_RELEASE\",\"lane\":\"$lane\",\"holder\":\"$holder\"}" >> "$DF1_HOME/events/launches.jsonl"
    echo "released lane=$lane holder=$holder"
    ;;
  heartbeat)
    lane="${2:?}"; holder="${3:?}"
    [ -d "$LEASES/$lane/$holder" ] || { echo "no such lease"; exit 5; }
    now > "$LEASES/$lane/$holder/hb"
    echo "heartbeat ok lane=$lane holder=$holder"
    ;;
  reap) reap; echo "reap done" ;;
  status)
    reap
    for lane in agent provision cargo pw sandbox gate; do
      printf '%-10s %s/%s\n' "$lane" "$(ls "$LEASES/$lane" 2>/dev/null | wc -l)" "$(cap_for "$lane")"
    done
    printf 'mem-avail %sG  load1 %s  disk-free %sG\n' "$(mem_avail_gb)" "$(load1)" "$(disk_free_gb)"
    ;;
  *) sed -n '2,25p' "$0" ;;
esac
