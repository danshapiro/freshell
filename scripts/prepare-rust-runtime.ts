#!/usr/bin/env tsx

/**
 * Prepare the two local prerequisites shared by every Rust server startup:
 * the first-run authentication file and the isolated Claude SDK sidecar.
 *
 * This is deliberately a small composition layer. Keeping the auth bootstrap
 * and sidecar installer independent makes each one testable, while the npm
 * lifecycle hooks and launch-rust.sh can call one deterministic entrypoint.
 */

import { ensureAuthTokenFile, type AuthTokenBootstrapOptions, type AuthTokenBootstrapResult } from './bootstrap-env.js'
import {
  ensureClaudeSidecarDependencies,
  type ClaudeSidecarInstallReceipt,
  type EnsureClaudeSidecarDependenciesOptions,
} from './ensure-claude-sidecar.js'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

export interface PrepareRustRuntimeOptions {
  env?: NodeJS.ProcessEnv
  envPath?: string
  sidecarDir?: string
  ensureAuthTokenFile?: (options: AuthTokenBootstrapOptions) => AuthTokenBootstrapResult
  ensureClaudeSidecarDependencies?: (
    options: EnsureClaudeSidecarDependenciesOptions,
  ) => ClaudeSidecarInstallReceipt
}

export interface PrepareRustRuntimeResult {
  authToken: AuthTokenBootstrapResult
  claudeSidecar: ClaudeSidecarInstallReceipt
}

export function prepareRustRuntime(options: PrepareRustRuntimeOptions = {}): PrepareRustRuntimeResult {
  const env = options.env ?? process.env
  const bootstrap = options.ensureAuthTokenFile ?? ensureAuthTokenFile
  const prepareSidecar = options.ensureClaudeSidecarDependencies ?? ensureClaudeSidecarDependencies

  const authOptions: AuthTokenBootstrapOptions = { env }
  if (options.envPath !== undefined) authOptions.envPath = options.envPath
  const authToken = bootstrap(authOptions)

  const sidecarOptions: EnsureClaudeSidecarDependenciesOptions = { env }
  if (options.sidecarDir !== undefined) sidecarOptions.sidecarDir = options.sidecarDir
  const claudeSidecar = prepareSidecar(sidecarOptions)

  return { authToken, claudeSidecar }
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isDirectInvocation()) {
  try {
    const result = prepareRustRuntime()
    process.stdout.write(`${JSON.stringify({
      severity: 'info',
      event: 'rust_runtime_prerequisites_ready',
      authToken: result.authToken,
      claudeSidecar: result.claudeSidecar,
    })}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      severity: 'error',
      event: 'rust_runtime_prerequisites_failed',
      error: error instanceof Error ? error.message : String(error),
    })}\n`)
    process.exitCode = 1
  }
}
