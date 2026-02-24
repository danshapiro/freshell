# Timecode Schema (JSONL)

Use one JSON object per line.

## Record fields

- `v` (number): schema version, currently `1`.
- `session_id` (string): stable id for one demo recording session.
- `seq` (number): strictly increasing event sequence number.
- `ts_utc` (string): wall-clock timestamp in UTC ISO-8601.
- `t_ms` (number): elapsed milliseconds from `session_start`.
- `kind` (string): `point`, `begin`, or `end`.
- `event` (string): event type (`coding`, `think_pause`, `layout_drag`, `note`, etc.).
- `id` (string, optional): pair key for `begin` + `end` events.
- `desc` (string): short human-readable description.
- `meta` (object, optional): structured context for downstream editors.

Additional fields emitted on `end` records:

- `duration_ms` (number): duration from matching `begin`.
- `start_seq` (number): `seq` of the matching `begin`.
- `start_t_ms` (number): `t_ms` of the matching `begin`.

Additional field emitted on note `begin` records:

- `gap_since_prev_note_ms` (number): silence gap since previous `note` end.

## Required event coverage for demos

Log these core event groups for each demo clip:

1. `layout_plan` (`point`): chosen pane/story strategy for this specific demo.
2. `coding` (`begin` + `end`): first keystroke to implementation complete.
3. `think_pause` (`begin` + `end`): intentional pauses while deciding next step.
4. `demo_interaction` (`begin` + `end`) around each major showcased interaction.

Log these conditional event groups when applicable:

1. `layout_drag` (`begin` + `end`): only when divider drag/resize is shown.
2. `server_start` and `server_ready` (`point`): only when runtime/server startup is part of the demo.
3. `note` (`begin` + `end`): only for musical/note-based demos.
4. Additional domain-specific begin/end events (for example collaboration handoffs or review passes).

## Example timeline

```json
{"v":1,"session_id":"demo-2026-02-23","seq":1,"ts_utc":"2026-02-23T08:12:01.210Z","t_ms":0,"kind":"point","event":"session_start","desc":"Recording session started"}
{"v":1,"session_id":"demo-2026-02-23","seq":2,"ts_utc":"2026-02-23T08:12:02.000Z","t_ms":790,"kind":"point","event":"layout_plan","desc":"Selected coordinator+agents+document layout"}
{"v":1,"session_id":"demo-2026-02-23","seq":3,"ts_utc":"2026-02-23T08:12:03.500Z","t_ms":2290,"kind":"begin","event":"coding","id":"doc-collab","desc":"Start coding collaboration workflow"}
{"v":1,"session_id":"demo-2026-02-23","seq":4,"ts_utc":"2026-02-23T08:13:49.114Z","t_ms":107904,"kind":"end","event":"coding","id":"doc-collab","desc":"Finish collaboration workflow","duration_ms":105614,"start_seq":3,"start_t_ms":2290}
{"v":1,"session_id":"demo-2026-02-23","seq":5,"ts_utc":"2026-02-23T08:13:50.000Z","t_ms":108790,"kind":"begin","event":"layout_drag","id":"layout-1","desc":"Start dragging pane divider"}
{"v":1,"session_id":"demo-2026-02-23","seq":6,"ts_utc":"2026-02-23T08:13:50.310Z","t_ms":109100,"kind":"end","event":"layout_drag","id":"layout-1","desc":"Stop dragging pane divider","duration_ms":310,"start_seq":5,"start_t_ms":108790}
{"v":1,"session_id":"demo-2026-02-23","seq":7,"ts_utc":"2026-02-23T08:14:10.000Z","t_ms":128790,"kind":"begin","event":"demo_interaction","id":"handoff-1","desc":"Coordinator sends task to agent A"}
{"v":1,"session_id":"demo-2026-02-23","seq":8,"ts_utc":"2026-02-23T08:14:13.000Z","t_ms":131790,"kind":"end","event":"demo_interaction","id":"handoff-1","desc":"Agent A acknowledges task","duration_ms":3000,"start_seq":7,"start_t_ms":128790}
{"v":1,"session_id":"demo-2026-02-23","seq":9,"ts_utc":"2026-02-23T08:14:14.600Z","t_ms":133390,"kind":"begin","event":"note","id":"C4","desc":"Press C4"}
{"v":1,"session_id":"demo-2026-02-23","seq":10,"ts_utc":"2026-02-23T08:14:14.950Z","t_ms":133740,"kind":"end","event":"note","id":"C4","desc":"Release C4","duration_ms":350,"start_seq":9,"start_t_ms":133390}
```

## Validation checks before handing to video editor

- Sequence numbers are strictly increasing.
- `t_ms` never goes backward.
- No open `begin` events remain.
- All core event groups exist.
- Conditional event groups are included when those actions were shown.
- All `desc` fields are concise and descriptive.
