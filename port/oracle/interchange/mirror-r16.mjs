import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
const TOK = readFileSync('/home/dan/freshell-scratch-007/tok.txt','utf8').trim()
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await ctx.addInitScript(() => { try { sessionStorage.setItem('freshell.setupWizardAutoDismissed','true') } catch {} })
const page = await ctx.newPage()
await page.goto(`http://127.0.0.1:17872/?e2e=1&token=${TOK}`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready', { timeout: 30000 })
const before = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length)
await page.locator('[data-context="tab-add"]').click()
await page.waitForFunction((n) => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length > n, before, { timeout: 10000 })
const ids = await page.waitForFunction(() => {
  const st = window.__FRESHELL_TEST_HARNESS__.getState()
  const tabId = st.tabs.activeTabId
  const layout = st.panes.layouts[tabId]
  const leaves = []
  const walk = (n) => { if (!n) return; if (n.type === 'leaf') leaves.push(n.id); else if (n.type === 'split') n.children.forEach(walk) }
  walk(layout)
  return leaves.length === 1 ? { tabId, paneId: leaves[0] } : null
}, { timeout: 10000 }).then(h => h.jsonValue())
await page.evaluate(({ tabId, paneId }) => {
  window.__FRESHELL_TEST_HARNESS__.dispatch({ type: 'panes/updatePaneContent',
    payload: { tabId, paneId, content: { kind: 'terminal', mode: 'shell', shell: 'system', createRequestId: 'mirror-'+Math.random().toString(36).slice(2), status: 'creating' } } })
}, ids)
const termId = await page.waitForFunction(({ tabId, paneId }) => {
  const st = window.__FRESHELL_TEST_HARNESS__.getState()
  const layout = st.panes.layouts[tabId]
  let found = null
  const walk = (n) => { if (!n || found) return; if (n.type === 'leaf' && n.id === paneId) found = n.content; else if (n.type === 'split') n.children.forEach(walk) }
  walk(layout)
  return found && found.kind === 'terminal' && found.terminalId ? found.terminalId : null
}, ids, { timeout: 20000 }).then(h => h.jsonValue())
await page.locator(`[data-pane-id="${ids.paneId}"] .xterm`).first().click()
await page.keyboard.type('echo TAURI-MIRROR-MARKER')
await page.keyboard.press('Enter')
await page.waitForTimeout(2000)
console.log('created tab', ids.tabId, 'terminal', termId)
await page.screenshot({ path: '/home/dan/freshell-scratch-007f/tauri-r16-2-chromium-mirror.png' })
await page.waitForTimeout(6000)  // give Tauri time to (not) pick it up
await browser.close()
