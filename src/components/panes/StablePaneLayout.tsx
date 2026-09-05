import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useAppSelector } from '@/store/hooks'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import PaneDivider from './PaneDivider'
import { usePaneSplitResize } from './usePaneSplitResize'
import type { PaneNode } from '@/store/paneTypes'
import {
  collectSurfaceOrder,
  localSurfaceRect,
  reconcileSurfaceMeasurements,
  resolveSurfaceZoom,
  type SurfaceMeasurements,
  type SurfaceRect,
} from '@/lib/pane-surface-layout'
import PaneContainer from './PaneContainer'
import PaneGeometryTree, { type RegisterPaneSlot } from './PaneGeometryTree'

type Props = { tabId: string; layout: PaneNode; zoomedPaneId?: string; hidden?: boolean }

function InertRegion({ hidden, style, children, paneId }: {
  hidden: boolean
  style?: CSSProperties
  children: ReactNode
  paneId?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // React 18 does not type inert as a JSX prop. Setting the DOM property
    // preserves native keyboard/a11y exclusion without a project-wide shim.
    if (ref.current) ref.current.inert = hidden
  }, [hidden])
  return (
    <div
      ref={ref}
      data-stable-pane-id={paneId}
      aria-hidden={hidden || undefined}
      className="absolute min-w-0 min-h-0"
      style={{ ...style, visibility: hidden ? 'hidden' : undefined, pointerEvents: hidden ? 'none' : 'auto' }}
    >
      {children}
    </div>
  )
}

function StablePaneDivider({ tabId, node, root, getSplitElement }: {
  tabId: string
  node: Extract<PaneNode, { type: 'split' }>
  root: PaneNode
  getSplitElement: (id: string) => HTMLDivElement | null
}) {
  // Resolve the CURRENT geometry slot when an input event occurs. Reading
  // a slot ref during render can capture the detached pre-restructure node.
  const containerRef = useMemo(() => ({ get current() { return getSplitElement(node.id) } }), [getSplitElement, node.id])
  const snapThreshold = useAppSelector((s) => s.settings?.settings?.panes?.snapThreshold ?? 2)
  const { handleResizeStart, handleResize, handleResizeEnd } = usePaneSplitResize({
    tabId, node, rootNode: root, containerRef, snapThreshold,
  })
  return (
    <div className={`flex h-full w-full ${node.direction === 'vertical' ? 'flex-col' : 'flex-row'}`}>
      <PaneDivider
        direction={node.direction}
        onResizeStart={handleResizeStart}
        onResize={(delta, shiftHeld) => handleResize(node.id, delta, node.direction, shiftHeld)}
        onResizeEnd={handleResizeEnd}
        dataContext={ContextIds.PaneDivider}
        dataTabId={tabId}
        dataSplitId={node.id}
      />
    </div>
  )
}

const readRect = (element: HTMLElement): SurfaceRect => {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}

/** Pane identity is independent of split-tree ancestry.
 *
 * Keep every surviving pane under the SAME keyed parent, including during
 * zoom. The empty split tree retains the existing flex/divider geometry; the
 * measured leaf rectangles position the real pane shells in a sibling layer.
 * No portals, DOM reparenting, terminal serialization, or global cache.
 *
 * The `hidden` prop fans out to three distinct consumers under one flag:
 * inactive-tab hiding (PaneLayout's own `hidden`), zoom-hidden siblings, and
 * surfaces whose measurement is temporarily unavailable. TerminalView's
 * hidden path routes to the background-hydration queue, which assumes
 * tab-level semantics; a zoom-hidden pane in the ACTIVE tab may therefore be
 * deprioritized by that queue. This is no worse than the previous behavior
 * (zoom used to unmount the pane entirely), but the overload is explicit so
 * later hydration work can split the two meanings.
 */
export default function StablePaneLayout({ tabId, layout, zoomedPaneId, hidden = false }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const slotsRef = useRef(new Map<string, HTMLDivElement>())
  const items = useMemo(() => collectSurfaceOrder(layout), [layout])
  const leaves = useMemo(() => items.filter((node) => node.type === 'leaf'), [items])
  const zoom = resolveSurfaceZoom(leaves, zoomedPaneId)
  const [measurements, setMeasurements] = useState<SurfaceMeasurements>(() => Object.create(null))
  const registerSlot: RegisterPaneSlot = useCallback((key, element) => {
    if (element) slotsRef.current.set(key, element)
    else slotsRef.current.delete(key)
  }, [])

  const getSplitElement = useCallback((id: string) => slotsRef.current.get(`split:${id}`) ?? null, [])

  // The measurement effect must NOT rerun on content-only leaf updates (new
  // layout object, same pane/divider/sizes structure): tearing down and
  // recreating the ResizeObserver for every output-driven content assignment
  // would force synchronous layout reads during provider churn. The effect
  // keys on the structural signature and reads the freshest items via ref.
  const structure = useMemo(
    () =>
      items
        .map((n) =>
          n.type === 'leaf'
            ? `pane:${n.id}`
            : `divider:${n.id}:${n.direction}:${n.sizes[0]}:${n.sizes[1]}`,
        )
        .join('|'),
    [items],
  )
  const itemsRef = useRef(items)
  itemsRef.current = items

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    let disposed = false
    const items = itemsRef.current
    const measure = () => {
      if (disposed) return
      // Read all geometry before setState can cause any writes. No per-token
      // work: this runs on layout commits or actual element size changes.
      const rootRect = readRect(root)
      const computed = getComputedStyle(root)
      // clientWidth/clientHeight round fractional CSS sizes. Use the computed
      // borderless content box to avoid changing xterm's column threshold.
      const width = Number.parseFloat(computed.width) || root.clientWidth
      const height = Number.parseFloat(computed.height) || root.clientHeight
      const measured = new Map<string, SurfaceRect>()
      for (const item of items) {
        const key = `${item.type === 'leaf' ? 'pane' : 'divider'}:${item.id}`
        const slot = slotsRef.current.get(key)
        const rect = slot ? localSurfaceRect(rootRect, readRect(slot), width, height) : undefined
        if (rect) measured.set(key, rect)
        else if (item.type === 'leaf' && item.id === zoom && width > 0 && height > 0 && rootRect.width > 0 && rootRect.height > 0) {
          // A new zoomed pane can mount even when its normal split slot has
          // collapsed; its actual visible region is the full layout root.
          measured.set(key, { left: 0, top: 0, width, height })
        }
      }
      setMeasurements((previous) => reconcileSurfaceMeasurements(previous, items.map((item) => `${item.type === 'leaf' ? 'pane' : 'divider'}:${item.id}`), measured))
    }
    // Establish correct geometry BEFORE mounting new terminal surfaces. An
    // already-mounted pane remains mounted even while geometry is unavailable.
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    for (const slot of slotsRef.current.values()) observer.observe(slot)
    return () => {
      disposed = true
      observer.disconnect()
    }
    // Structure (not content) or zoom changes re-arm the measurement pass.
  }, [structure, zoom])

  return (
    <div ref={rootRef} data-stable-pane-layout className="relative h-full w-full min-w-0 min-h-0">
      <div data-pane-geometry-tree aria-hidden="true" className="h-full w-full pointer-events-none" style={{ visibility: 'hidden' }}>
        <PaneGeometryTree node={layout} registerSlot={registerSlot} />
      </div>
      <div data-pane-surface-layer className="absolute inset-0 pointer-events-none">
        {items.map((node) => {
          const key = `${node.type === 'leaf' ? 'pane' : 'divider'}:${node.id}`
          const measurement = measurements[key]
          if (!measurement) return null
          const paneHidden = hidden || !measurement.measurable || (!!zoom && (node.type !== 'leaf' || zoom !== node.id))
          const style: CSSProperties = node.type === 'leaf' && zoom === node.id
            ? { left: 0, top: 0, width: '100%', height: '100%' }
            : measurement.rect
          return (
            <InertRegion key={key} paneId={node.type === 'leaf' ? node.id : undefined} hidden={paneHidden} style={style}>
              {node.type === 'leaf'
                ? <PaneContainer tabId={tabId} node={node} hidden={paneHidden} />
                : <StablePaneDivider tabId={tabId} node={node} root={layout} getSplitElement={getSplitElement} />}
            </InertRegion>
          )
        })}
      </div>
    </div>
  )
}
