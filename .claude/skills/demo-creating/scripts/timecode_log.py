#!/usr/bin/env python3
"""Append machine-readable timecode events for live demos.

Usage examples:
  scripts/timecode_log.py start --timeline demo/timecodes.jsonl --label "synth-demo"
  scripts/timecode_log.py begin --timeline demo/timecodes.jsonl --event coding --id synth --desc "Start coding"
  scripts/timecode_log.py end --timeline demo/timecodes.jsonl --event coding --id synth --desc "Finish coding"
  scripts/timecode_log.py begin --timeline demo/timecodes.jsonl --event think_pause --id p1 --desc "Pause to plan next step"
  scripts/timecode_log.py end --timeline demo/timecodes.jsonl --event think_pause --id p1 --desc "Resume typing"
  scripts/timecode_log.py begin --timeline demo/timecodes.jsonl --event layout_drag --id drag-1 --desc "Start dragging pane divider"
  scripts/timecode_log.py end --timeline demo/timecodes.jsonl --event layout_drag --id drag-1 --desc "Stop dragging pane divider"
  scripts/timecode_log.py note-on --timeline demo/timecodes.jsonl --note C4
  scripts/timecode_log.py note-off --timeline demo/timecodes.jsonl --note C4
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn

TIMELINE_VERSION = 1


@dataclass
class State:
    path: Path
    data: dict[str, Any]


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_meta(meta_pairs: list[str]) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    for item in meta_pairs:
        if "=" not in item:
            fail(f"invalid --meta '{item}' (expected key=value)")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            fail(f"invalid --meta '{item}' (missing key)")
        meta[key] = auto_cast(value.strip())
    return meta


def auto_cast(value: str) -> Any:
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    if value.lower() == "null":
        return None
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return value


def state_path_for_timeline(timeline: Path) -> Path:
    return timeline.with_suffix(f"{timeline.suffix}.state.json")


def load_state(timeline: Path) -> State:
    path = state_path_for_timeline(timeline)
    if not path.exists():
        fail(f"state file not found for timeline '{timeline}'. Run 'start' first.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"invalid state JSON in '{path}': {exc}")
    return State(path=path, data=data)


def save_state(state: State) -> None:
    state.path.write_text(json.dumps(state.data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def current_t_ms(state_data: dict[str, Any]) -> int:
    start_ns = int(state_data["start_monotonic_ns"])
    elapsed_ns = time.monotonic_ns() - start_ns
    return int(round(elapsed_ns / 1_000_000))


def timeline_parent(timeline: Path) -> None:
    timeline.parent.mkdir(parents=True, exist_ok=True)


def emit_event(
    timeline: Path,
    state: State,
    *,
    kind: str,
    event: str,
    desc: str,
    event_id: str | None,
    meta: dict[str, Any],
    forced_t_ms: int | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    seq = int(state.data["next_seq"])
    t_ms = forced_t_ms if forced_t_ms is not None else current_t_ms(state.data)

    record: dict[str, Any] = {
        "v": TIMELINE_VERSION,
        "session_id": state.data["session_id"],
        "seq": seq,
        "ts_utc": utc_now(),
        "t_ms": t_ms,
        "kind": kind,
        "event": event,
        "desc": desc,
    }
    if event_id:
        record["id"] = event_id
    if meta:
        record["meta"] = meta
    if extra:
        record.update(extra)

    with timeline.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, separators=(",", ":")) + "\n")

    state.data["next_seq"] = seq + 1
    save_state(state)
    return record


def open_key(event: str, event_id: str | None) -> str:
    return f"{event}::{event_id or '_'}"


def resolve_open_key(open_events: dict[str, Any], event: str, event_id: str | None) -> str:
    if event_id:
        key = open_key(event, event_id)
        if key not in open_events:
            fail(f"no open begin event for event='{event}' id='{event_id}'")
        return key

    matches = [k for k in open_events if k.startswith(f"{event}::")]
    if not matches:
        fail(f"no open begin event for event='{event}'")
    if len(matches) > 1:
        fail(f"multiple open '{event}' events; pass --id explicitly")
    return matches[0]


def command_start(args: argparse.Namespace) -> None:
    timeline = Path(args.timeline)
    state_file = state_path_for_timeline(timeline)

    timeline_parent(timeline)

    if (timeline.exists() or state_file.exists()) and not args.reset:
        fail(
            f"timeline '{timeline}' already exists. Use --reset to start a new recording session."
        )

    if args.reset:
        if timeline.exists():
            timeline.unlink()
        if state_file.exists():
            state_file.unlink()

    session_id = args.session_id or str(uuid.uuid4())
    state = State(
        path=state_file,
        data={
            "v": TIMELINE_VERSION,
            "session_id": session_id,
            "label": args.label,
            "created_at_utc": utc_now(),
            "start_monotonic_ns": time.monotonic_ns(),
            "next_seq": 1,
            "open_events": {},
            "last_note_end_t_ms": None,
        },
    )

    save_state(state)

    meta = {"label": args.label} if args.label else {}
    record = emit_event(
        timeline,
        state,
        kind="point",
        event="session_start",
        desc=args.desc,
        event_id=None,
        meta=meta,
        forced_t_ms=0,
    )

    print(json.dumps({"timeline": str(timeline), "state": str(state_file), "record": record}, indent=2))


def command_point(args: argparse.Namespace) -> None:
    timeline = Path(args.timeline)
    state = load_state(timeline)
    meta = parse_meta(args.meta)
    record = emit_event(
        timeline,
        state,
        kind="point",
        event=args.event,
        desc=args.desc,
        event_id=args.id,
        meta=meta,
    )
    print(json.dumps(record, indent=2))


def command_begin(args: argparse.Namespace) -> None:
    timeline = Path(args.timeline)
    state = load_state(timeline)
    opens = state.data.setdefault("open_events", {})

    key = open_key(args.event, args.id)
    if key in opens:
        fail(f"event already open for event='{args.event}' id='{args.id or '_'}'")

    meta = parse_meta(args.meta)
    t_ms = current_t_ms(state.data)
    extra: dict[str, Any] = {}

    if args.event == "note" and state.data.get("last_note_end_t_ms") is not None:
        gap = max(0, t_ms - int(state.data["last_note_end_t_ms"]))
        extra["gap_since_prev_note_ms"] = gap

    record = emit_event(
        timeline,
        state,
        kind="begin",
        event=args.event,
        desc=args.desc,
        event_id=args.id,
        meta=meta,
        forced_t_ms=t_ms,
        extra=extra,
    )

    opens[key] = {
        "event": args.event,
        "id": args.id,
        "start_seq": record["seq"],
        "start_t_ms": record["t_ms"],
    }
    save_state(state)
    print(json.dumps(record, indent=2))


def command_end(args: argparse.Namespace) -> None:
    timeline = Path(args.timeline)
    state = load_state(timeline)
    opens = state.data.setdefault("open_events", {})

    key = resolve_open_key(opens, args.event, args.id)
    started = opens.pop(key)

    t_ms = current_t_ms(state.data)
    start_t = int(started["start_t_ms"])
    duration_ms = max(0, t_ms - start_t)

    meta = parse_meta(args.meta)
    extra = {
        "duration_ms": duration_ms,
        "start_seq": int(started["start_seq"]),
        "start_t_ms": start_t,
    }

    record = emit_event(
        timeline,
        state,
        kind="end",
        event=args.event,
        desc=args.desc,
        event_id=started.get("id"),
        meta=meta,
        forced_t_ms=t_ms,
        extra=extra,
    )

    if args.event == "note":
        state.data["last_note_end_t_ms"] = t_ms
        save_state(state)

    print(json.dumps(record, indent=2))


def command_note_on(args: argparse.Namespace) -> None:
    ns = argparse.Namespace(
        timeline=args.timeline,
        event="note",
        id=args.note,
        desc=args.desc,
        meta=args.meta,
    )
    command_begin(ns)


def command_note_off(args: argparse.Namespace) -> None:
    ns = argparse.Namespace(
        timeline=args.timeline,
        event="note",
        id=args.note,
        desc=args.desc,
        meta=args.meta,
    )
    command_end(ns)


def command_validate(args: argparse.Namespace) -> None:
    timeline = Path(args.timeline)
    state = load_state(timeline)

    if not timeline.exists():
        fail(f"timeline file not found: {timeline}")

    lines = timeline.read_text(encoding="utf-8").splitlines()
    if not lines:
        fail("timeline is empty")

    last_seq = 0
    for idx, line in enumerate(lines, start=1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            fail(f"invalid JSON on line {idx}: {exc}")

        seq = int(event.get("seq", 0))
        if seq <= last_seq:
            fail(f"sequence order issue on line {idx}: seq={seq}, last_seq={last_seq}")
        last_seq = seq

        for required in ("kind", "event", "desc", "t_ms", "ts_utc", "session_id"):
            if required not in event:
                fail(f"missing required field '{required}' on line {idx}")

    open_events = state.data.get("open_events", {})
    if open_events:
        fail(f"open events still active: {json.dumps(open_events, sort_keys=True)}")

    print(
        json.dumps(
            {
                "timeline": str(timeline),
                "events": len(lines),
                "last_seq": last_seq,
                "status": "ok",
            },
            indent=2,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Log precise timecodes for demo recordings")
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start", help="Initialize a new timeline and state file")
    start.add_argument("--timeline", required=True, help="Path to timeline JSONL output")
    start.add_argument("--label", default="", help="Optional label for the recording session")
    start.add_argument("--session-id", default="", help="Optional explicit session id")
    start.add_argument("--desc", default="Recording session started", help="Description for session_start")
    start.add_argument("--reset", action="store_true", help="Overwrite existing timeline and state")
    start.set_defaults(func=command_start)

    for name, help_text, handler in (
        ("point", "Log a point-in-time event", command_point),
        ("begin", "Log the beginning of a duration event", command_begin),
        ("end", "Log the ending of a duration event", command_end),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--timeline", required=True, help="Path to timeline JSONL output")
        p.add_argument("--event", required=True, help="Event type (e.g. coding, think_pause, layout_drag, note)")
        p.add_argument("--id", default="", help="Optional event id for pairing begin/end")
        p.add_argument("--desc", required=True, help="Short human-readable description")
        p.add_argument("--meta", action="append", default=[], help="Extra key=value metadata (repeatable)")
        p.set_defaults(func=handler)

    note_on = sub.add_parser("note-on", help="Convenience wrapper for begin --event note")
    note_on.add_argument("--timeline", required=True, help="Path to timeline JSONL output")
    note_on.add_argument("--note", required=True, help="Note identifier (e.g. C4, F#3)")
    note_on.add_argument("--desc", default="Note on", help="Description")
    note_on.add_argument("--meta", action="append", default=[], help="Extra key=value metadata (repeatable)")
    note_on.set_defaults(func=command_note_on)

    note_off = sub.add_parser("note-off", help="Convenience wrapper for end --event note")
    note_off.add_argument("--timeline", required=True, help="Path to timeline JSONL output")
    note_off.add_argument("--note", required=True, help="Note identifier (e.g. C4, F#3)")
    note_off.add_argument("--desc", default="Note off", help="Description")
    note_off.add_argument("--meta", action="append", default=[], help="Extra key=value metadata (repeatable)")
    note_off.set_defaults(func=command_note_off)

    validate = sub.add_parser("validate", help="Check timeline integrity before video editing")
    validate.add_argument("--timeline", required=True, help="Path to timeline JSONL output")
    validate.set_defaults(func=command_validate)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if not hasattr(args, "func"):
        parser.print_help()
        raise SystemExit(2)
    args.func(args)


if __name__ == "__main__":
    main()
