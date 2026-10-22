// log.mjs — the claude sidecar's structured log (G14).
// ---------------------------------------------------------------------------
// stdout is the protocol, so stderr is the only log sink: one JSON record per
// line, `{ severity, component, event, ...fields }`. The Rust server reads the
// sidecar's stderr and re-emits each record through `tracing` at its severity,
// labelled with the session it serves (crates/freshell-freshagent/src/
// claude_sidecar_io.rs). A record carries ids, sizes and error text only:
// prompt text and transcript content are never logged.

/** The severities a record may carry, lowest first. */
export const SEVERITIES = Object.freeze(['debug', 'info', 'warn', 'error'])

/** The most bytes of one CLI stderr chunk a `cli.stderr` record keeps. */
export const CLI_STDERR_MAX_BYTES = 2048

/**
 * A `log(severity, event, fields)` function for one component. `write` gets
 * each finished line (newline included); it defaults to stderr.
 */
export function createLog(component, write = (line) => process.stderr.write(line)) {
  return function log(severity, event, fields = {}) {
    const valid = SEVERITIES.includes(severity)
    const record = { severity: valid ? severity : 'warn', component, event }
    if (!valid) record.invalidSeverity = String(severity)
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (!(key in record)) record[key] = value
    }
    let line
    try {
      line = JSON.stringify(record)
    } catch (error) {
      // A field that cannot be serialized must not cost the record itself.
      line = JSON.stringify({ severity: record.severity, component, event, unserializable: errorText(error) })
    }
    write(`${line}\n`)
  }
}

/** The sidecar's own log. */
export const log = createLog('claude-sidecar')

/** An error (or anything thrown) as text for a record's `error` field. */
export function errorText(error) {
  return String(error?.message || error)
}

/**
 * Whether this sidecar runs inside a hosted session host. The host sets
 * FRESHELL_HOSTED_FRESH_AGENT to the provider it hosts, which for this
 * runtime is `claude` or `kilroy`; a hosted sidecar logs CLI output by size only.
 */
export function isHostedSidecar(env = process.env) {
  return Boolean(env.FRESHELL_HOSTED_FRESH_AGENT)
}

/**
 * The SDK's `stderr` callback: each chunk the CLI writes becomes one
 * `cli.stderr` info record. Its text is cut to CLI_STDERR_MAX_BYTES (a cut
 * record also carries the chunk's full size); a hosted sidecar records the
 * size alone.
 */
export function cliStderrLogger(logFn, { hosted, fields = {} } = {}) {
  return (data) => {
    const chunk = String(data)
    const bytes = Buffer.byteLength(chunk)
    if (hosted) {
      logFn('info', 'cli.stderr', { ...fields, bytes })
      return
    }
    const text = chunk.trimEnd()
    const kept = truncateUtf8(text, CLI_STDERR_MAX_BYTES)
    logFn('info', 'cli.stderr', kept === text ? { ...fields, text } : { ...fields, text: kept, truncated: true, bytes })
  }
}

/** `text` cut to at most `maxBytes` of UTF-8, never inside a character. */
function truncateUtf8(text, maxBytes) {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.length <= maxBytes) return text
  let end = maxBytes
  // Back up over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1
  return encoded.subarray(0, end).toString('utf8')
}
