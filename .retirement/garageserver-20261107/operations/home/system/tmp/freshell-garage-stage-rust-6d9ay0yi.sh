#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/home/dan/.nvm/versions/node/v22.21.1/bin:/home/dan/.cargo/bin:/home/dan/.local/bin:$PATH
packet=/home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi
source=/home/dan/code/freshell/.worktrees/.base-gate-242209
export FRESHELL_BUILD_COMMIT=20dbddf53d831c2fbcebdac294d67cc262c57838
export FRESHELL_BUILD_SOURCE_STATE=20dbddf53-clean
exec > "$packet/logs/rust-build.log" 2>&1
cd "$source"
test "$(git rev-parse HEAD)" = "$FRESHELL_BUILD_COMMIT"
test -z "$(git status --porcelain=v1)"
export CARGO_TARGET_DIR="$packet/build-target"
cargo build --release -p freshell-server -p freshell-supervisor -p freshell-session-host --locked --features freshell-server/managed-runtime-v1
mkdir -p "$packet/candidate/bin"
for name in freshell-server freshell-supervisor freshell-session-host; do
  install -m 700 "$CARGO_TARGET_DIR/release/$name" "$packet/candidate/bin/$name"
done
python3 - <<'VERIFY'
from pathlib import Path
import json,hashlib,datetime,struct,subprocess,os
packet=Path('/home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi')
commit='20dbddf53d831c2fbcebdac294d67cc262c57838'
artifacts={}
for p in sorted((packet/'candidate/bin').iterdir()):
 data=p.read_bytes()
 assert data[:4]==b'\x7fELF',p
 assert struct.unpack('<H',data[18:20])[0]==62,p
 if p.name in ['freshell-server','freshell-supervisor']:assert commit.encode() in data,p
 artifacts[p.name]={'path':str(p),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'elf':'linux-x86_64'}
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commit':commit,'features':['freshell-server/managed-runtime-v1'],'cargo':subprocess.check_output(['cargo','--version'],text=True).strip(),'artifacts':artifacts,'status':'native-artifacts-ready'}
p=packet/'candidate/native-ready.json';p.write_text(json.dumps(record,indent=2));os.chmod(p,0o600)
print(json.dumps(record,indent=2))
VERIFY
