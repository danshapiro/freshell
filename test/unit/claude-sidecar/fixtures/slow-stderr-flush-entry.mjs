// The real sidecar entry (SIDECAR_INDEX_PATH) behind a slow stderr reader:
// every stderr write that asks to hear when it flushed hears back
// STDERR_FLUSH_DELAY_MS late, as it would when the server reads the
// sidecar's stderr slowly. The records themselves land at once. The only
// such write is the exit flush of a sidecar exiting on its own
// (index.mjs exitWithoutSession), so the delay holds that sidecar inside
// its exiting window long enough for a stdout error to arrive there.

const indexPath = process.env.SIDECAR_INDEX_PATH
if (!indexPath) {
  process.stderr.write('SIDECAR_INDEX_PATH is required\n')
  process.exit(2)
}
const delayMs = Number(process.env.STDERR_FLUSH_DELAY_MS ?? '500')

const write = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, encoding, callback) => {
  const flushed = typeof encoding === 'function' ? encoding : callback
  if (typeof flushed !== 'function') return write(chunk, encoding)
  return write(chunk, typeof encoding === 'string' ? encoding : undefined, (error) => {
    setTimeout(() => flushed(error), delayMs)
  })
}

await import(indexPath)
