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
})
