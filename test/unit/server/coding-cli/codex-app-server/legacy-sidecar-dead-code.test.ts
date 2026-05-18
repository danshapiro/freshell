import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '../../../../..')

describe('Codex app-server sidecar production surface', () => {
  it('does not keep the legacy polling sidecar modules alongside the launch-planner path', () => {
    expect(fs.existsSync(path.join(repoRoot, 'server/coding-cli/codex-app-server/sidecar.ts'))).toBe(false)
    expect(fs.existsSync(path.join(repoRoot, 'server/coding-cli/codex-app-server/durable-rollout-tracker.ts'))).toBe(false)
    expect(fs.existsSync(path.join(repoRoot, 'test/unit/server/coding-cli/codex-app-server/sidecar.test.ts'))).toBe(false)
    expect(fs.existsSync(path.join(repoRoot, 'test/unit/server/coding-cli/codex-app-server/durable-rollout-tracker.test.ts'))).toBe(false)
  })
})
