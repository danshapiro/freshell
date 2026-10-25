import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('executes the managed Codex wrapper with exact arguments and refuses a missing helper before npm dispatch', () => {
  const result = spawnSync(process.execPath, ['test/integration/providers/codex-managed-launch.mjs'], { encoding: 'utf8', timeout: 30_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('codex_managed_launch_unit_passed')
})

it('cleans owned image tags after setup and lost build acknowledgement failures', () => {
  const result = spawnSync(process.execPath, ['test/integration/providers/codex-managed-cleanup.mjs'], { encoding: 'utf8', timeout: 30_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('codex_managed_image_cleanup_passed')
})
