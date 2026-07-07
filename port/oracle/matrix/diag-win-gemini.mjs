#!/usr/bin/env node
// Focused native-Windows GEMINI diagnostic. Two panes:
//   A) mode=gemini spawn path (cmd.exe /K cd .. && gemini)
//   B) shell=cmd pane where we TYPE `gemini` (same ConPTY, user-equivalent)
// Samples both buffers up to ~150s, sends Enter at 60s, dumps xterm DOM text +
// /api/terminals + node.exe tasklist. SAFETY: scratch port 3044, netstat reap.
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const WORKTREE = resolve(new URL('../../..', import.meta.url).pathname)
const PORT = Number(process.env.MATRIX_PORT || 3044)
const TOKEN = 'winmatrix'
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim()
const SERVER_EXE = join(WORKTREE, 'target/x86_64-pc-windows-gnu/release/freshell-server.exe')
const EXE_WIN = sh(`wslpath -w '${SERVER_EXE}'`)
const CLIENT_DIR = join(WORKTREE, 'dist/client')
const WIN_HOST = sh(`ip route show default | awk '{print $3}'`).split('\n')[0]
const BASE = `http://${WIN_HOST}:${PORT}`
const WIN_TEMP = sh(`cmd.exe /d /c "echo %LOCALAPPDATA%\\Temp"`)
const WIN_TEMP_MNT = sh(`wslpath -u '${WIN_TEMP}'`)
const WIN_CLIENT_DIR = `${WIN_TEMP}\\freshell-diaggem-client`
const WIN_CLIENT_MNT = join(WIN_TEMP_MNT, 'freshell-diaggem-client')
const WS_NAME = `freshell-diaggem-ws`
const WORKSPACE_WIN = `C:\\Users\\Public\\${WS_NAME}`
const WORKSPACE_MNT = sh(`wslpath -u 'C:\\Users\\Public'`) + '/' + WS_NAME
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let child = null
function netstatPids(port) {
  try {
    const out = execSync('netstat.exe -ano', { encoding: 'utf8' })
    const pids = new Set()
    for (const line of out.split('\n')) if (line.includes(`:${port} `) && /LISTENING/i.test(line)) {
      const c = line.trim().split(/\s+/); const pid = (c[c.length - 1] || '').replace(/\r/g, ''); if (/^\d+$/.test(pid)) pids.add(pid)
    }
    return [...pids]
  } catch { return [] }
}
function reap() {
  for (const p of netstatPids(PORT)) { try { execSync(`powershell.exe -NoProfile -Command "Stop-Process -Id ${p} -Force -ErrorAction SilentlyContinue"`, { stdio: 'ignore' }) } catch {} }
  if (child) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
}
process.on('exit', reap)

const nodeCount = () => {
  try { return (execSync('tasklist.exe /FI "IMAGENAME eq node.exe" /FO CSV', { encoding: 'utf8' }).match(/node\.exe/g) || []).length } catch { return -1 }
}

async function newPane(page) {
  const before = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length)
  await page.locator('[data-context="tab-add"]').click()
  await page.waitForFunction((n) => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length > n, before, { timeout: 8000 })
  return await page.waitForFunction(() => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState(); const tabId = st.tabs.activeTabId
    const leaves = []; const walk = (n) => { if (!n) return; if (n.type === 'leaf') leaves.push(n.id); else if (n.type === 'split') n.children.forEach(walk) }
    walk(st.panes.layouts[tabId]); return leaves.length === 1 ? { tabId, paneId: leaves[0] } : null
  }, {}, { timeout: 8000 }).then((h) => h.jsonValue())
}

async function createTerm(page, { tabId, paneId }, content) {
  await page.evaluate(({ tabId, paneId, content }) => window.__FRESHELL_TEST_HARNESS__.dispatch({
    type: 'panes/updatePaneContent', payload: { tabId, paneId, content },
  }), { tabId, paneId, content })
  return await page.waitForFunction(({ tabId, paneId }) => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState(); let found = null
    const walk = (n) => { if (!n || found) return; if (n.type === 'leaf' && n.id === paneId) found = n.content; else if (n.type === 'split') n.children.forEach(walk) }
    walk(st.panes.layouts[tabId]); return found && found.kind === 'terminal' && found.terminalId ? found.terminalId : null
  }, { tabId, paneId }, { timeout: 20000 }).then((h) => h.jsonValue())
}

async function main() {
  mkdirSync(WORKSPACE_MNT, { recursive: true })
  writeFileSync(join(WORKSPACE_MNT, 'MARK.txt'), 'x')
  rmSync(WIN_CLIENT_MNT, { recursive: true, force: true })
  execSync(`cp -r '${CLIENT_DIR}' '${WIN_CLIENT_MNT}'`)
  for (const p of netstatPids(PORT)) try { execSync(`powershell.exe -NoProfile -Command "Stop-Process -Id ${p} -Force"`, { stdio: 'ignore' }) } catch {}
  const launch = `cd /d ${WIN_TEMP} && set PORT=${PORT}&& set AUTH_TOKEN=${TOKEN}&& set FRESHELL_BIND_HOST=0.0.0.0&& set FRESHELL_CLIENT_DIR=${WIN_CLIENT_DIR}&& ${EXE_WIN}`
  child = spawn('cmd.exe', ['/d', '/c', launch], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`${BASE}/api/health`, { headers: { 'x-auth-token': TOKEN } }); if (r.ok) break } catch {} await sleep(200) }
  console.log('=== health up === node.exe count:', nodeCount())

  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] })
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  await ctx.addInitScript(() => { try { sessionStorage.setItem('freshell.setupWizardAutoDismissed', 'true') } catch {} })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(`${BASE}/?token=${TOKEN}&e2e=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => { const h = window.__FRESHELL_TEST_HARNESS__; return h && h.getWsReadyState() === 'ready' && h.getState()?.connection?.status === 'ready' }, { timeout: 20000 })
  console.log('=== client ready ===')

  // A) spawned mode=gemini
  const paneA = await newPane(page)
  const termA = await createTerm(page, paneA, { kind: 'terminal', mode: 'gemini', shell: 'system', createRequestId: 'diag-gemA-' + Math.random(), status: 'creating', initialCwd: WORKSPACE_WIN })
  console.log('A spawned mode=gemini terminalId=', termA)

  // B) cmd pane, type gemini
  const paneB = await newPane(page)
  const termB = await createTerm(page, paneB, { kind: 'terminal', mode: 'shell', shell: 'cmd', createRequestId: 'diag-gemB-' + Math.random(), status: 'creating', initialCwd: WORKSPACE_WIN })
  console.log('B cmd pane terminalId=', termB)
  await page.locator(`[data-pane-id="${paneB.paneId}"] .xterm`).first().waitFor({ state: 'visible', timeout: 15000 })
  await sleep(1500)
  await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.sendWsMessage({ type: 'terminal.input', terminalId: id, data: 'gemini\r' }), termB)
  console.log('B typed `gemini`', '· node.exe count:', nodeCount())

  let elapsed = 0
  let pressedEnter = false
  for (const step of [10000, 10000, 10000, 10000, 10000, 10000, 15000, 15000, 15000, 15000]) {
    await sleep(step); elapsed += step
    const bufA = await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id), termA)
    const bufB = await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id), termB)
    const strip = (b) => (b || '').replace(/\n+/g, '\\n').slice(-500)
    console.log(`\n@${elapsed / 1000}s node.exe=${nodeCount()}  A(len ${(bufA || '').length}): ${JSON.stringify(strip(bufA))}`)
    console.log(`@${elapsed / 1000}s  B(len ${(bufB || '').length}): ${JSON.stringify(strip(bufB))}`)
    if (!pressedEnter && elapsed >= 60000) {
      pressedEnter = true
      await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.sendWsMessage({ type: 'terminal.input', terminalId: id, data: '\r' }), termA)
      console.log('>>> sent Enter to A')
    }
    if ((bufA || '').replace(/\s/g, '').length > 50 && (bufB || '').replace(/\s/g, '').length > 50) break
  }

  const dir = await page.evaluate(async (token) => { const r = await fetch('/api/terminals', { headers: { 'x-auth-token': token } }); return r.ok ? await r.json() : `HTTP ${r.status}` }, TOKEN)
  console.log('\n=== /api/terminals ===\n' + JSON.stringify(dir))

  // xterm DOM text of pane A (cross-check the harness buffer read).
  const domA = await page.evaluate((sel) => {
    const rows = document.querySelectorAll(`${sel} .xterm-rows > div`)
    return [...rows].map((r) => r.textContent).filter((t) => t && t.trim()).slice(0, 20)
  }, `[data-pane-id="${paneA.paneId}"]`)
  console.log('\n=== pane A DOM rows (non-empty) ===\n' + JSON.stringify(domA))

  for (const [pane, term] of [[paneA, termA], [paneB, termB]]) {
    try { await page.locator(`[data-tab-id="${pane.tabId}"]`).first().click(); await sleep(400) } catch {}
    await page.screenshot({ path: join(WORKTREE, `port/oracle/matrix/diag-gem-${term === termA ? 'A-spawned' : 'B-typed'}.png`) })
  }
  for (const t of [termA, termB]) await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.sendWsMessage({ type: 'terminal.kill', terminalId: id }), t)
  await sleep(800)
  await browser.close()
  reap()
  await sleep(500)
  try { rmSync(WIN_CLIENT_MNT, { recursive: true, force: true }) } catch {}
  try { rmSync(WORKSPACE_MNT, { recursive: true, force: true }) } catch {}
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); reap(); process.exit(1) })
