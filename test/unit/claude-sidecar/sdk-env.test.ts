// @vitest-environment node

import { describe, expect, it } from 'vitest'
// The sidecar runs directly in Node, so its shared environment logic is plain ESM.
// @ts-expect-error JavaScript sidecar module has no declaration file.
import { createClaudeSdkCleanEnv } from '../../../crates/freshell-claude-sidecar/sdk-env.mjs'

describe('Claude SDK clean environment', () => {
  it('drops CLAUDECODE so the CLI does not treat itself as a nested session', () => {
    expect(createClaudeSdkCleanEnv({ CLAUDECODE: '1', KEEP: 'yes' })).toEqual({ KEEP: 'yes' })
  })

  it('drops ANTHROPIC_API_KEY unless the managed OneCLI key is selected', () => {
    expect(createClaudeSdkCleanEnv({ ANTHROPIC_API_KEY: 'ambient', KEEP: 'yes' })).toEqual({ KEEP: 'yes' })
    expect(createClaudeSdkCleanEnv({ ANTHROPIC_API_KEY: 'ambient', FRESHELL_CLAUDE_ONECLI_API_KEY: 'true' }))
      .toEqual({})
  })

  it('keeps ANTHROPIC_API_KEY when FRESHELL_CLAUDE_ONECLI_API_KEY is exactly "1"', () => {
    expect(createClaudeSdkCleanEnv({
      ANTHROPIC_API_KEY: 'managed',
      FRESHELL_CLAUDE_ONECLI_API_KEY: '1',
      KEEP: 'yes',
    })).toEqual({ ANTHROPIC_API_KEY: 'managed', KEEP: 'yes' })
  })

  it('never passes the selection flag itself to the CLI', () => {
    expect(createClaudeSdkCleanEnv({ FRESHELL_CLAUDE_ONECLI_API_KEY: '1' })).toEqual({})
  })

  it('leaves the caller environment untouched', () => {
    const env = { CLAUDECODE: '1', ANTHROPIC_API_KEY: 'managed', FRESHELL_CLAUDE_ONECLI_API_KEY: '1' }
    createClaudeSdkCleanEnv(env)
    expect(env).toEqual({ CLAUDECODE: '1', ANTHROPIC_API_KEY: 'managed', FRESHELL_CLAUDE_ONECLI_API_KEY: '1' })
  })
})
