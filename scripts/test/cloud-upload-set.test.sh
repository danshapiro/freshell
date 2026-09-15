#!/usr/bin/env bash
# Test: cloud-upload-set — the source set Cloud Build receives (and the one
# `--local-build` feeds Docker) never contains a file git ignores, and the only
# files that honoring .gitignore removes are git-ignored ones: every checked-in
# re-include still ships.
#
# REAL behavior, not text: gcloud's own .gcloudignore evaluation
# (`gcloud meta list-files-for-upload`, the same chooser `gcloud builds submit`
# uses) runs over a copy of this checkout's git view with gitignored litter
# planted into it. The command is local-only — no credentials, no network.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

FAILURES=0
check() {
  local desc="$1"
  shift
  if "$@"; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "=== Cloud upload set test ==="

if ! command -v gcloud >/dev/null 2>&1; then
  echo "FAIL: gcloud is required (its .gcloudignore evaluation is the behavior under test)"
  exit 1
fi

WORK="$(mktemp -d /tmp/cloud-upload-set.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
TREE="$WORK/tree"
mkdir -p "$TREE"

# Git's view of this checkout: tracked plus untracked-but-not-ignored files —
# exactly what a clean worktree of the same content contains.
(cd "$ROOT" && git ls-files -z --cached --others --exclude-standard --deduplicate) > "$WORK/gitview.z"
(cd "$ROOT" && tar --null --ignore-failed-read --no-recursion -T "$WORK/gitview.z" -cf -) 2>/dev/null \
  | tar -C "$TREE" -xf -
tr '\0' '\n' < "$WORK/gitview.z" | LC_ALL=C sort -u > "$WORK/gitview.txt"

# Gitignored litter that .gcloudignore does not list on its own. Each path is
# ignored by a distinct .gitignore rule (asserted below, so the fixture cannot
# silently stop exercising the rule).
LITTER=(
  "release/win-unpacked/Freshell.exe"
  ".verify-vantages.env"
  "notes-from-agent.txt"
  "electron-runtime/node.bin"
  "blob-report/report.zip.json"
  ".venv/lib/site.py"
  "artifacts/perf/trace.json"
  ".kata.local.toml"
  "crates/freshell-ws/src/lib.rs.bk"
  "test/e2e-browser/gate01-reports/slice.json"
)
for path in "${LITTER[@]}"; do
  mkdir -p "$TREE/$(dirname "$path")"
  printf 'litter %s\n' "$path" > "$TREE/$path"
  check "fixture: '$path' is git-ignored" git -C "$ROOT" check-ignore -q --no-index -- "$path"
done

list_upload() {
  gcloud meta list-files-for-upload "$TREE" 2>/dev/null | LC_ALL=C sort -u
}

# L1: the upload set under the checked-in ignore rules.
list_upload > "$WORK/upload.txt"
check "gcloud listed a non-trivial upload set" test "$(wc -l < "$WORK/upload.txt")" -gt 100

for path in "${LITTER[@]}"; do
  check "gitignored '$path' is not uploaded" bash -c '! grep -Fxq -- "$1" "$2"' _ "$path" "$WORK/upload.txt"
done

LC_ALL=C comm -23 "$WORK/upload.txt" "$WORK/gitview.txt" > "$WORK/uploaded-outside-gitview.txt"
check "every uploaded file is in git's view (nothing git ignores ships)" \
  test ! -s "$WORK/uploaded-outside-gitview.txt"
if [ -s "$WORK/uploaded-outside-gitview.txt" ]; then
  head -5 "$WORK/uploaded-outside-gitview.txt" | sed 's/^/  uploaded but git-ignored: /'
fi

# L0: the same tree with the .gitignore include line removed. Honoring
# .gitignore must remove ONLY files outside git's view — every file of git's
# view that .gcloudignore alone ships (the checked-in fixture re-includes
# among them) must still ship.
grep -vxF '#!include:.gitignore' "$ROOT/.gcloudignore" > "$TREE/.gcloudignore"
list_upload > "$WORK/upload-without-gitignore.txt"
cp "$ROOT/.gcloudignore" "$TREE/.gcloudignore"
LC_ALL=C comm -12 "$WORK/upload-without-gitignore.txt" "$WORK/gitview.txt" > "$WORK/gitview-shipped-without-include.txt"
LC_ALL=C comm -3 "$WORK/gitview-shipped-without-include.txt" "$WORK/upload.txt" > "$WORK/include-diff.txt"
check "honoring .gitignore removes only git-ignored files (no checked-in file dropped)" \
  test ! -s "$WORK/include-diff.txt"
if [ -s "$WORK/include-diff.txt" ]; then
  head -5 "$WORK/include-diff.txt" | sed 's/^/  differs: /'
fi

# Readable pins for the deliberate re-includes the image depends on.
for path in \
  docker/cloud-run/Dockerfile \
  docker/cloud-run/test-durations.txt \
  test/fixtures/distribution/rust-only/dist/client/index.html \
  test/fixtures/distribution/node-server/node_modules/node-pty/index.js \
  AGENTS.md \
  docs/skills/testing.md \
  package-lock.json; do
  check "checked-in '$path' is uploaded" grep -Fxq -- "$path" "$WORK/upload.txt"
done

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
