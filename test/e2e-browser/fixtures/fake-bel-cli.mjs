#!/usr/bin/env node
// Fake claude/codex terminal-mode CLI for the TERM-15/TERM-16 activity e2e
// (`terminal-activity-rust.spec.ts`). Mirrors ONLY the activity-relevant
// behavior of the real CLIs:
//
//   - prints a prompt and stays interactive (`stdin.resume()`), so the pane
//     status remains 'running';
//   - tolerates arbitrary argv (the real launches append `--settings {Stop
//     hook}` for claude and `-c tui.notification_method=bel ...` for codex —
//     this fixture ignores all of it and rings the bell itself, exactly what
//     those flags make the real CLIs do);
//   - on each stdin line ("a turn"): prints working output, then after a
//     delay writes a BARE BEL (\x07) — the turn-complete signal the Rust
//     activity trackers consume — followed by a done marker.
//
// Turn duration: 700ms by default; a prompt containing "slow" takes 6000ms
// (long enough for the reload-during-busy reseed scenario to reload while
// the turn is provably still running).

process.stdout.write('fake-cli> \r\n')

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  const prompt = String(chunk)
  const turnMs = /slow/.test(prompt) ? 6000 : 700
  process.stdout.write('working on it...\r\n')
  setTimeout(() => {
    // The bare BEL is the positive turn-complete signal. Written together
    // with trailing output: a LEADING BEL in a chunk is tracker-eligible
    // (shared/turn-complete-signal.ts semantics), matching how the real
    // Stop-hook/notification bell arrives.
    process.stdout.write('\u0007')
    process.stdout.write('turn done.\r\n')
  }, turnMs)
})
process.stdin.resume()
