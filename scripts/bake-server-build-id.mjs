#!/usr/bin/env node
/**
 * Bake the build-provenance stamp for the compiled Node server: writes
 * `dist/server/build-id.json` = {"buildId": "<git HEAD sha | 'unknown'>"}.
 *
 * WHY a bake file: the running stamp must describe the BUILT ARTIFACT, not
 * the checkout. `server/build-id.ts` prefers this file (resolved next to
 * its compiled dist/server/build-id.js) and falls back to a runtime
 * `git rev-parse HEAD` probe ONLY when no bake file exists next to it —
 * which is exactly the tsx-from-source dev case, where the runtime probe
 * is correct because dev runs current source. A stale `dist/server`
 * started after HEAD moved therefore advertises the sha it was BUILT from,
 * never a false "current" one.
 *
 * Runs after `tsc` in the `build:server` script. Atomic write (tmp+rename).
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = path.join(repoRoot, 'dist', 'server', 'build-id.json')

function computeBuildId() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
const tmpPath = `${outPath}.tmp-${process.pid}`
fs.writeFileSync(tmpPath, `${JSON.stringify({ buildId: computeBuildId() })}\n`)
fs.renameSync(tmpPath, outPath)
console.log(`[bake-server-build-id] wrote ${outPath}`)
