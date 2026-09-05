# Example Extensions

These examples include supported CLI extensions and historical client/server
manifests. The Rust server can launch the CLI examples in terminal panes;
client and server extension panes are shown as unavailable and are not
started or proxied. To try a supported example, symlink it into your
extensions directory and restart Freshell:

```bash
# macOS/Linux
ln -sf "$(pwd)/examples/extensions/system-monitor" ~/.freshell/extensions/system-monitor

# Windows (use task-list instead of system-monitor)
ln -sf "$(pwd)/examples/extensions/task-list" ~/.freshell/extensions/task-list
```

After restarting, enabled CLI extensions appear in the **New Tab** pane
picker. The historical client and server manifests remain for reference and
do not create working extension panes.

## Extensions

### notepad (client, historical)

A scratchpad with auto-save to localStorage. No build step, no dependencies —
just an `index.html` and a `freshell.json`. The manifest documents the old
client-pane shape, but the Rust server does not render it.

**Key manifest fields:** `category: "client"`, `client.entry` points to the
HTML file.

### status-dashboard (server, historical)

A live system resource monitor. Its manifest and Node process are retained as
historical documentation only. Freshell does not spawn the process or render
its iframe in the Rust baseline.

**Historical manifest fields:** `category: "server"`, `server.command`,
`server.args`, `server.env`, and `server.readyPattern` describe the retired
Node extension lifecycle.

**Note:** If your server extension uses CommonJS (`require()`), include a
`package.json` without `"type": "module"` in the extension directory.
Otherwise Node may inherit an ESM `package.json` from a parent directory.

### live-counter (server, WebSocket, historical)

A shared counter with real-time updates. The files demonstrate the former
server-extension lifecycle, but the Rust server does not start the process or
proxy its WebSocket connection.

**Historical manifest fields:** Same as status-dashboard. The former
relative WebSocket URL depended on the retired proxy and is not a Rust-server
feature.

### system-monitor (cli, macOS/Linux)

Wraps `top` as a terminal pane. The simplest possible extension — just a
manifest pointing at an existing binary. No code needed.

**Key manifest fields:** `category: "cli"`, `cli.command` is the binary to run.

### task-list (cli, Windows)

Wraps `tasklist` as a terminal pane — the Windows equivalent of the
system-monitor example.

**Note:** CLI extensions must also be enabled in freshell settings
(Settings → Coding CLI → Enabled Providers) to appear in the picker.

## Server examples and the Rust baseline

The Rust server has no server-extension process manager or
`/api/proxy/http/:port/` route. If you need one of these historical services,
run it independently and open its separately reachable URL in a supported
browser pane. The example files do not describe a Freshell launch or proxy
path.

## Docker

The Docker example packages the Rust server. It does not launch or proxy the
historical server extensions; expose any independently-run service yourself.
See [`examples/docker/`](../docker/) for the Dockerfile.

## Creating Your Own

1. Create a directory with a `freshell.json` manifest
2. Choose the supported `cli` category
3. Symlink into `~/.freshell/extensions/<name>`
4. Restart freshell

See the [extension-installer skill](/.claude/skills/extension-installer/SKILL.md)
for the full CLI manifest reference and validation checklist.
