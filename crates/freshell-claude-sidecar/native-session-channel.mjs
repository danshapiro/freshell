import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const launchKey = 'FRESHELL_NATIVE_IDENTITY_LAUNCH'
const signalKey = 'FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'
const ownPath = fileURLToPath(import.meta.url)
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const validRoot = (root) => typeof root === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(root)

export async function writeNativeSessionSignal(input, env = process.env) {
  const launch = JSON.parse(env[launchKey] ?? 'null')
  const directory = env[signalKey]
  if (!launch?.launchNonce || !launch.incarnationId || !directory) throw new Error('missing current native launch')
  if (!input || input.hook_event_name !== 'SessionStart' || typeof input.session_id !== 'string'
    || !validRoot(input.session_id) || !['startup', 'resume', 'clear', 'compact'].includes(input.source)) {
    throw new Error('invalid native SessionStart')
  }
  const payload = { launch, native: input }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const staging = join(directory, `signal-${randomUUID()}.tmp`)
  await writeFile(staging, JSON.stringify(payload), { mode: 0o600 })
  await rename(staging, join(directory, 'session-start.json'))
}

export async function createNativeSessionChannel({ launch, directory, timeoutMs = 50_000, signal } = {}) {
  if (!launch?.launchNonce || !launch.incarnationId) throw new Error('missing current native launch')
  const ownedDirectory = join(directory ?? tmpdir(), `freshell-native-${randomUUID()}`)
  await mkdir(ownedDirectory, { recursive: true, mode: 0o700 })
  const env = { [launchKey]: JSON.stringify(launch), [signalKey]: ownedDirectory }
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(ownPath)}` }] }] } }
  return {
    env, settings, directory: ownedDirectory,
    cleanup: () => rm(ownedDirectory, { recursive: true, force: true }),
    async waitReady(query) {
      const deadline = Date.now() + timeoutMs
      let initialized = false
      let initializationError
      Promise.resolve().then(() => query.initializationResult()).then(
        () => { initialized = true },
        (error) => { initializationError = error },
      )
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('native startup cancelled')
        if (initializationError) throw initializationError
        try {
          const bytes = await readFile(join(ownedDirectory, 'session-start.json'), 'utf8')
          const value = JSON.parse(bytes)
          if (JSON.stringify(value.launch) !== JSON.stringify(launch)) throw new Error('stale native launch')
          if (value.native?.hook_event_name !== 'SessionStart' || !validRoot(value.native?.session_id)
            || !['startup', 'resume', 'clear', 'compact'].includes(value.native.source)) throw new Error('invalid native SessionStart')
          if (launch.requestedNativeSessionId && value.native.session_id !== launch.requestedNativeSessionId) throw new Error('wrong native root')
          if (initialized) return { nativeSessionId: value.native.session_id, native: value.native,
            evidenceDigest: createHash('sha256').update(bytes).digest('hex') }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error('native startup timeout')
    },
  }
}

if (process.argv[1] === ownPath) {
  try {
    let input = ''
    for await (const chunk of process.stdin) {
      input += chunk
      if (input.length > 1024 * 1024) throw new Error('native hook input too large')
    }
    await writeNativeSessionSignal(JSON.parse(input))
    process.stdout.write('{}\n')
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ severity: 'error', component: 'native-session-hook', message: error.message })}\n`)
    process.exitCode = 1
  }
}
