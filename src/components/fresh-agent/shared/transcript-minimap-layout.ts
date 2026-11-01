// src/components/fresh-agent/shared/transcript-minimap-layout.ts
//
// Pure geometry for the fresh-agent transcript minimap rail: maps measured
// user-turn landmarks (content coordinates) onto tick rects inside the rail.
// Kept free of DOM and React so it is exhaustively unit-testable without
// jsdom geometry mocks.
//
// Placement is EVENLY SPACED: every prompt gets one uniform slot
// (railHeight / prompt count) regardless of where it sits in the
// transcript — the content offsets only order the prompts. A prompt's LINE
// height stays proportional to its turn's size (scale =
// railHeight / scrollHeight, floored at the density-thinned minimum, capped
// one pixel below the slot so adjacent lines keep a gap) and centers in its
// slot.

/** Minimum rendered tick height, px — keeps every prompt clickable at sane
 * densities; under density the effective minimum thins below it (sub-pixel
 * allowed) so no prompt is ever dropped or stacked on another. */
export const MINIMAP_MIN_TICK_HEIGHT_PX = 3
/** Rail bottom inset, px. Clears the serif/mono bottom-right scroll-to-bottom
 * button (`src/index.css` `.fresh-agent-scroll-bottom` overrides) in every
 * pane style with one code path — in the default sans style the button is
 * bottom-centered and never overlaps the right edge anyway. */
export const MINIMAP_RAIL_BOTTOM_INSET_PX = 48
/** Tick heights at or above this remain individually pointer-clickable;
 *  below it, individual hits are physically unreliable on a 1× display, so
 *  the component layer adds one open-list hit target over each dense
 *  multi-member clickability run and gives a lone sub-4px tick's own hit
 *  box the 4px floor via computeTickHitBox's loneDense path (every
 *  per-prompt tick still renders — never dropped or capped). */
export const MINIMAP_TICK_MIN_CLICKABLE_PX = 4
/** Hit box horizontal growth: the rail is 12px (w-3); hit boxes are 18px
 *  wide, centered on it (50% of the rail width padding on each side). */
export const MINIMAP_TICK_HIT_WIDTH_PX = 18
/** Hit-box left offset inside the rail: -3 centers the 18px hit box on the
 *  12px rail column (the painted line keeps the 12px extent). */
export const MINIMAP_TICK_HIT_LEFT_PX = -3

export type MinimapLandmark = {
  /** Index into the transcript's displayTurns (the article's data-turn-index). */
  index: number
  /** Distance from the top of the scrollable content, px. Orders the
   *  prompts; never places them (placement is uniform-slot). */
  offsetTop: number
  /** Rendered height of the turn article, px. */
  height: number
  /** Prompt preview text (turnPlainText of the user turn). */
  label: string
}

export type MinimapTick = {
  index: number
  label: string
  /** Distance from the rail top, px — the LINE rect's top (the line
   *  centers in its uniform slot; the button's hit box is bigger —
   *  computeTickHitBox). */
  top: number
  /** Line height, px (>= the density-thinned minimum). */
  height: number
}

export type MinimapCluster = {
  /** Rail-space top of the run's first member tick. */
  top: number
  /** Run span, px: last member's bottom minus first member's top. */
  height: number
  /** Inclusive position of the first member tick within layout.ticks. */
  startIndex: number
  /** Inclusive position of the last member tick within layout.ticks. */
  endIndex: number
  /** True when at least one member tick's height is strictly below the
   *  clickable floor: dense multi-member runs get the open-list hit target;
   *  dense singletons (lone sub-4px ticks) get the loneDense hit floor
   *  in the component. */
  dense: boolean
}

export type MinimapLayout = {
  ticks: MinimapTick[]
  /** Clickability runs over the final laid-out ticks — ALL runs, singletons
   *  included (see the second pass at the end of computeMinimapLayout). */
  clusters: MinimapCluster[]
  /** Echoes the input railHeight for consumers (e.g. the tooltip side rule). */
  railHeight: number
  /** The uniform slot per prompt: railHeight / landmark count (0 when
   *  there are no prompts or the input is degenerate). Adjacent lines'
   *  centers sit exactly one slot apart, so computeTickHitBox's slot clamp
   *  is the non-overlap guarantee for hit boxes. */
  slotHeight: number
}

export function computeMinimapLayout(input: {
  scrollHeight: number
  railHeight: number
  landmarks: readonly MinimapLandmark[]
}): MinimapLayout {
  if (input.scrollHeight <= 0 || input.railHeight <= 0) {
    return { ticks: [], clusters: [], railHeight: 0, slotHeight: 0 }
  }
  const scale = input.railHeight / input.scrollHeight
  const sorted = [...input.landmarks].sort((a, b) => a.offsetTop - b.offsetTop || a.index - b.index)
  // One uniform slot per prompt, independent of offsetTop. No prompts ->
  // no slots: 0 keeps the field finite (never NaN/Infinity).
  const slotHeight = sorted.length > 0 ? input.railHeight / sorted.length : 0
  // Under density the minimum line height thins — sub-pixel allowed, no
  // pixel floor — so every prompt keeps a DISTINCT slot: two lines never
  // share a y-range, so no line ever occludes another's paint or hit-test.
  const effectiveMinTickHeight = slotHeight > 0
    ? Math.min(MINIMAP_MIN_TICK_HEIGHT_PX, slotHeight)
    : MINIMAP_MIN_TICK_HEIGHT_PX

  // Line rect per prompt: height proportional to the turn's size
  // (landmark.height * scale), floored at the density-thinned minimum and
  // capped one pixel below the slot so a >= 1px gap remains between
  // adjacent lines whenever the floor allows it (h == slot only when the
  // thinned floor already fills the slot). The line centers in its slot.
  const ticks = sorted.map((mark, i) => {
    const height = Math.min(
      Math.max(slotHeight - 1, effectiveMinTickHeight),
      Math.max(effectiveMinTickHeight, mark.height * scale),
    )
    const top = i * slotHeight + (slotHeight - height) / 2
    return { index: mark.index, label: mark.label, top, height }
  })

  // Clickability pass — a SECOND pass over the final laid-out ticks: a
  // cluster is a maximal run of consecutive ticks where each next tick
  // begins within its predecessor's minimum click row
  // (ticks[i + 1].top < ticks[i].top + MINIMAP_TICK_MIN_CLICKABLE_PX).
  // Under even spacing the line-center pitch is exactly one slot, so a
  // sub-4px slot joins EVERY consecutive pair — dense transcripts
  // naturally form one all-prompts mega-run whose bounded 60vh open-list
  // menu handles any count — while a slot >= 4 joins nothing. ALL runs
  // are listed (singletons included); `dense` marks any sub-clickable
  // member.
  const clusters: MinimapCluster[] = []
  for (let k = 0; k < ticks.length; k++) {
    const runStart = k
    while (
      k + 1 < ticks.length &&
      ticks[k + 1].top < ticks[k].top + MINIMAP_TICK_MIN_CLICKABLE_PX
    ) {
      k++
    }
    clusters.push({
      top: ticks[runStart].top,
      height: ticks[k].top + ticks[k].height - ticks[runStart].top,
      startIndex: runStart,
      endIndex: k,
      dense: ticks.slice(runStart, k + 1).some((tick) => tick.height < MINIMAP_TICK_MIN_CLICKABLE_PX),
    })
  }

  return {
    ticks,
    clusters,
    railHeight: input.railHeight,
    slotHeight,
  }
}

/** Vertical hit box for a tick: 2x the line height, centered on the line's
 *  center, so the line gets 50% of its height as padding on each side.
 *  Clamped so a hit never overlaps a neighbor's: each box's half-span stays
 *  within its uniform slot (adjacent centers are slot apart). A lone dense
 *  tick (clickability-run singleton with a sub-4px line) floors at the
 *  4px clickable minimum instead — isolation guarantees >= 4px pitch to both
 *  neighbors, so the floor still cannot overlap. Edges shrink (rail bounds). */
export function computeTickHitBox(
  tick: MinimapTick,
  slotHeight: number,
  railHeight: number,
  loneDense: boolean,
): { top: number; height: number } {
  const lineCenter = tick.top + tick.height / 2
  const grown = loneDense
    ? Math.max(2 * tick.height, MINIMAP_TICK_MIN_CLICKABLE_PX)
    : 2 * tick.height
  // The non-overlap guarantee: a hit can never exceed its uniform slot
  // (for loneDense the 4px floor already respects the pitch, but keep the
  // slot clamp too — the min only matters for pathological slots < 4
  // where isolation cannot exist anyway).
  const hitHeight = Math.min(grown, slotHeight)
  if (railHeight - hitHeight < 0) return { top: 0, height: railHeight }
  const top = Math.max(0, Math.min(lineCenter - hitHeight / 2, railHeight - hitHeight))
  return { top, height: hitHeight }
}
