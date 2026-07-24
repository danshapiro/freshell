/**
 * T2 warm-proxy shim generator (the `OPENCODE_CMD` warm-proxy proven in Exp5b of
 * `port/oracle/notes/t2-opencode-stall.md`).
 *
 * WHY THIS EXISTS
 * ---------------
 * Driving a live opencode/Kimi turn through the PRISTINE freshell fresh-agent
 * surface wedges on DEV-0001: freshell's cold `opencode serve` health probe
 * (`server/fresh-agent/adapters/opencode/serve-manager.ts:286`) is un-timed, so a
 * probe that connects during the cold-accept "orphan window" (TCP-accept-available
 * but HTTP-handler-not-ready) hangs forever and the loop can never retry →
 * `createSession` never runs → `turnAccepted=false`. The PORT fixes the probe
 * itself (per-attempt AbortController + retry); we must NOT touch `server/`.
 *
 * The oracle captures the ORIGINAL-side baseline by WARMING the serve so freshell's
 * own probe sails straight past the race. `OpencodeServeManager` honors the
 * `OPENCODE_CMD` env var as the serve command (serve-manager.ts:116) and always
 * invokes it as `<cmd> serve --hostname H --port P`. We point `OPENCODE_CMD` at
 * the shim below, which:
 *   1. allocates a private INNER loopback port,
 *   2. spawns the REAL `opencode serve` on 127.0.0.1:INNER (inheriting env),
 *   3. bounded-polls `http://127.0.0.1:INNER/global/health` (2s per-attempt abort
 *      + 150ms retry) until it is genuinely HTTP-ready, and only THEN
 *   4. opens an L4 TCP passthrough on freshell's port P → 127.0.0.1:INNER.
 * Because P does not accept until the inner serve is health-ready, the cold-accept
 * orphan window never exists on P, so freshell's un-timed probe always gets either
 * a fast ECONNREFUSED (→150ms retry) or a clean 200. ZERO freshell source is
 * changed — the port, not the baseline, carries DEV-0001's real fix.
 *
 * OWNERSHIP / REAPING
 * -------------------
 * The shim is spawned by freshell with `env: { ...serverEnv, FRESHELL_OPENCODE_
 * SIDECAR_ID }`, so it (and the inner `opencode serve` it spawns with the same
 * inherited env) both carry this run's `FRESHELL_PROBE_SENTINEL`. The harness's
 * sentinel-scoped reaper (`reapSentinelOwned`) therefore covers BOTH, and on
 * SIGTERM the shim also kills its inner child directly. Never killed by name.
 *
 * PORTABILITY NOTE FOR THE RUST-PORT QA
 * -------------------------------------
 * This warm-proxy is a HARNESS AID for capturing the pristine-original baseline
 * ONLY. The Rust port implements DEV-0001's fix natively, so the port's own T2 run
 * needs NO warm-proxy — it must cold-start cleanly through its fixed probe. The
 * baseline this proxy helps capture is what the port's (un-proxied) observation is
 * diffed against, with the DEV-0001 fingerprint whitelisting only the cold-start
 * difference.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * The shim body (everything after the shebang). CommonJS, node built-ins only, so
 * it runs as a bare `node <file>.cjs serve --hostname H --port P` with no bundler
 * or transform. Kept as a readable string constant so reviewers see the exact
 * proxy logic rather than a runtime-assembled blob.
 */
export const WARM_PROXY_SHIM_BODY = String.raw`'use strict'
// AUTO-WRITTEN by port/oracle/harness/opencode-warm-proxy.ts — T2 warm-proxy shim.
// Invoked by freshell's OpencodeServeManager as:  <this> serve --hostname H --port P
const net = require('node:net')
const http = require('node:http')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const args = process.argv.slice(2)
function flag(name) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
const outerHost = flag('--hostname') || '127.0.0.1'
const outerPort = Number(flag('--port') || '0')
const realOpencode = process.env.FRESHELL_T2_REAL_OPENCODE || 'opencode'
const logPath = process.env.FRESHELL_T2_PROXY_LOG || ''

const HEALTH_ATTEMPT_MS = 2000   // per-attempt abort (DEV-0001's missing bound)
const HEALTH_RETRY_MS = 150
const HEALTH_OVERALL_MS = 60000

function log(msg) {
  if (!logPath) return
  try { fs.appendFileSync(logPath, '[warm-proxy ' + new Date().toISOString() + ' pid=' + process.pid + '] ' + msg + '\n') } catch (_e) { /* ignore */ }
}

if (!Number.isFinite(outerPort) || outerPort <= 0) {
  console.error('[warm-proxy] missing/invalid --port')
  process.exit(2)
}

let inner = null
let proxyServer = null
let shuttingDown = false

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutdown(' + code + ')')
  try { if (proxyServer) proxyServer.close() } catch (_e) { /* ignore */ }
  const done = () => process.exit(code)
  if (inner && inner.pid && inner.exitCode === null) {
    try { inner.kill('SIGTERM') } catch (_e) { /* ignore */ }
    const t = setTimeout(() => { try { inner.kill('SIGKILL') } catch (_e2) { /* ignore */ } done() }, 1500)
    if (t.unref) t.unref()
    inner.once('exit', () => { clearTimeout(t); done() })
  } else {
    done()
  }
}
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const p = a && typeof a === 'object' ? a.port : 0
      s.close(() => (p ? resolve(p) : reject(new Error('no inner port'))))
    })
  })
}

function healthOnce(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: port, path: '/global/health', method: 'GET', timeout: HEALTH_ATTEMPT_MS },
      (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          let ok = res.statusCode === 200
          if (ok) {
            try { const j = JSON.parse(body); if (j && j.healthy === false) ok = false } catch (_e) { /* non-JSON 200 still counts */ }
          }
          resolve(ok)
        })
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { try { req.destroy() } catch (_e) { /* ignore */ } resolve(false) })
    req.end()
  })
}

async function waitHealthy(port) {
  const deadline = Date.now() + HEALTH_OVERALL_MS
  while (Date.now() < deadline) {
    if (shuttingDown) return false
    if (await healthOnce(port)) return true
    await new Promise((r) => setTimeout(r, HEALTH_RETRY_MS))
  }
  return false
}

;(async () => {
  const innerPort = await freePort()
  log('inner=' + innerPort + ' outer=' + outerHost + ':' + outerPort + ' real=' + realOpencode)
  inner = spawn(realOpencode, ['serve', '--hostname', '127.0.0.1', '--port', String(innerPort)], {
    env: process.env, // carries FRESHELL_PROBE_SENTINEL + FRESHELL_OPENCODE_SIDECAR_ID + isolated HOME/XDG
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (inner.stdout) inner.stdout.on('data', () => {})
  if (inner.stderr) inner.stderr.on('data', (c) => log('inner stderr: ' + String(c).trim().slice(0, 400)))
  inner.on('error', (err) => { log('inner spawn error: ' + (err && err.message)); shutdown(1) })
  inner.on('exit', (code, signal) => {
    log('inner exit code=' + code + ' signal=' + signal)
    if (!shuttingDown) {
      try { if (proxyServer) proxyServer.close() } catch (_e) { /* ignore */ }
      process.exit(code == null ? 1 : code)
    }
  })

  const healthy = await waitHealthy(innerPort)
  if (!healthy) { log('inner never healthy within budget'); shutdown(1); return }
  log('inner healthy — opening L4 passthrough on ' + outerHost + ':' + outerPort)

  proxyServer = net.createServer((sock) => {
    const up = net.connect(innerPort, '127.0.0.1')
    const destroyBoth = () => {
      try { sock.destroy() } catch (_e) { /* ignore */ }
      try { up.destroy() } catch (_e2) { /* ignore */ }
    }
    sock.on('error', destroyBoth)
    up.on('error', destroyBoth)
    sock.pipe(up)
    up.pipe(sock)
  })
  proxyServer.on('error', (err) => { log('proxy listen error: ' + (err && err.message)); shutdown(1) })
  proxyServer.listen(outerPort, outerHost, () => log('proxy listening ' + outerHost + ':' + outerPort + ' -> 127.0.0.1:' + innerPort))
})().catch((err) => { log('fatal: ' + ((err && err.stack) || err)); shutdown(1) })
`

export interface WriteWarmProxyOptions {
  /** Absolute node binary baked into the shebang (default: this process's node). */
  nodeExecPath?: string
  /** Shim file name (default: 'opencode-warm-proxy.cjs'). */
  fileName?: string
}

/**
 * Write an executable warm-proxy shim into `dir` and return its absolute path.
 * The shebang pins an ABSOLUTE node path (no `env`/PATH ambiguity), and the file
 * is chmod 0755 so freshell can `spawn()` it directly (kernel honors the shebang).
 */
export async function writeWarmProxyShim(dir: string, opts: WriteWarmProxyOptions = {}): Promise<string> {
  const node = opts.nodeExecPath ?? process.execPath
  const shimPath = path.join(dir, opts.fileName ?? 'opencode-warm-proxy.cjs')
  await fsp.writeFile(shimPath, `#!${node}\n${WARM_PROXY_SHIM_BODY}`, 'utf8')
  await fsp.chmod(shimPath, 0o755)
  return shimPath
}
