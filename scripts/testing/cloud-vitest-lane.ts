import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** The small environment surface the cloud Vitest lane decisions read. */
export type EnvironmentLike = Readonly<Record<string, string | undefined>>

/**
 * Cloud Vitest owns only the retained default client/tooling lane. The
 * source-runtime, Cargo, and Electron phases always run locally because they
 * need the built Rust artifact and a real process filesystem.
 */
export function isCloudVitestBackend(env: EnvironmentLike): boolean {
  return env.FRESHELL_VITEST_BACKEND === 'cloud'
}

/** `--changed` needs local git history, which the cloud image does not carry. */
export function hasGitDependentSelectors(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--changed' || arg.startsWith('--changed='))
}

/** The command that runs the default Vitest config on Cloud Run Jobs. */
export function resolveCloudVitestCommand(
  vitestArgs: readonly string[],
  env: EnvironmentLike,
): { command: string; args: string[] } {
  return {
    command: env.FRESHELL_VITEST_CLOUD_SCRIPT || path.join(PROJECT_ROOT, 'scripts', 'vitest-cloud.sh'),
    args: ['run', '--cloud', '--config=default', ...vitestArgs],
  }
}
