#!/usr/bin/env bash
# freshell rust/tauri port — laptop bootstrap. Run INSIDE WSL Ubuntu.
# Idempotent: safe to re-run. Full probe/QA contract: port/HANDOFF.md §3 in the repo.
set -uo pipefail

REPO_URL="https://github.com/danshapiro/freshell.git"
BRANCH="feat/rust-tauri-port"
DEST="$HOME/code/freshell"

echo "== [1/7] apt toolchain (build, cross-compile, GUI/Tauri, screenshots/OCR) =="
sudo apt-get update -y
sudo apt-get install -y build-essential curl git pkg-config libssl-dev unzip \
  mingw-w64 imagemagick tesseract-ocr xdotool \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

echo "== [2/7] rust (stable + the Windows cross target) =="
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
. "$HOME/.cargo/env"
rustup target add x86_64-pc-windows-gnu

echo "== [3/7] node 22 via nvm =="
if ! command -v node >/dev/null 2>&1; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
  nvm install 22
fi

echo "== [4/7] repo @ $BRANCH =="
if [ ! -d "$DEST/.git" ]; then
  mkdir -p "$(dirname "$DEST")" && git clone "$REPO_URL" "$DEST"
fi
cd "$DEST" && git fetch origin && git checkout "$BRANCH" && git pull --ff-only

echo "== [5/7] npm deps + playwright chromium =="
npm ci
(cd crates/freshell-claude-sidecar && npm install)
npx playwright install --with-deps chromium

echo "== [6/7] builds: original (reference) + rust linux + rust windows exe =="
npm run build
cargo build --release -p freshell-server
cargo build --release -p freshell-server --target x86_64-pc-windows-gnu
cargo build -p freshell-tauri || echo "WARN: tauri build failed — check GUI deps (HANDOFF §3); not fatal for server work"

echo "== [7/7] coding CLIs (binaries only — AUTH is a separate human step) =="
npm i -g @anthropic-ai/claude-code @openai/codex opencode-ai || echo "WARN: a global CLI install failed; install individually"

echo
echo "DONE. Remaining HUMAN steps:"
echo "  1) Authenticate each CLI once:  claude   |  codex login  |  opencode auth login"
echo "  2) Git push credentials (gh auth login, or a PAT) if this machine will push"
echo "  3) Point your agent at:  $DEST/port/HANDOFF.md  (+ port/GOAL.md)"
echo "     It starts with the Phase-0 probe (HANDOFF §3) and uses TEST PORTS 17870-17899."
