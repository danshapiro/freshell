# Laptop bootstrap — freshell rust/tauri port

Purpose: take a clean Windows machine (no WSL, no toolchain, no legacy freshell —
exactly the profile `port/HANDOFF.md` targets) to "agent can continue the port
locally" in two steps + reboot.

## Order of operations

1. **`1-install-wsl.cmd`** (double-click, approve admin, reboot). Installs WSL2 +
   Ubuntu. On first Ubuntu launch, create your Linux user.
2. **`2-bootstrap-wsl.sh`** (inside Ubuntu):
   `bash /mnt/c/Users/Public/freshell-bootstrap/2-bootstrap-wsl.sh`
   Idempotent. Installs apt toolchain (incl. mingw-w64 cross-compiler, Tauri GUI
   deps, imagemagick/tesseract/xdotool), rustup + `x86_64-pc-windows-gnu`, node 22,
   clones the repo at **`feat/rust-tauri-port`** (NOT main — the port and all its
   docs live on that branch), `npm ci` + sidecar deps + Playwright chromium, and
   builds the original reference + both Rust server binaries.

## What only a human can do (the agent cannot)

- Approve the WSL install + reboot (step 1).
- **Credentials**: `claude` / `codex login` / `opencode auth login` (one-time each);
  git push access (`gh auth login` or PAT); the agent runtime's own model keys.
- Everything else is automated or agent-doable per `port/HANDOFF.md` §3.

## Then

Point the agent at `port/HANDOFF.md` and `port/GOAL.md` in the cloned repo. Key
rules it will follow: test ports **17870–17899 only** (never 3000–3010), source
purity (`server/`, `shared/`, `src/` byte-pristine), differential QA against the
real running original.
