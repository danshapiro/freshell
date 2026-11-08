"""Exact production serde boundary; only actual probe bytes supply producer cases."""
import json
BINARY='/runtime/freshell-session-host'
PROBE='/runtime/managed-producer-probe'
OWNERSHIP_ENV='FRESHELL_CODEX_SIDECAR_ID'
UID,GID=65534,0
PREFIX=['/usr/bin/setpriv','--reuid',str(UID),'--regid',str(GID),'--clear-groups','--no-new-privs','--']
def helper_argv():
    return [*PREFIX,BINARY,'codex-owned-cleanup','--uid',str(UID),'--gid',str(GID)]
def decode(raw):
    value=json.loads(raw)
    assert type(value) is bool
    return value
