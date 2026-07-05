import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startExternalServer } from '../../harness/external-server.js'
import { capturePtyScenario } from '../../harness/pty-capture.js'
import { PTY_SCENARIOS } from '../../fixtures/pty-scenarios.js'

/**
 * Generate/refresh the committed T1 PTY goldens.
 *
 * Boots ONE isolated original server, captures every scenario's exact terminal
 * output bytes between the sentinels, and writes:
 *   - `<name>.golden`     — the raw golden bytes (binary; the Rust port target)
 *   - `<name>.meta.json`  — scenario + resolved shell argv + reassembledLength + sha256
 *
 * Only run this when the two-boot determinism test (pty-determinism-t1.test.ts)
 * is green; that test is what proves these bytes are reproducible. Regenerate
 * intentionally (a changed golden is a real behavioural change to adjudicate).
 *
 * Usage:  npx tsx port/oracle/baselines/pty/generate-pty-goldens.ts
 *
 * SAFETY: spawns its own server on an ephemeral loopback port and reaps it; never
 * touches the user's live :3001 / pid 1262455.
 */

const __filename = fileURLToPath(import.meta.url)
const BASELINE_DIR = path.dirname(__filename)

/** On this Linux host, shell:'system' → /bin/bash -l (terminal-registry.ts buildSpawnSpec). */
const RESOLVED_SHELL_ARGV = ['/bin/bash', '-l']

export interface GoldenMeta {
  scenario: string
  description: string
  /** The shell enum requested in terminal.create. */
  shell: string
  mode: string
  /** The argv the server actually spawns for that shell on this host. */
  resolvedShellArgv: string[]
  inputLines: string[]
  cols: number
  rows: number
  /** Length of the full reassembled stream (banner+sentinels+payload) at capture time. */
  reassembledLength: number
  /** Length of the golden byte window. */
  byteLength: number
  sha256: string
}

async function main(): Promise<void> {
  const cols = 120
  const rows = 30
  const server = await startExternalServer({ provider: 'oracle-t1-golden-gen' })
  const written: string[] = []
  try {
    for (const scenario of PTY_SCENARIOS) {
      const result = await capturePtyScenario(server, scenario, { cols, rows })
      const goldenPath = path.join(BASELINE_DIR, `${scenario.name}.golden`)
      const metaPath = path.join(BASELINE_DIR, `${scenario.name}.meta.json`)

      await fsp.writeFile(goldenPath, result.goldenBytes)

      const meta: GoldenMeta = {
        scenario: scenario.name,
        description: scenario.description,
        shell: scenario.shell,
        mode: scenario.mode,
        resolvedShellArgv: RESOLVED_SHELL_ARGV,
        inputLines: scenario.inputLines,
        cols,
        rows,
        reassembledLength: result.reassembledLength,
        byteLength: result.goldenBytes.length,
        sha256: result.sha256,
      }
      await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)

      written.push(
        `${scenario.name}: ${result.goldenBytes.length}B sha256=${result.sha256.slice(0, 16)}… ` +
          `-> ${path.relative(process.cwd(), goldenPath)}`,
      )
    }
  } finally {
    await server.stop()
  }
  // eslint-disable-next-line no-console
  console.log(`Wrote ${written.length} PTY goldens:\n  ${written.join('\n  ')}`)
}

// Only run when invoked directly (not when imported for BASELINE_DIR/type reuse).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('golden generation failed:', err)
    process.exitCode = 1
  })
}

export { BASELINE_DIR, RESOLVED_SHELL_ARGV }
