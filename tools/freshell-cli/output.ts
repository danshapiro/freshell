export function writeText(text: string) {
  if (text.endsWith('\n')) {
    process.stdout.write(text)
    return
  }
  process.stdout.write(`${text}\n`)
}

export function writeJson(data: unknown, pretty = true) {
  const payload = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  writeText(payload)
}

export function writeError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  // stderr is intentionally machine-readable JSONL. CLI command results still
  // own stdout, so diagnostics never corrupt piping/JSON output there.
  process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'cli.error', message })}\n`)
}
