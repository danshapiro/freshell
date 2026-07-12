#!/usr/bin/env node
// Mirror-client matrix harness for DESKTOP-SHELL legs (Tauri / Electron).
//
// Unlike run-matrix-generic.mjs this does NOT boot a server: it attaches a
// Playwright Chromium "mirror" client to an ALREADY-RUNNING server that a
// desktop shell (Tauri app-bound/remote, Electron) is also attached to, drives
// the SAME pane-kind matrix through the shared server state (tabs/terminals
// mirror across clients), asserts via the harness buffer, and captures the
// REAL desktop window per kind via ImageMagick `import -window <id>` (X11 id
// found by name regex through xdotool). Assertions are UNCHANGED from
// run-matrix-generic.mjs so results are directly comparable across cells.
//
// Env vars:
//   MATRIX_URL       server base URL, e.g. http://127.0.0.1:34619
//   MATRIX_TOKEN_FILE file containing the auth token (never printed)
//   MATRIX_PREFIX    output filename prefix, e.g. 'sbp9-tauriA'
//   MATRIX_WIN_RE    xdotool --name regexp for the desktop window (e.g. '^Freshell$')
//   MATRIX_ONLY      optional comma-separated kind filter
//   MATRIX_HEADLESS  default 1 (the mirror client)

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const WORKTREE = resolve(new URL('../../..', import.meta.url).pathname)
const BASE_URL = process.env.MATRIX_URL
const TOKEN = readFileSync(process.env.MATRIX_TOKEN_FILE, 'utf8').trim()
const PREFIX = process.env.MATRIX_PREFIX || 'sbp9-desktop'
const WIN_RE = process.env.MATRIX_WIN_RE || '^Freshell$'
const HEADLESS = process.env.MATRIX_HEADLESS !== '0'
if (!BASE_URL || !TOKEN) { console.error('MATRIX_URL + MATRIX_TOKEN_FILE required'); process.exit(2) }
const OUT_DIR = join(WORKTREE, 'port/oracle/matrix')
const SHOT = (name) => join(OUT_DIR, `${PREFIX}-${name}.png`)
const MARKER = 'freshell-matrix-OK'
const rand = () => Math.random().toString(36).slice(2, 10)

const ONLY = (process.env.MATRIX_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
const activeKinds = (all) => (ONLY.length ? all.filter((k) => ONLY.includes(k.key)) : all)

const MNT_PUBLIC = '/mnt/c/Users/Public'
const WORKSPACE = existsSync(MNT_PUBLIC)
  ? join(MNT_PUBLIC, `freshell-matrix-ws-${PREFIX}-${rand()}`)
  : WORKTREE
const WORKSPACE_IS_MNT = WORKSPACE.startsWith('/mnt/')
const WORKSPACE_NAME = basename(WORKSPACE)

// Identical kind list/assertions to run-matrix-generic.mjs (WSL-hosted server).
const KINDS = [
  { key: 'cmd', label: 'CMD', type: 'terminal', mode: 'shell', shell: 'cmd',
    cmd: `echo ${MARKER}`, marker: MARKER, minCount: 2,
    landedRe: new RegExp('C:\\\\Users\\\\Public\\\\' + WORKSPACE_NAME.replace(/[-]/g, '[-]'), 'i'),
    notLandedRe: /C:\\Windows>/i },
  { key: 'powershell', label: 'PowerShell', type: 'terminal', mode: 'shell', shell: 'powershell',
    cmd: `echo ${MARKER}`, marker: MARKER, minCount: 2,
    landedRe: new RegExp('PS C:\\\\Users\\\\Public\\\\' + WORKSPACE_NAME.replace(/[-]/g, '[-]'), 'i') },
  { key: 'wsl', label: 'WSL', type: 'terminal', mode: 'shell', shell: 'wsl',
    cmd: `echo ${MARKER} && pwd`, marker: MARKER, minCount: 2, also: 'Linux',
    preCmd: 'uname -a', landedRe: new RegExp(WORKSPACE.replace(/[-/.]/g, (c) => '[' + c + ']')) },
  { key: 'editor', label: 'Editor', type: 'editor' },
  { key: 'browser', label: 'Browser', type: 'browser', url: 'http://example.com', expect: /Example Domain/i },
  { key: 'claude', label: 'Claude CLI', type: 'cli', mode: 'claude',
    launchedRe: /welcome to claude|claude code|anthropic|╭|▐|✳|✽/i,
    steadyRe: /\? for shortcuts|for shortcuts|bypass permissions|╰─+|>\s*$|try "|/i },
  { key: 'codex', label: 'Codex CLI', type: 'cli', mode: 'codex',
    launchedRe: /openai codex|welcome to codex|codex|>_|model:|to get started|do you trust|you are in/i,
    steadyRe: /sign in with chatgpt|press enter to continue|provide your own api key|welcome to codex|to get started|describe a task|\/status|model:|yes, continue/i },
  { key: 'opencode', label: 'OpenCode', type: 'cli', mode: 'opencode',
    launchedRe: /opencode|build\s+·|share|anthropic/i,
    steadyRe: /ask anything|esc\s|ctrl\+|\/help|tab\s+agents|▌|>_/i },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[mirror:${PREFIX}]`, ...a)
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex')
const cdnHits = []
const cdnSummary = () => {
  const ok = cdnHits.filter((s) => s >= 200 && s < 400).length
  return `jsdelivr/monaco responses: ${cdnHits.length} (${ok}×2xx-3xx)`
}

// ── desktop-window capture ─────────────────────────────────────────────────
function findDesktopWindow() {
  try {
    const out = execSync(`DISPLAY=:0 xdotool search --name '${WIN_RE}'`, { encoding: 'utf8' })
    const ids = out.trim().split('\n').filter(Boolean)
    return ids[ids.length - 1] || null
  } catch { return null }
}

function shootDesktop(name) {
  const win = findDesktopWindow()
  if (!win) { log(`desktop window not found (${WIN_RE}) — no shot for ${name}`); return '' }
  const p = SHOT(name)
  try {
    execSync(`DISPLAY=:0 import -window ${win} '${p}'`, { encoding: 'utf8', timeout: 20000 })
    return p
  } catch (e) {
    // one retry — WSLg import is occasionally EAGAIN-flaky
    try { execSync(`sleep 1; DISPLAY=:0 import -window ${win} '${p}'`, { encoding: 'utf8', timeout: 20000 }); return p } catch {}
    log(`import failed for ${name}: ${String(e.message).slice(0, 120)}`)
    return ''
  }
}

// ── in-page helpers (identical to run-matrix-generic.mjs) ──────────────────
async function waitReady(page) {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 20000 })
  await page.waitForFunction(() => {
    const h = window.__FRESHELL_TEST_HARNESS__
    if (!h) return false
    const st = h.getState()
    return h.getWsReadyState() === 'ready' && st?.connection?.status === 'ready'
  }, { timeout: 20000 })
}

async function openPaneInNewTab(page) {
  const before = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length)
  await page.locator('[data-context="tab-add"]').click()
  await page.waitForFunction(
    (n) => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length > n,
    before, { timeout: 10000 },
  )
  return await page.waitForFunction(() => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState()
    const tabId = st.tabs.activeTabId
    const layout = st.panes.layouts[tabId]
    const leaves = []
    const walk = (n) => { if (!n) return; if (n.type === 'leaf') leaves.push(n.id); else if (n.type === 'split') n.children.forEach(walk) }
    walk(layout)
    return leaves.length === 1 ? { tabId, paneId: leaves[0] } : null
  }, { timeout: 10000 }).then((h) => h.jsonValue())
}

function dispatchContent(page, tabId, paneId, content) {
  return page.evaluate(({ tabId, paneId, content }) => {
    window.__FRESHELL_TEST_HARNESS__.dispatch({
      type: 'panes/updatePaneContent',
      payload: { tabId, paneId, content },
    })
  }, { tabId, paneId, content })
}

async function resolveTerminalId(page, tabId, paneId) {
  return await page.waitForFunction(({ tabId, paneId }) => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState()
    const layout = st.panes.layouts[tabId]
    let found = null
    const walk = (n) => {
      if (!n || found) return
      if (n.type === 'leaf' && n.id === paneId) { found = n.content }
      else if (n.type === 'split') n.children.forEach(walk)
    }
    walk(layout)
    if (found && found.kind === 'terminal' && found.terminalId) return found.terminalId
    return null
  }, { tabId, paneId }, { timeout: 20000 }).then((h) => h.jsonValue())
}

const readBuffer = (page, id) =>
  page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id), id)

async function waitBufferStable(page, id, { quietMs = 1600, timeoutMs = 20000 } = {}) {
  const start = Date.now()
  let last = ''
  let lastChange = Date.now()
  while (Date.now() - start < timeoutMs) {
    const buf = (await readBuffer(page, id)) || ''
    if (buf !== last) { last = buf; lastChange = Date.now() }
    else if (Date.now() - lastChange >= quietMs) return last
    await sleep(200)
  }
  return last
}

async function waitBufferMatch(page, id, re, timeoutMs) {
  await page.waitForFunction(
    ({ id, src, flags }) => {
      const buf = window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id)
      return !!buf && new RegExp(src, flags).test(buf)
    },
    { id, src: re.source, flags: re.flags },
    { timeout: timeoutMs },
  )
}

async function runTerminalKind(page, kind) {
  const { tabId, paneId } = await openPaneInNewTab(page)
  const content = {
    kind: 'terminal', mode: kind.mode, shell: kind.shell,
    createRequestId: `matrix-${kind.key}-${rand()}`, status: 'creating', initialCwd: WORKSPACE,
  }
  await dispatchContent(page, tabId, paneId, content)
  const terminalId = await resolveTerminalId(page, tabId, paneId)
  const paneSel = `[data-pane-id="${paneId}"]`
  await page.locator(`${paneSel} .xterm`).first().waitFor({ state: 'visible', timeout: 20000 })
  await page.locator(`${paneSel} .xterm`).first().click()
  await sleep(300)
  if (kind.preCmd) { await page.keyboard.type(kind.preCmd); await page.keyboard.press('Enter'); await sleep(200) }
  await page.keyboard.type(kind.cmd)
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    ({ id, marker, minCount, also }) => {
      const buf = window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id)
      if (!buf) return false
      let n = 0, i = 0
      for (;;) { const j = buf.indexOf(marker, i); if (j < 0) break; n++; i = j + marker.length }
      return n >= minCount && (!also || buf.includes(also))
    },
    { id: terminalId, marker: kind.marker, minCount: kind.minCount, also: kind.also || null },
    { timeout: 25000 },
  )
  await waitBufferStable(page, terminalId, { quietMs: 1000, timeoutMs: 8000 })
  const buffer = (await readBuffer(page, terminalId)) || ''
  const detail = []
  let landed = true
  if (kind.landedRe) {
    landed = kind.landedRe.test(buffer)
    detail.push(landed ? `landed in workspace (${WORKSPACE_NAME})` : `did NOT land in workspace`)
  }
  if (kind.notLandedRe && kind.notLandedRe.test(buffer)) { landed = false; detail.push('FELL BACK to C:\\Windows') }
  if (!landed && WORKSPACE_IS_MNT) throw new Error(`cwd assertion failed: ${detail.join('; ')}`)
  return { terminalId, tabId, buffer, detail: [`marker x>=${kind.minCount}`, ...detail].join(' · ') }
}

async function runCliKind(page, kind) {
  const { tabId, paneId } = await openPaneInNewTab(page)
  await dispatchContent(page, tabId, paneId, {
    kind: 'terminal', mode: kind.mode, shell: 'system',
    createRequestId: `matrix-${kind.key}-${rand()}`, status: 'creating', initialCwd: WORKSPACE,
  })
  const terminalId = await resolveTerminalId(page, tabId, paneId)
  const paneSel = `[data-pane-id="${paneId}"]`
  await page.locator(`${paneSel} .xterm`).first().waitFor({ state: 'visible', timeout: 20000 })
  await waitBufferMatch(page, terminalId, kind.launchedRe, 30000)
  let steadyOk = true
  try { await waitBufferMatch(page, terminalId, kind.steadyRe, 45000) } catch { steadyOk = false }
  await waitBufferStable(page, terminalId, { quietMs: 1800, timeoutMs: 30000 })
  const buffer = (await readBuffer(page, terminalId)) || ''
  if (!steadyOk) throw new Error(`steady UI (${kind.steadyRe}) never painted`)
  return { terminalId, tabId, buffer, detail: `launched + steady UI painted (${kind.steadyRe})` }
}

async function runBrowserKind(page, kind) {
  const { tabId, paneId } = await openPaneInNewTab(page)
  await dispatchContent(page, tabId, paneId, { kind: 'browser', browserInstanceId: `matrix-${rand()}`, url: '', devToolsOpen: false })
  const paneSel = `[data-pane-id="${paneId}"]`
  const urlInput = page.locator(`${paneSel} input[placeholder="Enter URL..."]`)
  await urlInput.waitFor({ state: 'visible', timeout: 20000 })
  await urlInput.fill(kind.url)
  await urlInput.press('Enter')
  const frameEl = page.locator(`${paneSel} iframe[title="Browser content"]`)
  await frameEl.waitFor({ state: 'visible', timeout: 25000 })
  let contentOk = false
  try {
    const frame = page.frameLocator(`${paneSel} iframe[title="Browser content"]`)
    await frame.locator('body').filter({ hasText: kind.expect }).first().waitFor({ state: 'visible', timeout: 20000 })
    contentOk = true
  } catch {}
  await sleep(800)
  if (!contentOk) throw new Error('browser iframe never rendered real page content')
  return { tabId, detail: `navigated ${kind.url} → page content rendered` }
}

async function runEditorKind(page) {
  const { tabId, paneId } = await openPaneInNewTab(page)
  const scratchText = [
    `// ${MARKER} — freshell editor scratch pad`, 'fn main() {',
    '    println!("freshell matrix editor OK");', '}', '',
  ].join('\n')
  await dispatchContent(page, tabId, paneId, {
    kind: 'editor', filePath: 'freshell-matrix.rs', language: 'rust',
    readOnly: false, content: scratchText, viewMode: 'source', wordWrap: true,
  })
  const paneSel = `[data-pane-id="${paneId}"]`
  const mountMonaco = async (timeout) => {
    await page.locator(`${paneSel} .monaco-editor`).first().waitFor({ state: 'visible', timeout })
    await page.locator(`${paneSel} .view-lines`).first().waitFor({ state: 'visible', timeout: 15000 })
  }
  let mounted = false
  try { await mountMonaco(75000); mounted = true } catch {}
  if (mounted) {
    await page.waitForFunction(
      ({ sel }) => {
        const el = document.querySelector(`${sel} .view-lines`)
        return !!el && el.textContent && el.textContent.includes('freshell')
      },
      { sel: paneSel }, { timeout: 10000 },
    )
    return { tabId, status: 'PASS', detail: `Monaco mounted + text visible · ${cdnSummary()}` }
  }
  return { tabId, status: 'FAIL', detail: `Monaco did not mount · ${cdnSummary()}` }
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(WORKSPACE, { recursive: true })
  try { writeFileSync(join(WORKSPACE, 'WORKSPACE_MARKER.txt'), MARKER) } catch {}
  const results = []
  let browser = null
  let page = null
  try {
    const health = await fetch(`${BASE_URL}/api/health`).then((r) => r.json())
    if (health.app !== 'freshell') throw new Error('health gate failed')
    log('health OK against', BASE_URL)

    browser = await chromium.launch({ headless: HEADLESS, args: ['--use-gl=angle', '--use-angle=swiftshader'] })
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 })
    await ctx.addInitScript(() => { try { sessionStorage.setItem('freshell.setupWizardAutoDismissed', 'true') } catch {} })
    page = await ctx.newPage()
    page.on('response', (r) => { const u = r.url(); if (/jsdelivr|monaco/i.test(u)) cdnHits.push(r.status()) })
    await page.goto(`${BASE_URL}/?token=${TOKEN}&e2e=1`, { waitUntil: 'domcontentloaded' })
    await waitReady(page)
    log('mirror client ready')
    shootDesktop('initial')

    for (const kind of activeKinds(KINDS)) {
      const rec = { kind: kind.key, label: kind.label, created: false, asserted: false, screenshot: '', status: 'FAIL', detail: '', bufferExcerpt: '' }
      log(`--- ${kind.label} ---`)
      try {
        let r
        if (kind.type === 'editor') { r = await runEditorKind(page); rec.status = r.status; rec.created = true; rec.asserted = r.status === 'PASS' }
        else if (kind.type === 'browser') { r = await runBrowserKind(page, kind); rec.status = 'PASS'; rec.created = true; rec.asserted = true }
        else if (kind.type === 'cli') { r = await runCliKind(page, kind); rec.status = 'PASS'; rec.created = true; rec.asserted = true }
        else { r = await runTerminalKind(page, kind); rec.status = 'PASS'; rec.created = true; rec.asserted = true }
        rec.detail = r.detail
        rec.tabId = r.tabId
        if (r.terminalId) rec.terminalId = r.terminalId
        if (r.buffer) rec.bufferExcerpt = r.buffer.split('\n').filter((l) => l.trim()).slice(-6).join(' | ').slice(0, 400)
        log(`${kind.label}: ${rec.status}`)
      } catch (err) {
        rec.detail = String(err && err.message || err).slice(0, 500)
        log(`${kind.label}: FAIL — ${rec.detail}`)
        try { if (rec.terminalId) rec.bufferExcerpt = ((await readBuffer(page, rec.terminalId)) || '').slice(-400) } catch {}
      }
      // settle, then capture the DESKTOP window (the cell's real evidence)
      await sleep(1200)
      rec.screenshot = shootDesktop(kind.key)
      results.push(rec)
      await sleep(300)
    }
    shootDesktop('overview')
  } finally {
    try {
      if (page) {
        const ids = await page.evaluate(async (token) => {
          const res = await fetch('/api/terminals', { headers: { 'x-auth-token': token } })
          if (!res.ok) return []
          const list = await res.json()
          const ids = (Array.isArray(list) ? list : []).filter((t) => t.status !== 'exited').map((t) => t.terminalId)
          const h = window.__FRESHELL_TEST_HARNESS__
          for (const id of ids) h?.sendWsMessage({ type: 'terminal.kill', terminalId: id })
          return ids
        }, TOKEN)
        if (ids.length) { log(`killed ${ids.length} PTY(s)`); await sleep(600) }
      }
    } catch {}
    try { if (browser) await browser.close() } catch {}
    try { const rp = join(OUT_DIR, `${PREFIX}-report.json`); writeFileSync(rp, JSON.stringify(results, null, 2)); log('report:', rp) } catch {}
    try { rmSync(WORKSPACE, { recursive: true, force: true }) } catch {}
  }

  const shots = ['initial', ...activeKinds(KINDS).map((k) => k.key), 'overview']
  const md5s = {}
  const seen = new Map()
  let dupes = 0
  for (const key of shots) {
    const p = SHOT(key)
    if (!existsSync(p)) continue
    const h = md5(p)
    md5s[key] = h
    if (seen.has(h)) { dupes++; log(`DUPLICATE screenshot: ${key} == ${seen.get(h)} (md5 ${h})`) }
    else seen.set(h, key)
  }
  console.log(`\n================ ${PREFIX} (mirror) — RESULTS ================`)
  for (const r of results) {
    console.log(`${r.status.padEnd(11)}  ${r.label.padEnd(12)}  created=${r.created} asserted=${r.asserted}  ${r.screenshot ? 'shot✓' : 'shot✗'}  md5=${(md5s[r.kind] || '').slice(0, 8)}`)
    if (r.status !== 'PASS') console.log(`        detail: ${r.detail}`)
    else console.log(`        ${r.detail}`)
    if (r.bufferExcerpt) console.log(`        buf: ${r.bufferExcerpt}`)
  }
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  console.log(`\n${pass}/${results.length} PASS · ${fail} FAIL · ${dupes} duplicate desktop screenshot(s)`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
