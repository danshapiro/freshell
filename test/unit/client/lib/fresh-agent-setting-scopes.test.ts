import { describe, expect, it } from 'vitest'
import {
  SETTING_SCOPE_COPY,
  freshAgentDialogFooterCopy,
  settingScopeHint,
} from '@/lib/fresh-agent-setting-scopes'

describe('fresh-agent setting scope copy', () => {
  it('maps per-send/create-only to hint copy', () => {
    expect(settingScopeHint({ permissionMode: 'per-send' }, 'permissionMode')).toBe(SETTING_SCOPE_COPY['per-send'])
    expect(settingScopeHint({ permissionMode: 'create-only' }, 'permissionMode')).toBe(SETTING_SCOPE_COPY['create-only'])
    expect(settingScopeHint(undefined, 'permissionMode')).toBe(SETTING_SCOPE_COPY['per-send']) // legacy fallback
  })
  it('builds the model dialog footer per scope', () => {
    expect(freshAgentDialogFooterCopy({ model: 'per-send', effort: 'per-send' })).toContain('applies from your next message')
    expect(freshAgentDialogFooterCopy({ model: 'create-only' })).toContain('applies at session start')
    expect(freshAgentDialogFooterCopy(undefined)).toContain('applies from your next message') // legacy fallback
  })
})
