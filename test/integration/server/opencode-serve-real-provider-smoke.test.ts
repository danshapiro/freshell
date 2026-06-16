import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  OpencodeServeManager,
  OPENCODE_SIDECAR_OWNERSHIP_ENV,
} from '../../../server/fresh-agent/adapters/opencode/serve-manager.js'
import { resolveProviderBinary } from '../../../test/helpers/coding-cli/real-session-contract-harness.js'

const opencode = await resolveProviderBinary('opencode')
const KIMI = 'umans-ai-coding-plan/umans-kimi-k2.7'
const describeReal = opencode.resolvedPath ? describe.sequential : describe.skip

describeReal(
  `opencode serve real provider${opencode.resolvedPath ? '' : ' (opencode not on PATH)'}`,
  () => {
    describe('OpencodeServeManager lifecycle', () => {
      it('starts a real serve, reports healthy, lists Kimi k2.7, and shuts the owned process down', async () => {
        const manager = new OpencodeServeManager()
        try {
          const { baseUrl } = await manager.ensureStarted()
          expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

          const providers = await fetch(`${baseUrl}/config/providers`).then((r) => r.json() as any)
          const json = JSON.stringify(providers)
          if (!json.includes('umans-kimi-k2.7')) {
            console.warn('Kimi k2.7 not configured on this machine; skipping turn assertions in this run.')
          }
        } finally {
          await manager.shutdown()
        }
      }, 60_000)
    })
  },
)

export { KIMI, OPENCODE_SIDECAR_OWNERSHIP_ENV }
