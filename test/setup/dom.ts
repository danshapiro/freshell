import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { enableMapSet } from 'immer'

enableMapSet()

let errorSpy: ReturnType<typeof vi.spyOn> | null = null

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    throw new Error('Unexpected console.error: ' + args.map(String).join(' '))
  })
})

afterEach(() => {
  errorSpy?.mockRestore()
  errorSpy = null
})

const clipboardMock = {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(''),
}

Object.defineProperty(globalThis.navigator, 'clipboard', {
  value: clipboardMock,
  configurable: true,
})
