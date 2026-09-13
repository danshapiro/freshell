import { execFileSync } from 'node:child_process'

/** Match the Rust compile-time stamp; git-less bundles leave reload detection inert. */
export function computeClientBuildId(cwd: string): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).toString().trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}
