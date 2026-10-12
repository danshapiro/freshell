import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const childKeys = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  opencode: 'OPENROUTER_API_KEY',
  amplifier: 'OPENAI_API_KEY',
} as const

export type OnecliProvider = keyof typeof childKeys

export function fakeOnecliGrants(providers: readonly OnecliProvider[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-parity-onecli-'))
  const grants = {} as Record<OnecliProvider, string>
  const serverEnv: Record<string, string> = {}
  const childDigests = {} as Record<OnecliProvider, string>
  for (const provider of providers) {
    const grant = path.join(directory, `${provider}.env`)
    const fakeValue = `fixture-secret-byte-${provider}`
    fs.writeFileSync(grant, `ONECLI_URL=http://127.0.0.1:10254\n${childKeys[provider]}=${fakeValue}\n`, { mode: 0o600 })
    grants[provider] = grant
    serverEnv[`FRESHELL_MANAGED_${provider.toUpperCase()}_ONECLI_ENV_FILE`] = grant
    childDigests[provider] = createHash('sha256').update(fakeValue).digest('hex')
  }
  return { directory, grants, serverEnv, childDigests, childKeys }
}

export async function withMissingGrant<T>(grant: string, action: () => Promise<T>): Promise<T> {
  const moved = `${grant}.inactive`
  fs.renameSync(grant, moved)
  try { return await action() } finally { fs.renameSync(moved, grant) }
}

export function exposeGrantsToHarness(serverEnv: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(serverEnv).map(key => [key, process.env[key]]))
  Object.assign(process.env, serverEnv)
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
