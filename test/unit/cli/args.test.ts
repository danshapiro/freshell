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
