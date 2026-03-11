// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_VISIBLE_FIRST_CAPABILITIES,
  FORBIDDEN_VISIBLE_FIRST_ROUTE_STRINGS,
  FORBIDDEN_VISIBLE_FIRST_WS_TYPES,
  VISIBLE_FIRST_WS_CONNECT_OWNER,
} from '@test/helpers/visible-first/acceptance-contract'

const packageJsonPath = path.resolve(process.cwd(), 'package.json')

describe('visible-first acceptance contract', () => {
  it('defines the forbidden websocket types, capabilities, route strings, and ownership invariant once', () => {
    expect(FORBIDDEN_VISIBLE_FIRST_WS_TYPES).toEqual([
      'sessions.updated',
      'sessions.page',
      'sessions.patch',
      'sessions.fetch',
      'sdk.history',
      'terminal.list',
      'terminal.list.response',
      'terminal.list.updated',
      'terminal.meta.list',
      'terminal.meta.list.response',
    ])

    expect(FORBIDDEN_VISIBLE_FIRST_CAPABILITIES).toEqual([
      'sessionsPatchV1',
      'sessionsPaginationV1',
    ])

    expect(FORBIDDEN_VISIBLE_FIRST_ROUTE_STRINGS).toEqual([
      '/api/sessions/search',
      '/api/sessions/query',
    ])

    expect(VISIBLE_FIRST_WS_CONNECT_OWNER).toBe('src/App.tsx')
  })

  it('declares the focused contract lane and JSON report command in package.json', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.['test:visible-first:contract']).toBe(
      'vitest run test/unit/visible-first/acceptance-contract.test.ts test/unit/visible-first/protocol-harness.test.ts test/unit/lib/visible-first-acceptance-report.test.ts',
    )
    expect(packageJson.scripts?.['visible-first:contract:check']).toBe(
      'tsx scripts/assert-visible-first-acceptance.ts',
    )
  })
})
