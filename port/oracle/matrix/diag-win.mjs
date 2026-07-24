#!/usr/bin/env node
// Focused native-Windows ConPTY diagnostic: boot the Windows server, create a
// cmd terminal (NO click), read the terminal buffer + pane DOM, send input via
// the harness WS, re-read. Tells us if ConPTY output streams and what overlay
// (if any) intercepts a click.
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const WORKTREE = resolve(new URL('../../..', import.meta.url).pathname)
const PORT = Number(process.env.MATRIX_PORT || 3042)
const TOKEN = 'winmatrix'
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim()
const SERVER_EXE = join(WORKTREE, 'target/x86_64-pc-windows-gnu/release/freshell-server.exe')
const EXE_WIN = sh(`wslpath -w '${SERVER_EXE}'`)
const CLIENT_DIR = join(WORKTREE, 'dist/client')
const WIN_HOST = sh(`ip route show default | awk '{print $3}'`).split('\n')[0]
const BASE = `http://${WIN_HOST}:${PORT}`
const WIN_TEMP = sh(`cmd.exe /d /c "echo %LOCALAPPDATA%\\Temp"`)
const WIN_TEMP_MNT = sh(`wslpath -u '${WIN_TEMP}'`)
const WIN_CLIENT_DIR = `${WIN_TEMP}\\freshell-diagwin-client`
const WIN_CLIENT_MNT = join(WIN_TEMP_MNT, 'freshell-diagwin-client')
const WS_NAME = `freshell-diagwin-ws`
const WORKSPACE_WIN = `C:\\Users\\Public\\${WS_NAME}`
const WORKSPACE_MNT = sh(`wslpath -u 'C:\\Users\\Public'`) + '/' + WS_NAME
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = () => Math.random().toString(36).slice(2, 8)

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

async function main() {
  mkdirSync(WORKSPACE_MNT, { recursive: true })
  writeFileSync(join(WORKSPACE_MNT, 'MARK.txt'), 'x')
  rmSync(WIN_CLIENT_MNT, { recursive: true, force: true })
  execSync(`cp -r '${CLIENT_DIR}' '${WIN_CLIENT_MNT}'`)
  for (const p of netstatPids(PORT)) try { execSync(`powershell.exe -NoProfile -Command "Stop-Process -Id ${p} -Force"`, { stdio: 'ignore' }) } catch {}
  const launch = `cd /d ${WIN_TEMP} && set PORT=${PORT}&& set AUTH_TOKEN=${TOKEN}&& set FRESHELL_BIND_HOST=0.0.0.0&& set FRESHELL_CLIENT_DIR=${WIN_CLIENT_DIR}&& ${EXE_WIN}`
  child = spawn('cmd.exe', ['/d', '/c', launch], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`))
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`${BASE}/api/health`, { headers: { 'x-auth-token': TOKEN } }); if (r.ok) break } catch {} await sleep(200) }
  console.log('=== health up ===')

  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] })
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  // First-run Network setup wizard auto-opens on a fresh (unconfigured) Windows
  // server and its z-50 overlay blocks all clicks. Pre-seed the app's OWN
  // dismissal flag (markAutoSetupWizardDismissed) so it doesn't auto-open — the
  // faithful equivalent of a user having dismissed it this session.
  await ctx.addInitScript(() => { try { sessionStorage.setItem('freshell.setupWizardAutoDismissed', 'true') } catch {} })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log(`[console.${m.type()}]`, m.text().slice(0, 200)) })
  await page.goto(`${BASE}/?token=${TOKEN}&e2e=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => { const h = window.__FRESHELL_TEST_HARNESS__; return h && h.getWsReadyState() === 'ready' && h.getState()?.connection?.status === 'ready' }, { timeout: 20000 })
  console.log('=== client ready ===')

  // Create a cmd terminal via direct dispatch (no click).
  const before = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length)
  await page.locator('[data-context="tab-add"]').click()
  await page.waitForFunction((n) => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length > n, before, { timeout: 8000 })
  const { tabId, paneId } = await page.waitForFunction(() => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState(); const tabId = st.tabs.activeTabId
    const leaves = []; const walk = (n) => { if (!n) return; if (n.type === 'leaf') leaves.push(n.id); else if (n.type === 'split') n.children.forEach(walk) }
    walk(st.panes.layouts[tabId]); return leaves.length === 1 ? { tabId, paneId: leaves[0] } : null
  }, {}, { timeout: 8000 }).then((h) => h.jsonValue())
  await page.evaluate(({ tabId, paneId }) => window.__FRESHELL_TEST_HARNESS__.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId, content: { kind: 'terminal', mode: 'shell', shell: 'cmd', createRequestId: 'diag-' + Math.random(), status: 'creating', initialCwd: 'C:\\Users\\Public\\freshell-diagwin-ws' } } }), { tabId, paneId })

  const terminalId = await page.waitForFunction(({ tabId, paneId }) => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState(); let found = null
    const walk = (n) => { if (!n || found) return; if (n.type === 'leaf' && n.id === paneId) found = n.content; else if (n.type === 'split') n.children.forEach(walk) }
    walk(st.panes.layouts[tabId]); return found && found.kind === 'terminal' && found.terminalId ? found.terminalId : null
  }, { tabId, paneId }, { timeout: 20000 }).then((h) => h.jsonValue())
  console.log('=== terminalId', terminalId, '===')

  // Read buffer at intervals WITHOUT clicking.
  for (const t of [1500, 3000, 5000]) {
    await sleep(t === 1500 ? 1500 : 1500)
    const buf = await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id), terminalId)
    console.log(`\n=== buffer @~${t}ms (len ${buf ? buf.length : 0}) ===\n` + JSON.stringify(buf))
  }

  // Pane DOM (find the intercepting overlay).
  const dom = await page.evaluate((sel) => {
    const el = document.querySelector(sel); if (!el) return '(no pane el)'
    return el.outerHTML.replace(/\s+/g, ' ').slice(0, 1200)
  }, `[data-pane-id="${paneId}"]`)
  console.log('\n=== pane DOM ===\n' + dom)

  // Send input via WS (no click needed) and re-read.
  await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.sendWsMessage({ type: 'terminal.input', terminalId: id, data: 'echo diaghi\r' }), terminalId)
  await sleep(2500)
  const buf2 = await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id), terminalId)
  console.log('\n=== buffer AFTER ws input "echo diaghi" (len ' + (buf2 ? buf2.length : 0) + ') ===\n' + JSON.stringify(buf2))

  // Terminal directory (server-side view).
  const dir = await page.evaluate(async (token) => { const r = await fetch('/api/terminals', { headers: { 'x-auth-token': token } }); return r.ok ? await r.json() : `HTTP ${r.status}` }, TOKEN)
  console.log('\n=== /api/terminals ===\n' + JSON.stringify(dir))

  await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.sendWsMessage({ type: 'terminal.kill', terminalId: id }), terminalId)
  await sleep(500)
  await browser.close()
  reap()
  await sleep(500)
  try { rmSync(WIN_CLIENT_MNT, { recursive: true, force: true }) } catch {}
  try { rmSync(WORKSPACE_MNT, { recursive: true, force: true }) } catch {}
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); reap(); process.exit(1) })
