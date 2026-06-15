import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

type CoverageRequirement = {
  category: string
  file: string
  signals: RegExp[]
}

const requirements: CoverageRequirement[] = [
  {
    category: 'public protocol rejects removed legacy client commands',
    file: 'test/unit/server/ws-fresh-agent-contract.test.ts',
    signals: [
      /ClientMessageSchema\.safeParse/,
      /freshAgent\.send/,
      /success\)\.toBe\(false\)/,
    ],
  },
  {
    category: 'provider events normalize before reaching browser',
    file: 'test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts',
    signals: [
      /normalizes \$provider snapshot\/status-only live provider events/,
      /freshAgent\.session\.snapshot/,
      /freshAgent\.status/,
    ],
  },
  {
    category: 'create restore gate delays browser created acknowledgement',
    file: 'test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts',
    signals: [
      /does not send freshAgent\.created until create has coherent runtime state/,
      /freshAgent\.created/,
      /subscribe/,
    ],
  },
  {
    category: 'attach restore failure does not grant mutation rights',
    file: 'test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts',
    signals: [
      /does not subscribe or authorize mutating commands after attach restore failure/,
      /UNAUTHORIZED/,
      /not\.toHaveBeenCalled/,
    ],
  },
  {
    category: 'all fresh-agent mutating commands require ownership',
    file: 'test/unit/server/ws-handler-fresh-agent-ownership.test.ts',
    signals: [
      /freshAgent\.send/,
      /freshAgent\.interrupt/,
      /freshAgent\.compact/,
      /freshAgent\.approval\.respond/,
      /freshAgent\.question\.respond/,
      /freshAgent\.fork/,
      /freshAgent\.kill/,
    ],
  },
  {
    category: 'client ignores removed top-level legacy events',
    file: 'test/unit/client/lib/fresh-agent-ws.test.ts',
    signals: [
      /does not handle top-level legacy SDK websocket messages/,
      /toBe\(false\)/,
    ],
  },
  {
    category: 'client protects delayed metadata and duplicate interactive requests',
    file: 'test/unit/client/lib/fresh-agent-ws.test.ts',
    signals: [
      /does not let delayed metadata downgrade newer snapshot identity/,
      /deduplicates repeated permission and question requests by request id/,
      /pendingPermissions/,
      /pendingQuestions/,
    ],
  },
  {
    category: 'stale bundle mismatch drops queued messages before reload',
    file: 'test/unit/client/ws-client-protocol-reload.test.ts',
    signals: [
      /does not flush queued legacy, fresh-agent, or layout messages after protocol mismatch/,
      /PROTOCOL_MISMATCH/,
      /freshAgent\.create/,
      /ui\.layout\.sync/,
    ],
  },
]

describe('Task 7 fresh-agent websocket parity coverage', () => {
  it.each(requirements)('covers $category', ({ file, signals }) => {
    const absolutePath = path.resolve(process.cwd(), file)
    expect(fs.existsSync(absolutePath), `${file} should exist`).toBe(true)
    const contents = fs.readFileSync(absolutePath, 'utf8')
    for (const signal of signals) {
      expect(contents, `${file} should include ${signal}`).toMatch(signal)
    }
  })
})
