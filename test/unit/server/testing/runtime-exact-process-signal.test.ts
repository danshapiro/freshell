import { describe, expect, it } from 'vitest'
import {
  classifyExactProcessSignalResult,
  exactOwnedExecDockerArgs,
  exactProcessSignalDockerArgs,
  normalizeExpectedProcessFragments,
} from '../../../../scripts/testing/runtime-sandbox.js'

describe('exact owned runtime process signaling', () => {


  it('passes a bounded explicit provider environment to an exact owned exec', () => {
    const args = exactOwnedExecDockerArgs('b'.repeat(64), '65534:0', {
      HOME: '/home/freshell/provider',
      XDG_DATA_HOME: '/home/freshell/provider/.local/share',
    }, ['opencode', '--version'])
    expect(args).toEqual([
      'exec', '--user', '65534:0',
      '--env', 'HOME=/home/freshell/provider',
      '--env', 'XDG_DATA_HOME=/home/freshell/provider/.local/share',
      'b'.repeat(64), 'opencode', '--version',
    ])
    expect(() => exactOwnedExecDockerArgs('b'.repeat(64), '65534:0', { 'BAD-NAME': 'x' }, ['true']))
      .toThrow(/environment/i)
    expect(() => exactOwnedExecDockerArgs('b'.repeat(64), '65534:0', { HOME: 'bad\nvalue' }, ['true']))
      .toThrow(/environment/i)
  })

  it('uses container-root only inside the exact receipt-owned enclosure for the verified signal', () => {
    const args = exactProcessSignalDockerArgs('a'.repeat(64), 11, ['codex', 'app-server'], 'KILL')
    expect(args.slice(0, 5)).toEqual(['exec', '--user', '65534:0', 'a'.repeat(64), 'node'])
    expect(args).toContain('11')
    expect(args).toContain('KILL')
    expect(args).toContain(JSON.stringify(['codex', 'app-server']))
    expect(args.slice(-2)).toEqual(['65534', '0'])

    expect(() => exactProcessSignalDockerArgs('a'.repeat(64), 11, ['codex'], 'KILL', 0, 0))
      .toThrow(/uid\/gid/i)
    expect(args.join(' ')).not.toMatch(/docker (kill|rm)|pkill|killall/)
  })

  it('accepts an exact signal or an already-ended target as the requested fault condition', () => {
    expect(classifyExactProcessSignalResult({ status: 0, stdout: '{"outcome":"signalled"}\n', stderr: '' }))
      .toBe('signalled')
    expect(classifyExactProcessSignalResult({ status: 0, stdout: '{"outcome":"already_exited"}\n', stderr: '' }))
      .toBe('already_exited')
  })

  it('never turns an identity mismatch, malformed reply, or arbitrary command failure into success', () => {
    expect(() => classifyExactProcessSignalResult({ status: 45, stdout: '', stderr: 'identity mismatch' }))
      .toThrow(/identity mismatch/i)
    expect(() => classifyExactProcessSignalResult({ status: 0, stdout: '{}', stderr: '' }))
      .toThrow(/malformed/i)
    expect(() => classifyExactProcessSignalResult({ status: 1, stdout: '', stderr: 'permission denied' }))
      .toThrow(/permission denied/i)
  })

  it('requires bounded printable process identity fragments', () => {
    expect(normalizeExpectedProcessFragments(['opencode', '--session'])).toEqual(['opencode', '--session'])
    for (const fragments of [[], [''], [' codex'], ['codex\n'], ['x'.repeat(257)], ['same', 'same']]) {
      expect(() => normalizeExpectedProcessFragments(fragments)).toThrow()
    }
  })
})
