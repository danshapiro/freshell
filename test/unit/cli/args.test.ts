import { it, expect } from 'vitest'
import { parseArgs } from '../../../server/cli/args'

it('parses subcommand and options', () => {
  const parsed = parseArgs(['send-keys', '-t', 'alpha.0', 'C-c'])
  expect(parsed.command).toBe('send-keys')
  expect(parsed.flags.t).toBe('alpha.0')
  expect(parsed.args[0]).toBe('C-c')
})

it('treats known short boolean flags as boolean and keeps following args positional', () => {
  const parsed = parseArgs(['send-keys', '-t', 'alpha.0', '-l', 'echo hello'])
  expect(parsed.command).toBe('send-keys')
  expect(parsed.flags.t).toBe('alpha.0')
  expect(parsed.flags.l).toBe(true)
  expect(parsed.args).toEqual(['echo hello'])
})

it('parses negative numeric values for short value flags', () => {
  const parsed = parseArgs(['capture-pane', '-t', 'alpha.0', '-S', '-20'])
  expect(parsed.command).toBe('capture-pane')
  expect(parsed.flags.t).toBe('alpha.0')
  expect(parsed.flags.S).toBe('-20')
  expect(parsed.args).toEqual([])
})

it('parses dash-prefixed pane ids for target flags', () => {
  const parsed = parseArgs(['split-pane', '-t', '-FFH7C5JAoRTjK8Qu8RXR', '--editor', '/tmp/sample.txt'])
  expect(parsed.command).toBe('split-pane')
  expect(parsed.flags.t).toBe('-FFH7C5JAoRTjK8Qu8RXR')
  expect(parsed.flags.editor).toBe('/tmp/sample.txt')
})

it('parses dash-prefixed pane ids for attach short pane flag', () => {
  const parsed = parseArgs(['attach', '-t', 'term_1', '-p', '-FFH7C5JAoRTjK8Qu8RXR'])
  expect(parsed.command).toBe('attach')
  expect(parsed.flags.t).toBe('term_1')
  expect(parsed.flags.p).toBe('-FFH7C5JAoRTjK8Qu8RXR')
})

it('does not treat dash-prefixed values as -p arguments outside attach', () => {
  const parsed = parseArgs(['display', '-p', '-ABC123'])
  expect(parsed.command).toBe('display')
  expect(parsed.flags.p).toBe(true)
  // Single-dash multi-char tokens are parsed as one short key in this parser.
  expect(parsed.flags.ABC123).toBe(true)
})
