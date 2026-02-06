import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { enableMapSet } from 'immer'

enableMapSet()

let errorSpy: ReturnType<typeof vi.spyOn> | null = null
let consoleErrorCalls: unknown[][] = []

beforeEach(() => {
  consoleErrorCalls = []
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrorCalls.push(args)
  })
})

afterEach(() => {
  errorSpy?.mockRestore()
  errorSpy = null

  const allow = (globalThis as any).__ALLOW_CONSOLE_ERROR__ === true
  ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = false

  if (!allow && consoleErrorCalls.length > 0) {
    const first = consoleErrorCalls[0]?.map(String).join(' ') ?? ''
    throw new Error(`Unexpected console.error: ${first}`)
  }
})

const clipboardMock = {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(''),
}

Object.defineProperty(globalThis.navigator, 'clipboard', {
  value: clipboardMock,
  configurable: true,
})
