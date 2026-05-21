import type { Browser, Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'

const RETIRED_TAB_TITLE = 'Retire endpoint e2e tab'
const RETIRED_DEVICE_LABEL = 'closing-device-e2e'

async function newDevicePage(
  browser: Browser,
  input: {
    baseUrl: string
    token: string
    deviceId: string
    deviceLabel: string
  },
): Promise<Page> {
  const context = await browser.newContext()
  await context.addInitScript((device) => {
    localStorage.setItem('freshell.device-id.v2', device.deviceId)
    localStorage.setItem('freshell.device-label.v2', device.deviceLabel)
    localStorage.setItem('freshell.device-label-custom.v2', '1')
    localStorage.setItem('freshell.device-fingerprint.v2', `${navigator.platform}|${navigator.userAgent}`)
  }, {
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel,
  })
  const page = await context.newPage()
  await page.goto(`${input.baseUrl}/?token=${input.token}&e2e=1`)
  await waitForReady(page)
  return page
}

async function waitForReady(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 15_000 })
  await page.waitForFunction(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    return harness?.getWsReadyState() === 'ready'
      && harness.getState()?.connection?.status === 'ready'
  }, { timeout: 15_000 })
}

async function waitForTabsSnapshot(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    return !!state?.tabRegistry?.lastSnapshotAt && state.tabRegistry.loading === false
  }, { timeout: 15_000 })
}

async function openTabsView(page: Page): Promise<void> {
  await page.getByTitle(/^Tabs \(Ctrl\+B A\)$/).click()
  await expect(page.getByRole('heading', { name: 'Tabs' })).toBeVisible()
}

async function seedBrowserTab(page: Page, title: string): Promise<void> {
  await page.evaluate((tabTitle) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) throw new Error('Freshell test harness is not installed')

    harness.clearSentWsMessages?.()
    harness.dispatch({
      type: 'tabs/addTab',
      payload: {
        id: 'retire-e2e-tab',
        title: tabTitle,
        mode: 'shell',
        status: 'running',
        titleSetByUser: true,
      },
    })
    harness.dispatch({
      type: 'panes/initLayout',
      payload: {
        tabId: 'retire-e2e-tab',
        paneId: 'retire-e2e-pane',
        content: {
          kind: 'browser',
          url: 'https://example.com/retire-e2e',
        },
      },
    })
  }, title)

  await page.waitForFunction((tabTitle) => {
    const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
    return sent.some((message: any) =>
      message?.type === 'tabs.sync.push'
      && Array.isArray(message.records)
      && message.records.some((record: any) => record.tabName === tabTitle && record.status === 'open')
    )
  }, title, { timeout: 15_000 })
}

async function retireByPagehideWithoutWebSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) throw new Error('Freshell test harness is not installed')
    harness.forceDisconnect()
  })
  await page.waitForFunction(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getWsReadyState()
    return state !== 'ready'
  }, { timeout: 5_000 })
  await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'))
  })
  await page.close()
}

test('closed browser client is removed from the Tabs UI through the unload retire API', async ({ browser, serverInfo }) => {
  const closingPage = await newDevicePage(browser, {
    baseUrl: serverInfo.baseUrl,
    token: serverInfo.token,
    deviceId: 'closing-device-id-e2e',
    deviceLabel: RETIRED_DEVICE_LABEL,
  })
  await seedBrowserTab(closingPage, RETIRED_TAB_TITLE)

  const beforePage = await newDevicePage(browser, {
    baseUrl: serverInfo.baseUrl,
    token: serverInfo.token,
    deviceId: 'observer-before-device-id-e2e',
    deviceLabel: 'observer-before-e2e',
  })
  await waitForTabsSnapshot(beforePage)
  await openTabsView(beforePage)
  await expect(beforePage.getByRole('button', {
    name: `${RETIRED_DEVICE_LABEL}: ${RETIRED_TAB_TITLE}`,
  })).toBeVisible()
  await beforePage.context().close()

  await retireByPagehideWithoutWebSocket(closingPage)

  const afterPage = await newDevicePage(browser, {
    baseUrl: serverInfo.baseUrl,
    token: serverInfo.token,
    deviceId: 'observer-after-device-id-e2e',
    deviceLabel: 'observer-after-e2e',
  })
  await waitForTabsSnapshot(afterPage)
  await openTabsView(afterPage)
  await expect(afterPage.getByRole('button', {
    name: `${RETIRED_DEVICE_LABEL}: ${RETIRED_TAB_TITLE}`,
  })).toHaveCount(0)

  await afterPage.context().close()
})
