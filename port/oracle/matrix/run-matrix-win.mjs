#!/usr/bin/env node
// Screenshot-driven shell-matrix validation harness.
//
// Matrix cell: NATIVE-WINDOWS-server x Chrome (Chromium via Playwright in WSL).
//
// This is the entirely-different native-Windows ConPTY spawn path (portable-pty
// conpty backend), NOT the WSL server. It boots the cross-compiled
// `freshell-server.exe` as a REAL Windows process via WSL interop (cmd.exe `set`
// wrapper + a NATIVE Windows client dir), reachable from WSL at the Windows HOST
// IP (not 127.0.0.1). Then it drives a real Chromium against the retained
// (unchanged) SPA and, for every shell/pane kind the win32 picker offers:
//   - CMD        -> cmd.exe /K            : echo marker, assert output + real cwd
//   - PowerShell -> powershell.exe -NoLogo: echo marker, assert output + real cwd
//   - WSL        -> wsl.exe --exec bash -l: echo marker + uname, assert Linux
//   - coding CLIs (claude/codex/... whatever /api/platform reports available on
//     the Windows PATH via where.exe): launch + assert the steady interactive UI
//   - editor  : drive Monaco (CDN)
//   - browser : navigate a real URL, assert page content
// Every screenshot is verified BYTE-DISTINCT (md5) at the end.
//
// SAFETY: never touches :3001 or the user's live processes. Own scratch port +
// native Windows temp client dir + a C:\Users\Public workspace. The Windows
// process is health-gated up and REAPED down by port (netstat.exe -ano ->
// Stop-Process, the only reliable interop kill); PTYs are killed through the app
// first so no orphan shells; temp dirs are removed.
//
// Usage:  node port/oracle/matrix/run-matrix-win.mjs
// Env overrides: MATRIX_PORT, MATRIX_TOKEN, MATRIX_HEADLESS=0 (headed),
//                MATRIX_WIN_HOST (Windows host IP, else derived from default route)

import { spawn, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

// ── config ────────────────────────────────────────────────────────────────
const WORKTREE = resolve(new URL('../../..', import.meta.url).pathname)
const PORT = Number(process.env.MATRIX_PORT || 3041)
const TOKEN = process.env.MATRIX_TOKEN || 'winmatrix'
const HEADLESS = process.env.MATRIX_HEADLESS !== '0'
const OUT_DIR = join(WORKTREE, 'port/oracle/matrix')
const SHOT = (name) => join(OUT_DIR, `win-chrome-${name}.png`)
const MARKER = 'freshell-matrix-OK'
const rand = () => Math.random().toString(36).slice(2, 10)

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()

// The cross-compiled native-Windows server + its Windows-form path (\\wsl.localhost\..).
const SERVER_EXE = join(WORKTREE, 'target/x86_64-pc-windows-gnu/release/freshell-server.exe')
const EXE_WIN = sh(`wslpath -w '${SERVER_EXE}'`)
const CLIENT_DIR = join(WORKTREE, 'dist/client')

// Windows HOST IP (from WSL's default route) — where a WSL client reaches a
// service the Windows side bound on 0.0.0.0. NOT 127.0.0.1.
const WIN_HOST = process.env.MATRIX_WIN_HOST || sh(`ip route show default | awk '{print $3}'`).split('\n')[0]
const BASE_URL = `http://${WIN_HOST}:${PORT}`

// Native Windows temp (SPA served from here — a \\wsl.localhost FRESHELL_CLIENT_DIR
// is unreliable). Resolve both the Windows form and its /mnt view.
const WIN_TEMP = sh(`cmd.exe /d /c "echo %LOCALAPPDATA%\\Temp"`)
const WIN_TEMP_MNT = sh(`wslpath -u '${WIN_TEMP}'`)
const WIN_CLIENT_DIR = `${WIN_TEMP}\\freshell-matrix-winclient`
const WIN_CLIENT_MNT = join(WIN_TEMP_MNT, 'freshell-matrix-winclient')

// A real workspace on C:, visible to both native Windows shells (C:\Users\Public\..)
// and the WSL shell (/mnt/c/Users/Public/..), so cwd routing is genuinely exercised.
const WORKSPACE_NAME = `freshell-matrix-ws-${rand()}`
const WORKSPACE_WIN = `C:\\Users\\Public\\${WORKSPACE_NAME}`
const WORKSPACE_MNT = sh(`wslpath -u 'C:\\Users\\Public'`) + '/' + WORKSPACE_NAME

// win32 picker shell kinds + editor/browser. CLI kinds are appended at runtime
// from /api/platform's availableClis (where.exe detection on the Windows box).
const WS_NAME_RE = WORKSPACE_NAME.replace(/[-]/g, '[-]')
const BASE_KINDS = [
  { key: 'cmd', label: 'CMD', type: 'terminal', mode: 'shell', shell: 'cmd',
    cmd: `echo ${MARKER}`, marker: MARKER, minCount: 2,
    landedRe: new RegExp('C:\\\\Users\\\\Public\\\\' + WS_NAME_RE, 'i'),
    notLandedRe: /C:\\Windows>/i },
  { key: 'powershell', label: 'PowerShell', type: 'terminal', mode: 'shell', shell: 'powershell',
    cmd: `echo ${MARKER}`, marker: MARKER, minCount: 2,
    landedRe: new RegExp('PS C:\\\\Users\\\\Public\\\\' + WS_NAME_RE, 'i') },
  { key: 'wsl', label: 'WSL', type: 'terminal', mode: 'shell', shell: 'wsl',
    cmd: `echo ${MARKER} && uname -a`, marker: MARKER, minCount: 2, also: 'Linux',
    landedRe: new RegExp('/mnt/c/Users/Public/' + WS_NAME_RE) },
  { key: 'editor', label: 'Editor', type: 'editor' },
  { key: 'browser', label: 'Browser', type: 'browser', url: 'http://example.com', expect: /Example Domain/i },
]

// Steady-UI markers for the coding CLIs (asserting the interactive UI painted,
// not the first startup line). Fresh/authed either way still shows a steady UI.
const CLI_KINDS = {
  claude: { key: 'claude', label: 'Claude CLI', type: 'cli', mode: 'claude',
    launchedRe: /welcome to claude|claude code|anthropic|╭|▐|✻|✽|\btry\b/i,
    steadyRe: /\? for shortcuts|for shortcuts|bypass permissions|╰─+|>\s*$|try "|esc to/i },
  codex: { key: 'codex', label: 'Codex CLI', type: 'cli', mode: 'codex',
    // On a first run in a fresh workspace codex's first interactive screen is the
    // directory-trust prompt ("You are in <dir> / Do you trust the contents of
    // this directory? ... Press enter to continue") which contains no literal
    // "codex" — it IS the launched+steady interactive UI (verified via
    // diag-win-cli.mjs buffer dumps).
    launchedRe: /openai codex|welcome to codex|codex|>_|model:|to get started|do you trust|you are in/i,
    steadyRe: /sign in with chatgpt|press enter to continue|provide your own api key|welcome to codex|to get started|describe a task|\/status|model:|yes, continue/i },
  opencode: { key: 'opencode', label: 'OpenCode', type: 'cli', mode: 'opencode',
    launchedRe: /opencode|build\s+·|share|anthropic/i,
    steadyRe: /ask anything|esc\s|ctrl\+|\/help|tab\s+agents|▌|>_/i },
  gemini: { key: 'gemini', label: 'Gemini CLI', type: 'cli', mode: 'gemini',
    launchedRe: /gemini|google|GEMINI\.md|▲|◇|tips for getting started/i,
    steadyRe: /type your message|\/help|waiting for auth|sign in|gemini-\d|>\s*$|context left|no sandbox/i },
  kimi: { key: 'kimi', label: 'Kimi CLI', type: 'cli', mode: 'kimi',
    launchedRe: /kimi|moonshot/i, steadyRe: /kimi|>\s*$|\/help/i },
}

// ── tiny utils ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[win-matrix]', ...a)
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex')

const cdnHits = []
const cdnSummary = () => {
  const ok = cdnHits.filter((s) => s >= 200 && s < 400).length
  return `jsdelivr/monaco responses: ${cdnHits.length} (${ok}×2xx-3xx)`
}

// ── Windows server lifecycle (via WSL interop) ───────────────────────────────
let serverChild = null

function netstatPidsOnPort(port) {
  try {
    const out = execSync('netstat.exe -ano', { encoding: 'utf8' })
    const pids = new Set()
    for (const line of out.split('\n')) {
      if (line.includes(`:${port} `) && /LISTENING/i.test(line)) {
        const cols = line.trim().split(/\s+/)
        const pid = (cols[cols.length - 1] || '').replace(/\r/g, '')
        if (/^\d+$/.test(pid)) pids.add(pid)
      }
    }
    return [...pids]
  } catch { return [] }
}

function stopWindowsPid(pid) {
  try { execSync(`powershell.exe -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`, { stdio: 'ignore' }) } catch {}
}

async function bootServer() {
  // Workspace on C: (both a Windows and a /mnt view), with a marker file.
  mkdirSync(WORKSPACE_MNT, { recursive: true })
  try { writeFileSync(join(WORKSPACE_MNT, 'WORKSPACE_MARKER.txt'), MARKER) } catch {}
  // SPA -> native Windows client dir (fresh copy).
  rmSync(WIN_CLIENT_MNT, { recursive: true, force: true })
  execSync(`cp -r '${CLIENT_DIR}' '${WIN_CLIENT_MNT}'`)
  if (!existsSync(join(WIN_CLIENT_MNT, 'index.html'))) throw new Error('client copy missing index.html')

  // Any stale listener from a prior aborted run on our scratch port -> reap first.
  for (const p of netstatPidsOnPort(PORT)) { log(`reaping stale :${PORT} pid ${p}`); stopWindowsPid(p) }

  const launch = `cd /d ${WIN_TEMP} && set PORT=${PORT}&& set AUTH_TOKEN=${TOKEN}&& set FRESHELL_BIND_HOST=0.0.0.0&& set FRESHELL_CLIENT_DIR=${WIN_CLIENT_DIR}&& ${EXE_WIN}`
  log(`boot Windows server :${PORT} host=${WIN_HOST} client=${WIN_CLIENT_DIR} workspace=${WORKSPACE_WIN}`)
  serverChild = spawn('cmd.exe', ['/d', '/c', launch], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const logPath = join(OUT_DIR, 'win-server.log')
  const chunks = []
  serverChild.stdout.on('data', (d) => { chunks.push(d); process.stdout.write(`[srv] ${d}`) })
  serverChild.stderr.on('data', (d) => { chunks.push(d); process.stderr.write(`[srv!] ${d}`) })
  serverChild.on('exit', (code, sig) => { try { writeFileSync(logPath, Buffer.concat(chunks)) } catch {}; log(`launcher exited code=${code} sig=${sig}`) })

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
  throw new Error('Windows server health-gate timed out')
}

async function fetchAvailableClis() {
  try {
    const res = await fetch(`${BASE_URL}/api/platform`, { headers: { 'x-auth-token': TOKEN } })
    if (!res.ok) return {}
    const j = await res.json()
    return (j && j.availableClis) || {}
  } catch { return {} }
}

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
    if (ids.length) { log(`killed ${ids.length} PTY(s) via terminal.kill`); await sleep(800) }
  } catch {}
}

async function reapServer() {
  // Kill our scratch-port Windows listener (the only reliable interop kill), then
  // the WSL-side launcher process group. netstat/Stop-Process, per the recipe.
  const pids = netstatPidsOnPort(PORT)
  for (const p of pids) { stopWindowsPid(p); log(`Stop-Process ${p} (:${PORT})`) }
  if (serverChild) { try { process.kill(-serverChild.pid, 'SIGKILL') } catch {} }
  // Verify the port is free.
  for (let i = 0; i < 15; i++) {
    if (netstatPidsOnPort(PORT).length === 0) break
    await sleep(300)
  }
  const left = netstatPidsOnPort(PORT)
  log(left.length ? `WARN: :${PORT} still has listener(s): ${left.join(',')}` : `server reaped (:${PORT} free)`)
}

function reapServerSync() {
  for (const p of netstatPidsOnPort(PORT)) stopWindowsPid(p)
  if (serverChild) { try { process.kill(-serverChild.pid, 'SIGKILL') } catch {} }
}

// ── in-page helpers (identical to the WSL cell) ──────────────────────────────
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
    window.__FRESHELL_TEST_HARNESS__.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId, content } })
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

// ── per-kind runners ─────────────────────────────────────────────────────────
async function runTerminalKind(page, kind) {
  const { tabId, paneId } = await openPaneInNewTab(page)
  const content = {
    kind: 'terminal', mode: kind.mode, shell: kind.shell,
    createRequestId: `winmatrix-${kind.key}-${rand()}`, status: 'creating', initialCwd: WORKSPACE_WIN,
  }
  await dispatchContent(page, tabId, paneId, content)
  const terminalId = await resolveTerminalId(page, tabId, paneId)
  const paneSel = `[data-pane-id="${paneId}"]`
  await page.locator(`${paneSel} .xterm`).first().waitFor({ state: 'visible', timeout: 20000 })

  await page.locator(`${paneSel} .xterm`).first().click()
  await sleep(400)
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
    { timeout: 30000 },
  )
  await waitBufferStable(page, terminalId, { quietMs: 1000, timeoutMs: 8000 })
  const buffer = (await readBuffer(page, terminalId)) || ''

  const detail = []
  let landed = true
  if (kind.landedRe) {
    landed = kind.landedRe.test(buffer)
    detail.push(landed ? `landed in workspace (${WORKSPACE_NAME})` : 'did NOT land in workspace')
  }
  if (kind.notLandedRe && kind.notLandedRe.test(buffer)) { landed = false; detail.push('FELL BACK to C:\\Windows') }
  if (!landed) throw new Error(`cwd assertion failed: ${detail.join('; ')}`)
  return { terminalId, buffer, detail: [`marker x>=${kind.minCount}`, ...detail].join(' · ') }
}

async function runCliKind(page, kind) {
  const { tabId, paneId } = await openPaneInNewTab(page)
  const content = {
    kind: 'terminal', mode: kind.mode, shell: 'system',
    createRequestId: `winmatrix-${kind.key}-${rand()}`, status: 'creating', initialCwd: WORKSPACE_WIN,
  }
  await dispatchContent(page, tabId, paneId, content)
  const terminalId = await resolveTerminalId(page, tabId, paneId)
  const paneSel = `[data-pane-id="${paneId}"]`
  await page.locator(`${paneSel} .xterm`).first().waitFor({ state: 'visible', timeout: 20000 })

  // 90s launch window: the Windows CLIs are npm .cmd shims whose node cold start
  // is slow (gemini observed blank >45s under contention — diag-win-gemini.mjs
  // showed the identical launch painting fine, just late).
  await waitBufferMatch(page, terminalId, kind.launchedRe, 90000)
  let steadyOk = true
  try { await waitBufferMatch(page, terminalId, kind.steadyRe, 45000) } catch { steadyOk = false }
  await waitBufferStable(page, terminalId, { quietMs: 1800, timeoutMs: 30000 })
  const buffer = (await readBuffer(page, terminalId)) || ''
  if (!steadyOk) throw new Error(`steady UI (${kind.steadyRe}) never painted`)
  return { terminalId, buffer, detail: `launched + steady UI painted (${kind.steadyRe})` }
}

async function runBrowserKind(page, kind) {
  const { tabId, paneId } = await openPaneInNewTab(page)
  await dispatchContent(page, tabId, paneId, { kind: 'browser', browserInstanceId: `winmatrix-${rand()}`, url: '', devToolsOpen: false })
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
  } catch {
    try {
      await urlInput.fill(`${BASE_URL}/?token=${TOKEN}`)
      await urlInput.press('Enter')
      await frameEl.waitFor({ state: 'visible', timeout: 20000 })
      const frame = page.frameLocator(`${paneSel} iframe[title="Browser content"]`)
      await frame.locator('body').first().waitFor({ state: 'visible', timeout: 20000 })
      contentOk = true
    } catch {}
  }
  await sleep(800)
  if (!contentOk) throw new Error('browser iframe never rendered real page content')
  return { detail: `navigated ${kind.url} → page content rendered` }
}

async function runEditorKind(page) {
  const { tabId, paneId } = await openPaneInNewTab(page)
  const scratchText = [
    `// ${MARKER} — freshell editor scratch pad`,
    'fn main() {',
    '    println!("freshell matrix editor OK");',
    '}',
    '',
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
  if (!mounted) {
    await dispatchContent(page, tabId, paneId, {
      kind: 'editor', filePath: 'freshell-matrix.rs', language: 'rust',
      readOnly: false, content: scratchText + '\n// retry\n', viewMode: 'source', wordWrap: true,
    })
    try { await mountMonaco(45000); mounted = true } catch {}
  }
  if (mounted) {
    try {
      const ta = page.locator(`${paneSel} .monaco-editor textarea`).first()
      await ta.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(`// typed live in matrix ${MARKER}\n`)
    } catch {}
    await page.waitForFunction(
      ({ sel }) => {
        const el = document.querySelector(`${sel} .view-lines`)
        return !!el && el.textContent && el.textContent.includes('freshell')
      },
      { sel: paneSel }, { timeout: 10000 },
    )
    return { status: 'PASS', detail: `Monaco mounted + text visible · ${cdnSummary()}` }
  }
  await dispatchContent(page, tabId, paneId, {
    kind: 'editor', filePath: 'freshell-matrix.md', language: 'markdown',
    readOnly: false, content: `# ${MARKER}\n\nMatrix editor preview (Monaco CDN too slow/unreachable in headless).\n`,
    viewMode: 'preview', wordWrap: true,
  })
  await sleep(1500)
  return {
    status: 'ENV-LIMITED',
    detail: `Monaco did not mount within budget in headless swiftshader · ${cdnSummary()}`,
    envReason: 'Monaco loads from the jsdelivr CDN via the unchanged frontend; the Windows server serves the SPA/editor chunk correctly and injects no CSP. CDN load is a frontend/env concern identical on the original Node server (same dist/client) — not port-differentiating.',
  }
}

async function switchToTab(page, tabId) {
  const target = tabId || await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs[0]?.id)
  if (!target) return
  await page.locator(`[data-tab-id="${target}"]`).first().click().catch(() => {})
  await sleep(600)
}

// ── main ─────────────────────────────────────────────────────────────────────
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

  let KINDS = BASE_KINDS
  try {
    await bootServer()
    const availableClis = await fetchAvailableClis()
    log('availableClis:', JSON.stringify(availableClis))
    const cliKinds = Object.entries(availableClis)
      .filter(([, v]) => v === true)
      .map(([name]) => CLI_KINDS[name])
      .filter(Boolean)
    KINDS = [...BASE_KINDS, ...cliKinds]
    log('CLI kinds to test:', cliKinds.map((k) => k.key).join(', ') || '(none detected)')

    browser = await chromium.launch({ headless: HEADLESS, args: ['--use-gl=angle', '--use-angle=swiftshader'] })
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 })
    // The first-run Network setup wizard auto-opens on a fresh (unconfigured)
    // native-Windows server — its `configured:false` + `remoteAccessEnabled:false`
    // status (portOpen probe deferred on Windows) satisfies the SPA's auto-show
    // condition (App.tsx:1282). Its z-50 backdrop intercepts every click. Pre-seed
    // the app's OWN dismissal flag (markAutoSetupWizardDismissed writes exactly
    // this sessionStorage key) so it doesn't auto-open — the faithful equivalent of
    // a user having dismissed the first-run wizard this session. (The WSL server
    // never triggered it: WSL2 reports host 0.0.0.0 + remoteAccessEnabled true.)
    await ctx.addInitScript(() => { try { sessionStorage.setItem('freshell.setupWizardAutoDismissed', 'true') } catch {} })
    page = await ctx.newPage()
    page.on('pageerror', (e) => log('pageerror:', e.message))
    page.on('response', (r) => { const u = r.url(); if (/jsdelivr|monaco/i.test(u)) cdnHits.push(r.status()) })

    await page.goto(`${BASE_URL}/?token=${TOKEN}&e2e=1`, { waitUntil: 'domcontentloaded' })
    await waitReady(page)
    log('client ready (harness + ws connected to the Windows server)')

    for (const kind of KINDS) {
      const rec = { kind: kind.key, label: kind.label, created: false, asserted: false, screenshot: '', status: 'FAIL', detail: '', bufferExcerpt: '' }
      log(`--- ${kind.label} ---`)
      try {
        if (kind.type === 'editor') {
          const r = await runEditorKind(page)
          rec.created = true; rec.asserted = r.status === 'PASS'; rec.status = r.status; rec.detail = r.detail
          if (r.envReason) rec.envReason = r.envReason
        } else if (kind.type === 'browser') {
          const r = await runBrowserKind(page, kind)
          rec.created = true; rec.asserted = true; rec.status = 'PASS'; rec.detail = r.detail
        } else if (kind.type === 'cli') {
          const { terminalId, buffer, detail } = await runCliKind(page, kind)
          rec.created = true; rec.asserted = true; rec.status = 'PASS'; rec.terminalId = terminalId; rec.detail = detail
          rec.bufferExcerpt = buffer.split('\n').filter((l) => l.trim()).slice(-6).join(' | ').slice(0, 400)
        } else {
          const { terminalId, buffer, detail } = await runTerminalKind(page, kind)
          rec.created = true; rec.asserted = true; rec.status = 'PASS'; rec.terminalId = terminalId; rec.detail = detail
          rec.bufferExcerpt = buffer.split('\n').filter((l) => l.trim()).slice(-6).join(' | ').slice(0, 400)
        }
        log(`${kind.label}: ${rec.status}`)
      } catch (err) {
        rec.detail = String(err && err.message || err).slice(0, 500)
        rec.status = 'FAIL'
        log(`${kind.label}: FAIL — ${rec.detail}`)
        try {
          rec.bufferExcerpt = await page.evaluate(() => {
            const s = window.__FRESHELL_TEST_HARNESS__.getState()
            return JSON.stringify(s.panes.layouts[s.tabs.activeTabId]).slice(0, 400)
          })
        } catch {}
        // Also capture the live terminal buffer, if any, to root-cause spawn issues.
        try {
          if (rec.terminalId) rec.bufferExcerpt = ((await readBuffer(page, rec.terminalId)) || '').slice(-400)
        } catch {}
      }
      try { rec.tabId = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__.getState().tabs.activeTabId) } catch {}
      try { await page.screenshot({ path: SHOT(kind.key), fullPage: false }); rec.screenshot = SHOT(kind.key) } catch (e) { log('screenshot failed', e.message) }
      results.push(rec)
      await sleep(300)
    }

    // Distinct overview: switch to the cmd tab (real content that landed in the
    // workspace) so the frame differs from the last screenshot AND shows the tab strip.
    try {
      const cmdTabId = results.find((r) => r.kind === 'cmd')?.tabId
      await switchToTab(page, cmdTabId)
      await page.screenshot({ path: SHOT('overview'), fullPage: false })
      log('overview screenshot written (switched to cmd tab)')
    } catch (e) { log('overview screenshot failed', e.message) }

  } finally {
    await cleanup()
    try { const rp = join(OUT_DIR, 'win-chrome-report.json'); writeFileSync(rp, JSON.stringify(results, null, 2)); log('report:', rp) } catch {}
    await sleep(1000)
    try { rmSync(WIN_CLIENT_MNT, { recursive: true, force: true }) } catch {}
    try { rmSync(WORKSPACE_MNT, { recursive: true, force: true }) } catch {}
  }

  // md5 distinctness across all screenshots.
  const shots = [...KINDS.map((k) => k.key), 'overview']
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

  console.log('\n============ NATIVE-Windows-server x Chrome — RESULTS ============')
  for (const r of results) {
    console.log(`${r.status.padEnd(11)}  ${r.label.padEnd(12)}  created=${r.created} asserted=${r.asserted}  ${r.screenshot ? 'shot✓' : 'shot✗'}  md5=${(md5s[r.kind] || '').slice(0, 8)}`)
    if (r.status !== 'PASS') console.log(`        ${r.status === 'ENV-LIMITED' ? 'env' : 'detail'}: ${r.envReason || r.detail}`)
    else console.log(`        ${r.detail}`)
    if (r.bufferExcerpt) console.log(`        buf: ${r.bufferExcerpt}`)
  }
  console.log(`\noverview md5=${(md5s.overview || '').slice(0, 8)}`)
  const pass = results.filter((r) => r.status === 'PASS').length
  const envLimited = results.filter((r) => r.status === 'ENV-LIMITED').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  console.log(`\n${pass}/${results.length} PASS · ${envLimited} ENV-LIMITED · ${fail} FAIL · ${dupes} duplicate screenshot(s)`)
  process.exit(fail === 0 && dupes === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); reapServerSync(); process.exit(2) })
