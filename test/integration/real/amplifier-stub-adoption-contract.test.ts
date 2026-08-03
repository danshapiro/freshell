// @vitest-environment node
//
// Real Amplifier stub-adoption contract (launcher-assigned session identity).
//
// The Rust broker pre-creates ~/.amplifier/projects/<cwd-slug>/sessions/<id>/
// stubs and spawns `amplifier session resume --full-history <id>`. This test
// pins the two external contracts that path rests on, against the REAL CLI:
//   1. STUB ADOPTION: `amplifier session resume --full-history <id>` of a
//      pre-created stub is
//      accepted (not rejected like an unknown id), the metadata survives in
//      place, and custom keys (freshell_terminal_id) are preserved.
//      Adoption also implicitly proves the slug: amplifier only searches the
//      CURRENT cwd's project slug, so finding our stub means our slug
//      matched its algorithm.
//   2. SLUG ALGORITHM (explicit, key-gated): a real headless turn creates
//      amplifier's own session dir; its project dir name must equal our
//      computed slug, and its metadata must carry `turn_count` (the GC
//      "used" signature).
//
// Isolation (VALIDATED, V1): the real CLI stores sessions ONLY under
// $HOME/.amplifier (session_store.py:96-98 hardcodes Path.home();
// AMPLIFIER_HOME moves ONLY caches/registry.json, never sessions), so session
// data is sandboxed via HOME=<tmp>. HOME alone does NOT isolate Amplifier's
// Python environment: first-run provider activation installs editable packages
// into sys.executable. We therefore clone the real CLI's complete Python
// environment and run that private interpreter. Provider/module installs can
// only mutate the disposable clone, never the user's shared Amplifier tool.
// NOTE: the first run in a fresh HOME performs network bundle-prepare git
// clones (~30s observed) — the per-run timeouts below are sized for that.
//
// Gates mirror amplifier-launch-smoke.test.ts: on-PATH probe (top-level
// await), FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1, provider key for the
// turn-making test. Opt-in run:
//   FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- \
//     run test/integration/real/amplifier-stub-adoption-contract.test.ts \
//     --config config/vitest/vitest.server.config.ts
//

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import {
  createIsolatedAmplifierCli,
  type IsolatedAmplifierCli,
} from '../../helpers/amplifier-cli-isolation.js'

const execFileAsync = promisify(execFile)

async function amplifierOnPath(): Promise<boolean> {
  try {
    await execFileAsync('amplifier', ['--version'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

const onPath = await amplifierOnPath()
const realEnabled = process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
const hasProviderKey = Boolean(
  process.env.ANTHROPIC_API_KEY
  || process.env.OPENAI_API_KEY
  || process.env.AZURE_OPENAI_API_KEY
  || process.env.GOOGLE_API_KEY,
)

// The slug contract (amplifier_app_cli project_utils.py:22-30). The Rust
// twin is freshell_sessions::amplifier_stub::cwd_slug — keep byte-identical.
function cwdSlug(resolvedCwd: string): string {
  const slug = resolvedCwd.replaceAll('/', '-').replaceAll('\\', '-').replaceAll(':', '')
  return slug.startsWith('-') ? slug : `-${slug}`
}

function isolatedAmplifierEnv(home: string): NodeJS.ProcessEnv {
  const inherited = { ...process.env }
  delete inherited.AMPLIFIER_HOME
  delete inherited.PYTHONHOME
  delete inherited.PYTHONPATH
  delete inherited.VIRTUAL_ENV
  return {
    ...inherited,
    HOME: home,
    AMPLIFIER_HOME: path.join(home, '.amplifier'),
    PROMPT_TOOLKIT_NO_CPR: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  }
}

// The exact stub shape the Rust broker writes (plan Global Constraints).
// `home` is the sandbox $HOME — the CLI hardcodes `$HOME/.amplifier` for
// session storage (validated), hence the '.amplifier' segment here.
async function writeStub(home: string, resolvedCwd: string, sessionId: string): Promise<string> {
  const dir = path.join(home, '.amplifier', 'projects', cwdSlug(resolvedCwd), 'sessions', sessionId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
    session_id: sessionId,
    created: new Date().toISOString(),
    working_dir: resolvedCwd,
    freshell_terminal_id: 'contract-test-terminal',
  }))
  await fs.writeFile(path.join(dir, 'transcript.jsonl'), '')
  await fs.writeFile(path.join(dir, 'events.jsonl'), '')
  return dir
}

// Spawn `amplifier session resume --full-history <id>` (interactive), collect
// combined output for up to timeoutMs, then SIGTERM. We never make a turn — a
// zero-turn resume is the validated adoption shape. Resolves the output PLUS exit semantics:
// `exitedBeforeTimeout` distinguishes a self-exiting rejection (validated:
// exit 1 in ~1-2s, before bundle/provider init) from an adoption that stays
// interactive until OUR SIGTERM. timeoutMs must absorb the first run's
// network bundle-prepare git clones in a fresh HOME (~30s observed).
function runResume(
  cli: IsolatedAmplifierCli,
  sessionId: string,
  opts: { home: string; cwd: string; timeoutMs: number },
): Promise<{ output: string; exitedBeforeTimeout: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cli.command, [...cli.baseArgs, 'session', 'resume', '--full-history', sessionId], {
      cwd: opts.cwd,
      // VALIDATED (V1): HOME is the isolation lever — session storage is
      // hardcoded to $HOME/.amplifier; AMPLIFIER_HOME would isolate nothing
      // but caches.
      env: isolatedAmplifierEnv(opts.home),
    })
    let output = ''
    let timedOut = false
    child.stdout.on('data', (d) => { output += String(d) })
    child.stderr.on('data', (d) => { output += String(d) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, opts.timeoutMs)
    child.on('close', () => { clearTimeout(timer); resolve({ output, exitedBeforeTimeout: !timedOut }) })
  })
}

// The rejection message echoes the queried id (validated:
// `Error: No session found matching '<uuid>'`), so RAW output comparison
// between two resumes is vacuous — two rejections always differ by the
// echoed id. Normalize UUIDs out before comparing signatures.
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
function normalize(s: string): string {
  return s.replace(UUID_RE, '<ID>')
}

describe('amplifier stub-adoption contract (real CLI)', () => {
  let isolatedCli: IsolatedAmplifierCli | undefined
  let isolatedHome: string | undefined

  beforeAll(async () => {
    if (onPath && realEnabled) {
      isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'amp-contract-home-'))
      try {
        isolatedCli = await createIsolatedAmplifierCli()
      } catch (error) {
        await fs.rm(isolatedHome, { recursive: true, force: true })
        isolatedHome = undefined
        throw error
      }
    }
  }, 60_000)

  afterAll(async () => {
    try {
      await isolatedCli?.dispose()
    } finally {
      if (isolatedHome) {
        await fs.rm(isolatedHome, { recursive: true, force: true })
      }
    }
  })

  function cli(): IsolatedAmplifierCli {
    if (!isolatedCli) throw new Error('Isolated Amplifier CLI was not prepared')
    return isolatedCli
  }

  function home(): string {
    if (!isolatedHome) throw new Error('Isolated Amplifier HOME was not prepared')
    return isolatedHome
  }

  const itAdoption = onPath && realEnabled ? it : it.skip
  itAdoption('adopts a broker-shaped pre-created stub under the cwd slug', async () => {
    const cwdRaw = await fs.mkdtemp(path.join(os.tmpdir(), 'amp-contract-cwd-'))
    const cwd = await fs.realpath(cwdRaw) // mirror Path.cwd().resolve()
    try {
      // Self-calibrating negative probe, run TWICE with two random ids (no
      // hardcoded CLI error strings): after UUID normalization the rejection
      // signature must be id-independent — that CALIBRATES the signature and
      // makes the adoption comparison below non-vacuous (validated V3: raw
      // rejection outputs differ only by the echoed id).
      const unknown1 = await runResume(cli(), randomUUID(), {
        home: home(),
        cwd,
        timeoutMs: 60_000,
      })
      const unknown2 = await runResume(cli(), randomUUID(), {
        home: home(),
        cwd,
        timeoutMs: 60_000,
      })
      expect(normalize(unknown1.output)).toEqual(normalize(unknown2.output))
      // Rejections self-exit on their own (validated: exit 1 in ~1-2s,
      // before bundle/provider init) — never reach our SIGTERM.
      expect(unknown1.exitedBeforeTimeout).toBe(true)
      expect(unknown2.exitedBeforeTimeout).toBe(true)

      const sessionId = randomUUID()
      const dir = await writeStub(home(), cwd, sessionId)
      const stub = await runResume(cli(), sessionId, {
        home: home(),
        cwd,
        timeoutMs: 60_000,
      })

      // Adoption signal 1: the id-normalized stub output must NOT match the
      // calibrated rejection signature.
      expect(normalize(stub.output)).not.toEqual(normalize(unknown1.output))
      // Adoption signal 2: exit semantics — the stub resume stays
      // interactive until OUR SIGTERM (a rejection would have self-exited
      // before the timeout).
      expect(stub.exitedBeforeTimeout).toBe(false)

      // The dir survived, metadata still parses, identity + custom key intact.
      const meta = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'))
      expect(meta.session_id).toBe(sessionId)
      expect(meta.freshell_terminal_id).toBe('contract-test-terminal')
      // Zero-turn adoption must not mark the session used (GC contract).
      expect(meta.turn_count).toBeUndefined()
    } finally {
      await fs.rm(cwdRaw, { recursive: true, force: true }).catch(() => {})
    }
  }, 120_000)

  const itSlug = onPath && realEnabled && hasProviderKey ? it : it.skip
  itSlug('creates its own session dirs under exactly our computed slug, with turn_count', async () => {
    const cwdRaw = await fs.mkdtemp(path.join(os.tmpdir(), 'amp-contract-slugcwd-'))
    const cwd = await fs.realpath(cwdRaw)
    try {
      await execFileAsync(
        cli().command,
        [
          ...cli().baseArgs,
          'run',
          '--output-format',
          'json',
          'Reply with exactly: contract-ok',
        ],
        {
          cwd,
          // Same HOME isolation as the adoption test (sessions are hardcoded
          // to $HOME/.amplifier — validated V1). AMPLIFIER_HOME is also pinned
          // so an inherited value cannot redirect cache writes outside it.
          env: isolatedAmplifierEnv(home()),
          timeout: 180_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      )
      const projectDirs = await fs.readdir(path.join(home(), '.amplifier', 'projects'))
      // EXACT-match slug contract: a mismatch here fails silently in prod
      // (stub dir and amplifier's own dir diverge), so this must be strict.
      expect(projectDirs).toContain(cwdSlug(cwd))
      const sessionsDir = path.join(home(), '.amplifier', 'projects', cwdSlug(cwd), 'sessions')
      const sessions = await fs.readdir(sessionsDir)
      expect(sessions.length).toBeGreaterThan(0)
      const meta = JSON.parse(
        await fs.readFile(path.join(sessionsDir, sessions[0], 'metadata.json'), 'utf8'),
      )
      // The "used" signature the broker's GC keys off.
      expect(meta.turn_count).toBeDefined()
      expect(meta.working_dir).toBe(cwd)
    } finally {
      await fs.rm(cwdRaw, { recursive: true, force: true }).catch(() => {})
    }
  }, 240_000)
})
