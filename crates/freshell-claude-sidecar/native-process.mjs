import { spawn } from 'node:child_process'
import { Writable } from 'node:stream'

export function spawnObservedNative(options, { onControlWrite, onStderr } = {}) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const nativeStdin = child.stdin
  child.stderr.on('data', (bytes) => onStderr?.(bytes.toString()))
  let pending = ''
  const observedStdin = new Writable({
    write(chunk, encoding, done) {
      nativeStdin.write(chunk, encoding, (error) => {
        pending += chunk.toString()
        let boundary
        while ((boundary = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, boundary)
          pending = pending.slice(boundary + 1)
          try {
            const frame = JSON.parse(line)
            if (frame.type === 'control_response' && typeof frame.response?.request_id === 'string') onControlWrite?.(frame, error ?? undefined)
          } catch { /* The SDK also writes non-control protocol lines. */ }
        }
        done(error)
      })
    },
    final(done) { nativeStdin.end(done) },
    destroy(error, done) { nativeStdin.destroy(error); done(error) },
  })
  nativeStdin.on('error', (error) => observedStdin.destroy(error))
  observedStdin.on('error', () => { /* SDK transport observes failed writes. */ })
  // Preserve the actual SDK-selected child and its complete supported interface.
  child.stdin = observedStdin
  return child
}
