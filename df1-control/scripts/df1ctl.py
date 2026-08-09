#!/usr/bin/env python3
"""df1 campaign control: work-queue state machine + launch ledger + reports.

State lives OUTSIDE git (survives worktree teardown):
  DF1_HOME (default ~/.freshell/df1)/
    items.json          work queue (copied from repo df1-control/queue/ at init)
    events/launches.jsonl  append-only event log (LAUNCHED/KILLED/REQUEUED/...)
    status/<ID>.json    per-item latest snapshot written by agents
    leases/             managed by acquire.sh

Commands:
  init <queue.json>          seed DF1_HOME/items.json + dirs (idempotent)
  claim <ID> <agent-id>      queued -> claimed; logs LAUNCHED
  update <ID> <json-fields>  merge fields into status/<ID>.json (agents use this)
  requeue <ID> <reason>      claimed/in-progress -> queued (kill path); logs
  set-state <ID> <state>     force state (orchestrator use); logs
  report [--states a,b]      compact table of all items with current status
  events [--last N]          tail the launch ledger
  item <ID>                  full queue record + latest status for one item
"""
import json
import os
import sys
import time
import urllib.parse

DF1_HOME = os.environ.get("DF1_HOME", os.path.expanduser("~/.freshell/df1"))
ITEMS = os.path.join(DF1_HOME, "items.json")
EVENTS = os.path.join(DF1_HOME, "events", "launches.jsonl")
STATUS = os.path.join(DF1_HOME, "status")

FINAL_STATES = {"done", "host-limited"}
OK_STATES = {"queued", "claimed", "in-progress", "review",
             "merged-unverified-e2e", "done", "host-limited", "blocked",
             "needs-human", "failed"}


def load_items():
    with open(ITEMS, encoding="utf-8") as fh:
        return json.load(fh)


def save_items(q):
    tmp = ITEMS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(q, fh, indent=2)
    os.replace(tmp, ITEMS)


def find(q, iid):
    for it in q["items"]:
        if it["id"] == iid:
            return it
    raise SystemExit(f"unknown item {iid}")


def log(event: dict):
    os.makedirs(os.path.dirname(EVENTS), exist_ok=True)
    event = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **event}
    with open(EVENTS, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event) + "\n")


def set_status(iid, fields):
    os.makedirs(STATUS, exist_ok=True)
    p = os.path.join(STATUS, f"{iid}.json")
    cur = {}
    if os.path.exists(p):
        with open(p, encoding="utf-8") as fh:
            cur = json.load(fh)
    cur.update(fields)
    cur["updated"] = int(time.time())
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cur, fh, indent=2)
    os.replace(tmp, p)
    return cur


def ago(epoch):
    if not epoch:
        return "-"
    d = int(time.time()) - int(epoch)
    return f"{d}s" if d < 90 else f"{d // 60}m" if d < 5400 else f"{d // 3600}h"


def cmd_report(states_filter=None):
    q = load_items()
    rows = []
    for it in q["items"]:
        if states_filter and it["state"] not in states_filter:
            continue
        st = {}
        p = os.path.join(STATUS, f"{it['id']}.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as fh:
                st = json.load(fh)
        rows.append((it["id"], it["state"], st.get("phase", "-"),
                     st.get("agent", "-"), ago(st.get("updated")),
                     (st.get("note") or "")[:60]))
    rows.sort(key=lambda r: (r[1], r[0]))
    print(f"{'ID':<14}{'state':<24}{'phase':<14}{'agent':<22}{'upd':>6}  note")
    for r in rows:
        print(f"{r[0]:<14}{r[1]:<24}{r[2]:<14}{r[3]:<22}{r[4]:>6}  {r[5]}")
    print(f"\n{len(rows)} items shown")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    if cmd == "init":
        src = sys.argv[2]
        os.makedirs(DF1_HOME, exist_ok=True)
        for d in ("status", "leases", "events", "queue"):
            os.makedirs(os.path.join(DF1_HOME, d), exist_ok=True)
        if not os.path.exists(ITEMS):
            with open(src, encoding="utf-8") as fh:
                q = json.load(fh)
            save_items(q)
            log({"event": "INIT", "items": len(q["items"])})
            print(f"initialized {ITEMS} with {len(q['items'])} items")
        else:
            print("already initialized; not overwriting")
    elif cmd == "claim":
        iid, agent = sys.argv[2], sys.argv[3]
        q = load_items()
        it = find(q, iid)
        if it["state"] not in ("queued", "blocked"):
            raise SystemExit(f"{iid} not claimable (state={it['state']})")
        it["state"] = "claimed"
        save_items(q)
        log({"event": "LAUNCHED", "item": iid, "agent": agent})
        set_status(iid, {"agent": agent, "phase": "launched", "note": ""})
        print(f"{iid} claimed by {agent}")
    elif cmd == "update":
        iid = sys.argv[2]
        fields = json.loads(urllib.parse.unquote(sys.argv[3]))
        cur = set_status(iid, fields)
        if "state" in fields:
            q = load_items()
            it = find(q, iid)
            it["state"] = fields["state"]
            save_items(q)
        if fields.get("terminal"):
            log({"event": fields["terminal"], "item": iid,
                 "agent": cur.get("agent"), "note": fields.get("note", "")})
        print("ok")
    elif cmd == "requeue":
        iid, reason = sys.argv[2], sys.argv[3]
        q = load_items()
        it = find(q, iid)
        prev = it["state"]
        it["state"] = "queued"
        save_items(q)
        log({"event": "REQUEUED", "item": iid, "from": prev, "reason": reason})
        set_status(iid, {"phase": "requeued", "note": reason[:120],
                         "terminal": "REQUEUED"})
        print(f"{iid} requeued ({prev} -> queued): {reason}")
    elif cmd == "set-state":
        # set-state <ID> <state> [note]
        iid, state = sys.argv[2], sys.argv[3]
        if state not in OK_STATES:
            raise SystemExit(f"bad state {state}; ok: {sorted(OK_STATES)}")
        note = sys.argv[4] if len(sys.argv) > 4 else ""
        q = load_items()
        it = find(q, iid)
        prev = it["state"]
        it["state"] = state
        save_items(q)
        log({"event": "STATE", "item": iid, "from": prev, "to": state,
             "note": note[:160]})
        set_status(iid, {"note": note[:120]})
        print(f"{iid}: {prev} -> {state}")
    elif cmd == "report":
        states = sys.argv[sys.argv.index("--states") + 1].split(",") \
            if "--states" in sys.argv else None
        cmd_report(states)
    elif cmd == "events":
        n = int(sys.argv[sys.argv.index("--last") + 1]) \
            if "--last" in sys.argv else 20
        with open(EVENTS, encoding="utf-8") as fh:
            lines = fh.readlines()
        for ln in lines[-n:]:
            print(ln, end="")
    elif cmd == "item":
        iid = sys.argv[2]
        q = load_items()
        it = find(q, iid)
        p = os.path.join(STATUS, f"{iid}.json")
        st = {}
        if os.path.exists(p):
            with open(p, encoding="utf-8") as fh:
                st = json.load(fh)
        print(json.dumps({"queue": it, "status": st}, indent=2))
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
