# Docker Rust Server Example

Demonstrates running the Rust Freshell server in Docker. Historical server
extension files are not launched or proxied by the Rust server.

## Scope

The container exposes the Rust Freshell server on port 3001. It does not
include the retired Node extension process manager or the old
`/api/proxy/http/:port/` route. Run any separate service yourself and publish
its port explicitly if you need to access it.

## Try It

```bash
# From the freshell repo root:
docker build -t freshell-docker-test -f examples/docker/Dockerfile .
docker run --rm -p 3001:3001 freshell-docker-test
```

Open the URL printed to stdout. The pane picker contains the Rust-supported
panes; the historical client/server extension manifests are not working pane
types in this server.
