#!/usr/bin/env node
// Focused diagnostic: boot server, create an Editor pane and a Claude CLI pane,
// dump console errors, failed requests, editor DOM + CLI terminal buffer.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const WORKTREE = resolve(new URL('../../..', import.meta.url).pathname)
const PORT = 3032, TOKEN = 'matrixtok', HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const home = mkdtempSync(join(tmpdir(), 'freshell-diag-'))

const srv = spawn(join(WORKTREE, 'target/release/freshell-server'), [], {
  cwd: WORKTREE, detached: true, stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, PORT: String(PORT), AUTH_TOKEN: TOKEN, FRESHELL_BIND_HOST: HOST,
    HOME: home, FRESHELL_HOME: home, FRESHELL_CLIENT_DIR: join(WORKTREE, 'dist/client') },
})
const reap = () => { try { process.kill(-srv.pid, 'SIGKILL') } catch {} }
process.on('exit', reap)

async function main() {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`${BASE}/api/health`, { headers: { 'x-auth-token': TOKEN } }); if (r.ok) break } catch {} await sleep(200) }
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] })
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage()
  const failed = []
  const isCdn = (u) => /jsdelivr|unpkg|cdnjs|monaco|\/vs\//i.test(u)
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log(`[console.${m.type()}]`, m.text().slice(0, 300)) })
  page.on('request', (r) => { if (isCdn(r.url())) console.log('[cdn.request]', r.url().slice(0, 140)) })
  page.on('response', (r) => { if (isCdn(r.url())) console.log('[cdn.response]', r.status(), r.url().slice(0, 140)) })
  page.on('requestfailed', (r) => { failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`); if (isCdn(r.url())) console.log('[cdn.FAILED]', r.failure()?.errorText, r.url().slice(0, 140)) })
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`) })

  await page.goto(`${BASE}/?token=${TOKEN}&e2e=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => { const h = window.__FRESHELL_TEST_HARNESS__; return h && h.getWsReadyState() === 'ready' && h.getState()?.connection?.status === 'ready' }, { timeout: 20000 })
  console.log('=== ready ===')

  // ---- Editor ----
  const addTab = async () => {
    const n = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length)
    await page.locator('[data-context="tab-add"]').click()
    await page.waitForFunction((x) => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length > x, n, { timeout: 8000 })
    return page.getByRole('toolbar', { name: /pane type picker/i }).last()
  }
  let picker = await addTab()
  await picker.getByRole('button', { name: /^Editor$/i }).click()
  await sleep(8000)
  const monacoCount = await page.locator('.monaco-editor').count()
  const editorHtml = await page.evaluate(() => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState()
    const t = st.tabs.activeTabId
    const walk = (n) => n?.type === 'leaf' ? n.id : walk(n?.children?.[0])
    const pid = walk(st.panes.layouts[t])
    const el = document.querySelector(`[data-pane-id="${pid}"]`)
    return el ? el.innerHTML.replace(/\s+/g, ' ').slice(0, 500) : '(no pane el)'
  })
  console.log(`\n=== EDITOR: .monaco-editor count=${monacoCount} ===`)
  console.log('editor pane html:', editorHtml)

  // ---- OpenCode CLI ----
  picker = await addTab()
  await picker.getByRole('button', { name: /^OpenCode$/i }).click()
  const combo = page.locator('[role="combobox"]').filter({ visible: true }).last()
  await combo.waitFor({ state: 'visible', timeout: 8000 })
  await combo.fill(home); await sleep(150); await combo.press('Enter')
  await sleep(18000)
  const ocBuf = await page.evaluate(() => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState()
    const t = st.tabs.activeTabId
    const out = []
    const walk = (n) => { if (!n) return; if (n.type === 'leaf') { if (n.content?.kind === 'terminal') out.push(n.content) } else n.children?.forEach(walk) }
    walk(st.panes.layouts[t])
    const c = out.find((x) => x.mode === 'opencode')
    const buf = c?.terminalId ? window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(c.terminalId) : null
    return { mode: c?.mode, terminalId: c?.terminalId, status: c?.status, buf }
  })
  console.log(`\n=== OPENCODE: terminalId=${ocBuf.terminalId} status=${ocBuf.status} ===`)
  console.log('opencode buffer:\n' + JSON.stringify(ocBuf.buf))

  console.log('\n=== failed/4xx requests ===')
  for (const f of [...new Set(failed)]) console.log(' ', f)

  await browser.close()
  reap()
  await sleep(500)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); reap(); process.exit(1) })
