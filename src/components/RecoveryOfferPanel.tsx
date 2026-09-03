import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppDispatch, useAppStore } from '@/store/hooks'
import type { RootState } from '@/store/store'
import { getRecoveryInventory } from '@/lib/api'
import { hadPersistedLayoutAtBoot, bootCapturedAtMs } from '@/lib/recovery/boot-state'
import {
  getPendingOffer,
  setPendingOffer,
  clearPendingOffer,
  isDismissed,
  recordDismissal,
} from '@/lib/recovery/dismissal'
import { buildRecoveryPlan, countRecoverablePanes, placeLedgerEntries } from '@/lib/recovery/build-recovery-plan'
import type { RecoveryInventory } from '@/lib/recovery/types'
import { getCurrentTabRegistryClientInstanceId } from '@/store/tabRegistrySync'
import { addTab } from '@/store/tabsSlice'
import { restoreLayout } from '@/store/panesSlice'
import { addTerminalRestoreRequestId } from '@/lib/terminal-restore'
import type { PaneNode } from '@/store/paneTypes'
import { OVERLAY_Z } from '@/components/ui/overlay'
import { Button } from '@/components/ui/button'

const HEADING_ID = 'recovery-offer-heading'

// Focus pattern shared with src/components/ui/confirm-modal.tsx
function getFocusable(container: HTMLElement): HTMLElement[] {
  const selectors = [
    'button',
    '[href]',
    'input',
    'select',
    'textarea',
    '[tabindex]:not([tabindex="-1"])',
  ]
  return Array.from(container.querySelectorAll<HTMLElement>(selectors.join(',')))
    .filter((el) => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'))
}

function walkArmingRestores(node: PaneNode | undefined): void {
  if (!node) return
  if (node.type === 'leaf') {
    const content = node.content
    if (content.kind === 'terminal' && content.sessionRef && content.createRequestId) {
      // Post-normalization id — restoreLayout's reducer re-minted it (App.tsx:1069 pattern).
      addTerminalRestoreRequestId(content.createRequestId)
    }
    return
  }
  for (const child of node.children) walkArmingRestores(child)
}

/**
 * Arms terminal restore for every terminal leaf carrying a sessionRef in the
 * given tabs' post-normalization layouts. Live panes never arm: Task 4's plan
 * builder strips their sessionRef (D7), so the walk skips them naturally.
 */
export function armRecoveredTerminalRestores(state: Pick<RootState, 'panes'>, tabIds: string[]): void {
  for (const tabId of tabIds) {
    walkArmingRestores(state.panes.layouts[tabId])
  }
}

/**
 * Self-gating recover-my-panes offer (D1/D3): rendered unconditionally from App,
 * decides its own eligibility, fetches the recovery inventory once, and offers
 * to recreate the lost tabs from server memory.
 */
export function RecoveryOfferPanel(): JSX.Element | null {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const [inventory, setInventory] = useState<RecoveryInventory | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const acceptRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const previousOverflowRef = useRef<string | null>(null)
  const open = inventory !== null

  useEffect(() => {
    const pending = getPendingOffer()
    // D1: a boot that found a persisted layout lost nothing — unless a pending
    // offer from an earlier (empty) boot is still awaiting an answer.
    if (hadPersistedLayoutAtBoot && !pending) return
    // D2: anchor the server's concurrent-client cutoff to the ORIGINAL
    // pre-junk boot, also across pending re-offers.
    const bootAt = pending?.bootAt ?? bootCapturedAtMs
    let cancelled = false
    getRecoveryInventory(getCurrentTabRegistryClientInstanceId(), Date.now() - bootAt)
      .then((inv) => {
        if (cancelled) return
        if (!inv.recoverable || isDismissed(inv.contentId)) {
          // A dead offer (nothing recoverable / already dismissed) must not
          // leave a stale pending record causing pointless fetches every boot.
          // Fetch ERRORS deliberately keep the flag set (retry next boot).
          clearPendingOffer()
          return
        }
        setPendingOffer(inv.contentId, bootAt)
        setInventory(inv)
      })
      .catch(() => {
        // Recovery is best-effort: on fetch failure, stay quiet.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Focus management + body scroll-lock while the dialog is open
  // (confirm-modal.tsx pattern).
  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    previousOverflowRef.current = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusTimer = window.setTimeout(() => {
      acceptRef.current?.focus()
    }, 0)

    return () => {
      window.clearTimeout(focusTimer)
      document.body.style.overflow = previousOverflowRef.current || ''
      previousFocusRef.current?.focus()
    }
  }, [open])

  // Escape closes WITHOUT deciding: unlike decline (which permanently records
  // dismissal), an undecided close keeps the pending flag set so the offer
  // re-appears next boot (D3) — matching confirm-modal's "cancel" semantics.
  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setInventory(null)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const closeWithoutDecision = () => {
    setInventory(null)
  }

  const accept = () => {
    if (!inventory) return
    clearPendingOffer()
    const plans = buildRecoveryPlan(inventory)
    for (const plan of plans) {
      dispatch(addTab({ id: plan.tabId, title: plan.title }))
      dispatch(restoreLayout({ tabId: plan.tabId, layout: plan.layout, paneTitles: plan.paneTitles }))
    }
    armRecoveredTerminalRestores(store.getState(), plans.map((p) => p.tabId))
    setInventory(null)
  }

  const decline = () => {
    if (inventory) recordDismissal(inventory.contentId)
    clearPendingOffer()
    setInventory(null)
  }

  if (!inventory) return null

  const paneCount = countRecoverablePanes(inventory)
  const device = inventory.device
  const anyLive = device?.tabs.some((tab) => tab.panes.some((pane) => pane.live)) ?? false
  // D8 placement: the listing must match the plan's physical destination, so
  // both consume the same partition — a kept ledger row whose stamped tabKey
  // names a restorable tab renders under THAT tab in the same line format as
  // its snapshot panes. Rows without a restorable tab match are not restored
  // (delta-r2 Finding 3) and are not listed.
  const restorableTabs = (device?.tabs ?? []).filter((tab) => tab.panes.length > 0)
  const placement = placeLedgerEntries(inventory)

  return createPortal(
    <div
      className={`fixed inset-0 flex items-center justify-center bg-black/50 ${OVERLAY_Z.modal}`}
      onClick={closeWithoutDecision}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          closeWithoutDecision()
        }
      }}
      role="presentation"
      tabIndex={-1}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={HEADING_ID}
        data-testid="recovery-offer-panel"
        className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4 p-5 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return
          const dialog = dialogRef.current
          if (!dialog) return
          const focusables = getFocusable(dialog)
          if (focusables.length === 0) {
            e.preventDefault()
            return
          }
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          const active = document.activeElement as HTMLElement | null
          if (e.shiftKey) {
            if (active === first || !dialog.contains(active)) {
              e.preventDefault()
              last.focus()
            }
          } else if (active === last) {
            e.preventDefault()
            first.focus()
          }
        }}
      >
        <h2 id={HEADING_ID} className="text-lg font-semibold">
          Restore {paneCount} {paneCount === 1 ? 'pane' : 'panes'} from server memory?
        </h2>
        {device && <p className="mt-1 text-xs text-muted-foreground">{device.deviceLabel}</p>}
        {/* Sole scroll region (R1): keeps heading, notes, and buttons out of the scrollable area. */}
        <ul className="mt-3 text-sm text-muted-foreground list-disc pl-5 space-y-1 overflow-y-auto flex-1 min-h-0">
          {restorableTabs.flatMap((tab) => [
            ...tab.panes.map((pane) => (
              <li key={`${tab.tabKey}:${pane.paneId}`}>
                {tab.tabName}: {pane.mode ?? pane.kind}
                {pane.cwd ? ` — ${pane.cwd}` : ''}
              </li>
            )),
            ...(placement.joinedByTabKey.get(tab.tabKey) ?? []).map((entry) => (
              <li key={`${entry.provider}:${entry.sessionId}`}>
                {tab.tabName}: {entry.mode}
                {entry.cwd ? ` — ${entry.cwd}` : ''}
              </li>
            )),
          ])}
        </ul>
        {anyLive && (
          <p data-testid="recovery-live-note" className="mt-3 text-xs text-muted-foreground">
            Some sessions are still running on the server — they were left untouched; their panes
            reopen without resuming.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" data-testid="recovery-decline" onClick={decline}>
            Not now
          </Button>
          <Button
            ref={acceptRef}
            variant="default"
            size="sm"
            data-testid="recovery-accept"
            onClick={accept}
          >
            Restore
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
