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
  if (err instanceof Error) {
    process.stderr.write(`${err.message}\n`)
    return
  }
  process.stderr.write(`${String(err)}\n`)
}
