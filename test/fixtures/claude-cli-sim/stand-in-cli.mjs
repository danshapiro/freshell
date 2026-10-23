// The process that stands in for the native Claude CLI while the simulator
// runs. It does no work: it exists so that the CLI pid is a real process the
// way the real SDK's is (initializationResult().pid, SIGKILL from a test, the
// sidecar's process-tree handling), and so that its death ends the
// simulator's stream exactly as a CLI death ends the real SDK's.
//
// It lives until stdin closes (exit 0) or it reads `exit <code>` on stdin.

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  let newline
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, newline).trim()
    buffered = buffered.slice(newline + 1)
    const exit = /^exit (\d{1,3})$/.exec(line)
    if (exit) process.exit(Number(exit[1]))
  }
})
process.stdin.on('end', () => process.exit(0))
