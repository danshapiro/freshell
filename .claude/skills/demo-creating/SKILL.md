---
name: demo-creating
description: "Use when producing screen-recorded demos that need scenario-specific pane layouts, live interaction walkthroughs, and machine-readable timecodes for automated video editing."
---

# Demo Creating

## Overview

Produce polished demos that show the full workflow: build, stage, run, and interact.
Choose pane layout based on demo story, not a single fixed arrangement.
Always record precise timecodes so post-editing can speed up non-critical segments and keep key interactions real-time.

## Output Contract

Deliver all of the following:

1. A working demo artifact shown live in the primary showcase pane (`browser`, `editor`, or `terminal`, depending on scenario).
2. A clean, purpose-fit pane layout for the chosen demo narrative.
3. A validated timecode file (`demo/timecodes.jsonl`) with short, meaningful descriptions.
4. Logged timing for coding, thinking pauses, pane/layout adjustments, and each showcased interaction.

## Quick Start

```bash
# Skill-local logger path
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/demo-creating"
TIMELOG="$SKILL_ROOT/scripts/timecode_log.py"
TL="demo/timecodes.jsonl"

# Initialize timeline
$TIMELOG start --timeline "$TL" --label "my-demo" --reset
```

## Layout Selection (Scenario-Driven)

Before arranging panes, decide the story you want viewers to follow.
Log the chosen layout plan:

```bash
$TIMELOG point --timeline "$TL" --event layout_plan --desc "Selected layout profile: <profile-name>"
```

Common profiles:

1. Build + Preview + Runtime:
   - coding pane, browser preview pane, and a short shell pane for server/runtime logs.
2. Multi-Agent Collaboration:
   - coordinator pane, worker-A pane, worker-B pane, plus optional document/browser pane.
3. Debug + Verification:
   - coding pane, failing-test/log pane, and live app pane.

When adjusting divider positions, keep all critical panes readable and visually balanced.
If you drag dividers, log those drags as timed events.

## Example: Build + Preview + Runtime Layout

```bash
FSH="npx tsx server/cli/index.ts"

# Start from one code pane id in $CODE_PANE
BOTTOM_JSON="$($FSH split-pane -t "$CODE_PANE" -v --mode shell)"
BOTTOM_PANE="$(printf '%s' "$BOTTOM_JSON" | jq -r '.data.newPaneId')"

RIGHT_JSON="$($FSH split-pane -t "$CODE_PANE" --browser "http://localhost:5173")"
RIGHT_PANE="$(printf '%s' "$RIGHT_JSON" | jq -r '.data.newPaneId')"

$FSH resize-pane -t "$CODE_PANE" --x 40
$FSH resize-pane -t "$BOTTOM_PANE" --y 22
```

## Example: Coordinator + Two Agents + Document

```bash
FSH="npx tsx server/cli/index.ts"

# Start with coordinator in $COORD_PANE
RIGHT_JSON="$($FSH split-pane -t "$COORD_PANE" --mode codex)"
AGENT_A="$(printf '%s' "$RIGHT_JSON" | jq -r '.data.newPaneId')"

BOTTOM_JSON="$($FSH split-pane -t "$COORD_PANE" -v --mode codex)"
AGENT_B="$(printf '%s' "$BOTTOM_JSON" | jq -r '.data.newPaneId')"

DOC_JSON="$($FSH split-pane -t "$AGENT_A" -v --editor "/absolute/path/to/doc.md")"
DOC_PANE="$(printf '%s' "$DOC_JSON" | jq -r '.data.newPaneId')"
```

## Timecode Workflow

Follow this exact sequence for every demo.

1. Start timeline session.
2. Log chosen layout plan.
3. Log coding begin and end around implementation.
4. Log every intentional thinking pause.
5. Log pane divider drag begin and end while tuning layout.
6. Log runtime lifecycle points when relevant (for example `server_start` and `server_ready`).
7. Log each major interaction block in the primary showcase pane(s).
8. Log domain-specific interaction atoms:
   - synth demo: each note-on and note-off
   - multi-agent demo: each key handoff/sync moment
   - document demo: each major edit/review action
9. Validate timeline before handoff.

### Canonical commands

```bash
# Coding segment
$TIMELOG begin --timeline "$TL" --event coding --id feature --desc "Start implementing feature"
# ... code ...
$TIMELOG end --timeline "$TL" --event coding --id feature --desc "Finish implementation"

# Thinking pause segment
$TIMELOG begin --timeline "$TL" --event think_pause --id p1 --desc "Pause to choose next step"
# ... pause ...
$TIMELOG end --timeline "$TL" --event think_pause --id p1 --desc "Resume work"

# Pane drag segment (real-time visual moment)
$TIMELOG begin --timeline "$TL" --event layout_drag --id drag-1 --desc "Start dragging divider"
# ... drag divider ...
$TIMELOG end --timeline "$TL" --event layout_drag --id drag-1 --desc "Stop dragging divider"

# Runtime lifecycle points (when a server/runtime process is part of the demo)
$TIMELOG point --timeline "$TL" --event server_start --desc "Run dev server in bottom pane"
$TIMELOG point --timeline "$TL" --event server_ready --desc "Server reports ready"

# Interaction block (use IDs/names that match your scenario)
$TIMELOG begin --timeline "$TL" --event demo_interaction --id synth-play --desc "Start synth interaction"
# ... interact in primary showcase pane ...
$TIMELOG end --timeline "$TL" --event demo_interaction --id synth-play --desc "End synth interaction"

# Notes for music demos only (gap since previous note is auto-added)
$TIMELOG note-on  --timeline "$TL" --note C4 --desc "Press C4"
$TIMELOG note-off --timeline "$TL" --note C4 --desc "Release C4"
$TIMELOG note-on  --timeline "$TL" --note E4 --desc "Press E4"
$TIMELOG note-off --timeline "$TL" --note E4 --desc "Release E4"

# Final integrity check
$TIMELOG validate --timeline "$TL"
```

## Logging Standards

Use these standards so the editor can cut automatically:

- Keep descriptions short and action-oriented.
- Use stable core event names: `layout_plan`, `coding`, `think_pause`, `layout_drag`, `demo_interaction`, plus scenario-specific events.
- Pair every `begin` with an `end` using the same `--event` and `--id`.
- Never leave open events in the final file.
- Log before action starts and immediately after action ends.
- Do not batch-log from memory after the fact.

## Validation Gate

A demo is not complete until both pass:

1. Feature demo visually works in the staged layout.
2. `validate` succeeds with no open events.

```bash
$TIMELOG validate --timeline "$TL"
```

For schema and required fields, see `references/timecode-schema.md`.
