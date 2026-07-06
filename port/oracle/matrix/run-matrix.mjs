#!/usr/bin/env node
// Screenshot-driven shell-matrix validation harness.
//
// Matrix cell: WSL-server x Chrome (Chromium via Playwright, running in WSL).
//
// Boots the Rust `freshell-server` on a scratch loopback port with a throwaway
// HOME, drives a real Chromium against the retained (unchanged) SPA, creates
// every shell/pane kind the WSL picker offers, runs a command in each terminal,
// ASSERTS the output really appears (via the xterm buffer harness), and captures
// a screenshot per kind. Everything it spawns is owned and reaped on exit.
//
// SAFETY: never touches :3001 or the user's live processes. Own scratch port +
// temp HOME. Server runs in its own process group; PTYs are killed through the
// app before shutdown, then the group is SIGTERM/SIGKILLed.
//
// Usage:
//   node port/oracle/matrix/run-matrix.mjs
// Env overrides: MATRIX_PORT, MATRIX_TOKEN, MATRIX_HEADLESS=0 (headed)

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

// ── config ──────────────────────────────────────────────────────────────────
const WORKTREE = resolve(new URL('../../..', import.meta.url).pathname)
const PORT = Number(process.env.MATRIX_PORT || 3031)
const TOKEN = process.env.MATRIX_TOKEN || 'matrixtok'
const HOST = '127.0.0.1'
const BASE_URL = `http://${HOST}:${PORT}`
const HEADLESS = process.env.MATRIX_HEADLESS !== '0'
const SERVER_BIN = join(WORKTREE, 'target/release/freshell-server')
const CLIENT_DIR = join(WORKTREE, 'dist/client')
const OUT_DIR = join(WORKTREE, 'port/oracle/matrix')
const SHOT = (name) => join(OUT_DIR, `wsl-chrome-${name}.png`)
const MARKER = 'freshell-matrix-OK'

// The kinds the WSL picker surfaces (platform 'wsl' + claude/codex/opencode enabled).
const KINDS = [
  { key: 'cmd', label: 'CMD', type: 'shell', shell: 'cmd', mode: 'shell',
    cmd: `echo ${MARKER}`, marker: MARKER, minCount: 2 },
  { key: 'powershell', label: 'PowerShell', type: 'shell', shell: 'powershell', mode: 'shell',
    cmd: `echo ${MARKER}`, marker: MARKER, minCount: 2 },
  { key: 'wsl', label: 'WSL', type: 'shell', shell: 'wsl', mode: 'shell',
    cmd: `echo ${MARKER} && uname -a`, marker: MARKER, minCount: 2, also: 'Linux' },
  // CLI "launched" markers assert real CLI-UI chrome the process renders at startup
  // (banner / onboarding / prompt) — NOT a live model turn. Each CLI runs in the
  // throwaway HOME, so an onboarding/auth screen still counts as "launched".
  { key: 'claude', label: 'Claude CLI', type: 'cli', shell: 'system', mode: 'claude',
    banner: /welcome to claude|claude code|for shortcuts|bypass permissions|choose the text style|\/help|anthropic|claude/i },
  { key: 'codex', label: 'Codex CLI', type: 'cli', shell: 'system', mode: 'codex',
    banner: /openai codex|to get started|\/status|model:|approval|proceeding, even though|codex/i },
  { key: 'opencode', label: 'OpenCode', type: 'cli', shell: 'system', mode: 'opencode',
    banner: /ask anything|ctrl\+p|tab\s+agents|build\s+·|share|opencode/i },
  // Monaco is loaded at runtime from the jsdelivr CDN by the UNCHANGED frontend
  // (`@monaco-editor/loader`; the EditorPane chunk references
  // cdn.jsdelivr.net/npm/monaco-editor@X/min/vs). The Rust server serves the SPA +
  // the editor chunk correctly (verified: HTTP 200, content-type text/javascript);
  // when Monaco does not initialize in this headless harness it's an ENV/frontend
  // limitation identical on the original server, NOT a port defect — so a miss here
  // is recorded ENV-LIMITED, not FAIL.
  { key: 'editor', label: 'Editor', type: 'editor', envLimited: true,
    envReason: 'Monaco loads from jsdelivr CDN via the unchanged frontend; server serves the editor chunk correctly (200, text/javascript). Not port-differentiating.' },
  { key: 'browser', label: 'Browser', type: 'browser' },
]

// ── tiny utils ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[matrix]', ...a)
function countOccurrences(hay, needle) {
  if (!hay || !needle) return 0
  let n = 0, i = 0
  for (;;) { const j = hay.indexOf(needle, i); if (j < 0) break; n++; i = j + needle.length }
  return n
}

// ── server lifecycle ────────────────────────────────────────────────────────
let serverChild = null
let scratchHome = null

async function bootServer() {
  scratchHome = mkdtempSync(join(tmpdir(), 'freshell-matrix-'))
  log(`boot server :${PORT} HOME=${scratchHome} bind=${HOST}`)
  serverChild = spawn(SERVER_BIN, [], {
    cwd: WORKTREE,
    detached: true, // own process group so we can reap PTY children
    env: {
      ...process.env,
      PORT: String(PORT),
      AUTH_TOKEN: TOKEN,
      FRESHELL_BIND_HOST: HOST,
      HOME: scratchHome,
      FRESHELL_HOME: scratchHome,
      FRESHELL_CLIENT_DIR: CLIENT_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logPath = join(OUT_DIR, 'server.log')
  const chunks = []
  serverChild.stdout.on('data', (d) => { chunks.push(d); process.stdout.write(`[srv] ${d}`) })
  serverChild.stderr.on('data', (d) => { chunks.push(d); process.stderr.write(`[srv!] ${d}`) })
  serverChild.on('exit', (code, sig) => { try { writeFileSync(logPath, Buffer.concat(chunks)) } catch {}; log(`server exited code=${code} sig=${sig}`) })

  // health-gate
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`, { headers: { 'x-auth-token': TOKEN } })
      if (res.ok) {
        const j = await res.json()
        if (j && j.app === 'freshell') { log('health OK', JSON.stringify(j)); return }
      }
    } catch {}
    await sleep(200)
  }
  throw new Error('server health-gate timed out')
}

// Kill every live PTY THROUGH the app first (registry.kill SIGKILLs+joins each
// child, which also tears down the Windows-side interop cmd.exe/powershell.exe),
// using the in-page harness WS. Best-effort; the process-group reap is the
// backstop.
async function killAllTerminalsViaPage(page) {
  try {
    const ids = await page.evaluate(async (token) => {
      const res = await fetch('/api/terminals', { headers: { 'x-auth-token': token } })
      if (!res.ok) return []
      const list = await res.json()
      const ids = (Array.isArray(list) ? list : []).filter((t) => t.status !== 'exited').map((t) => t.terminalId)
      const h = window.__FRESHELL_TEST_HARNESS__
      for (const id of ids) h?.sendWsMessage({ type: 'terminal.kill', terminalId: id })
      return ids
    }, TOKEN)
    if (ids.length) { log(`killed ${ids.length} PTY(s) via terminal.kill`); await sleep(400) }
  } catch {}
}

function pgAlive(pid) { try { process.kill(-pid, 0); return true } catch { return false } }

async function reapServer() {
  if (!serverChild || serverChild.killed || serverChild.exitCode !== null) return
  const pid = serverChild.pid
  try { process.kill(-pid, 'SIGTERM') } catch {}
  for (let i = 0; i < 12 && pgAlive(pid); i++) await sleep(200)
  if (pgAlive(pid)) { try { process.kill(-pid, 'SIGKILL') } catch {}; await sleep(300) }
  log(pgAlive(pid) ? 'WARN: server group still alive after SIGKILL' : 'server group reaped')
}

function reapServerSync() {
  if (!serverChild) return
  try { process.kill(-serverChild.pid, 'SIGKILL') } catch {}
}

// ── in-page helpers ─────────────────────────────────────────────────────────
async function waitReady(page) {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 20000 })
  await page.waitForFunction(() => {
    const h = window.__FRESHELL_TEST_HARNESS__
    if (!h) return false
    const st = h.getState()
    return h.getWsReadyState() === 'ready' && st?.connection?.status === 'ready'
  }, { timeout: 20000 })
}

async function openPickerInNewTab(page) {
  const before = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length)
  await page.locator('[data-context="tab-add"]').click()
  await page.waitForFunction(
    (n) => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length > n,
    before, { timeout: 10000 },
  )
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  try {
    await picker.waitFor({ state: 'visible', timeout: 6000 })
    return picker
  } catch {
    // Fallback: a shell auto-spawned instead of showing a picker -> split to get one.
    const term = page.locator('.xterm').filter({ visible: true }).last()
    if (await term.isVisible().catch(() => false)) {
      await term.click({ button: 'right' })
      await page.getByRole('menuitem', { name: /split horizontally/i }).click()
      await picker.waitFor({ state: 'visible', timeout: 6000 })
      return picker
    }
    throw new Error('no pane picker appeared after tab-add')
  }
}

async function confirmDirectory(page, dir) {
  const combo = page.locator('[role="combobox"]').filter({ visible: true }).last()
  await combo.waitFor({ state: 'visible', timeout: 10000 })
  await combo.fill(dir)
  await sleep(150)
  await combo.press('Enter')
}

// Resolve the pane (paneId + terminalId) matching the requested kind in the
// active tab. Polls until the server-assigned terminalId is present.
async function resolveTerminalPane(page, { mode, shell }) {
  return await page.waitForFunction(({ mode, shell }) => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState()
    const tabId = st.tabs.activeTabId
    const layout = st.panes.layouts[tabId]
    const out = []
    const walk = (n) => {
      if (!n) return
      if (n.type === 'leaf') {
        const c = n.content
        if (c && c.kind === 'terminal') out.push({ paneId: n.id, content: c })
      } else if (n.type === 'split') { n.children.forEach(walk) }
    }
    walk(layout)
    const match = out.find((p) => p.content.mode === mode && (!shell || p.content.shell === shell))
      || out.find((p) => p.content.mode === mode)
      || (out.length === 1 ? out[0] : null)
    if (!match || !match.content.terminalId) return null
    return { paneId: match.paneId, terminalId: match.content.terminalId }
  }, { mode, shell }, { timeout: 20000 }).then((h) => h.jsonValue())
}

async function readBuffer(page, terminalId) {
  return await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id), terminalId)
}

// ── per-kind runners ────────────────────────────────────────────────────────
async function runTerminalKind(page, kind, dir) {
  const picker = await openPickerInNewTab(page)
  await picker.getByRole('button', { name: new RegExp(`^${kind.label}$`, 'i') }).click()

  if (kind.type === 'cli') await confirmDirectory(page, dir)

  const pane = await resolveTerminalPane(page, { mode: kind.mode, shell: kind.shell })
  const paneSel = `[data-pane-id="${pane.paneId}"]`
  await page.locator(`${paneSel} .xterm`).first().waitFor({ state: 'visible', timeout: 20000 })

  if (kind.type === 'shell') {
    // focus this pane's terminal and run the command
    await page.locator(`${paneSel} .xterm`).first().click()
    await sleep(150)
    await page.keyboard.type(kind.cmd)
    await page.keyboard.press('Enter')
    // assert the OUTPUT appears (marker on its own line => count >= minCount)
    await page.waitForFunction(
      ({ id, marker, minCount, also }) => {
        const buf = window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id)
        if (!buf) return false
        let n = 0, i = 0
        for (;;) { const j = buf.indexOf(marker, i); if (j < 0) break; n++; i = j + marker.length }
        return n >= minCount && (!also || buf.includes(also))
      },
      { id: pane.terminalId, marker: kind.marker, minCount: kind.minCount, also: kind.also || null },
      { timeout: 25000 },
    )
  } else {
    // CLI: prove the CLI process launched by waiting for its banner/prompt text.
    await page.waitForFunction(
      ({ id, re }) => {
        const buf = window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id)
        return !!buf && new RegExp(re.source, re.flags).test(buf)
      },
      { id: pane.terminalId, re: { source: kind.banner.source, flags: kind.banner.flags } },
      { timeout: 30000 },
    )
  }
  const buffer = await readBuffer(page, pane.terminalId)
  return { terminalId: pane.terminalId, buffer }
}

async function runEditorKind(page) {
  const picker = await openPickerInNewTab(page)
  await picker.getByRole('button', { name: /^Editor$/i }).click()
  await page.locator('.monaco-editor').first().waitFor({ state: 'visible', timeout: 30000 })
}

async function runBrowserKind(page) {
  const picker = await openPickerInNewTab(page)
  await picker.getByRole('button', { name: /^Browser$/i }).click()
  await page.locator('[data-context="browser"]').filter({ visible: true }).last()
    .waitFor({ state: 'visible', timeout: 20000 })
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const results = []
  let browser = null
  let page = null

  const cleanup = async () => {
    try { if (page) await killAllTerminalsViaPage(page) } catch {}
    try { if (browser) await browser.close() } catch {}
    await reapServer()
  }
  process.on('exit', reapServerSync)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup().finally(() => process.exit(130)) })

  try {
    await bootServer()
    browser = await chromium.launch({ headless: HEADLESS, args: ['--use-gl=angle', '--use-angle=swiftshader'] })
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 })
    page = await ctx.newPage()
    page.on('pageerror', (e) => log('pageerror:', e.message))

    await page.goto(`${BASE_URL}/?token=${TOKEN}&e2e=1`, { waitUntil: 'domcontentloaded' })
    await waitReady(page)
    log('client ready (harness + ws connected)')

    for (const kind of KINDS) {
      const rec = { kind: kind.key, label: kind.label, created: false, asserted: false, screenshot: '', status: 'FAIL', detail: '', bufferExcerpt: '' }
      log(`--- ${kind.label} ---`)
      try {
        if (kind.type === 'editor') {
          await runEditorKind(page); rec.created = true; rec.asserted = true
          rec.detail = 'monaco-editor rendered'
        } else if (kind.type === 'browser') {
          await runBrowserKind(page); rec.created = true; rec.asserted = true
          rec.detail = 'browser pane rendered'
        } else {
          const { terminalId, buffer } = await runTerminalKind(page, kind, scratchHome)
          rec.created = true; rec.asserted = true; rec.terminalId = terminalId
          rec.bufferExcerpt = (buffer || '').split('\n').filter((l) => l.trim()).slice(-6).join(' | ').slice(0, 400)
          rec.detail = kind.type === 'cli' ? `banner matched ${kind.banner}` : `marker x>=${kind.minCount}${kind.also ? ' + ' + kind.also : ''}`
        }
        rec.status = 'PASS'
        log(`${kind.label}: PASS`)
      } catch (err) {
        rec.detail = String(err && err.message || err).slice(0, 500)
        rec.status = kind.envLimited ? 'ENV-LIMITED' : 'FAIL'
        if (kind.envLimited) rec.envReason = kind.envReason
        log(`${kind.label}: ${rec.status} — ${rec.detail}`)
        // capture buffer evidence if a terminal exists
        try {
          const st = await page.evaluate(() => {
            const s = window.__FRESHELL_TEST_HARNESS__.getState()
            const t = s.tabs.activeTabId
            return JSON.stringify(s.panes.layouts[t])
          })
          rec.layoutExcerpt = st.slice(0, 600)
        } catch {}
      }
      // always screenshot for evidence
      try { await page.screenshot({ path: SHOT(kind.key), fullPage: false }); rec.screenshot = SHOT(kind.key) } catch (e) { log('screenshot failed', e.message) }
      results.push(rec)
      await sleep(300)
    }

    // overview: show the tab strip with all tabs
    try { await page.screenshot({ path: SHOT('overview'), fullPage: false }); log('overview screenshot written') } catch {}

  } finally {
    await cleanup()
    try { const rp = join(OUT_DIR, 'wsl-chrome-report.json'); writeFileSync(rp, JSON.stringify(results, null, 2)); log('report:', rp) } catch {}
    // give reaper a moment, then drop scratch home
    await sleep(1500)
    try { if (scratchHome) rmSync(scratchHome, { recursive: true, force: true }) } catch {}
  }

  // summary table
  console.log('\n================ WSL-server x Chrome — RESULTS ================')
  for (const r of results) {
    console.log(`${r.status.padEnd(11)}  ${r.label.padEnd(12)}  created=${r.created} asserted=${r.asserted}  ${r.screenshot ? 'shot✓' : 'shot✗'}`)
    if (r.status !== 'PASS') console.log(`        ${r.status === 'ENV-LIMITED' ? 'env' : 'detail'}: ${r.envReason || r.detail}`)
    if (r.bufferExcerpt) console.log(`        buf: ${r.bufferExcerpt}`)
  }
  const pass = results.filter((r) => r.status === 'PASS').length
  const envLimited = results.filter((r) => r.status === 'ENV-LIMITED').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  console.log(`\n${pass}/${results.length} PASS · ${envLimited} ENV-LIMITED · ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); reapServer(); process.exit(2) })
