#!/usr/bin/env python3
"""Darkforge work-source adapter: freshell bug katas on dandesktop, pulled over SSH.

Implements the Darkforge custom source protocol: one JSON request on stdin,
one JSON response on stdout. Actions: next, complete, report.

Serves open, ready (unblocked) issues from kata project `freshell` that look
like bugs (label `bug` or title prefix `[bug]`), in priority order. Served
issues are claimed as actor "darkforge" so no other actor picks them up.
`complete` closes the issue with the landed SHA as evidence; `report` leaves
a non-convergence comment, labels it df-nonconvergent (permanently excluded
from future `next` results), and unassigns it.
"""

import json
import shlex
import subprocess
import sys

SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "dandesktop"]
PROJECT = "freshell"
ACTOR = "darkforge"
NONCONV_LABEL = "df-nonconvergent"
MAX_COMMENTS_CHARS = 8000


def kata(*args, check=True):
    # dandesktop's ssh default shell is PowerShell, which mangles multi-word
    # quoted arguments in the remote command string. Feeding the script over
    # stdin to a bare `bash` avoids every intermediate quoting layer: only the
    # remote bash parses it.
    script = "kata " + " ".join(shlex.quote(a) for a in args) + "\n"
    r = subprocess.run(SSH + ["bash"], input=script, capture_output=True, text=True, timeout=180)
    if check and not kata_ok(r):
        raise RuntimeError(
            f"kata {' '.join(args)} rc={r.returncode}: "
            f"{(r.stderr or r.stdout).strip()[:500]}"
        )
    return r


def kata_ok(r):
    """kata exits 0 even on errors; detect the error envelopes instead."""
    if r.returncode != 0:
        return False
    out = r.stdout.strip()
    if out.startswith("{"):
        try:
            if "error" in json.loads(out):
                return False
        except json.JSONDecodeError:
            pass
    for line in (r.stderr + "\n" + r.stdout).splitlines():
        if line.startswith("kata: "):  # cobra-style fatal error line
            return False
    return True


def kata_json(*args):
    return json.loads(kata(*args, "--json").stdout)


def is_bug(issue):
    labels = issue.get("labels") or []
    return "bug" in labels or issue["title"].strip().lower().startswith("[bug]")


def api_ready_issues():
    return kata_json("ready", "--project", PROJECT).get("issues", [])


def issue_status(ref):
    """Return 'open'/'closed'/etc, or None if the issue can't be read."""
    r = kata("show", ref, "--project", PROJECT, "--json", check=False)
    if not kata_ok(r):
        return None
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        return None
    issue = data.get("issue") or data
    return issue.get("status")


def issue_comments(ref):
    r = kata("show", ref, "--project", PROJECT, "--json", check=False)
    if not kata_ok(r):
        return []
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        return []
    comments = data.get("comments") or []
    out = []
    for c in comments:
        author = c.get("author", "?")
        body = (c.get("body") or "").strip()
        if body:
            out.append(f"--- comment by {author} ---\n{body}")
    return out


def try_claim(ref):
    """Claim ref as ACTOR. Idempotent for our own actor; False if owned by another."""
    r = kata(
        "claim",
        ref,
        "--project",
        PROJECT,
        f"--as={ACTOR}",
        check=False,
    )
    if kata_ok(r):
        return True
    msg = (r.stderr or r.stdout).strip().lower()
    if "already owned" in msg and ACTOR in msg:
        return True
    return False


def action_next(req):
    known = set(req.get("known") or [])
    issues = api_ready_issues()
    issues.sort(key=lambda i: (i.get("priority", 3), i.get("created_at", "")))
    for issue in issues:
        sid = issue["short_id"]
        if sid in known or not is_bug(issue):
            continue
        labels = issue.get("labels") or []
        if NONCONV_LABEL in labels:
            continue
        owner = issue.get("owner") or ""
        if owner and owner != ACTOR:
            continue
        if not try_claim(sid):
            continue
        comments = issue_comments(sid)
        instructions = (
            f"# kata {issue.get('qualified_id', 'freshell#' + sid)}: {issue['title']}\n\n"
            f"{issue.get('body') or '(no body)'}\n"
        )
        if comments:
            blob = "\n\n".join(comments)
            if len(blob) > MAX_COMMENTS_CHARS:
                blob = blob[:MAX_COMMENTS_CHARS] + "\n...(comments truncated)"
            instructions += f"\n## Issue comments\n\n{blob}\n"
        return {
            "work": {
                "id": sid,
                "ref": issue.get("qualified_id", f"freshell#{sid}"),
                "title": issue["title"],
                "instructions": instructions,
                "raw": {"kata_issue": issue},
                "oracle": "npm run check",
            }
        }
    return {"work": None}


def action_complete(req):
    work = req["work"]
    sid = work["id"]
    sha = req.get("sha") or "unknown"
    if issue_status(sid) == "closed":
        return {}  # idempotent retry after a successful close
    kata(
        "close",
        sid,
        "--project",
        PROJECT,
        "--reason=done",
        f"--evidence=commit:{sha}",
        "--message=Fixed and landed by Darkforge factory (owner worktree QA: npm run check).",
        f"--as={ACTOR}",
    )
    return {}


# Kernel-authored relaunch-budget suspensions (provider storms etc.) look like
# this — they are transient infrastructure failures, not real non-convergence.
KERNEL_STORM_MARKERS = ("relaunch budget", "kernel launched the owner")


def action_report(req):
    work = req["work"]
    sid = work["id"]
    report = req.get("report") or {}
    summary = (report.get("summary") or "").strip()
    evidence = report.get("evidence") or []
    report_blob = json.dumps(report).lower()
    storm = any(m in report_blob for m in KERNEL_STORM_MARKERS)
    if storm:
        body = (
            "Darkforge kernel suspended this job after hitting the relaunch budget "
            "(repeated owner-process deaths, typically provider connectivity). "
            "This is NOT a work-item non-convergence; the job can be resumed. "
            f"Detail: {(summary or 'relaunch budget exhausted')[:800]}"
        )
        kata("comment", sid, "--project", PROJECT, f"--body={body}", f"--as={ACTOR}", check=False)
        return {}
    body = (
        "Darkforge owner reported non-convergence; parked for human attention.\n\n"
        f"Summary: {(summary or 'no summary')[:4000]}\n"
    )
    if evidence:
        body += "\nEvidence:\n" + "\n".join(f"- {str(e)[:300]}" for e in evidence[:20])
    kata("comment", sid, "--project", PROJECT, f"--body={body}", f"--as={ACTOR}", check=False)
    kata("edit", sid, "--project", PROJECT, f"--label={NONCONV_LABEL}", f"--as={ACTOR}", check=False)
    kata("unassign", sid, "--project", PROJECT, f"--as={ACTOR}", check=False)
    return {}


def main():
    try:
        req = json.load(sys.stdin)
        action = req.get("action")
        if action == "next":
            resp = action_next(req)
        elif action == "complete":
            resp = action_complete(req)
        elif action == "report":
            resp = action_report(req)
        else:
            raise RuntimeError(f"unknown action: {action!r}")
        json.dump(resp, sys.stdout)
        sys.stdout.write("\n")
    except Exception as e:
        print(f"kata-freshell adapter: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
