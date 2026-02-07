import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { enableMapSet } from 'immer'

enableMapSet()

let errorSpy: ReturnType<typeof vi.spyOn> | null = null
let consoleErrorCalls: Array<{ args: unknown[]; stack?: string }> = []
let hasCapturedErrorStack = false

beforeEach(() => {
  consoleErrorCalls = []
  hasCapturedErrorStack = false
  const impl = (...args: unknown[]) => {
    // Capturing stacks for every console.error can be expensive; keep the first one for debugging.
    let stack: string | undefined
    if (!hasCapturedErrorStack) {
      hasCapturedErrorStack = true
      const err = new Error('console.error captured')
      // Exclude this helper from the captured stack for better signal.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(Error as any).captureStackTrace?.(err, impl)
      stack = err.stack
    }
    consoleErrorCalls.push({ args, stack })
  }
  errorSpy = vi.spyOn(console, 'error').mockImplementation(impl)
})

afterEach(() => {
  errorSpy?.mockRestore()
  errorSpy = null

  const allow = (globalThis as any).__ALLOW_CONSOLE_ERROR__ === true
  ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = false

  if (!allow && consoleErrorCalls.length > 0) {
    const first = consoleErrorCalls[0]
    const rendered = first?.args?.map(String).join(' ') ?? ''
    const stack = first?.stack ? `\n${first.stack}` : ''
    throw new Error(`Unexpected console.error: ${rendered}${stack}`)
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
