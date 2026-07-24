import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startExternalServer } from '../../harness/external-server.js'
import { capturePtyScenario } from '../../harness/pty-capture.js'
import { BATCH_PTY_SCENARIOS } from '../../fixtures/batch-pty-scenarios.js'

/**
 * Generate/refresh the committed T1 **batch-ON** PTY goldens (`terminal.output.batch`).
 *
 * Boots ONE isolated ORIGINAL server, negotiates `terminalOutputBatchV1`, and captures
 * each scenario's exact terminal output bytes (reassembled from the BATCH frames)
 * between the sentinels, writing:
 *   - `<name>.batch.golden`     — the raw golden bytes (the Rust port target via the batch path)
 *   - `<name>.batch.meta.json`  — scenario + reassembledLength + sha256 + output type counts
 *
 * WHY DATA, NOT STRUCTURE: the live batch SEGMENT structure is chunk-nondeterministic
 * (two boots of the original produce different batch groupings — proven empirically), so
 * the committed live golden is the DATA (which IS deterministic). The byte-exact batch
 * STRUCTURE proof is the deterministic crate golden test
 * (`crates/freshell-terminal/tests/batch_wire_golden.rs`, goldens under
 * `port/oracle/baselines/batch/`).
 *
 * WHY THE BASELINE IS CAPTURED FROM `rust` (`FRESHELL_ORACLE_TARGET=rust` by default
 * here): in THIS environment the node ORIGINAL's node-pty master-read UPPERCASES all
 * PTY output (a\u2192A, and even ANSI `31m`\u2192`31M`) — a flagged candidate deviation
 * (`DEVIATIONS.md`), NOT controlled by any tty case flag (stty shows `-OLCUC -IUCLC
 * -XCASE`). The rust port (portable-pty) preserves case and reproduces every
 * historically-committed batch-OFF `<name>.golden` byte-for-byte, so it is the
 * case-correct baseline. The live test additionally asserts, for the four shared
 * scenarios, that `<name>.batch.golden === <name>.golden` (batch\u2261legacy DATA at the
 * baseline) and, for the node original, equivalence MODULO the flagged case-fold.
 *
 * Usage:  npx tsx port/oracle/baselines/pty/generate-batch-pty-goldens.ts
 *
 * SAFETY: spawns its own server on an ephemeral loopback port and reaps it; never
 * touches the user's live :3001 / pid 1262455.
 */

const __filename = fileURLToPath(import.meta.url)
const BASELINE_DIR = path.dirname(__filename)
const CAPABILITIES = { terminalOutputBatchV1: true }

async function main(): Promise<void> {
  const cols = 120
  const rows = 30
  // Case-correct baseline (see header): rust reproduces the historical node baseline;
  // the current node original uppercases via the flagged node-pty read defect.
  const server = await startExternalServer({ target: 'rust', provider: 'oracle-t1-batch-golden-gen' })
  const written: string[] = []
  try {
    for (const scenario of BATCH_PTY_SCENARIOS) {
      const result = await capturePtyScenario(server, scenario, { cols, rows, capabilities: CAPABILITIES })
      // The negotiated stream must arrive as batch frames (never legacy) for these
      // small scenarios (no over-budget single-segment fallback).
      const batchCount = result.outputTypeCounts['terminal.output.batch'] ?? 0
      const legacyCount = result.outputTypeCounts['terminal.output'] ?? 0
      if (batchCount === 0) {
        throw new Error(`scenario ${scenario.name}: expected terminal.output.batch frames, saw none (${JSON.stringify(result.outputTypeCounts)})`)
      }
      const goldenPath = path.join(BASELINE_DIR, `${scenario.name}.batch.golden`)
      const metaPath = path.join(BASELINE_DIR, `${scenario.name}.batch.meta.json`)
      await fsp.writeFile(goldenPath, result.goldenBytes)
      const meta = {
        scenario: scenario.name,
        description: scenario.description,
        shell: scenario.shell,
        mode: scenario.mode,
        inputLines: scenario.inputLines,
        capabilities: CAPABILITIES,
        cols,
        rows,
        reassembledLength: result.reassembledLength,
        byteLength: result.goldenBytes.length,
        sha256: result.sha256,
        outputTypeCounts: result.outputTypeCounts,
      }
      await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
      written.push(
        `${scenario.name}: ${result.goldenBytes.length}B sha256=${result.sha256.slice(0, 16)}… ` +
          `types=${JSON.stringify(result.outputTypeCounts)} (batch=${batchCount}, legacy=${legacyCount})`,
      )
    }
  } finally {
    await server.stop()
  }
  // eslint-disable-next-line no-console
  console.log(`Wrote ${written.length} batch-ON PTY goldens:\n  ${written.join('\n  ')}`)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('batch golden generation failed:', err)
    process.exitCode = 1
  })
}

export { BASELINE_DIR }
