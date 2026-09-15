export type CoordinatorLogLevel = 'info' | 'warn' | 'error'

/**
 * Structured JSONL coordinator events, in the same shape as the standard test
 * runner's log lines: info goes to stdout, warnings and errors to stderr.
 */
export function logCoordinatorEvent(
  level: CoordinatorLogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    severity: level,
    time: new Date().toISOString(),
    component: 'test-coordinator',
    event,
    ...fields,
  })
  const stream = level === 'info' ? process.stdout : process.stderr
  stream.write(`${line}\n`)
}
