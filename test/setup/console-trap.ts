import { vi } from 'vitest'

// Shared console trap used by both the client (jsdom) and server (node) test
// setups. A test that deliberately exercises an error/warning path must capture
// that output (spy on the console method and assert on it) rather than let it
// leak. Any console.error or console.warn a test does not capture fails that
// test — unexpected console noise is a bug. A test that legitimately cannot spy
// can opt out for a single test by setting __ALLOW_CONSOLE_ERROR__ /
// __ALLOW_CONSOLE_WARN__ to true; the flag resets after each test.

type ConsoleMethod = 'error' | 'warn'

interface ConsoleTrap {
  method: ConsoleMethod
  allowFlag: '__ALLOW_CONSOLE_ERROR__' | '__ALLOW_CONSOLE_WARN__'
  spy: ReturnType<typeof vi.spyOn> | null
  calls: Array<{ args: unknown[]; stack?: string }>
  hasCapturedStack: boolean
}

// Output that is environmental noise rather than app output, so it never
// signals an app bug: Redux Toolkit's dev-only invariant middleware warns when a
// check exceeds a wall-clock threshold, which is machine-load dependent.
const IGNORED_OUTPUT_PATTERNS = [
  / took \d+ms, which is more than the warning threshold/,
]

function isIgnoredOutput(args: unknown[]): boolean {
  const rendered = args.map(String).join(' ')
  return IGNORED_OUTPUT_PATTERNS.some((pattern) => pattern.test(rendered))
}

export interface InstalledConsoleTraps {
  /** Restore the spies and return a failure message per unexpected method. */
  collectFailures(): string[]
}

export function installConsoleTraps(): InstalledConsoleTraps {
  const traps: ConsoleTrap[] = [
    { method: 'error', allowFlag: '__ALLOW_CONSOLE_ERROR__', spy: null, calls: [], hasCapturedStack: false },
    { method: 'warn', allowFlag: '__ALLOW_CONSOLE_WARN__', spy: null, calls: [], hasCapturedStack: false },
  ]

  for (const trap of traps) {
    const impl = (...args: unknown[]) => {
      // Capturing stacks for every call can be expensive; keep the first one for debugging.
      let stack: string | undefined
      if (!trap.hasCapturedStack) {
        trap.hasCapturedStack = true
        const err = new Error(`console.${trap.method} captured`)
        // Exclude this helper from the captured stack for better signal.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(Error as any).captureStackTrace?.(err, impl)
        stack = err.stack
      }
      trap.calls.push({ args, stack })
    }
    trap.spy = vi.spyOn(console, trap.method).mockImplementation(impl)
  }

  return {
    collectFailures(): string[] {
      const failures: string[] = []
      for (const trap of traps) {
        trap.spy?.mockRestore()
        trap.spy = null

        const allow = (globalThis as any)[trap.allowFlag] === true
        ;(globalThis as any)[trap.allowFlag] = false

        const relevant = trap.calls.filter((call) => !isIgnoredOutput(call.args))
        if (!allow && relevant.length > 0) {
          const first = relevant[0]
          const rendered = first?.args?.map(String).join(' ') ?? ''
          const stack = first?.stack ? `\n${first.stack}` : ''
          failures.push(`Unexpected console.${trap.method}: ${rendered}${stack}`)
        }
      }
      return failures
    },
  }
}
