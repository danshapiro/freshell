# Docker Extension Test

Demonstrates that server extensions work when freshell runs inside Docker.

## The Problem

Server extensions spawn processes on dynamically allocated ports inside the
container. Docker only exposes explicitly mapped ports, so the browser can't
reach those dynamic ports directly.

## The Solution

Freshell proxies all server extension requests through its own port via
`/api/proxy/http/:port/`. The browser only needs to reach port 3001 (freshell),
and freshell internally proxies HTTP and WebSocket traffic to the extension's
port inside the container.

## Try It

```bash
# From the freshell repo root:
docker build -t freshell-docker-test -f examples/docker/Dockerfile .
docker run --rm -p 3001:3001 freshell-docker-test
```

Open the URL printed to stdout. The pane picker will show:
- **Status Dashboard** — HTTP server extension (auto-refreshing system stats)
- **Live Counter** — WebSocket server extension (shared real-time counter)
- **Notepad** — Client extension (static HTML, no server)

All three work despite only port 3001 being exposed.
