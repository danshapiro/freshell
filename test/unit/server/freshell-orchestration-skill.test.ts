import path from 'node:path'
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('freshell orchestration skill docs', () => {
  it('requires quoting multi-word rename names and targets', async () => {
    const skillPath = path.resolve(process.cwd(), '.claude/skills/freshell-orchestration/SKILL.md')
    const content = await fs.readFile(skillPath, 'utf8')

    expect(content).not.toContain('prefer the flagged `-t/-n` form.')
    expect(content).toContain('If a target or name contains spaces, quote it.')
  })
})
