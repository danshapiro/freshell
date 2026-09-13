// test/unit/server/claude-sidecar/fixtures/sidecar-crash-probe.mjs
// Case-8 no-guard invariant probe: imports the REAL sidecar entry, waits for a
// magic stdin line, then rejects a promise with NO handler. The sidecar must
// install NO process-level unhandledRejection/uncaughtException swallow handlers
// (reviewed guard design): with Node's default fatal path kept, this process
// exits NONZERO, preserving the Rust exit-eviction path (ADR 2.1). A wedged-alive
// sidecar exiting 0 on stdin close would mean a swallow guard snuck in.

const indexPath = process.env.SIDECAR_INDEX_PATH
if (!indexPath) {
  process.stderr.write('SIDECAR_INDEX_PATH is required\n')
  process.exit(2)
}

await import(indexPath)

// The imported entry already installed its newline-JSON readline on stdin (an
// unknown frame type is a log-only no-op there), so the cue rides a raw data
// listener.
let fired = false
process.stdin.on('data', (chunk) => {
  if (fired) return
  if (String(chunk).includes('__reject__')) {
    fired = true
    // Deliberately unhandled — default throw-mode must terminate the process.
    Promise.reject(new Error('synthetic-unhandled'))
  }
})
