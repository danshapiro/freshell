#!/usr/bin/env node
// Focused native-Windows coding-CLI diagnostic: boot the Windows server, create
// mode=codex / mode=gemini panes (direct dispatch, no click), dump their raw
// terminal buffers over ~45s + /api/terminals. Root-causes why the CLI UI does
// not paint. SAFETY: scratch port 3043, reaped by netstat/Stop-Process.
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const WORKTREE = resolve(new URL('../../..', import.meta.url).pathname)
const PORT = Number(process.env.MATRIX_PORT || 3043)
const TOKEN = 'winmatrix'
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim()
const SERVER_EXE = join(WORKTREE, 'target/x86_64-pc-windows-gnu/release/freshell-server.exe')
const EXE_WIN = sh(`wslpath -w '${SERVER_EXE}'`)
const CLIENT_DIR = join(WORKTREE, 'dist/client')
const WIN_HOST = sh(`ip route show default | awk '{print $3}'`).split('\n')[0]
const BASE = `http://${WIN_HOST}:${PORT}`
const WIN_TEMP = sh(`cmd.exe /d /c "echo %LOCALAPPDATA%\\Temp"`)
const WIN_TEMP_MNT = sh(`wslpath -u '${WIN_TEMP}'`)
const WIN_CLIENT_DIR = `${WIN_TEMP}\\freshell-diagcli-client`
const WIN_CLIENT_MNT = join(WIN_TEMP_MNT, 'freshell-diagcli-client')
const WS_NAME = `freshell-diagcli-ws`
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
  await ctx.addInitScript(() => { try { sessionStorage.setItem('freshell.setupWizardAutoDismissed', 'true') } catch {} })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(`${BASE}/?token=${TOKEN}&e2e=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => { const h = window.__FRESHELL_TEST_HARNESS__; return h && h.getWsReadyState() === 'ready' && h.getState()?.connection?.status === 'ready' }, { timeout: 20000 })
  console.log('=== client ready ===')

  const panes = []
  for (const mode of ['codex', 'gemini']) {
    console.log(`\n############ create mode=${mode} ############`)
    const { tabId, paneId } = await newPane(page)
    await page.evaluate(({ tabId, paneId, mode, cwd }) => window.__FRESHELL_TEST_HARNESS__.dispatch({
      type: 'panes/updatePaneContent',
      payload: { tabId, paneId, content: { kind: 'terminal', mode, shell: 'system', createRequestId: `diag-${mode}-` + Math.random(), status: 'creating', initialCwd: cwd } },
    }), { tabId, paneId, mode, cwd: WORKSPACE_WIN })
    const terminalId = await page.waitForFunction(({ tabId, paneId }) => {
      const st = window.__FRESHELL_TEST_HARNESS__.getState(); let found = null
      const walk = (n) => { if (!n || found) return; if (n.type === 'leaf' && n.id === paneId) found = n.content; else if (n.type === 'split') n.children.forEach(walk) }
      walk(st.panes.layouts[tabId]); return found && found.kind === 'terminal' && found.terminalId ? found.terminalId : null
    }, { tabId, paneId }, { timeout: 20000 }).then((h) => h.jsonValue())
    console.log(`${mode}: terminalId=${terminalId} tabId=${tabId}`)
    panes.push({ mode, terminalId, tabId })
  }

  // Sample both buffers over ~45s.
  let elapsed = 0
  for (const step of [3000, 5000, 7000, 10000, 20000]) {
    await sleep(step); elapsed += step
    for (const p of panes) {
      const buf = await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id), p.terminalId)
      console.log(`\n=== ${p.mode} buffer @${elapsed}ms (len ${buf ? buf.length : 0}) ===\n` + JSON.stringify((buf || '').slice(-1200)))
    }
  }

  const dir = await page.evaluate(async (token) => { const r = await fetch('/api/terminals', { headers: { 'x-auth-token': token } }); return r.ok ? await r.json() : `HTTP ${r.status}` }, TOKEN)
  console.log('\n=== /api/terminals ===\n' + JSON.stringify(dir, null, 1))

  for (const p of panes) {
    try { await page.locator(`[data-tab-id="${p.tabId}"]`).first().click(); await sleep(500) } catch {}
    await page.screenshot({ path: join(WORKTREE, `port/oracle/matrix/diag-cli-${p.mode}.png`) })
  }

  for (const p of panes) await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.sendWsMessage({ type: 'terminal.kill', terminalId: id }), p.terminalId)
  await sleep(800)
  await browser.close()
  reap()
  await sleep(500)
  try { rmSync(WIN_CLIENT_MNT, { recursive: true, force: true }) } catch {}
  try { rmSync(WORKSPACE_MNT, { recursive: true, force: true }) } catch {}
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); reap(); process.exit(1) })
