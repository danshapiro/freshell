import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SHA_PATTERN = /^[0-9a-f]{40}$/

// Resolved relative to THIS module: next to the compiled
// dist/server/build-id.js in production (where `build:server`'s bake step
// wrote dist/server/build-id.json), or next to server/build-id.ts in
// tsx-from-source runs (where no bake file exists and the runtime probe is
// correct because dev runs current source).
function defaultBakePath(): string {
  try {
    return fileURLToPath(new URL('build-id.json', import.meta.url))
  } catch {
    // Non-file: import.meta.url (electron-style loaders): a relative path
    // that readFileSync will miss, degrading to the inert "unknown" (compiled)
    // or the runtime git probe (source) — never an import crash.
    return 'build-id.json'
  }
}

/**
 * The git commit the server runs from — the SAME identity the Rust server
 * bakes at compile time (`crates/freshell-ws/build.rs`'s
 * `FRESHELL_WS_BUILD_COMMIT`) and the client bakes at Vite build time
 * (`__FRESHELL_BUILD_ID__`). Falls back to the literal `"unknown"` when git
 * is unavailable or the output is not a full 40-hex sha; the client's
 * compare rule ignores `"unknown"` on both sides, so a git-less deployment
 * never triggers a reload and never clears an armed one.
 */
export function computeBuildId(cwd: string = process.cwd()): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
      .toString()
      .trim()
    return SHA_PATTERN.test(sha) ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Read a bake file written by `scripts/bake-server-build-id.mjs`. */
export function readBakedBuildId(bakePath: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(bakePath, 'utf8')) as { buildId?: unknown }
    const value = raw.buildId
    if (typeof value !== 'string') return undefined
    // Same validation as the writer and the git probes: a 40-hex sha or the
    // literal "unknown". Anything else is a malformed stamp — treat as
    // absent, never authoritative (a garbage stamp would cause a needless
    // mismatch reload).
    return value === 'unknown' || SHA_PATTERN.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

// Source runs (tsx dev, vitest) execute THIS .ts module; a compiled
// production artifact executes dist/server/build-id.js. The distinction
// decides what a MISSING bake file means (see resolveServerBuildId).
const SOURCE_MODE = import.meta.url.endsWith('.ts')

/**
 * BAKE-WINS-ELSE-FAIL-INERT: a compiled production artifact describes
 * itself ONLY by its bake file — a stale dist started after HEAD moved
 * advertises the sha it was built from (never a false "current" one), and
 * an artifact whose stamp is missing or malformed fails inert to
 * "unknown" (it must never impersonate the checkout). Source runs have no
 * bake file next to the source module and probe runtime HEAD instead,
 * which is correct because they execute current source.
 */
export function resolveServerBuildId(
  bakePath: string = defaultBakePath(),
  opts?: { sourceMode?: boolean },
): string {
  const sourceMode = opts?.sourceMode ?? SOURCE_MODE
  if (sourceMode) return computeBuildId()
  return readBakedBuildId(bakePath) ?? 'unknown'
}

let cached: string | undefined

/** Per-process cached build id — one resolution per server lifetime. */
export function serverBuildId(): string {
  if (cached === undefined) cached = resolveServerBuildId()
  return cached
}

export function _resetServerBuildIdCacheForTests(): void {
  cached = undefined
}
