import { it, expect } from 'vitest'
import { translateKeys } from '../../../server/cli/keys'

it('translates C-c and Enter', () => {
  expect(translateKeys(['C-c', 'Enter'])).toBe('\x03\r')
})
