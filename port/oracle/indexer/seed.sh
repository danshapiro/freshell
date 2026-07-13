#!/bin/bash
set -e
cd /home/dan/code/freshell
for side in orig rust; do
  H=/home/dan/.freshell-qa-007i-$side
  rm -rf "$H"
  P="$H/.claude/projects/-home-dan-code-testproj"
  mkdir -p "$P"
  cp test/fixtures/sessions/*.jsonl "$P/"
  # multibyte fixture: CJK + emoji + combining chars + RTL
  cat > "$P/multibyte.jsonl" <<'JSONL'
{"type":"system","subtype":"init","session_id":"multibyte-session","uuid":"mb-001","timestamp":"2025-06-01T10:00:00.000Z"}
{"type":"user","message":"こんにちは、世界 🌏 — テスト用のマルチバイト行です。Ωμέγα και ελληνικά. עברית מימין לשמאל. Ünïcödé çombining: éèêë","uuid":"mb-002","parentUuid":"mb-001","timestamp":"2025-06-01T10:00:01.000Z"}
{"type":"assistant","message":"了解しました！絵文字も含めます: 👨‍👩‍👧‍👦 🇯🇵 ✨ and 4-byte chars: 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 𐍈","uuid":"mb-003","parentUuid":"mb-002","timestamp":"2025-06-01T10:00:02.000Z"}
{"type":"summary","summary":"マルチバイト・テスト 🌸 multibyte summary","leafUuid":"mb-003"}
JSONL
  # invalid-utf8 fixture: identical raw bytes both sides (bug#7 regression class)
  printf '{"type":"system","subtype":"init","session_id":"badutf8-session","uuid":"bu-001","timestamp":"2025-06-01T11:00:00.000Z"}\n' > "$P/multibyte-invalid.jsonl"
  printf '{"type":"user","message":"broken \xc3\x28 \xe2\x82 truncated \xf0\x9f\x98","uuid":"bu-002","parentUuid":"bu-001","timestamp":"2025-06-01T11:00:01.000Z"}\n' >> "$P/multibyte-invalid.jsonl"
  # identical mtimes
  find "$H" -exec touch -d '2026-07-01 12:00:00' {} +
done
echo seeded
md5sum /home/dan/.freshell-qa-007i-orig/.claude/projects/-home-dan-code-testproj/* | awk '{print $1}' | md5sum
md5sum /home/dan/.freshell-qa-007i-rust/.claude/projects/-home-dan-code-testproj/* | awk '{print $1}' | md5sum
# --- real-format additions (UUID filenames, real claude transcript shape) ---
for side in orig rust; do
  P=/home/dan/.freshell-qa-007i-$side/.claude/projects/-home-dan-code-testproj
  cat > "$P/aaaa1111-2222-4333-8444-555566667777.jsonl" <<'JSONL'
{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/home/dan/code/testproj","sessionId":"aaaa1111-2222-4333-8444-555566667777","version":"2.1.23","gitBranch":"main","type":"user","message":{"role":"user","content":"こんにちは、世界 🌏 マルチバイトのテストです。Ωμέγα ελληνικά. עברית. 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 𐍈 👨‍👩‍👧‍👦"},"uuid":"aaaa0001-0000-4000-8000-000000000001","timestamp":"2026-01-30T07:00:00.000Z"}
{"parentUuid":"aaaa0001-0000-4000-8000-000000000001","isSidechain":false,"userType":"external","cwd":"/home/dan/code/testproj","sessionId":"aaaa1111-2222-4333-8444-555566667777","version":"2.1.23","gitBranch":"main","message":{"model":"claude-opus-4-5-20251101","id":"msg_mb1","type":"message","role":"assistant","content":[{"type":"text","text":"了解しました！絵文字 🇯🇵 ✨ と結合文字 éèêë を含む返信です。"}]},"type":"assistant","uuid":"aaaa0002-0000-4000-8000-000000000002","timestamp":"2026-01-30T07:00:01.000Z"}
{"type":"summary","summary":"マルチバイト・テスト 🌸 multibyte summary","leafUuid":"aaaa0002-0000-4000-8000-000000000002"}
JSONL
  printf '{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/home/dan/code/testproj","sessionId":"bbbb1111-2222-4333-8444-555566667777","version":"2.1.23","gitBranch":"main","type":"user","message":{"role":"user","content":"invalid utf8 follows \xc3\x28 \xe2\x82 \xf0\x9f\x98 end"},"uuid":"bbbb0001-0000-4000-8000-000000000001","timestamp":"2026-01-30T08:00:00.000Z"}\n' > "$P/bbbb1111-2222-4333-8444-555566667777.jsonl"
  printf '{"parentUuid":"bbbb0001-0000-4000-8000-000000000001","isSidechain":false,"userType":"external","cwd":"/home/dan/code/testproj","sessionId":"bbbb1111-2222-4333-8444-555566667777","version":"2.1.23","gitBranch":"main","message":{"model":"claude-opus-4-5-20251101","id":"msg_bad1","type":"message","role":"assistant","content":[{"type":"text","text":"reply after invalid bytes"}]},"type":"assistant","uuid":"bbbb0002-0000-4000-8000-000000000002","timestamp":"2026-01-30T08:00:01.000Z"}\n' >> "$P/bbbb1111-2222-4333-8444-555566667777.jsonl"
  find /home/dan/.freshell-qa-007i-$side -exec touch -d '2026-07-01 12:00:00' {} +
done
echo re-seeded
md5sum /home/dan/.freshell-qa-007i-orig/.claude/projects/-home-dan-code-testproj/* | awk '{print $1}' | md5sum
md5sum /home/dan/.freshell-qa-007i-rust/.claude/projects/-home-dan-code-testproj/* | awk '{print $1}' | md5sum
