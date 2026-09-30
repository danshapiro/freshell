#!/usr/bin/env bash
set -euo pipefail

probe_root=$(mktemp -d)
trap 'rm -rf "$probe_root"' EXIT
mkdir -p "$probe_root/home/.config/opencode/plugin" "$probe_root/project/.opencode"

cat > "$probe_root/home/.config/opencode/opencode.json" <<'JSON'
{"model":"global-json","mcp":{"global_json":{"type":"remote","url":"http://127.0.0.1:4101"}}}
JSON
cat > "$probe_root/home/.config/opencode/opencode.jsonc" <<'JSONC'
{ // user global JSONC
  "model":"global-jsonc",
  "mcp":{"global_jsonc":{"type":"remote","url":"http://127.0.0.1:4102"}},
}
JSONC
cat > "$probe_root/project/opencode.json" <<'JSON'
{"model":"root-json","mcp":{"root_json":{"type":"remote","url":"http://127.0.0.1:4105"}}}
JSON
cat > "$probe_root/project/opencode.jsonc" <<'JSONC'
{ // root project JSONC
  "model":"root-jsonc",
  "mcp":{"root_jsonc":{"type":"remote","url":"http://127.0.0.1:4106"}},
}
JSONC
cat > "$probe_root/project/.opencode/opencode.json" <<'JSON'
{"model":"project-json","mcp":{"project_json":{"type":"remote","url":"http://127.0.0.1:4103"}}}
JSON
cat > "$probe_root/project/.opencode/opencode.jsonc" <<'JSONC'
{ // user project JSONC
  "model":"project-jsonc",
  "mcp":{"project_jsonc":{"type":"remote","url":"http://127.0.0.1:4104"}},
  "plugin":["file:///tmp/opencode-parity/home/.config/opencode/plugin/marker.js"],
}
JSONC
cat > "$probe_root/home/.config/opencode/plugin/marker.js" <<'JS'
import { writeFileSync } from 'node:fs'
writeFileSync('/tmp/opencode-parity/plugin-executed', 'yes')
export const Marker = async () => ({})
JS

# OpenCode 1.18.21's debug command has no --cwd option. Its effective
# directory is the shell cwd, so enter the fixture before invoking it.
docker run --rm --entrypoint sh \
  --mount "type=bind,src=$probe_root,dst=/tmp/opencode-parity" \
  freshell-managed-runtime:provider-parity \
  -lc 'cd /tmp/opencode-parity/project && HOME=/tmp/opencode-parity/home XDG_CONFIG_HOME=/tmp/opencode-parity/home/.config opencode debug config' \
  > "$probe_root/effective.json"

python3 - "$probe_root" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
config = json.loads((root / 'effective.json').read_text())
assert config['model'] == 'project-jsonc', config.get('model')
assert set(config['mcp']) >= {'global_json', 'global_jsonc', 'root_json', 'root_jsonc', 'project_json', 'project_jsonc'}
assert any('marker.js' in plugin for plugin in config['plugin'])
assert (root / 'plugin-executed').read_text() == 'yes'
print('OpenCode 1.18.21: global, root, and .opencode JSON/JSONC merge; project JSONC wins; plugin executed')
PY
