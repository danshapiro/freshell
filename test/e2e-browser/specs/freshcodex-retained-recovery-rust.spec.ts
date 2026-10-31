/** Hosted loss is injected at the browser's transport boundary; native server
 * ownership/history remain real. Task006 Rust tests saturate the actual host
 * bridge. This slice proves immediate retained rendering while HTTP is held. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, createFreshE2ePage } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const source = fileURLToPath(new URL('../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs', import.meta.url))

test('Freshcodex renders retained hosted output before native HTTP recovery and keeps composer focus', async ({ browser }) => {
  test.setTimeout(180_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshcodex-retained-'))
  const wrapper = path.join(root, 'codex.mjs')
  await fs.writeFile(wrapper, `#!/usr/bin/env node\nimport ${JSON.stringify(source)}\n`)
  await fs.chmod(wrapper, 0o755)
  const server = new RustServer({ env: { CODEX_CMD: wrapper, FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES:'1', FAKE_CODEX_APP_SERVER_BEHAVIOR:JSON.stringify({recordTurns:true}) }, setupHome:async(home) => {
    await fs.mkdir(path.join(home,'.freshell'),{recursive:true})
    await fs.writeFile(path.join(home,'.freshell/config.json'),JSON.stringify({version:1,settings:{freshAgent:{enabled:true},codingCli:{enabledProviders:['codex']}}}))
  } })
  let context: Awaited<ReturnType<typeof createFreshE2ePage>>['context'] | undefined
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {release=resolve})
  try {
    const info = await server.start()
    const owned = await createFreshE2ePage(browser,info)
    context=owned.context
    const page=owned.page
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness=new TestHarness(page)
    await harness.waitForHarness(); await harness.waitForConnection()
    await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.dispatch({type:'connection/setAvailableClis',payload:{claude:false,codex:true}}))
    const picker=await openPanePicker(page)
    await picker.getByRole('button',{name:/^Freshcodex$/i}).click({force:true})
    const directory=page.getByRole('combobox',{name:'Starting directory for Freshcodex'})
    await directory.fill(root); await directory.press('Enter')
    const pane=page
    const composer=pane.getByRole('textbox',{name:'Chat message input'})
    await expect(composer).toBeEnabled()
    const sessionId=await page.evaluate(() => {
      const layouts=window.__FRESHELL_TEST_HARNESS__!.getState().panes.layouts
      const leaf=Object.values(layouts).find((node) => node.type==='leaf' && node.content.kind==='fresh-agent')
      if (!leaf || leaf.type!=='leaf' || leaf.content.kind!=='fresh-agent' || !leaf.content.sessionId) throw new Error('Freshcodex not created')
      return leaf.content.sessionId
    })
    const owner = await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__!.getState().freshAgent.runtimeOwners[`codex:${id}`], sessionId)
    const response=await page.request.get(`${info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${sessionId}`,{headers:{'x-auth-token':info.token}})
    expect(response.ok()).toBe(true)
    const snapshot=await response.json()
    snapshot.turns=[{id:'recovered-turn',turnId:'recovered-turn',role:'assistant',summary:'',items:[{id:'recovered-answer',kind:'text',text:'Final hosted output recovered without another token'}]}]
    snapshot.extensions={codex:{projection:{id:'browser-source',historyGeneration:0,eventRevision:10,eventOwnedTurnIds:['recovered-turn'],nativePreviewTurnIds:[],nativeFinalTurnIds:[],turnRows:{'recovered-turn':['recovered-turn']},turnOutputStates:{'recovered-turn':{provenance:'retained',diagnostic:'unsaved',refreshPending:false}},settledTurnIds:['recovered-turn']}}}
    let refreshes=0
    await page.route('**/api/fresh-agent/threads/freshcodex/codex/**',async(route) => {refreshes++; await held; await route.fulfill({json:snapshot})})
    await composer.fill('Draft stays local')
    for (const type of ['freshAgent.host.backpressure','freshAgent.host.journal.reset']) {
      await harness.receiveWsMessage({type:'freshAgent.event',provider:'codex',sessionType:'freshcodex',sessionId,event:{type,retainedState:{source:{projectionId:'browser-source',ownerEpoch:owner?.epoch ?? 0,ownerGeneration:owner?.generation ?? 0,soulId:'browser-soul',incarnationId:'browser-incarnation',hostBootId:'browser-host'},snapshot,pendingControls:[],attentionMarks:[]}}})
    }
    await expect(pane.getByText('Final hosted output recovered without another token',{exact:true})).toBeVisible()
    await expect.poll(() => refreshes).toBeGreaterThan(0)
    await expect(composer).toHaveValue('Draft stays local')
    await expect(composer).toBeFocused()
    await expect(pane.getByRole('note',{name:'Output persistence'})).toHaveText('Retained output. Saved output could not be confirmed.')
  } finally {
    release?.()
    await context?.close().catch(() => {})
    await server.stop()
    await fs.rm(root,{recursive:true,force:true})
  }
})
