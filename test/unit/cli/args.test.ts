import { it, expect } from 'vitest'
import { parseArgs } from '../../../server/cli/args'

it('parses subcommand and options', () => {
  const parsed = parseArgs(['send-keys', '-t', 'alpha.0', 'C-c'])
  expect(parsed.command).toBe('send-keys')
  expect(parsed.flags.t).toBe('alpha.0')
  expect(parsed.args[0]).toBe('C-c')
})
