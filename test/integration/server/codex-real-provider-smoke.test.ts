import { afterEach, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexLaunchPlanner } from '../../../server/coding-cli/codex-app-server/launch-planner.js'
import { CodexAppServerRuntime } from '../../../server/coding-cli/codex-app-server/runtime.js'
import { TerminalRegistry } from '../../../server/terminal-registry.js'

const tempDirs = new Set<string>()
const registries = new Set<TerminalRegistry>()
const planners = new Set<CodexLaunchPlanner>()

type SessionIndexEntry = {
  id?: unknown
}

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-real-provider-'))
  tempDirs.add(dir)
  return dir
}

async function processHasOwnershipEnv(pid: number, ownershipId: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(`/proc/${pid}/environ`)
    return raw.toString('utf8').split('\0').includes(`FRESHELL_CODEX_SIDECAR_ID=${ownershipId}`)
  } catch {
    return false
  }
}

async function pidsWithOwnershipId(ownershipId: string): Promise<number[]> {
  const entries = await fsp.readdir('/proc').catch(() => [])
  const matches: number[] = []
  await Promise.all(entries.map(async (entry) => {
    if (!/^\d+$/.test(entry)) return
    const pid = Number(entry)
    if (await processHasOwnershipEnv(pid, ownershipId)) {
      matches.push(pid)
    }
  }))
  return matches.sort((a, b) => a - b)
}

async function readOwnershipId(metadataDir: string): Promise<string> {
  const entries = await fsp.readdir(metadataDir)
  const metadataFile = entries.find((entry) => entry.endsWith('.json'))
  if (!metadataFile) throw new Error(`No Codex ownership metadata found in ${metadataDir}`)
  const raw = await fsp.readFile(path.join(metadataDir, metadataFile), 'utf8')
  const parsed = JSON.parse(raw) as { ownershipId?: unknown }
  if (typeof parsed.ownershipId !== 'string') {
    throw new Error('Codex ownership metadata did not include an ownership id.')
  }
  return parsed.ownershipId
}

async function copyIfExists(source: string, target: string): Promise<boolean> {
  try {
    await fsp.copyFile(source, target)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

async function collectRolloutFiles(root: string): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  const visit = async (dir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return []
      throw error
    })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
        continue
      }
      const match = entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
      if (!match) continue
      const files = result.get(match[1]) ?? []
      files.push(fullPath)
      result.set(match[1], files)
    }
  }
  await visit(root)
  return result
}

async function prepareRealProviderCodexHome(targetCodexHome: string): Promise<{ sessionId: string }> {
  const sourceCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const authCopied = await copyIfExists(
    path.join(sourceCodexHome, 'auth.json'),
    path.join(targetCodexHome, 'auth.json'),
  )
  if (!authCopied) {
    throw new Error(
      `Codex real-provider smoke requires an authenticated Codex home at ${sourceCodexHome}. Run codex login before running the integration suite.`,
    )
  }
  await copyIfExists(
    path.join(sourceCodexHome, 'config.toml'),
    path.join(targetCodexHome, 'config.toml'),
  )
  await fsp.writeFile(
    path.join(targetCodexHome, 'version.json'),
    `${JSON.stringify({
      latest_version: '999.0.0',
      last_checked_at: new Date().toISOString(),
      dismissed_version: '999.0.0',
    })}\n`,
    { mode: 0o600 },
  )

  const indexPath = path.join(sourceCodexHome, 'session_index.jsonl')
  const indexRaw = await fsp.readFile(indexPath, 'utf8').catch((error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(
        `Codex real-provider smoke requires at least one saved Codex session in ${sourceCodexHome}. Run Codex once before running the integration suite.`,
      )
    }
    throw error
  })
  const sessionRollouts = await collectRolloutFiles(path.join(sourceCodexHome, 'sessions'))
  const indexLines = indexRaw.split('\n').filter((line) => line.trim().length > 0)
  const parsedIndexLines: Array<{ id: string; line: string }> = []
  for (const line of indexLines) {
    try {
      const parsed = JSON.parse(line) as SessionIndexEntry
      if (typeof parsed.id === 'string') {
        parsedIndexLines.push({ id: parsed.id, line })
      }
    } catch {
      // Ignore malformed historical index entries; the smoke only needs one
      // current, resumable session.
    }
  }
  const candidates: Array<{ id: string; lines: string[] }> = []
  const seen = new Set<string>()
  for (const parsed of [...parsedIndexLines].reverse()) {
    if (seen.has(parsed.id)) continue
    seen.add(parsed.id)
    const lines = parsedIndexLines
      .filter((candidateLine) => candidateLine.id === parsed.id)
      .map((candidateLine) => candidateLine.line)
    candidates.push({ id: parsed.id, lines })
  }

  const selected = candidates.find((candidate) => (sessionRollouts.get(candidate.id)?.length ?? 0) > 0)
  if (!selected) {
    throw new Error(
      `Codex real-provider smoke requires at least one saved Codex rollout file under ${path.join(sourceCodexHome, 'sessions')}.`,
    )
  }

  await fsp.writeFile(
    path.join(targetCodexHome, 'session_index.jsonl'),
    `${selected.lines.join('\n')}\n`,
    { mode: 0o600 },
  )
  for (const rollout of sessionRollouts.get(selected.id) ?? []) {
    const relativePath = path.relative(sourceCodexHome, rollout)
    const target = path.join(targetCodexHome, relativePath)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.copyFile(rollout, target)
  }
  return { sessionId: selected.id }
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

afterEach(async () => {
  await Promise.all([...registries].map(async (registry) => {
    registries.delete(registry)
    await registry.shutdownGracefully(100)
  }))
  await Promise.all([...planners].map(async (planner) => {
    planners.delete(planner)
    await planner.shutdown()
  }))
  await Promise.all([...tempDirs].map(async (dir) => {
    tempDirs.delete(dir)
    await fsp.rm(dir, { recursive: true, force: true })
  }))
})

describe('Codex real-provider smoke', () => {
  it('covers the actual codex remote resume path and owned process cleanup', async () => {
    const metadataDir = await makeTempDir()
    const codexHome = await makeTempDir()
    const { sessionId } = await prepareRealProviderCodexHome(codexHome)
    const registry = new TerminalRegistry()
    registries.add(registry)
    const outputChunks: string[] = []
    const outputHandler = (event: { data?: unknown }) => {
      if (typeof event.data === 'string') {
        outputChunks.push(stripAnsi(event.data))
      }
    }
    registry.on('terminal.output.raw', outputHandler)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const planner = new CodexLaunchPlanner(() => new CodexAppServerRuntime({
      metadataDir,
      env: {
        CODEX_HOME: codexHome,
      },
      requestTimeoutMs: 5_000,
      startupAttemptTimeoutMs: 10_000,
    }))
    planners.add(planner)

    try {
      const resumePlan = await planner.planCreate({
        cwd: process.cwd(),
        resumeSessionId: sessionId,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      })
      const term = registry.create({
        mode: 'codex',
        cwd: process.cwd(),
        resumeSessionId: resumePlan.sessionId,
        providerSettings: {
          codexAppServer: {
            ...resumePlan.remote,
            sidecar: resumePlan.sidecar,
          },
        },
      })
      await resumePlan.sidecar.adopt({ terminalId: term.terminalId, generation: 0 })
      try {
        await resumePlan.sidecar.waitForLoadedThread(sessionId, { timeoutMs: 20_000, pollMs: 250 })
      } catch (error) {
        const outputTail = outputChunks.join('').slice(-1_000)
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nCodex TUI output before failure:\n${outputTail}`,
        )
      }
      const ownershipId = await readOwnershipId(metadataDir)

      await registry.killAndWait(term.terminalId)
      await planner.shutdown()

      await expect(pidsWithOwnershipId(ownershipId)).resolves.toEqual([])
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      registry.off('terminal.output.raw', outputHandler)
    }
  }, 60_000)
})
