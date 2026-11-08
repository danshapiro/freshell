#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/home/dan/.nvm/versions/node/v22.21.1/bin:/home/dan/.cargo/bin:/home/dan/.local/bin:$PATH
packet=/home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi
source=/home/dan/code/freshell/.worktrees/.base-gate-242209
export FRESHELL_BUILD_COMMIT=20dbddf53d831c2fbcebdac294d67cc262c57838
export FRESHELL_BUILD_SOURCE_STATE=20dbddf53-clean
exec > "$packet/logs/runtime-image-build.log" 2>&1
export DOCKER_HOST=unix:///run/user/1000/docker.sock
unset DOCKER_CONTEXT
cd "$packet/source"
docker build --progress=plain --label org.opencontainers.image.revision="$FRESHELL_BUILD_COMMIT" --label org.opencontainers.image.source-tree=1f832415bf5a58d8841a94c0d3dfaf1763336f7b -f docker/runtime/Dockerfile --iidfile "$packet/candidate/runtime-image.id" -t freshell-runtime:staged-20dbddf53-6d9ay0yi .
image_id="$(cat "$packet/candidate/runtime-image.id")"
docker image inspect "$image_id" --format '{{json .}}' > "$packet/candidate/runtime-image-inspect.json"
docker run --rm --network none --label com.freshell.deployment-check=prepare-20dbddf53-6d9ay0yi --entrypoint /usr/local/bin/node "$image_id" -e 'const fs=require("node:fs");const p="/opt/freshell-claude-sidecar/native-checkpoint-admission.mjs";if(!fs.existsSync(p))throw Error("Updated sidecar module missing");const sdk=JSON.parse(fs.readFileSync("/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json","utf8"));console.log(JSON.stringify({node:process.version,platform:process.platform,sidecarNativeCheckpointModule:true,claudeSdk:sdk.version}));' > "$packet/candidate/runtime-image-probe.json"
python3 - <<'VERIFY'
from pathlib import Path
import json,datetime,os
packet=Path('/home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi');c=packet/'candidate'
d=json.loads((c/'runtime-image-inspect.json').read_text());probe=json.loads((c/'runtime-image-probe.json').read_text());commit='20dbddf53d831c2fbcebdac294d67cc262c57838'
assert d['Id']==(c/'runtime-image.id').read_text().strip()
assert d['Os']=='linux' and d['Architecture']=='amd64'
assert d['Config']['Labels']['org.opencontainers.image.revision']==commit
assert probe['sidecarNativeCheckpointModule'] and probe['claudeSdk']=='0.3.237'
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commit':commit,'imageId':d['Id'],'imageCreated':d['Created'],'architecture':d['Architecture'],'probe':probe,'status':'runtime-image-ready'}
p=c/'runtime-image-ready.json';p.write_text(json.dumps(record,indent=2));os.chmod(p,0o600)
print(json.dumps(record,indent=2))
VERIFY
