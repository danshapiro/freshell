export type ParsedArgs = {
  command?: string
  flags: Record<string, string | boolean>
  args: string[]
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const args: string[] = []
  let command: string | undefined
  let i = 0

  while (i < argv.length) {
    const token = argv[i]
    if (!command && !token.startsWith('-')) {
      command = token
      i += 1
      continue
    }

    if (token === '--') {
      args.push(...argv.slice(i + 1))
      break
    }

    if (token.startsWith('--')) {
      const raw = token.slice(2)
      const eqIndex = raw.indexOf('=')
      if (eqIndex >= 0) {
        const key = raw.slice(0, eqIndex)
        const value = raw.slice(eqIndex + 1)
        flags[key] = value
        i += 1
        continue
      }
      const key = raw
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        flags[key] = next
        i += 2
        continue
      }
      flags[key] = true
      i += 1
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      const key = token.slice(1)
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        flags[key] = next
        i += 2
        continue
      }
      flags[key] = true
      i += 1
      continue
    }

    args.push(token)
    i += 1
  }

  return { command, flags, args }
}
