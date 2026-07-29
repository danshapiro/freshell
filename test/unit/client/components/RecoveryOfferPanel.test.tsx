import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRecoveryInventory: vi.fn(),
}))
vi.mock('@/lib/recovery/boot-state', () => ({
  computeHadPersistedLayout: () => false,
  hadPersistedLayoutAtBoot: false, // simulate empty boot
  bootCapturedAtMs: 0,
}))
vi.mock('@/store/tabRegistrySync', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCurrentTabRegistryClientInstanceId: () => 'client-me',
}))

import { getRecoveryInventory } from '@/lib/api'
import {
  RecoveryOfferPanel,
  recoveryLedgerOnlyEntryKey,
} from '@/components/RecoveryOfferPanel'
import { getPendingOffer, setPendingOffer, isDismissed, recordDismissal } from '@/lib/recovery/dismissal'
import { consumeTerminalRestoreRequestId } from '@/lib/terminal-restore'
import type { RecoveryInventory } from '@/lib/recovery/types'
import type { PaneNode } from '@/store/paneTypes'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'

function makeTestStore() {
  return configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
}

type TestStore = ReturnType<typeof makeTestStore>

const INVENTORY: RecoveryInventory = {
  recoverable: true,
  contentId: 'cid-1',
  device: {
    deviceId: 'd',
    deviceLabel: 'l',
    capturedAt: 1,
    tabs: [
      {
        tabKey: 'k',
        tabName: 'work',
        panes: [
          {
            paneId: 'p1',
            kind: 'terminal',
            mode: 'claude',
            shell: null,
            cwd: '/w',
            payload: {},
            sessionRef: { provider: 'claude', sessionId: 'S2' },
            ledgerState: 'bound',
            live: false,
          },
        ],
      },
    ],
  },
  otherDevices: [],
  ledgerOnly: [],
}

function collectTerminalLeaves(node: PaneNode | undefined): Extract<PaneNode, { type: 'leaf' }>[] {
  if (!node) return []
  if (node.type === 'leaf') return node.content.kind === 'terminal' ? [node] : []
  return node.children.flatMap((child) => collectTerminalLeaves(child))
}

function findRecoveredTerminalLeaves(store: TestStore, title: string) {
  const tab = store.getState().tabs.tabs.find((t) => t.title === title)
  expect(tab, `expected a recovered tab titled "${title}"`).toBeTruthy()
  return collectTerminalLeaves(store.getState().panes.layouts[tab!.id])
}

describe('RecoveryOfferPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(getRecoveryInventory).mockReset()
  })

  afterEach(() => cleanup())

  it('uses provider scope in scoped ledger-only identities while preserving legacy identities', () => {
    expect(recoveryLedgerOnlyEntryKey({
      provider: 'codex',
      sessionId: 'C9',
      mode: 'codex',
      cwd: null,
    })).toBe('codex:C9')

    const firstScope = recoveryLedgerOnlyEntryKey({
      provider: 'amplifier',
      providerScope: '/workspace/one',
      sessionId: 'shared',
      mode: 'amplifier',
      cwd: '/workspace/one',
    })
    const secondScope = recoveryLedgerOnlyEntryKey({
      provider: 'amplifier',
      providerScope: '/workspace/two',
      sessionId: 'shared',
      mode: 'amplifier',
      cwd: '/workspace/two',
    })

    expect(firstScope).not.toBe(secondScope)
  })

  it('offers when eligible and inventory is recoverable, recording the pending offer', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/restore 1 pane/i)).toBeInTheDocument()
    expect(screen.getByText(/work/)).toBeInTheDocument()
    // D2: the pending flag anchors re-offers to the original boot
    expect(getPendingOffer()).toEqual({ contentId: 'cid-1', bootAt: 0 })
    // no live panes in this inventory -> no live note
    expect(screen.queryByTestId('recovery-live-note')).not.toBeInTheDocument()
  })

  it('accept creates the tabs, arms terminal restore, and hides the panel', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    const store = makeTestStore()
    render(<Provider store={store}><RecoveryOfferPanel /></Provider>)
    await userEvent.click(await screen.findByTestId('recovery-accept'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const leaves = findRecoveredTerminalLeaves(store, 'work')
    expect(leaves).toHaveLength(1)
    const content = leaves[0].content
    expect(content.kind).toBe('terminal')
    if (content.kind !== 'terminal') throw new Error('unreachable')
    // Recreated pane carries the ledger-corrected ref
    expect(content.sessionRef?.sessionId).toBe('S2')
    // The post-normalization createRequestId was armed for restore
    expect(consumeTerminalRestoreRequestId(content.createRequestId)).toBe(true)
    // Pending flag is cleared on accept
    expect(getPendingOffer()).toBeNull()
  })

  it('decline hides, records dismissal, and a remount stays quiet', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    const store = makeTestStore()
    const first = render(<Provider store={store}><RecoveryOfferPanel /></Provider>)
    await userEvent.click(await screen.findByTestId('recovery-decline'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(getPendingOffer()).toBeNull()
    first.unmount()

    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    await waitFor(() => expect(vi.mocked(getRecoveryInventory)).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders nothing when inventory is not recoverable and clears a stale pending offer', async () => {
    setPendingOffer('cid-1', 0)
    vi.mocked(getRecoveryInventory).mockResolvedValue({
      ...INVENTORY,
      recoverable: false,
      device: null,
    })
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    await waitFor(() => expect(vi.mocked(getRecoveryInventory)).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // A dead offer must not leave a pending record causing pointless fetches every boot
    await waitFor(() => expect(getPendingOffer()).toBeNull())
  })

  it('clears a stale pending offer when the fetched inventory is already dismissed', async () => {
    recordDismissal('cid-1')
    setPendingOffer('cid-1', 0)
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    await waitFor(() => expect(vi.mocked(getRecoveryInventory)).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(getPendingOffer()).toBeNull())
  })

  it('renders nothing when the inventory fetch fails, keeping any pending offer for retry', async () => {
    setPendingOffer('cid-1', 0)
    vi.mocked(getRecoveryInventory).mockRejectedValue(new Error('boom'))
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    await waitFor(() => expect(vi.mocked(getRecoveryInventory)).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Fetch errors are transient: the pending flag stays so the next boot retries
    expect(getPendingOffer()).toEqual({ contentId: 'cid-1', bootAt: 0 })
  })

  it('moves initial focus to the Restore button and locks body scroll while open', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(screen.getByTestId('recovery-accept')).toHaveFocus())
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('traps Tab focus inside the dialog', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    await screen.findByRole('dialog')
    await waitFor(() => expect(screen.getByTestId('recovery-accept')).toHaveFocus())
    // accept is the last focusable; Tab wraps to the first (decline)
    await userEvent.tab()
    expect(screen.getByTestId('recovery-decline')).toHaveFocus()
    // decline is the first focusable; Shift+Tab wraps back to the last (accept)
    await userEvent.tab({ shift: true })
    expect(screen.getByTestId('recovery-accept')).toHaveFocus()
  })

  it('Escape closes without deciding: no dismissal recorded, pending offer kept, re-offers on remount', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    const first = render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Undecided close (D3): pending survives so the offer re-appears next boot
    expect(getPendingOffer()).toEqual({ contentId: 'cid-1', bootAt: 0 })
    expect(isDismissed('cid-1')).toBe(false)
    first.unmount()

    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('overlay click closes without deciding; clicks inside the dialog do not close', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    const dialog = await screen.findByRole('dialog')
    // Clicking inside the dialog body must NOT close it
    await userEvent.click(screen.getByText(/restore 1 pane/i))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // Clicking the overlay closes without recording a decision
    await userEvent.click(dialog.parentElement as HTMLElement)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(getPendingOffer()).toEqual({ contentId: 'cid-1', bootAt: 0 })
    expect(isDismissed('cid-1')).toBe(false)
  })

  it('shows the live note for live panes and recreates them without sessionRef (D7)', async () => {
    const liveInventory: RecoveryInventory = {
      ...INVENTORY,
      device: {
        ...INVENTORY.device!,
        tabs: [
          {
            tabKey: 'k',
            tabName: 'work',
            panes: [{ ...INVENTORY.device!.tabs[0].panes[0], live: true }],
          },
        ],
      },
    }
    vi.mocked(getRecoveryInventory).mockResolvedValue(liveInventory)
    const store = makeTestStore()
    render(<Provider store={store}><RecoveryOfferPanel /></Provider>)
    expect(await screen.findByTestId('recovery-live-note')).toBeVisible()

    await userEvent.click(screen.getByTestId('recovery-accept'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const leaves = findRecoveredTerminalLeaves(store, 'work')
    expect(leaves).toHaveLength(1)
    const content = leaves[0].content
    if (content.kind !== 'terminal') throw new Error('unreachable')
    // Live sessions are left untouched: no resume ref, no restore arming
    expect(content.sessionRef).toBeUndefined()
    expect(consumeTerminalRestoreRequestId(content.createRequestId)).toBe(false)
  })
})
