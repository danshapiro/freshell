#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureAuthTokenFile } from './bootstrap-env.js'

const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
}

/**
 * Resolve the server executable without changing the caller's arguments.
 * Windows release builds conventionally add `.exe`; accepting the extensionless
 * spelling keeps package scripts identical on every platform.
 */
export function resolveServerBinary(
  requested: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: (filePath: string) => boolean = existsSync,
  cwd: string = process.cwd(),
): string {
  if (!requested.trim()) {
    throw new Error('A freshell-server binary path is required.')
  }

  const resolved = path.isAbsolute(requested)
    ? requested
    : path.resolve(cwd, requested)

  if (platform !== 'win32' || path.extname(resolved).toLowerCase() === '.exe') {
    return resolved
  }

  const windowsBinary = `${resolved}.exe`
  return fileExists(windowsBinary) || !fileExists(resolved) ? windowsBinary : resolved
}

function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({
    severity: 'error',
    event,
    timestamp: new Date().toISOString(),
    ...fields,
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
}

export function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [requestedBinary, ...args] = argv
  if (!requestedBinary) {
    logError('rust_server_wrapper_usage', 'Usage: start-rust-server.ts <freshell-server> [args...]')
    return Promise.resolve(2)
  }

  try {
    ensureAuthTokenFile({ envPath: path.join(process.cwd(), '.env') })
  } catch (error) {
    logError('rust_server_wrapper_bootstrap_failed', error)
    return Promise.resolve(1)
  }

  let binary: string
  try {
    binary = resolveServerBinary(requestedBinary)
  } catch (error) {
    logError('rust_server_wrapper_resolve_failed', error, { requestedBinary })
    return Promise.resolve(2)
  }

  return new Promise<number>((resolve) => {
    let settled = false
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
    const forwardSignal = (signal: typeof signals[number]) => {
      if (child.exitCode !== null || child.killed) return
      try {
        child.kill(signal)
      } catch (error) {
        logError('rust_server_wrapper_signal_failed', error, { signal, pid: child.pid })
      }
    }

    const finish = (code: number) => {
      if (settled) return
      settled = true
      for (const signal of signals) process.off(signal, forwardSignal)
      resolve(code)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      })
    } catch (error) {
      logError('rust_server_wrapper_spawn_failed', error, { binary, args })
      finish(1)
      return
    }

    for (const signal of signals) process.once(signal, forwardSignal)

    child.once('error', (error) => {
      logError('rust_server_wrapper_child_error', error, { binary, pid: child.pid })
      finish(1)
    })
    child.once('exit', (code, signal) => {
      if (signal) {
        finish(SIGNAL_EXIT_CODES[signal] ?? 1)
      } else {
        finish(code ?? 1)
      }
    })
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().then((code) => {
    process.exitCode = code
  }).catch((error: unknown) => {
    logError('rust_server_wrapper_unhandled_error', error)
    process.exitCode = 1
  })
}
