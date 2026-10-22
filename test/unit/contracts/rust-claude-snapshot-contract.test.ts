// Pins the Rust claude snapshot adapter's output (via the checked-in golden fixture,
// asserted byte-identical to the builder by crates/freshell-freshagent/src/
// claude_snapshot.rs::builder_output_matches_the_golden_snapshot_fixture) against the
// FROZEN client's strict zod contract. If this fails, the Rust builder violates
// FreshAgentSnapshotSchema and the pane would render nothing (FreshAgentApiContractError).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { FreshAgentSnapshotSchema } from '../../../shared/fresh-agent-contract.js'

describe('rust claude snapshot contract', () => {
  it('the golden snapshot fixture parses under FreshAgentSnapshotSchema (strict)', () => {
    const golden = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../fixtures/fresh-agent/claude-snapshot-golden.json'),
        'utf-8',
      ),
    )
    const parsed = FreshAgentSnapshotSchema.safeParse(golden)
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2))
    }
    expect(parsed.success).toBe(true)
    // Load-bearing specifics for the frozen client:
    expect(parsed.data.turns[0].role).toBe('user')
    expect(parsed.data.turns[0].items[0]).toMatchObject({ kind: 'text', text: 'first question' })
    const turnIds = parsed.data.turns.map((t: any) => t.turnId)
    expect(new Set(turnIds).size).toBe(turnIds.length)
  })

  // Goldens built by the Rust builder from transcripts the pinned Claude CLI
  // 2.1.237 wrote (crates/freshell-freshagent/src/claude_snapshot_real_cli_tests.rs
  // asserts builder == golden). Each must satisfy the strict client schema.
  const realCliRoot = path.join(__dirname, '../../fixtures/fresh-agent/claude/real-cli-2.1.237')
  const realCliScenarios = fs.readdirSync(realCliRoot)
    .filter((name) => fs.existsSync(path.join(realCliRoot, name, 'snapshot.golden.json')))

  it('covers every captured real-CLI scenario', () => {
    expect(realCliScenarios.sort()).toEqual([
      'agent-async',
      'agent-failed',
      'api-error',
      'compact-fail',
      'compact-ok',
      'image',
      'tools-sync',
    ])
  })

  it.each(realCliScenarios)('the %s real-CLI golden parses under FreshAgentSnapshotSchema (strict)', (scenario) => {
    const golden = JSON.parse(
      fs.readFileSync(path.join(realCliRoot, scenario, 'snapshot.golden.json'), 'utf-8'),
    )
    const parsed = FreshAgentSnapshotSchema.safeParse(golden)
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2))
    }
    const turnIds = parsed.data.turns.map((t) => t.turnId)
    expect(new Set(turnIds).size).toBe(turnIds.length)
  })
})
