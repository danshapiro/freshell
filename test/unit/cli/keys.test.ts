import { it, expect } from 'vitest'
import { translateKeys } from '../../../server/cli/keys'

it('translates C-c and Enter', () => {
  expect(translateKeys(['C-c', 'Enter'])).toBe('\x03\r')
})

it('translates C-u to line-kill control byte', () => {
  expect(translateKeys(['C-u'])).toBe('\x15')
})

it('translates generic C-<letter> chords case-insensitively', () => {
  expect(translateKeys(['c-w', 'C-a', 'C-e'])).toBe('\x17\x01\x05')
})
