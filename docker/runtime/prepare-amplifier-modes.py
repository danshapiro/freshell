"""Bind the packaged ordinary modes behavior to its installed pinned modules."""

from pathlib import Path
import yaml

path = Path("/opt/amplifier-modes/behaviors/modes.yaml")
behavior = yaml.safe_load(path.read_text())
sources = {
    "hooks-mode": "file:///opt/amplifier-modes#subdirectory=modules/hooks-mode",
    "tool-mode": "file:///opt/amplifier-modes#subdirectory=modules/tool-mode",
    "hooks-approval": "file:///opt/amplifier-hooks-approval",
}
seen = set()
for group in ("hooks", "tools"):
    for row in behavior[group]:
        name = row["module"]
        if name in sources:
            row["source"] = sources[name]
            seen.add(name)
if seen != sources.keys():
    raise ValueError("pinned ordinary modes module set changed")
path.write_text(yaml.safe_dump(behavior, sort_keys=False))
