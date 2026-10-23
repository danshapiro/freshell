import { describe, expect, it } from 'vitest'
import type { FreshAgentPermissionUpdate } from '@shared/fresh-agent-contract'
import {
  buildAllowDecision,
  buildDenyDecision,
  buildPlanDecision,
  describePermissionUpdate,
  rememberLabel,
} from '@/lib/fresh-agent-permission-updates'

const npmRule = (destination: string): FreshAgentPermissionUpdate => ({
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
  behavior: 'allow',
  destination,
} as FreshAgentPermissionUpdate)
const acceptEdits: FreshAgentPermissionUpdate = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }

describe('describePermissionUpdate', () => {
  it('a project rule names the rule and the file it is saved to', () => {
    const line = describePermissionUpdate(npmRule('localSettings'))
    expect(line).toContain('Bash(npm test *)')
    expect(line).toContain('.claude/settings.local.json')
  })

  it('a conversation rule names the rule and no file', () => {
    const line = describePermissionUpdate(npmRule('session'))
    expect(line).toContain('Bash(npm test *)')
    expect(line).not.toMatch(/settings/)
  })

  it('each destination reads differently, and the shared and user files are named', () => {
    const lines = ['localSettings', 'projectSettings', 'userSettings', 'session'].map((destination) => describePermissionUpdate(npmRule(destination)))
    expect(new Set(lines).size).toBe(4)
    expect(lines[1]).toContain('.claude/settings.json')
    expect(lines[2]).toContain('~/.claude/settings.json')
  })

  it('a rule with no content names the whole tool, and several rules are all named', () => {
    const line = describePermissionUpdate({
      type: 'addRules',
      rules: [{ toolName: 'Read' }, { toolName: 'Grep', ruleContent: 'src/**' }],
      behavior: 'allow',
      destination: 'session',
    })
    expect(line).toContain('Read')
    expect(line).toContain('Grep(src/**)')
  })

  it('allow, deny and ask rules read differently', () => {
    const lines = (['allow', 'deny', 'ask'] as const).map((behavior) => describePermissionUpdate({ ...npmRule('session'), behavior } as FreshAgentPermissionUpdate))
    expect(new Set(lines).size).toBe(3)
  })

  it('a mode change and a directory are described in their own words', () => {
    const modes = (['acceptEdits', 'bypassPermissions', 'default', 'plan', 'dontAsk', 'auto'] as const)
      .map((mode) => describePermissionUpdate({ type: 'setMode', mode, destination: 'session' }))
    expect(new Set(modes).size).toBe(6)
    const directory = describePermissionUpdate({ type: 'addDirectories', directories: ['/srv/data'], destination: 'session' })
    expect(directory).toContain('/srv/data')
    expect(describePermissionUpdate({ type: 'removeDirectories', directories: ['/srv/data'], destination: 'session' })).not.toBe(directory)
  })

  it('replacing and removing rules read differently from adding them', () => {
    const lines = (['addRules', 'replaceRules', 'removeRules'] as const)
      .map((type) => describePermissionUpdate({ ...npmRule('localSettings'), type } as FreshAgentPermissionUpdate))
    expect(new Set(lines).size).toBe(3)
    for (const line of lines) expect(line).toContain('Bash(npm test *)')
  })
})

describe('rememberLabel', () => {
  it('names what the button does: auto-accepting edits when that is the only update, otherwise not asking again', () => {
    expect(rememberLabel([acceptEdits])).toBe('Allow and auto-accept edits')
    expect(rememberLabel([npmRule('localSettings')])).toBe('Allow and don\'t ask again')
    expect(rememberLabel([npmRule('localSettings'), acceptEdits])).toBe('Allow and don\'t ask again')
  })
})

describe('decision builders', () => {
  it('a plain allow states only the behavior: a defined updatedInput would replace the tool input', () => {
    expect(buildAllowDecision()).toEqual({ behavior: 'allow' })
    expect(buildAllowDecision([])).toEqual({ behavior: 'allow' })
  })

  it('an allow with updates sends exactly those updates', () => {
    const updates = [npmRule('localSettings'), acceptEdits]
    expect(buildAllowDecision(updates)).toEqual({ behavior: 'allow', updatedPermissions: updates })
  })

  it('a deny keeps the turn going, with the user\'s message or the default one', () => {
    expect(buildDenyDecision()).toEqual({ behavior: 'deny', message: 'Denied by user', interrupt: false })
    expect(buildDenyDecision('  not that file  ')).toEqual({ behavior: 'deny', message: 'not that file', interrupt: false })
    expect(buildDenyDecision('   ')).toEqual({ behavior: 'deny', message: 'Denied by user', interrupt: false })
  })

  it('each plan choice is its exact decision', () => {
    expect(buildPlanDecision('approve')).toEqual({ behavior: 'allow' })
    expect(buildPlanDecision('approve-accept-edits')).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    expect(buildPlanDecision('approve-bypass')).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
    })
    expect(buildPlanDecision('keep-planning', ' Split step 2 ')).toEqual({ behavior: 'deny', message: 'Split step 2', interrupt: false })
    expect(buildPlanDecision('keep-planning')).toEqual({ behavior: 'deny', message: 'The user wants to keep planning.', interrupt: false })
    expect(buildPlanDecision('keep-planning', '  ')).toEqual({ behavior: 'deny', message: 'The user wants to keep planning.', interrupt: false })
  })
})
