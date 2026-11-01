import { expect, it } from 'vitest'
import { convergeCodexSettings } from '@/lib/fresh-agent-settings-convergence'

it('keeps a newly explicit native Default when an older effort statement arrives after an inherited selection', () => {
  const original = { effort: undefined, effortIsNativeDefault: false }
  const first = convergeCodexSettings(undefined, 'codex:owned', original, {})
  const cleared = { ...original, effortIsNativeDefault: true }
  const late = convergeCodexSettings(first.cursor, 'codex:owned', cleared, { effort: 'ultra' })
  expect(late.updates).toEqual({})
  const acknowledged = convergeCodexSettings(late.cursor, 'codex:owned', cleared, { effort: null })
  expect(acknowledged.updates).toEqual({})
  const changed = convergeCodexSettings(acknowledged.cursor, 'codex:owned', cleared, { effort: 'future-effort' })
  expect(changed.updates).toEqual({ effort: 'future-effort', effortIsNativeDefault: false })
})
