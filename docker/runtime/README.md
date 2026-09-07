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

The trusted session-host starts as container UID 0, but terminal containers use
`CapDrop=ALL` and add back only `CHOWN`, `SETUID`, and `SETGID`. Before spawning
the PTY it prepares the soul-owned provider volume, then launches the actual
shell/coding CLI through `setpriv` as UID `65534`, GID `0`, with
`no-new-privileges`. The provider process has zero effective/permitted/
inheritable/ambient capabilities. Under the supported **rootless Docker**
backend, the host user's bind-mounted workspace maps to container group 0; the
repository's group-write permissions therefore remain usable by the provider
without broad host chmod/chown changes. Root-owned `0600` incarnation secret
and host-control socket remain unreadable/unconnectable to the provider UID.
Every runtime still has a private PID namespace, read-only image root, bounded
tmpfs, explicit CPU/memory/PID limits, and no Docker or supervisor-admin socket.

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

## Real-provider acceptance order

OpenCode is the first real-provider Phase 2 acceptance lane and should use its free-tier path for repeated continuity/resource tests. A Claude binary being present in this image does not make Claude the first acceptance dependency; it is retained for later provider coverage. Managed OpenCode must be one provider runtime per soul rather than the legacy shared serve process.

Routine later-provider tests are cost-pinned: Claude uses **Haiku** at the lowest available thinking/reasoning setting; Codex uses **GPT-5.6 Luna** at the lowest available thinking/reasoning setting. Tests must record the resolved model/setting and must block rather than silently upgrade to a more expensive model/configuration.
