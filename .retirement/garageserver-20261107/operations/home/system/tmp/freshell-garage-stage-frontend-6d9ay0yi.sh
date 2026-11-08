#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/home/dan/.nvm/versions/node/v22.21.1/bin:/home/dan/.cargo/bin:/home/dan/.local/bin:$PATH
packet=/home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi
source=/home/dan/code/freshell/.worktrees/.base-gate-242209
export FRESHELL_BUILD_COMMIT=20dbddf53d831c2fbcebdac294d67cc262c57838
export FRESHELL_BUILD_SOURCE_STATE=20dbddf53-clean
exec > "$packet/logs/client-tools-sidecar-build.log" 2>&1
cd "$source"
test "$(git rev-parse HEAD)" = "$FRESHELL_BUILD_COMMIT"
pnpm run typecheck:client
pnpm run build:client --outDir "$packet/candidate/client"
pnpm run build:tools --outDir "$packet/candidate/tools"
pnpm --filter freshell-claude-sidecar --prod --frozen-lockfile --config.node-linker=hoisted deploy "$packet/candidate/claude-sidecar"
node --check "$packet/candidate/claude-sidecar/index.mjs"
node --check "$packet/candidate/claude-sidecar/native-checkpoint-admission.mjs"
python3 - <<'VERIFY'
from pathlib import Path
import json,hashlib,datetime,os
packet=Path('/home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi');candidate=packet/'candidate';commit='20dbddf53d831c2fbcebdac294d67cc262c57838'
assert (candidate/'client/index.html').is_file()
assert any(commit in p.read_text() for p in (candidate/'client/assets').glob('index-*.js'))
sidecar=candidate/'claude-sidecar';assert (sidecar/'native-checkpoint-admission.mjs').is_file()
for p in sidecar.rglob('*'):
 if p.is_symlink():assert p.resolve().is_relative_to(sidecar),p
sdk=sidecar/'node_modules/@anthropic-ai/claude-agent-sdk/package.json';sdk_metadata=json.loads(sdk.read_text());assert sdk_metadata['version']=='0.3.237',sdk_metadata['version']
artifacts={}
for component in ['client','tools','claude-sidecar']:
 directory=candidate/component;files=[]
 for p in sorted(directory.rglob('*')):
  if p.is_file():files.append((p.relative_to(directory).as_posix(),hashlib.file_digest(p.open('rb'),'sha256').hexdigest()))
 digest=hashlib.sha256(json.dumps(files,separators=(',',':')).encode()).hexdigest()
 artifacts[component]={'path':str(directory),'files':len(files),'manifestSha256':digest}
 manifest=candidate/(component+'-manifest.json');manifest.write_text(json.dumps(files,indent=2));os.chmod(manifest,0o600)
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commit':commit,'pnpm':'10.34.5','claudeSdk':sdk_metadata['version'],'artifacts':artifacts,'status':'client-tools-sidecar-ready'}
p=candidate/'client-tools-sidecar-ready.json';p.write_text(json.dumps(record,indent=2));os.chmod(p,0o600)
print(json.dumps(record,indent=2))
VERIFY
