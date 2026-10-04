# Managed runtime image and deployment contract

Phase 2 uses a digest-pinned workload image based on Node 22.23.2 with exact
Claude Code 2.1.263 and OpenCode 1.18.21 installs. `provider-versions.json` is the machine-readable
version receipt and `Dockerfile` must reproduce it; floating `latest` tags are
not accepted by the supervisor or live gate. The runtime harness disables
BuildKit provenance/SBOM attestations for this local workload build so unrelated
build-context metadata cannot change the image identity; the recorded `sha256:`
therefore names the reproducible image manifest itself.

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
Set `FRESHELL_RUNTIME_ROOT` to a private, persistent directory on the Docker
host before starting Compose. Compose mounts it at the same absolute path in
the supervisor so Docker can bind each incarnation's control directory and
each fresh-agent soul's protected actor journal into its dynamic container.
Keep this directory across supervisor restarts and incarnation replacement.

The image includes the same Freshell MCP tool as an ordinary terminal at
`/opt/freshell-mcp/server.js`. It is built from this checkout and deployed with
the frozen workspace lock, so a managed provider can launch it without a web
server worktree mount. Check the image with
`pnpm exec tsx scripts/testing/probe-managed-mcp-image.ts --image <image>`;
the probe calls `tools/list` and `tools/call` through a fake local endpoint
while Node's environment proxy is enabled, then verifies Freshell's API request
did not reach the proxy.
The controller supplies each incarnation's scoped MCP grant in the
provider environment. Provider MCP configuration, including user entries,
keeps its ordinary semantics.

Provider credentials and MCP capability bytes are never placed in durable
launch records or terminal environment snapshots. Managed providers obtain
secrets through child-only OneCLI grants; the live MCP capability belongs to
the current incarnation and is recreated on replacement. Kilroy retains its
separate legacy credential bootstrap.

## Real-provider acceptance order

OpenCode is the first real-provider Phase 2 acceptance lane. The live gate pins OpenCode 1.18.21 and uses `openai/gpt-5.6-luna` through the dedicated OneCLI OpenAI OAuth grant. The receipt reads the actual provider and model from OpenCode's native session database and fails if they differ; it does not silently fall back. Managed OpenCode is one provider runtime per soul rather than the legacy shared serve process. Its ordinary JSON, JSONC, plugin, and TUI rebind configuration is retained.

P2-G04 runs its web server with an isolated home directory. Before the browser
gate, set all three private grant references:

```bash
export FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE=/path/to/private/opencode-auth.json
export FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE=/path/to/private/opencode-onecli.env
export FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE=/path/to/private/gateway-ca.pem
```

The auth file is an OpenCode-native OAuth placeholder with `onecli-managed`
access and refresh values and a future expiry; it must not contain a provider
token. The environment grant carries the dedicated authenticated proxy aliases,
`OPENAI_BASE_URL`, `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS` pointing to
`/home/freshell/provider/.config/onecli/gateway-ca.pem`, and
`NO_PROXY=localhost,127.0.0.1`. Only those loopback hosts may bypass the proxy,
because OpenCode's TUI must reach its own local server directly. The CA grant
is staged at that provider-home path before OpenCode starts. Freshell resolves
the grants only for the provider child.

Amplifier launches the ordinary configured CLI and bundle. The image carries
the generic Amplifier app and a pinned vLLM module for existing profiles; it
does not force that provider, model, or a particular OneCLI profile. Amplifier's
bundle resolver selects any additional modules named by the ordinary bundle.

OpenCode's TUI JITs a small native render library. Global `/tmp` remains bounded and `noexec`; only managed OpenCode gets a separate bounded 64 MiB `rw,exec,nosuid,nodev` tmpfs at `/run/opencode-tmp`, exposed through `TMPDIR`. Its loopback serve endpoint is fixed at `127.0.0.1:4096` inside the soul-private network namespace, so no web-host port allocator is involved.

Routine later-provider tests are cost-pinned: Claude uses **Haiku** at the lowest available thinking/reasoning setting; Codex uses **GPT-5.6 Luna** at the lowest available thinking/reasoning setting. Tests must record the resolved model/setting and must block rather than silently upgrade to a more expensive model/configuration.
