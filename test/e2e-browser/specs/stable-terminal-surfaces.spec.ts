import type { ElementHandle, Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import type { TestHarness } from '../helpers/test-harness.js'

// Client topology regression with real xterm and the configured isolated test
// backend. It is not a benchmark of provider startup or an actual CLI transcript.
// Run only against owned test instances, never a production/external target.
function pane(page: Page, id: string): Locator {
  return page.locator(`[data-pane-shell="true"][data-pane-id="${id}"]`)
}
async function sameSurface(original: ElementHandle, selector: string) {
  await expect.poll(() => original.evaluate((node, query) => node.isConnected && document.querySelector(query) === node, selector)).toBe(true)
}
async function requireMessageCapture(page: Page) {
  await page.evaluate(() => {
    const harness=window.__FRESHELL_TEST_HARNESS__
    if (!harness?.getSentWsMessages || !harness.clearSentWsMessages) throw new Error('Outbound message recording is required for this regression')
  })
}
async function noReattach(harness: TestHarness, terminalId: string, requestId: string) {
  const messages=await harness.getSentWsMessages() as Array<{type?: string;terminalId?: string;requestId?: string}>
  expect(messages.filter(message =>
    (['terminal.attach','terminal.detach','terminal.kill'].includes(message.type??'') && message.terminalId===terminalId)
    || (message.type==='terminal.create' && message.requestId===requestId),
  )).toEqual([])
}
async function splitPicker(page: Page, current: Locator) {
  await current.locator('.xterm').click({button:'right'})
  await page.getByRole('menuitem',{name:/split horizontally/i}).click()
  await expect(page.locator('[data-context="pane-picker"]').last()).toBeVisible()
}
async function chooseShell(page: Page) {
  const picker=page.locator('[data-context="pane-picker"]').last()
  const button=picker.getByRole('button',{name:/^(Shell|WSL|CMD|PowerShell|Bash)$/i}).first()
  await expect(button).toBeVisible();await button.click()
}

test.describe('Stable terminal surfaces',()=>{
  test('split and sibling close preserve the original xterm DOM, output, and attachment',async({freshellPage,page,harness,terminal})=>{
    void freshellPage
    await terminal.waitForTerminal();await terminal.waitForPrompt();await requireMessageCapture(page)
    const tabId=await harness.getActiveTabId();expect(tabId).toBeTruthy()
    const layout=await harness.getPaneLayout(tabId!)
    expect(layout.type).toBe('leaf')
    const paneId=layout.id as string, terminalId=layout.content.terminalId as string, requestId=layout.content.createRequestId as string
    expect(terminalId).toBeTruthy()
    const selector=`[data-pane-shell="true"][data-pane-id="${paneId}"] .xterm`
    const original=await page.locator(selector).elementHandle();expect(original).not.toBeNull()
    await terminal.executeCommand('echo stable-surface-marker');await harness.waitForTerminalText('stable-surface-marker',{terminalId})
    await harness.clearSentWsMessages()
    await splitPicker(page,pane(page,paneId))
    await sameSurface(original!,selector)
    const pickerPane=page.locator('[data-pane-shell="true"]').filter({has:page.locator('[data-context="pane-picker"]')})
    await pickerPane.getByRole('button',{name:'Close pane',exact:true}).click()
    await expect.poll(async()=>(await harness.getPaneLayout(tabId!)).type).toBe('leaf')
    await sameSurface(original!,selector)
    await harness.waitForTerminalText('stable-surface-marker',{terminalId})
    await noReattach(harness,terminalId,requestId)
  })

  test('zoom and unzoom preserve both real xterms while excluding hidden input and dividers',async({freshellPage,page,harness,terminal})=>{
    void freshellPage
    await terminal.waitForTerminal();await terminal.waitForPrompt();await requireMessageCapture(page)
    const tabId=await harness.getActiveTabId();const initial=await harness.getPaneLayout(tabId!)
    await splitPicker(page,pane(page,initial.id));await chooseShell(page)
    await expect(page.locator('.xterm:visible')).toHaveCount(2)
    const layout=await harness.getPaneLayout(tabId!)
    const first=layout.children[0], second=layout.children[1]
    await expect.poll(async()=>(await harness.getPaneLayout(tabId!)).children[1].content.terminalId).toBeTruthy()
    // Re-read after the second create response has installed its terminal ID.
    const settled=await harness.getPaneLayout(tabId!)
    const secondId=settled.children[1].content.terminalId as string
    await expect.poll(()=>harness.getTerminalBuffer(secondId)).not.toBeNull()
    const firstSelector=`[data-pane-shell="true"][data-pane-id="${first.id}"] .xterm`
    const secondSelector=`[data-pane-shell="true"][data-pane-id="${second.id}"] .xterm`
    const firstElement=await page.locator(firstSelector).elementHandle()
    const secondElement=await page.locator(secondSelector).elementHandle()
    expect(firstElement).not.toBeNull();expect(secondElement).not.toBeNull()
    // Positive traffic proves the second pane is anchored before clearing
    // capture; merely registering an empty xterm buffer is not attach readiness.
    await page.locator(secondSelector).click()
    await page.keyboard.type('echo stable-second-marker')
    await page.keyboard.press('Enter')
    await harness.waitForTerminalText('stable-second-marker', { terminalId: secondId })
    await harness.clearSentWsMessages()
    for(let i=0;i<5;i++) {
      await pane(page,first.id).getByRole('button',{name:'Maximize pane',exact:true}).click()
      await expect(page.locator('.xterm:visible')).toHaveCount(1)
      await expect(page.locator('[data-context="pane-divider"]:visible')).toHaveCount(0)
      expect(await pane(page,second.id).evaluate(node=>(node.closest('[data-stable-pane-id]') as HTMLElement)?.inert)).toBe(true)
      await sameSurface(firstElement!,firstSelector);await sameSurface(secondElement!,secondSelector)
      await pane(page,first.id).getByRole('button',{name:'Restore pane',exact:true}).click()
      await expect(page.locator('.xterm:visible')).toHaveCount(2)
    }
    await noReattach(harness,first.content.terminalId,first.content.createRequestId)
    await noReattach(harness,secondId,second.content.createRequestId)
    await sameSurface(firstElement!,firstSelector);await sameSurface(secondElement!,secondSelector)
  })
})
