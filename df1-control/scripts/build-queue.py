#!/usr/bin/env python3
"""Generate the df1 work queue (items.json) from the parity checklist.

Parses docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md for
checkbox items and classifies each with the static tables below (checked set,
host-limited set, dependency hints) derived from
docs/plans/2026-07-18-checklist-reconciliation.md.

Output: JSON array, one object per item:
  {id, section, title, checked, hostLimited, deps[], hardGates[],
   state: "done"|"host-limited"|"queued", pwMode: null}

`pwMode` is deliberately left null -- the orchestrator assigns
"self-verify" | "deferred" per item at launch time (see df1-control/README.md
"Deferred Playwright policy").

Usage: build-queue.py [path-to-checklist] > items.json
"""
import json
import re
import sys

CHECKLIST = sys.argv[1] if len(sys.argv) > 1 else (
    "docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md")

# Items already checked in the checklist (states verified 2026-08-08).
CHECKED = {
    "HARNESS-01", "HARNESS-02", "SESSION-10", "TERM-02", "TERM-18",
    "TERM-28", "AGENT-08",
}

# Items whose acceptance requires a native-Windows / packaged / Electron lane
# this Linux host cannot provide (reconciliation doc class H).
HOST_LIMITED = (
    {f"TAURI-{i:02d}" for i in range(1, 31)}
    | {f"PACKAGE-{i:02d}" for i in range(1, 5)}
    | {f"UPDATE-{i:02d}" for i in range(1, 6)}
    | {f"MIGRATE-{i:02d}" for i in range(1, 14)}
    | {"HARNESS-07", "HARNESS-08", "HARNESS-09", "HARNESS-10", "HARNESS-13",
       "CFG-05", "TERM-20", "TERM-26", "FILE-02",
       "NET-04", "NET-05", "NET-07", "GATE-02", "GATE-03"}
)

# Dependency hints (soft; scheduler ordering only). Cheap items blocked on the
# missing harnesses per the reconciliation doc.
DEPS = {
    "TERM-19": ["HARNESS-05"], "SAFE-05": ["HARNESS-05"],
    "SAFE-07": ["HARNESS-05"], "AUTO-12": ["HARNESS-05"],
    "TERM-11": ["HARNESS-14"], "SAFE-02": ["HARNESS-14"],
    "AUTO-15": ["HARNESS-14", "CFG-08"],
    "GATE-07": ["HARNESS-11"],
    "SYNC-05": ["TERM-22", "SAFE-11"],
    "SESSION-18": ["EXT-01"],
    "EXT-10": ["TERM-27", "SESSION-01"],
    "GATE-01": [],  # effectively all; handled by phase ordering
}
# Items whose PW validation names the `stress project` (which doesn't exist yet).
NEEDS_STRESS = {"TERM-09", "TERM-22", "SESSION-20", "SAFE-12"}

item_re = re.compile(
    r"^- \[(?P<mark>[ x])\] \*\*(?:PARTIAL — )?(?P<id>[A-Z]+-\d+) — (?P<title>.+?)\*\*")
section_re = re.compile(r"^##+ (?P<sec>.+)$")

items, section = [], "?"
with open(CHECKLIST, encoding="utf-8") as fh:
    for line in fh:
        m = section_re.match(line)
        if m:
            section = m.group("sec").strip()
        m = item_re.match(line)
        if not m:
            continue
        iid, checked = m.group("id"), m.group("mark") == "x"
        items.append({
            "id": iid,
            "section": section,
            "title": m.group("title").strip(),
            "checked": checked,
            "hostLimited": iid in HOST_LIMITED,
            "deps": DEPS.get(iid, []),
            "hardGates": (["stress-project"] if iid in NEEDS_STRESS else []),
            "state": ("done" if checked
                      else "host-limited" if iid in HOST_LIMITED else "queued"),
            "pwMode": None,
        })

ids = [i["id"] for i in items]
dups = sorted({i for i in ids if ids.count(i) > 1})
queue = {
    "source": CHECKLIST,
    "generatedBy": "df1-control/scripts/build-queue.py",
    "counts": {
        "total": len(items),
        "checked": sum(1 for i in items if i["checked"]),
        "hostLimited": sum(1 for i in items if i["hostLimited"] and not i["checked"]),
        "queued": sum(1 for i in items if i["state"] == "queued"),
    },
    "duplicateIds": dups,
    "items": items,
}
json.dump(queue, sys.stdout, indent=2)
print(file=sys.stderr)  # noqa: T201
print(f"total={len(items)} queued={queue['counts']['queued']} "
      f"hostLimited={queue['counts']['hostLimited']} checked={queue['counts']['checked']} "
      f"dups={dups}", file=sys.stderr)
