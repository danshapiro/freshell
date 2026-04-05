import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('dev scripts tsx watch exclude patterns', () => {
  const packageJsonPath = path.resolve(__dirname, '../../../package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))

  it('dev script contains --exclude patterns for .worktrees, demo-projects, and dist', () => {
    const devScript = packageJson.scripts.dev
    expect(devScript).toContain("--exclude '.worktrees/**'")
    expect(devScript).toContain("--exclude 'demo-projects/**'")
    expect(devScript).toContain("--exclude 'dist/**'")
    expect(devScript).not.toContain('--ignore')
  })

  it('dev:server script contains --exclude patterns for .worktrees, demo-projects, and dist', () => {
    const devServerScript = packageJson.scripts['dev:server']
    expect(devServerScript).toContain("--exclude '.worktrees/**'")
    expect(devServerScript).toContain("--exclude 'demo-projects/**'")
    expect(devServerScript).toContain("--exclude 'dist/**'")
    expect(devServerScript).not.toContain('--ignore')
  })
})
