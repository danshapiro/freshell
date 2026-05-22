import { describe, expect, it } from 'vitest'

import {
  CODEX_CLIENT_REQUEST_METHODS,
  CODEX_RUNTIME_LEAF_VALUES,
  CODEX_SERVER_NOTIFICATION_METHODS,
  CODEX_SERVER_REQUEST_METHODS,
  CODEX_THREAD_ITEM_VARIANTS,
} from '../../../../fixtures/coding-cli/codex-app-server/schema-inventory.js'
import {
  CODEX_CLIENT_REQUEST_TRACEABILITY,
  CODEX_RUNTIME_LEAF_TRACEABILITY,
  CODEX_SERVER_NOTIFICATION_TRACEABILITY,
  CODEX_SERVER_REQUEST_TRACEABILITY,
  CODEX_THREAD_ITEM_TRACEABILITY,
} from '../../../../fixtures/coding-cli/codex-app-server/schema-traceability.js'

function expectExactCoverage(label: string, inventory: readonly string[], traced: readonly { name: string }[]) {
  expect(traced.map((entry) => entry.name).sort(), label).toEqual([...inventory].sort())
}

function expectFilledEntries(label: string, entries: readonly Array<Record<string, unknown>>) {
  for (const entry of entries) {
    for (const field of ['status', 'owner', 'parser', 'normalizer', 'ui', 'test']) {
      expect(entry[field], `${label}.${String(entry.name)}.${field}`).toBeTruthy()
    }
  }
}

describe('Codex generated schema traceability', () => {
  it('classifies every generated client request method', () => {
    expectExactCoverage('client request methods', CODEX_CLIENT_REQUEST_METHODS, CODEX_CLIENT_REQUEST_TRACEABILITY)
    expectFilledEntries('client request methods', CODEX_CLIENT_REQUEST_TRACEABILITY)
  })

  it('classifies every generated server request method', () => {
    expectExactCoverage('server request methods', CODEX_SERVER_REQUEST_METHODS, CODEX_SERVER_REQUEST_TRACEABILITY)
    expectFilledEntries('server request methods', CODEX_SERVER_REQUEST_TRACEABILITY)
  })

  it('classifies every generated server notification method', () => {
    expectExactCoverage('server notification methods', CODEX_SERVER_NOTIFICATION_METHODS, CODEX_SERVER_NOTIFICATION_TRACEABILITY)
    expectFilledEntries('server notification methods', CODEX_SERVER_NOTIFICATION_TRACEABILITY)
  })

  it('classifies every generated thread item variant', () => {
    expectExactCoverage('thread item variants', CODEX_THREAD_ITEM_VARIANTS, CODEX_THREAD_ITEM_TRACEABILITY)
    expectFilledEntries('thread item variants', CODEX_THREAD_ITEM_TRACEABILITY)
  })

  it('classifies every runtime leaf type and keeps values explicit', () => {
    expectExactCoverage(
      'runtime leaf types',
      Object.keys(CODEX_RUNTIME_LEAF_VALUES),
      CODEX_RUNTIME_LEAF_TRACEABILITY,
    )
    expectFilledEntries('runtime leaf types', CODEX_RUNTIME_LEAF_TRACEABILITY)

    expect(CODEX_RUNTIME_LEAF_VALUES.reasoningEffort).toContain('xhigh')
    expect(CODEX_RUNTIME_LEAF_VALUES.reasoningEffort).not.toContain('max')
    expect(CODEX_RUNTIME_LEAF_VALUES.askForApproval).not.toContain('bypassPermissions')
  })

  it('records that codex-cli 0.129.0 stable schema has no generated thread/turns/list method', () => {
    expect(CODEX_CLIENT_REQUEST_METHODS).not.toContain('thread/turns/list')
  })
})
