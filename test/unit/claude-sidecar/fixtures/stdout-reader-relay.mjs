// Runs a sidecar entry (RELAY_ENTRY) as this process's only child and is the
// only process that holds the read end of the sidecar's stdout. Requests on
// this process's stdin go to the sidecar, its stdout lines come back here,
// and its stderr is this process's stderr. A `relay.ready` line says SIGUSR2
// is handled: it closes that read end and answers with a
// `relay.reader_dropped` line. The relay exits the way the sidecar exits.
//
// A test that closes the reader in the test process itself cannot be sure
// the reader is gone: the test process spawns children for other test files
// too, and every child holds copies of all of its descriptors from fork until
// exec, which takes long for a large test process. A sidecar write in that
// window lands in the copy instead of failing with EPIPE. This relay forks
// once, before the reader exists anywhere else, so once it closes the reader
// nothing else holds one.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const entry = process.env.RELAY_ENTRY
if (!entry) {
  process.stderr.write('RELAY_ENTRY is required\n')
  process.exit(64)
}

const sidecar = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] })
sidecar.on('error', (error) => {
  process.stderr.write(`the relay could not start ${entry}: ${error.message}\n`)
  process.exit(70)
})
// The relay's own end of the request pipe closing (the test killed it) ends
// the sidecar's stdin too, so a sidecar never outlives its relay.
process.stdin.pipe(sidecar.stdin)
sidecar.stdin.on('error', () => { /* the sidecar exited; a late request is moot */ })

const lines = createInterface({ input: sidecar.stdout })
lines.on('line', (line) => process.stdout.write(`${line}\n`))

process.on('SIGUSR2', () => {
  lines.close()
  sidecar.stdout.destroy()
  process.stdout.write(`${JSON.stringify({ type: 'relay.reader_dropped' })}\n`)
})
// Before the handler above, SIGUSR2 would end this process.
process.stdout.write(`${JSON.stringify({ type: 'relay.ready' })}\n`)

sidecar.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
