# Example Extensions

Example extensions demonstrating each extension category. To try one,
symlink it into your extensions directory and restart freshell:

```bash
# macOS/Linux
ln -sf "$(pwd)/examples/extensions/notepad" ~/.freshell/extensions/notepad
ln -sf "$(pwd)/examples/extensions/status-dashboard" ~/.freshell/extensions/status-dashboard
ln -sf "$(pwd)/examples/extensions/live-counter" ~/.freshell/extensions/live-counter
ln -sf "$(pwd)/examples/extensions/system-monitor" ~/.freshell/extensions/system-monitor

# Windows (use task-list instead of system-monitor)
ln -sf "$(pwd)/examples/extensions/task-list" ~/.freshell/extensions/task-list
```

After restarting, each extension appears in the **New Tab** pane picker.

## Extensions

### notepad (client)

A scratchpad with auto-save to localStorage. No build step, no dependencies —
just an `index.html` and a `freshell.json`. Freshell serves the static files
directly.

**Key manifest fields:** `category: "client"`, `client.entry` points to the
HTML file.

### status-dashboard (server)

A live system resource monitor. Freshell spawns the Node process, allocates a
port via the `{{port}}` template variable, and waits for the `readyPattern`
to appear on stdout before rendering the iframe.

**Key manifest fields:** `category: "server"`, `server.command` and
`server.args` define how to start the process, `server.env` passes the
allocated port, `server.readyPattern` tells freshell when the server is ready.

**Note:** If your server extension uses CommonJS (`require()`), include a
`package.json` without `"type": "module"` in the extension directory.
Otherwise Node may inherit an ESM `package.json` from a parent directory.

### live-counter (server, WebSocket)

A shared counter with real-time updates. Click +/- in one pane and see
the count update instantly in all other panes via WebSocket. Demonstrates
that server extensions can use WebSocket through freshell's HTTP proxy.

**Key manifest fields:** Same as status-dashboard. The WebSocket connection
uses a relative URL so it routes through the proxy automatically.

### system-monitor (cli, macOS/Linux)

Wraps `top` as a terminal pane. The simplest possible extension — just a
manifest pointing at an existing binary. No code needed.

**Key manifest fields:** `category: "cli"`, `cli.command` is the binary to run.

### task-list (cli, Windows)

Wraps `tasklist` as a terminal pane — the Windows equivalent of the
system-monitor example.

**Note:** CLI extensions must also be enabled in freshell settings
(Settings → Coding CLI → Enabled Providers) to appear in the picker.

## How Server Extensions Are Proxied

Server extension iframes load through freshell's built-in HTTP proxy at
`/api/proxy/http/:port/`. This means:

- The browser only needs to reach freshell's port (e.g., 3001)
- Extension server ports are internal — they don't need to be exposed
- **Docker/WSL2/containers work out of the box** — no extra port mapping needed
- Both HTTP and WebSocket are proxied transparently

For WebSocket, use a relative URL from your extension's JavaScript:

```javascript
const wsUrl = 'ws://' + location.host + location.pathname + '/ws'
```

This routes through the proxy automatically. See `live-counter/server.js`
for a complete example.

## Docker

Server extensions work in Docker without exposing extension ports.
See [`examples/docker/`](../docker/) for a ready-to-run Dockerfile.

## Creating Your Own

1. Create a directory with a `freshell.json` manifest
2. Choose a category (`client`, `server`, or `cli`)
3. Symlink into `~/.freshell/extensions/<name>`
4. Restart freshell

See the [extension-installer skill](/.claude/skills/extension-installer/SKILL.md)
for the full manifest reference and validation checklist.
