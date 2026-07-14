#!/usr/bin/env node
// s7.F interchange + multi-client probe (task-007, restart #14).
// Servers booted EXTERNALLY (same AUTH_TOKEN for all three):
//   17871 original node   HOME=~/.freshell-qa-007f-orig
//   17872 rust WSL        HOME=~/.freshell-qa-007f-rust
//   17873 rust native-win FRESHELL_HOME=...freshell-qa-b1\home  (reach via $WINIP)
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const TOK = readFileSync('/home/dan/freshell-scratch-007f/tok.txt', 'utf8').trim()
const WINIP = process.env.WINIP
if (!WINIP) throw new Error('source env.sh first (WINIP)')
const ORIG = `http://127.0.0.1:17871`
const RUST = `http://127.0.0.1:17872`
const WIN = `http://${WINIP}:17873`
const OUT = '/home/dan/freshell-scratch-007f'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = () => Math.random().toString(36).slice(2, 10)
const results = { legs: {} }
let failures = 0
const record = (leg, ok, detail) => {
  results.legs[leg] = { ok, detail }
  console.log(ok ? 'PASS' : 'FAIL', leg, '-', detail)
  if (!ok) failures++
}

async function waitReady(page) {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 30000 })
  await page.waitForFunction(() => {
    const h = window.__FRESHELL_TEST_HARNESS__
    const st = h?.getState()
    return h && h.getWsReadyState() === 'ready' && st?.connection?.status === 'ready'
  }, { timeout: 30000 })
}
const tabCount = (page) => page.evaluate(() => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length)

async function openTerminalTab(page, marker) {
  const before = await tabCount(page)
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
  }, { timeout: 10000 }).then((h) => h.jsonValue())
  await page.evaluate(({ tabId, paneId, reqId }) => {
    window.__FRESHELL_TEST_HARNESS__.dispatch({
      type: 'panes/updatePaneContent',
      payload: { tabId, paneId, content: { kind: 'terminal', mode: 'shell', shell: 'system', createRequestId: reqId, status: 'creating' } },
    })
  }, { tabId: ids.tabId, paneId: ids.paneId, reqId: `intx-${rand()}` })
  const terminalId = await page.waitForFunction(({ tabId, paneId }) => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState()
    const layout = st.panes.layouts[tabId]
    let found = null
    const walk = (n) => { if (!n || found) return; if (n.type === 'leaf' && n.id === paneId) found = n.content; else if (n.type === 'split') n.children.forEach(walk) }
    walk(layout)
    return found && found.kind === 'terminal' && found.terminalId ? found.terminalId : null
  }, ids, { timeout: 20000 }).then((h) => h.jsonValue())
  await page.locator(`[data-pane-id="${ids.paneId}"] .xterm`).first().waitFor({ state: 'visible', timeout: 20000 })
  await page.locator(`[data-pane-id="${ids.paneId}"] .xterm`).first().click()
  await sleep(400)
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await waitBufferHas(page, terminalId, marker, 2)
  return { ...ids, terminalId }
}
const readBuffer = (page, id) => page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id), id)
async function waitBufferHas(page, id, marker, minCount = 1, timeout = 25000) {
  await page.waitForFunction(({ id, marker, minCount }) => {
    const buf = window.__FRESHELL_TEST_HARNESS__.getTerminalBuffer(id)
    if (!buf) return false
    let n = 0, i = 0
    for (;;) { const j = buf.indexOf(marker, i); if (j < 0) break; n++; i = j + marker.length }
    return n >= minCount
  }, { id, marker, minCount }, { timeout })
}
async function waitBufferStable(page, id, quietMs = 1500, timeoutMs = 15000) {
  const start = Date.now(); let last = ''; let lastChange = Date.now()
  while (Date.now() - start < timeoutMs) {
    const buf = (await readBuffer(page, id)) || ''
    if (buf !== last) { last = buf; lastChange = Date.now() } else if (Date.now() - lastChange >= quietMs) return last
    await sleep(200)
  }
  return last
}
const goto = (page, base) => page.goto(`${base}/?e2e=1&token=${TOK}`, { waitUntil: 'domcontentloaded' })

// -- LEG1 + LEG2: port-switch with same token --
async function portSwitchLeg(browser, name, baseA, baseB) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addInitScript(() => { try { sessionStorage.setItem('freshell.setupWizardAutoDismissed', 'true') } catch {} })
  const page = await ctx.newPage()
  const M_A = `IX-A-${rand()}`
  await goto(page, baseA); await waitReady(page)
  const a = await openTerminalTab(page, M_A)
  const tabsA1 = await tabCount(page)
  await page.screenshot({ path: `${OUT}/${name}-1-serverA.png` })

  await goto(page, baseB); await waitReady(page)
  const M_B = `IX-B-${rand()}`
  const b = await openTerminalTab(page, M_B)
  const tabsB1 = await tabCount(page)
  await page.screenshot({ path: `${OUT}/${name}-2-serverB.png` })

  await goto(page, baseA); await waitReady(page)
  const tabsA2 = await tabCount(page)
  await waitBufferHas(page, a.terminalId, M_A, 1)
  const bufA = await waitBufferStable(page, a.terminalId)
  await page.screenshot({ path: `${OUT}/${name}-3-backA.png` })

  await goto(page, baseB); await waitReady(page)
  const tabsB2 = await tabCount(page)
  await waitBufferHas(page, b.terminalId, M_B, 1)
  await page.screenshot({ path: `${OUT}/${name}-4-backB.png` })

  const ok = tabsA2 === tabsA1 && tabsB2 === tabsB1 && bufA.includes(M_A)
  record(name, ok, `A tabs ${tabsA1}->${tabsA2}, B tabs ${tabsB1}->${tabsB2}, marker replay A=${bufA.includes(M_A)}; URL-only change, same token`)
  await ctx.close()
}

// -- LEG3: cross-client on one server --
// Tabs are CLIENT-LOCAL (localStorage per-origin; verified: fresh context on the
// original shows only "Tab 1"/picker while the server holds running terminals).
// So: (a) record whether A's new tab appears in B live, (b) whether it appears
// after B reloads (expected NO on the original - behavior to match, not fix),
// (c) attach B to the SAME terminalId explicitly (the restore path), verify
// scrollback replay, live mirroring of new output, and byte-identical buffers.
async function crossClientLeg(browser, name, base) {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  for (const c of [ctxA, ctxB]) await c.addInitScript(() => { try { sessionStorage.setItem('freshell.setupWizardAutoDismissed', 'true') } catch {} })
  const A = await ctxA.newPage(); const B = await ctxB.newPage()
  await goto(A, base); await waitReady(A)
  await goto(B, base); await waitReady(B)
  const tabsB0 = await tabCount(B)

  const M1 = `XC-1-${rand()}`
  const t = await openTerminalTab(A, M1)

  // (a) live-appear in B without reload? poll 6s
  let liveAppear = false
  for (let i = 0; i < 30; i++) {
    if ((await tabCount(B)) > tabsB0) { liveAppear = true; break }
    await sleep(200)
  }

  // (b) appear after B reload?
  await B.reload({ waitUntil: 'domcontentloaded' }); await waitReady(B)
  const appearAfterReload = (await tabCount(B)) > tabsB0

  // (c) attach B to the same terminal explicitly (client restore path):
  //     new tab -> pane content with the existing terminalId.
  const beforeB = await tabCount(B)
  await B.locator('[data-context="tab-add"]').click()
  await B.waitForFunction((n) => window.__FRESHELL_TEST_HARNESS__.getState().tabs.tabs.length > n, beforeB, { timeout: 10000 })
  const bIds = await B.waitForFunction(() => {
    const st = window.__FRESHELL_TEST_HARNESS__.getState()
    const tabId = st.tabs.activeTabId
    const layout = st.panes.layouts[tabId]
    const leaves = []
    const walk = (n) => { if (!n) return; if (n.type === 'leaf') leaves.push(n.id); else if (n.type === 'split') n.children.forEach(walk) }
    walk(layout)
    return leaves.length === 1 ? { tabId, paneId: leaves[0] } : null
  }, { timeout: 10000 }).then((h) => h.jsonValue())
  await B.evaluate(({ tabId, paneId, terminalId }) => {
    window.__FRESHELL_TEST_HARNESS__.dispatch({
      type: 'panes/updatePaneContent',
      payload: { tabId, paneId, content: { kind: 'terminal', mode: 'shell', shell: 'system', terminalId, status: 'running' } },
    })
  }, { tabId: bIds.tabId, paneId: bIds.paneId, terminalId: t.terminalId })
  await B.locator(`[data-pane-id="${bIds.paneId}"] .xterm`).first().waitFor({ state: 'visible', timeout: 20000 })
  await waitBufferHas(B, t.terminalId, M1, 1)   // scrollback replayed to second client

  // (d) live mirroring: type in A while B attached
  const M2 = `XC-2-${rand()}`
  await A.locator(`[data-pane-id="${t.paneId}"] .xterm`).first().click()
  await A.keyboard.type(`echo ${M2}`)
  await A.keyboard.press('Enter')
  await waitBufferHas(A, t.terminalId, M2, 2)
  let liveMirror = true
  try { await waitBufferHas(B, t.terminalId, M2, 2, 15000) } catch { liveMirror = false }

  const bufA = await waitBufferStable(A, t.terminalId)
  const bufB = await waitBufferStable(B, t.terminalId)
  const bytesEqual = bufA === bufB
  await A.screenshot({ path: `${OUT}/${name}-clientA.png` })
  await B.screenshot({ path: `${OUT}/${name}-clientB.png` })
  await ctxA.close(); await ctxB.close()
  return { liveAppear, appearAfterReload, attachReplay: true, liveMirror, bytesEqual, bufLenA: bufA.length, bufLenB: bufB.length }
}

const browser = await chromium.launch({ headless: true })
try {
  await portSwitchLeg(browser, 'leg1-rustwsl-rustwin', RUST, WIN)
  await portSwitchLeg(browser, 'leg2-orig-rust', ORIG, RUST)
  const orig = await crossClientLeg(browser, 'leg3-orig-17871', ORIG)
  console.log('LEG3 original observed:', JSON.stringify(orig))
  const rust = await crossClientLeg(browser, 'leg3-rust-17872', RUST)
  console.log('LEG3 rust observed:    ', JSON.stringify(rust))
  const behaviorEqual = orig.liveAppear === rust.liveAppear && orig.appearAfterReload === rust.appearAfterReload && orig.liveMirror === rust.liveMirror
  record('leg3-differential', behaviorEqual && orig.bytesEqual && rust.bytesEqual,
    `liveAppear orig=${orig.liveAppear} rust=${rust.liveAppear}; appearAfterReload orig=${orig.appearAfterReload} rust=${rust.appearAfterReload}; ` +
    `liveMirror orig=${orig.liveMirror} rust=${rust.liveMirror}; A==B bytes orig=${orig.bytesEqual}(${orig.bufLenA}) rust=${rust.bytesEqual}(${rust.bufLenA})`)
  results.leg3 = { orig, rust }
} finally {
  await browser.close()
}
writeFileSync(`${OUT}/interchange-results.json`, JSON.stringify(results, null, 1))
console.log('FAILURES:', failures)
process.exit(failures ? 1 : 0)
