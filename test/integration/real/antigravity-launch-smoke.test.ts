// @vitest-environment node
//
// Real Antigravity CLI launch smoke test.
//
// - "launches the real agy binary" always runs when `agy` (or the
//   `ANTIGRAVITY_CMD` override) is available — it skips with a clear reason
//   otherwise, never fails. This is the "actually launch the real CLI" proof:
//   it spawns the binary and asserts the version shape the Task 1 real-binary
//   probe recorded (`agy --version` prints a bare semver, e.g. `1.4.10`).
// - "rejects a bare -i" also always runs when available (round 6, whole-
//   delta review Major): the argv probes (2026-11-01, binaries v1.4.10 AND
//   v1.4.12, receipts in the plan's Provider Contract Record) proved
//   `-i`/`--prompt-interactive` TAKE A PROMPT VALUE — a bare `-i` exits 2
//   at flag parse (`flag needs an argument: -i`), BEFORE any TTY, auth, or
//   store work. Freshell panes therefore launch BARE (the manifest ships no
//   static args); this smoke is the early warning that a future CLI version
//   changed that argv shape (re-open the launch-contract record if it ever
//   fails). It runs with a disposable HOME for hygiene parity with the
//   probe, bounded by a timeout, and performs no authenticated operation.
// - "completes a headless turn" is opt-in: it makes a real model call and is
//   DOUBLE-gated by FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 AND a Google API
//   key in the env. It skips (never fails) otherwise, and never runs in the
//   default suite — the whole test/integration/real/ tree is excluded from the
//   default config without the opt-in.
//
//   To run the full turn (CLI settings precondition: the real CLI's settings
//   must select API-key auth — `modelProvider: "gemini"` — per the plan's
//   Provider Contract Record, or the first paid attempt fails on CLI setup
//   rather than a contract fact):
//     FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 GEMINI_API_KEY=... \
//       pnpm run test:vitest run test/integration/real/antigravity-launch-smoke.test.ts \
//       --config config/vitest/vitest.config.ts
//
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

const execFileAsync = promisify(execFile)

// Provider contract (plan docs/plans/2026-10-29-google-cli-first-class-support.md,
// Provider Contract Record): command `agy`, env override `ANTIGRAVITY_CMD`;
// `-p` is the short alias for `--print` (headless prompt).
const agyCommand = process.env.ANTIGRAVITY_CMD || 'agy'

async function agyAvailable(): Promise<boolean> {
  try {
    await execFileAsync(agyCommand, ['--version'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

const available = await agyAvailable()
const realEnabled = process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
const hasProviderKey = Boolean(process.env.GEMINI_API_KEY)

describe('antigravity real launch smoke', () => {
  const itIfAvailable = available
    ? it
    : it.skip
  itIfAvailable('launches the real agy binary (agy --version)', async () => {
    const { stdout } = await execFileAsync(agyCommand, ['--version'], { timeout: 20_000 })
    // The real binary prints a bare version ("1.4.10" — Task 1 probe,
    // contract-probe.md), not a product name, so assert that exact shape.
    expect(stdout.trim()).toMatch(/^\d+\.\d+(\.\d+)?/)
  }, 30_000)

  itIfAvailable('rejects a bare -i exactly as the round-6 argv probes recorded', async () => {
    // `flag needs an argument: -i` + usage on stderr, exit 2, at flag
    // parse — before any TTY/auth/store work. Disposable HOME for hygiene
    // parity with the probe; bounded timeout; no authenticated operation.
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agy-smoke-home-'))
    try {
      const res = await execFileAsync(agyCommand, ['-i'], {
        env: { ...process.env, HOME: tmpHome },
        timeout: 20_000,
      }).then(
        (r) => ({ code: 0, stderr: String(r.stderr ?? '') }),
        (err: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) => ({
          code: typeof err.code === 'number' ? err.code : -1,
          stderr: String(err.stderr ?? ''),
        }),
      )
      expect(res.code, `agy -i stderr: ${res.stderr}`).toBe(2)
      expect(res.stderr).toContain('flag needs an argument: -i')
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)

  const runTurn = available && realEnabled && hasProviderKey
  const itTurn = runTurn
    ? it
    : it.skip
  itTurn('completes a headless turn and echoes the nonce', async () => {
    const { stdout } = await execFileAsync(
      agyCommand,
      ['-p', 'Reply with exactly: antigravity-smoke-ok'],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    )
    expect(stdout).toContain('antigravity-smoke-ok')
  }, 200_000)
})
