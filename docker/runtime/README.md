# Managed runtime image and deployment contract

Phase 2 uses a digest-pinned workload image based on Node 22.23.2 and an exact
Claude Code 2.1.263 install. `provider-versions.json` is the machine-readable
version receipt and `Dockerfile` must reproduce it; floating `latest` tags are
not accepted by the supervisor or live gate.

The session-host binary is not baked into the image. The supervisor bind-mounts
the exact candidate binary read-only at `/runtime/freshell-session-host`, so
runtime evidence can independently hash the tested host and the tool image.
Each soul receives a separate named provider volume mounted at
`/home/freshell/provider`; workspaces and required Git common directories are
canonical-path bind mounts. Supervisor registry/control state and Docker sockets
are forbidden from workload mounts.

The image currently runs as container UID 0 because host worktrees in the live
gate may be owned by different unprivileged UIDs. This does **not** grant host
root: every managed runtime has its own PID namespace, `CapDrop=ALL`,
`no-new-privileges`, a read-only image root, bounded tmpfs, explicit CPU/memory/
PID limits, and no Docker/control socket. This avoids broad host `chmod`/`chown`
changes. A rootless UID-mapping profile can replace this once it is proven across
Linux/WSL/macOS hosts.

`compose.yaml` owns only the web and supervisor services. Dynamic session-host
containers are intentionally outside Compose. Operational restart commands must
name `web` or `supervisor`; do not use `docker compose down` for an ordinary
Freshell restart, because that is a project-wide destruction primitive.

Provider credentials are never placed in the persisted terminal environment.
For managed Claude, `FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE` may point at one
canonical `.credentials.json` file; the supervisor records only that path,
Docker mounts only that file read-only, and the session host copies it into the
soul-owned provider volume with mode `0600`. Phase 2 strips the legacy web-bound
Freshell MCP config from managed Claude; Phase 3 supplies the durable tool router.

When web/supervisor are themselves containers, an enabled Claude credential
reference must be mounted read-only into both controller containers at that
same canonical host path. `compose.yaml` carries this exact-file mount; it
never mounts the containing `.claude` directory or host home.
