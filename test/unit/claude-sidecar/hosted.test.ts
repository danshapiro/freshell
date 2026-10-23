// @vitest-environment node

// One place decides whether the claude sidecar is hosted (hosted.mjs). The
// session host sets FRESHELL_HOSTED_FRESH_AGENT to the provider it hosts:
// `claude` for freshclaude, `kilroy` for kilroy. Every hosted sidecar logs CLI
// output by size only. The managed spawn check and the fixed hosted MCP recipe
// apply to hosted claude alone today; extending them to hosted kilroy is an
// explicit item of the api-hosted-ops workstream
// (docs/plans/2026-10-22-freshclaude-api-hosted-ops.md §2.4), not a silent
// side effect of sharing the predicate.

import { describe, expect, it } from 'vitest'
// @ts-expect-error JavaScript sidecar module has no declaration file.
import { hostedProvider, isHostedSidecar, usesHostedClaudeRuntime } from '../../../crates/freshell-claude-sidecar/hosted.mjs'
// @ts-expect-error JavaScript sidecar module has no declaration file.
import { hostedMcpServers } from '../../../crates/freshell-claude-sidecar/hosted-mcp.mjs'
// @ts-expect-error JavaScript sidecar module has no declaration file.
import { managedSdkSpawn } from '../../../crates/freshell-claude-sidecar/exec-profile.mjs'

const env = (provider?: string) => (provider === undefined ? {} : { FRESHELL_HOSTED_FRESH_AGENT: provider })

describe('Claude sidecar hosted mode', () => {
  it('names the provider the session host hosts, or none', () => {
    expect(hostedProvider(env('claude'))).toBe('claude')
    expect(hostedProvider(env('kilroy'))).toBe('kilroy')
    expect(hostedProvider(env(''))).toBeUndefined()
    expect(hostedProvider(env())).toBeUndefined()
  })

  it('treats every hosted sidecar as hosted for logging (claude and kilroy alike)', () => {
    expect(isHostedSidecar(env('claude'))).toBe(true)
    expect(isHostedSidecar(env('kilroy'))).toBe(true)
    expect(isHostedSidecar(env(''))).toBe(false)
    expect(isHostedSidecar(env())).toBe(false)
  })

  it('gives the managed spawn check and the fixed MCP recipe to hosted claude only', () => {
    expect(usesHostedClaudeRuntime(env('claude'))).toBe(true)
    expect(usesHostedClaudeRuntime(env('kilroy'))).toBe(false)
    expect(usesHostedClaudeRuntime(env())).toBe(false)

    expect(hostedMcpServers(true, env('claude'))).toEqual({ freshell: { command: 'node', args: ['/opt/freshell-mcp/server.js'] } })
    expect(hostedMcpServers(true, env('kilroy'))).toBeUndefined()
    expect(hostedMcpServers(true, env())).toBeUndefined()

    // The managed spawn is Linux-only by design.
    expect(typeof managedSdkSpawn(() => {}, env('claude'))).toBe(process.platform === 'linux' ? 'function' : 'undefined')
    expect(managedSdkSpawn(() => {}, env('kilroy'))).toBeUndefined()
    expect(managedSdkSpawn(() => {}, env())).toBeUndefined()
  })
})
