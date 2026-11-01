import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ContextMenu } from '@/components/context-menu/ContextMenu'
import type { MenuItem } from '@/components/context-menu/context-menu-types'
import {
  computeMinimapLayout,
  computeTickHitBox,
  MINIMAP_RAIL_BOTTOM_INSET_PX,
  MINIMAP_TICK_HIT_LEFT_PX,
  MINIMAP_TICK_HIT_WIDTH_PX,
  MINIMAP_TICK_MIN_CLICKABLE_PX,
  type MinimapCluster,
  type MinimapLayout,
  type MinimapTick,
} from './shared/transcript-minimap-layout'
import type { TranscriptMeasurement } from './shared/transcript-measurement'

const ARIA_LABEL_MAX_LENGTH = 60
const TOOLTIP_MAX_LENGTH = 120

function truncatePrompt(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text
}

export type FreshAgentTranscriptMinimapProps = {
  /** The transcript's scroll container: owns the turn landmarks and geometry. */
  scrollerRef: { current: HTMLDivElement | null }
  /** The transcript's SINGLE shared landmark sweep result — the same
   *  measurement that feeds the glom chip. Null when the scroller is missing. */
  measurement: TranscriptMeasurement | null
  /** Requests a fresh shared sweep. Fired by this component's ResizeObservers
   *  (article-level and pane-level resize); the transcript owns the sweep. */
  onRemeasure: () => void
  /** Content signature; a change re-subscribes child observation (new articles). */
  transcriptSignature: string
}

/**
 * ChatGPT-style scroll minimap for the fresh-agent transcript: one tick per
 * user prompt, evenly spaced (each prompt gets an equal slot in the rail;
 * the line's height stays proportional to its turn's size), a hover/focus
 * prompt preview, and click-to-jump.
 * Every tick's hover/click hit box is bigger than its painted line — 2x the
 * line height and 1.5x the rail width, centered on the line and clamped to
 * the uniform slot so adjacent hit boxes never overlap. Presentational on
 * top of the transcript's shared landmark sweep: geometry arrives via the
 * `measurement` prop; the only work this component owns is its two
 * ResizeObserver subscriptions, which request re-measurement through
 * `onRemeasure` — so unmounting it (the show/hide setting, pane teardown)
 * removes exactly its own work while the glom chip keeps its data.
 */
export function FreshAgentTranscriptMinimap({
  scrollerRef,
  measurement,
  onRemeasure,
  transcriptSignature,
}: FreshAgentTranscriptMinimapProps) {
  const layout = useMemo<MinimapLayout | null>(() => {
    if (!measurement) return null
    const railHeight = measurement.clientHeight - MINIMAP_RAIL_BOTTOM_INSET_PX
    // Hidden when the content fits the viewport or the rail has no room; also
    // the state jsdom sits in by default (zero geometry), which keeps the
    // rest of the transcript suite free of minimap buttons.
    if (measurement.scrollHeight <= measurement.clientHeight || railHeight <= 0) return null
    return computeMinimapLayout({
      scrollHeight: measurement.scrollHeight,
      railHeight,
      landmarks: measurement.landmarks,
    })
  }, [measurement])

  // Observe every direct child of the scroller, not just turn articles: the
  // rolled-back-history disclosure section (and any caption) sits outside the
  // articles, and its expand/collapse changes scrollHeight without touching
  // transcriptSignature (derived only from displayTurns) or the scroller's
  // own border box. Re-subscribed per signature so new articles are observed
  // and stale ones released.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(onRemeasure)
    Array.from(scroller.children).forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [onRemeasure, scrollerRef, transcriptSignature])

  // Pane resize: the scroller's border box changes with no scroll event, no
  // signature change, and no child resize — request a fresh sweep.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(onRemeasure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [onRemeasure, scrollerRef])

  const handleTickClick = useCallback((index: number) => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const el = scroller.querySelector<HTMLElement>(`[data-turn-index="${index}"]`)
    // Optional call: jsdom has no scrollIntoView — the glom chip guards the
    // same way. The resulting scroll event flips atBottom false via the
    // transcript's existing onScroll handler, so stick-to-bottom disengages.
    el?.scrollIntoView?.({ block: 'start' })
  }, [scrollerRef])

  // The open cluster menu: which cluster's key opened it, its items, its
  // position, the OPENER element (focus is restored to it on close — the
  // ContextMenu primitive never does that itself), and — round 3 — the
  // measurement identity it opened UNDER: every sweep mints a NEW
  // TranscriptMeasurement object, so the hygiene effect below detects ANY
  // re-measure while the menu is open (scroll, pane resize, streamed
  // prompt) and closes the menu before its captured snapshot goes stale.
  const [clusterMenu, setClusterMenu] = useState<{
    key: string
    items: MenuItem[]
    position: { x: number; y: number }
    opener: HTMLButtonElement
    openedMeasurement: TranscriptMeasurement
  } | null>(null)
  // The dense-cluster hover preview: which member tick the pointer is over,
  // scoped to its cluster so one cluster's focus-tooltip can never surface
  // another cluster's member.
  const [hoveredMember, setHoveredMember] = useState<{ clusterKey: string; tick: MinimapTick } | null>(null)

  /** Rail-Y → member band: offset the pointer into the cluster button
   *  (clientY − rect.top), add the run's rail top, and keep the LAST member
   *  tick whose top is at or below that Y — the nearest band at or above the
   *  pointer (a run's members sit at sub-4px pitch, so this is the band the
   *  pointer is in; a Y above the run clamps to the first member, and a Y
   *  past the run's end is already the last member by the same rule). */
  const memberUnderPointer = (
    event: MouseEvent<HTMLButtonElement>,
    cluster: MinimapCluster,
    memberTicks: MinimapTick[],
  ): MinimapTick => {
    const rect = event.currentTarget.getBoundingClientRect()
    const railY = cluster.top + (event.clientY - rect.top)
    let hit = memberTicks[0]
    for (const member of memberTicks) {
      if (member.top <= railY) hit = member
    }
    return hit
  }

  // UI-state hygiene, NOT measurement: when the rail hides (layout null)
  // while the cluster menu is open, the menu unmounts — clear its state so
  // a later rail restoration cannot resurrect a stale menu whose opener
  // element is detached; the same applies to the stale hover selection (a
  // restored rail + focus on a target would otherwise surface it). Round 3
  // adds the stale-SNAPSHOT close: any re-measure while the menu is open —
  // transcript scroll, pane resize, or a streamed prompt — replaces the
  // measurement OBJECT; the menu's items/position/opener were captured at
  // open, so it closes (standard popover behavior). Identity comparison,
  // not deep equality: every sweep mints a fresh TranscriptMeasurement, so
  // `!==` detects every re-measure. Scrolling the MENU's own portaled list
  // never re-measures the transcript (the list lives in a document.body
  // portal, outside the scroller — its wheel/scroll events never reach the
  // transcript's onScroll), so list scrolling never dismisses the menu;
  // only transcript-side geometry changes do. The plan imposes no "no
  // passive effects" rule — the component has owned effects since Task 2
  // (its two ResizeObserver subscriptions); this effect never sweeps, and
  // the Global-Constraints synchronous-measurement rule is untouched.
  useEffect(() => {
    if (!layout) {
      if (clusterMenu) setClusterMenu(null)
      if (hoveredMember) setHoveredMember(null)
      return
    }
    if (clusterMenu && measurement !== clusterMenu.openedMeasurement) {
      setClusterMenu(null)
    }
  }, [layout, clusterMenu, hoveredMember, measurement])

  // Render gate (the Task-2 line, one addition): `!measurement` is dead by
  // construction — layout is null whenever measurement is, because layout
  // derives from it — but it narrows `measurement` to non-null for the
  // cluster-target onClick's `openedMeasurement: measurement` capture in
  // (d), keeping the state type honest without a cast or a dead in-handler
  // guard.
  if (!layout || !measurement) return null

  // Dense-singleton clusters are lone sub-4px ticks: their OWN buttons get
  // the loneDense hit floor inside computeTickHitBox (dense multi-member
  // clusters get the open-list button below instead). Keyed by the member
  // tick's landmark index (tick.index), which is unique across the rail.
  const loneDenseTickIndexes = new Set(
    layout.clusters
      .filter((cluster) => cluster.dense && cluster.startIndex === cluster.endIndex)
      .map((cluster) => layout.ticks[cluster.startIndex].index),
  )

  return (
    <div
      className="fresh-agent-minimap pointer-events-none absolute right-2 top-0 z-30 w-3"
      style={{ bottom: MINIMAP_RAIL_BOTTOM_INSET_PX }}
      role="group"
      aria-label="Transcript minimap"
    >
      {layout.ticks.map((tick) => {
        const firstLine = tick.label.split('\n')[0]
        // LONE sub-4px tick (dense-singleton run member): it never joined a
        // clickability run, so it has >= 4px pitch on both sides — its hit
        // box floors at the clickable minimum (computeTickHitBox's
        // loneDense path) and still cannot overlap a neighbor. Every tick —
        // lone dense or not — renders the same universal shape: a
        // hit-box-sized button (2x the line height, 1.5x the rail width,
        // centered on the line, slot-clamped) carrying an inner aria-hidden
        // paint span at the LINE rect; the button keeps its aria-label and
        // jumps DIRECTLY on click (no menu — one tick, one unambiguous
        // target), and the hover/focus tint covers the whole hit box.
        const loneSubFloorTick = loneDenseTickIndexes.has(tick.index)
        const hitBox = computeTickHitBox(tick, layout.slotHeight, layout.railHeight, loneSubFloorTick)
        return (
          <Tooltip key={tick.index}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="fresh-agent-minimap-tick pointer-events-auto absolute rounded-sm transition-colors hover:bg-primary/15 focus-visible:bg-primary/15"
                style={{
                  top: hitBox.top,
                  height: hitBox.height,
                  left: MINIMAP_TICK_HIT_LEFT_PX,
                  width: MINIMAP_TICK_HIT_WIDTH_PX,
                }}
                aria-label={`Jump to prompt: ${truncatePrompt(firstLine, ARIA_LABEL_MAX_LENGTH)}`}
                onClick={() => handleTickClick(tick.index)}
              >
                <span
                  aria-hidden="true"
                  className="absolute rounded-sm bg-muted-foreground/40"
                  style={{
                    top: tick.top - hitBox.top,
                    height: tick.height,
                    left: 0 - MINIMAP_TICK_HIT_LEFT_PX,
                    right: 0 - MINIMAP_TICK_HIT_LEFT_PX,
                  }}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side={tick.top < layout.railHeight * 0.25 ? 'bottom' : 'top'}
              align="end"
              className="max-w-64 whitespace-pre-wrap break-words"
            >
              {truncatePrompt(firstLine, TOOLTIP_MAX_LENGTH)}
            </TooltipContent>
          </Tooltip>
        )
      })}
      {layout.clusters
        .filter((cluster) => cluster.dense && cluster.endIndex > cluster.startIndex)
        .map((cluster) => {
          const clusterKey = `cluster-${cluster.startIndex}`
          const memberTicks = layout.ticks.slice(cluster.startIndex, cluster.endIndex + 1)
          // The hovered member, when it belongs to THIS cluster (the
          // clusterKey scoping keeps one cluster's focus-tooltip from ever
          // surfacing another cluster's member).
          const hoveredTick =
            hoveredMember !== null && hoveredMember.clusterKey === clusterKey
              ? hoveredMember.tick
              : null
          return (
            <Tooltip key={clusterKey}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="pointer-events-auto absolute z-10 rounded-sm bg-transparent transition-colors hover:bg-primary/15 focus-visible:bg-primary/15"
                  style={{
                    top: cluster.top,
                    height: Math.min(
                      Math.max(cluster.height, MINIMAP_TICK_MIN_CLICKABLE_PX),
                      layout.railHeight - cluster.top,
                    ),
                    left: MINIMAP_TICK_HIT_LEFT_PX,
                    width: MINIMAP_TICK_HIT_WIDTH_PX,
                  }}
                  aria-haspopup="menu"
                  aria-expanded={clusterMenu !== null && clusterMenu.key === clusterKey}
                  aria-label={`Prompts ${cluster.startIndex + 1}-${cluster.endIndex + 1} — open list`}
                  // The z-10 target wins pointer events over the member
                  // ticks, so it HOSTS their hover previews: enter and move
                  // both map the pointer's Y to a member band (enter too, so
                  // a pointer entering without moving still previews the
                  // band under it); leave clears the selection and the
                  // tooltip primitive closes the shell.
                  onMouseEnter={(event) => {
                    setHoveredMember({ clusterKey, tick: memberUnderPointer(event, cluster, memberTicks) })
                  }}
                  onMouseMove={(event) => {
                    setHoveredMember({ clusterKey, tick: memberUnderPointer(event, cluster, memberTicks) })
                  }}
                  onMouseLeave={() => setHoveredMember(null)}
                  onClick={(event) => {
                    // Button-rect positioning works for pointer AND keyboard
                    // activation (a keyboard click event carries clientX/Y 0).
                    const rect = event.currentTarget.getBoundingClientRect()
                    setClusterMenu({
                      key: clusterKey,
                      items: memberTicks.map((tick) => ({
                        type: 'item' as const,
                        id: `cluster-prompt-${tick.index}`,
                        label: truncatePrompt(tick.label.split('\n')[0], ARIA_LABEL_MAX_LENGTH),
                        onSelect: () => handleTickClick(tick.index),
                      })),
                      position: { x: rect.left, y: rect.top },
                      opener: event.currentTarget,
                      // The measurement identity this menu opened under
                      // (narrowed non-null by the render gate) — the
                      // hygiene effect's staleness reference.
                      openedMeasurement: measurement,
                    })
                  }}
                />
              </TooltipTrigger>
              {hoveredTick !== null ? (
                <TooltipContent
                  side={cluster.top < layout.railHeight * 0.25 ? 'bottom' : 'top'}
                  align="end"
                  className="max-w-64 whitespace-pre-wrap break-words"
                >
                  {truncatePrompt(hoveredTick.label.split('\n')[0], TOOLTIP_MAX_LENGTH)}
                </TooltipContent>
              ) : null}
            </Tooltip>
          )
        })}
      {layout && clusterMenu ? (
        <ContextMenu
          open={clusterMenu !== null}
          items={clusterMenu.items}
          position={clusterMenu.position}
          className="max-h-[60vh] overflow-y-auto"
          scrollFocusedItemIntoView
          onClose={() => {
            // The primitive closes for selection, Escape, and Tab-out but
            // never restores focus itself (ContextMenu.tsx:86-94, :122-128,
            // :154-157 — all route through onClose, no external focus()) —
            // land focus back on the opener, then clear the state. The
            // isConnected guard (round 3): a streamed prompt can unmount
            // the opener before this runs; focusing a detached node is a
            // silent no-op that would strand focus on body.
            if (clusterMenu.opener.isConnected) clusterMenu.opener.focus()
            setClusterMenu(null)
          }}
        />
      ) : null}
    </div>
  )
}
