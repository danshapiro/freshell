/**
 * DIAG-03 — Redact secrets and rotate logs safely (PW-RUST).
 *
 * Rust-only Playwright spec. The frozen legacy `server/` tree does not support
 * `FRESHELL_LOG_MAX_BYTES` / `FRESHELL_LOG_MAX_BACKUPS` env-var-configurable
 * rotation limits, so small-limit-rotation and rotation-count assertions have
 * no legacy equivalent — this is a deliberate Rust-only hardening feature.
 *
 * The Rust integration test `diag01_diag03_logging.rs` covers the same
 * behaviors at the crate level; this spec adds the Playwright-layer proof the
 * checklist `PW-RUST` validation requires.
 *
 * Clauses proven:
 *   1. URL/header/body/nested-error secret sentinels — the auth token never
 *      appears in any log file regardless of transmission path (URL query
 *      param, x-auth-token header, POST body with token-keyed JSON field,
 *      404 error route containing the token).
 *   2. Concurrent writers — simultaneous requests produce no interleaved or
 *      corrupted JSON lines.
 *   3. Rotation count — with tiny limits, at least one backup exists and the
 *      total file count is bounded (active + max_backups).
 *   4. Final flush — the last request's entry is present after graceful
 *      server shutdown.
 *   5. Chronological coverage — timestamps are present on every entry and
 *      are non-decreasing within each file.
 *   6. Valid JSON — every line in every file (active + rotated) parses as JSON.
 */
import { test, expect } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import fsp from 'node:fs/promises'
import path from 'node:path'

const LOG_FILE_NAME = 'rust-server.jsonl'

/** Read all log files (active + rotated backups) from the logs directory. */
async function readAllLogFiles(
  logsDir: string,
): Promise<{ name: string; content: string }[]> {
  const entries = await fsp.readdir(logsDir)
  const logFiles = entries.filter((e) => e.startsWith(LOG_FILE_NAME))
  const results: { name: string; content: string }[] = []
  for (const name of logFiles) {
    const content = await fsp.readFile(path.join(logsDir, name), 'utf-8')
    results.push({ name, content })
  }
  return results
}

/** Parse every non-empty line as JSON, throwing on any corrupted line. */
function parseLogLines(content: string): Record<string, unknown>[] {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test.describe('DIAG-03 — Redact secrets and rotate logs safely (PW-RUST)', () => {
  test('small-limit rotation: valid JSON, no raw secret, bounded file count, chronological coverage', async () => {
    const server = new RustServer({
      env: {
        FRESHELL_LOG_MAX_BYTES: '2000',
        FRESHELL_LOG_MAX_BACKUPS: '2',
      },
    })
    const info = await server.start()
    const secret = info.token

    try {
      const baseUrl = info.baseUrl
      const headers = { 'x-auth-token': secret }

      // Phase 1: secret sentinels via URL, header, body, error.
      // URL: token in query param (sanitize_route strips it, scrub() is belt-and-braces).
      await fetch(`${baseUrl}/api/sessions?token=${secret}`, { headers })
      // Body: token-keyed JSON field in POST body (scrub() redacts any *token* key).
      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_token: secret, cookie: secret }),
      })
      // Nested error: 404 on a route containing the token value.
      await fetch(`${baseUrl}/api/${secret}/nonexistent`, { headers })

      // Phase 2: generate enough volume to force rotation.
      // Each request log entry is ~150-200 bytes; with a 2000-byte limit,
      // ~12-15 entries fit per file. Generate 80 to fill active + 2 backups.
      for (let i = 0; i < 80; i++) {
        await fetch(`${baseUrl}/api/sessions`, { headers })
      }

      // Allow a moment for any buffered I/O to settle.
      await new Promise((r) => setTimeout(r, 300))

      const files = await readAllLogFiles(info.logsDir)

      // Clause 3: rotation happened — at least 2 files (active + 1 backup).
      expect(files.length).toBeGreaterThanOrEqual(2)
      // Clause 3: file count bounded (active + max_backups = 3).
      expect(files.length).toBeLessThanOrEqual(3)

      // Clauses 1, 5, 6: per-file assertions.
      for (const file of files) {
        // Clause 1: no raw secret anywhere in the file content.
        expect(file.content).not.toContain(secret)

        // Clause 6: every line is valid JSON.
        const entries = parseLogLines(file.content)
        expect(entries.length).toBeGreaterThan(0)

        // Clause 5: every entry has a timestamp and they are non-decreasing.
        let prevTs = ''
        for (const entry of entries) {
          expect(entry).toHaveProperty('ts')
          const ts = String(entry.ts)
          expect(ts.length).toBeGreaterThan(0)
          if (prevTs) {
            expect(ts >= prevTs).toBe(true)
          }
          prevTs = ts
        }
      }
    } finally {
      await server.stop()
    }
  })

  test('concurrent writers: no interleaved or corrupted JSON lines', async () => {
    const server = new RustServer()
    const info = await server.start()

    try {
      const baseUrl = info.baseUrl
      const headers = { 'x-auth-token': info.token }

      // Fire 50 concurrent requests simultaneously.
      const concurrency = 50
      const requests = Array.from({ length: concurrency }, () =>
        fetch(`${baseUrl}/api/sessions`, { headers }),
      )
      await Promise.all(requests)

      // Allow a moment for I/O to settle.
      await new Promise((r) => setTimeout(r, 300))

      const logPath = path.join(info.logsDir, LOG_FILE_NAME)
      const content = await fsp.readFile(logPath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim().length > 0)

      // Clause 2: every line is valid JSON (no interleaved/corrupted lines
      // from concurrent log writes).
      let parseCount = 0
      for (const line of lines) {
        JSON.parse(line) // throws if corrupted/interleaved
        parseCount++
      }

      // Clause 2: all concurrent writes were logged.
      expect(parseCount).toBeGreaterThanOrEqual(concurrency)
    } finally {
      await server.stop()
    }
  })

  test('final shutdown flush: last request entry present after server stop', async () => {
    const server = new RustServer({
      preserveHomeOnStop: true,
    })
    const info = await server.start()

    const sentinel = `diag03-flush-sentinel-${Date.now()}`
    try {
      const baseUrl = info.baseUrl
      const headers = { 'x-auth-token': info.token }

      // Make a distinctive request (404 on a unique path).
      await fetch(`${baseUrl}/api/${sentinel}`, { headers })
    } finally {
      // Stop the server — triggers graceful SIGTERM shutdown.
      await server.stop()
    }

    // Clause 4: after shutdown, the last request's entry is present
    // (it was flushed before the server process exited).
    const logPath = path.join(info.logsDir, LOG_FILE_NAME)
    const content = await fsp.readFile(logPath, 'utf-8')

    // The sentinel path should appear in the log (route field).
    expect(content).toContain(sentinel)

    // Clause 6: every line is valid JSON.
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    for (const line of lines) {
      JSON.parse(line)
    }
  })
})
