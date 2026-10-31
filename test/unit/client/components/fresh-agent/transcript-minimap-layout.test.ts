import { describe, expect, it } from 'vitest'
import {
  computeMinimapLayout,
  computeTickHitBox,
  MINIMAP_MIN_TICK_HEIGHT_PX,
  MINIMAP_TICK_HIT_LEFT_PX,
  MINIMAP_TICK_HIT_WIDTH_PX,
  MINIMAP_TICK_MIN_CLICKABLE_PX,
  type MinimapLandmark,
  type MinimapTick,
} from '@/components/fresh-agent/shared/transcript-minimap-layout'

function landmark(index: number, offsetTop: number, height = 100): MinimapLandmark {
  return { index, offsetTop, height, label: `Prompt ${index}` }
}

// Even-spacing reference arithmetic (transcript-minimap-layout.ts):
//   N     = landmark count (after the offsetTop/index sort)
//   slot  = railHeight / N                     — one uniform slot per prompt
//   scale = railHeight / scrollHeight           — line HEIGHTS only
//   em    = min(3, slot)                        — density-thinned line floor
//   h_i   = clamp(landmark_i.height * scale, em, max(slot - 1, em))
//   top_i = i * slot + (slot - h_i) / 2         — line centered in its slot
// Content offsets order the prompts but never place them: every prompt gets
// an equal slot regardless of where it sits in the transcript.

describe('computeMinimapLayout', () => {
  it('maps landmarks to uniform slot positions within the rail', () => {
    // rail 100, scrollHeight 2000 -> scale 0.05; N=3 -> slot 100/3 = 33.3̅;
    // em = min(3, 33.3̅) = 3; h = clamp(100*0.05 = 5, 3, max(32.3̅, 3)) = 5;
    // tops = i*33.3̅ + (33.3̅ - 5)/2 = i*33.3̅ + 14.1̅6 = 14.1̅6 / 47.5 / 80.8̅3.
    const layout = computeMinimapLayout({
      scrollHeight: 2000, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(2, 1000), landmark(4, 1900)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 2, 4])
    expect(layout.ticks[0].top).toBeCloseTo(14.1666667, 5)
    expect(layout.ticks[1].top).toBeCloseTo(47.5, 5)
    expect(layout.ticks[2].top).toBeCloseTo(80.8333333, 5)
    expect(layout.ticks[1].height).toBeCloseTo(5, 5)
    expect(layout.ticks[1].label).toBe('Prompt 2')
    expect(layout.railHeight).toBe(100)
    expect(layout.slotHeight).toBeCloseTo(100 / 3, 5)
  })

  it('enforces the minimum tick height for tiny turns', () => {
    // N=1 -> slot 100; 10 * 0.05 = 0.5px clamps up to the 3px floor,
    // centered in its slot at (100 - 3)/2 = 48.5.
    const layout = computeMinimapLayout({
      scrollHeight: 2000, railHeight: 100,
      landmarks: [landmark(0, 0, 10)],
    })
    expect(layout.ticks[0].height).toBe(MINIMAP_MIN_TICK_HEIGHT_PX)
  })

  it('gives every prompt an equal slot regardless of its transcript position', () => {
    // The old 3-colliding fixture: offsets 0/100/500 of a 10000px transcript
    // used to collide proportionally and pack at rail 0/3/6. Even spacing:
    // N=3 -> slot 33.3̅, scale 0.01, h = clamp(100*0.01 = 1, 3, 32.3̅) = 3,
    // tops = i*33.3̅ + 15.1̅6 — a uniform 33.3̅px pitch; the offsets order
    // the prompts but place nothing.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(1, 100), landmark(2, 500)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 1, 2])
    expect(layout.ticks[0].top).toBeCloseTo(15.1666667, 5)
    expect(layout.ticks[1].top).toBeCloseTo(48.5, 5)
    expect(layout.ticks[2].top).toBeCloseTo(81.8333333, 5)
    expect(layout.ticks[1].height).toBeCloseTo(3, 5)
    // Uniform pitch: every consecutive pair sits exactly one slot apart.
    expect(layout.ticks[1].top - layout.ticks[0].top).toBeCloseTo(layout.slotHeight, 5)
    expect(layout.ticks[2].top - layout.ticks[1].top).toBeCloseTo(layout.slotHeight, 5)
  })

  it('thins the minimum tick height under density so every prompt keeps a visible tick', () => {
    // rail 20, 10 landmarks: slot 2, em = min(3, 2) = 2; raw 100*(20/5000) =
    // 0.4 clamps to 2 (cap max(2 - 1, 2) = 2), so h = slot and every line
    // fills its slot exactly, centered at top 2i: 0, 2, ..., 18.
    const layout = computeMinimapLayout({
      scrollHeight: 5000, railHeight: 20,
      landmarks: Array.from({ length: 10 }, (_, i) => landmark(i, i * 100)),
    })
    expect(layout.ticks).toHaveLength(10)
    expect(layout.ticks.map((t) => t.top)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
  })

  it('never drops a landmark at absurd density — every tick keeps a distinct in-bounds slot', () => {
    // rail 20, 30 landmarks: slot 20/30 = 2/3, em = min(3, 2/3) = 2/3
    // (sub-pixel allowed), cap = max(2/3 - 1, 2/3) = 2/3; raw 100*(20/3000)
    // = 2/3 clamps to exactly 2/3 = slot. tops = i*2/3 — 30 distinct ticks,
    // monotonic, in-bounds. No two ticks share coordinates: nothing
    // occludes anything.
    const layout = computeMinimapLayout({
      scrollHeight: 3000, railHeight: 20,
      landmarks: Array.from({ length: 30 }, (_, i) => landmark(i, i * 100)),
    })
    expect(layout.ticks).toHaveLength(30)
    for (let i = 1; i < layout.ticks.length; i++) {
      expect(layout.ticks[i].top).toBeGreaterThan(layout.ticks[i - 1].top)
      expect(layout.ticks[i].top + layout.ticks[i].height).toBeLessThanOrEqual(20.000001)
    }
    expect(layout.ticks[29].height).toBeCloseTo(20 / 30, 5)
    expect(layout.ticks[29].top).toBeCloseTo(29 * (20 / 30), 5)
  })

  it('caps the line height at slot - 1 and centers it in the slot (a ≥1px gap survives)', () => {
    // rail 100, 2 huge prompts: slot 50, scale 100/500 = 0.2, raw 300*0.2 =
    // 60 clamps to cap max(50 - 1, 3) = 49. Lines center in their slots at
    // tops 0.5 / 50.5 — a full 1px gap between tick 0's bottom (49.5) and
    // tick 1's top (50.5). The old packer scaled this pair to 50/50 abutting.
    const layout = computeMinimapLayout({
      scrollHeight: 500, railHeight: 100,
      landmarks: [landmark(0, 0, 300), landmark(1, 250, 300)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 1])
    expect(layout.ticks[0].top).toBeCloseTo(0.5, 5)
    expect(layout.ticks[0].height).toBeCloseTo(49, 5)
    expect(layout.ticks[1].top).toBeCloseTo(50.5, 5)
    expect(layout.ticks[1].height).toBeCloseTo(49, 5)
  })

  it('spreads late-bunched prompts across uniform slots — no bunching at the rail bottom', () => {
    // The old locality fixture: one early prompt then five bunched at
    // offsets 9500..9900 of a 10000px transcript, which packed them all
    // near the rail bottom. Even spacing: N=6 -> slot 200/6 = 33.3̅, h =
    // clamp(100*0.02 = 2, 3, 32.3̅) = 3, tops = i*33.3̅ + 15.1̅6 — the five
    // late prompts share the SAME uniform pitch as the first, spread
    // across the whole rail.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, railHeight: 200,
      landmarks: [
        landmark(0, 0),
        landmark(1, 9500), landmark(2, 9600), landmark(3, 9700),
        landmark(4, 9800), landmark(5, 9900),
      ],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5])
    for (let i = 0; i < 6; i++) {
      expect(layout.ticks[i].top).toBeCloseTo(i * (200 / 6) + (200 / 6 - 3) / 2, 5)
      expect(layout.ticks[i].height).toBeCloseTo(3, 5)
    }
  })

  it('sorts unsorted landmarks by offsetTop (ties by index)', () => {
    // N=2 -> slot 50; h = clamp(100*0.05 = 5, 3, 49) = 5; tops i*50 + 22.5.
    const layout = computeMinimapLayout({
      scrollHeight: 2000, railHeight: 100,
      landmarks: [landmark(4, 1000), landmark(0, 0)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 4])
    expect(layout.ticks[0].top).toBeCloseTo(22.5, 5)
    expect(layout.ticks[1].top).toBeCloseTo(72.5, 5)
  })

  it('breaks offsetTop ties by landmark index (reversed input order)', () => {
    // Equal offsetTops (500/500): without the index tie-break, modern V8's
    // STABLE sort keeps the tied pair in INPUT order (2 before 1) and the
    // slot assignment would be [0, 2, 1]. Sorted [0, 1, 2] -> slots 0/1/2
    // (h = clamp(100*0.05 = 5, 3, 32.3̅) = 5, tops i*33.3̅ + 14.1̅6).
    const layout = computeMinimapLayout({
      scrollHeight: 2000, railHeight: 100,
      landmarks: [landmark(2, 500), landmark(1, 500), landmark(0, 0)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 1, 2])
    expect(layout.ticks[1].top).toBeCloseTo(47.5, 5)
    expect(layout.ticks[2].top).toBeCloseTo(80.8333333, 5)
  })

  it('keeps 3px-floor ticks on the even grid as dense singleton runs (no joins at slot 33.3̅)', () => {
    // The 3-colliding fixture under even spacing: line tops 15.1̅6 / 48.5 /
    // 81.8̅3 at 3px heights. The clickability pass (a second pass over the
    // FINAL ticks) joins a next tick that begins within its predecessor's
    // 4px click row — 48.5 >= 15.1̅6 + 4 and 81.8̅3 >= 48.5 + 4, so NO
    // joins: three singleton runs, each dense (3 < 4) — lone sub-4px
    // ticks, the geometry the component's loneDense hit path serves.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(1, 100), landmark(2, 500)],
    })
    expect(layout.clusters).toHaveLength(3)
    layout.clusters.forEach((cluster, i) => {
      expect(cluster.startIndex).toBe(i)
      expect(cluster.endIndex).toBe(i)
      expect(cluster.top).toBeCloseTo([15.1666667, 48.5, 81.8333333][i], 5)
      expect(cluster.height).toBeCloseTo(3, 5)
      expect(cluster.dense).toBe(true)
    })
  })

  it('keeps individually-clickable ticks as separate non-dense runs', () => {
    // 49px lines in 50px slots: tops 0.5 / 50.5 — 50.5 >= 0.5 + 4, so the
    // clickability pass does not join them: two singleton runs, each
    // comfortably clickable (49 >= 4) — no open-list affordance.
    const layout = computeMinimapLayout({
      scrollHeight: 500, railHeight: 100,
      landmarks: [landmark(0, 0, 300), landmark(1, 250, 300)],
    })
    expect(layout.clusters).toEqual([
      { top: 0.5, height: 49, startIndex: 0, endIndex: 0, dense: false },
      { top: 50.5, height: 49, startIndex: 1, endIndex: 1, dense: false },
    ])
  })

  it('treats the clickable floor as inclusive — 4px ticks stay directly clickable', () => {
    // scale 0.04, N=2 -> slot 50: 100px turns land exactly at the 4px
    // floor, centered at tops 23 / 73. 73 >= 23 + 4 -> no join; each
    // singleton run is dense: false (dense is strictly-below the floor).
    // A 75px turn (3px) in the same geometry stays separate too, but its
    // singleton run is dense: a lone sub-4px tick.
    const atFloor = computeMinimapLayout({
      scrollHeight: 2500, railHeight: 100,
      landmarks: [landmark(0, 0, 100), landmark(1, 10, 100)],
    })
    expect(atFloor.ticks[0].height).toBeCloseTo(MINIMAP_TICK_MIN_CLICKABLE_PX, 5)
    expect(atFloor.clusters).toEqual([
      { top: 23, height: 4, startIndex: 0, endIndex: 0, dense: false },
      { top: 73, height: 4, startIndex: 1, endIndex: 1, dense: false },
    ])

    const belowFloor = computeMinimapLayout({
      scrollHeight: 2500, railHeight: 100,
      landmarks: [landmark(0, 0, 100), landmark(1, 10, 75)],
    })
    expect(belowFloor.clusters[1].dense).toBe(true)
  })

  it('reports singleton clusters for non-colliding ticks (never dense) and none for degenerate inputs', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 2000, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(2, 1000), landmark(4, 1900)],
    })
    expect(layout.clusters).toHaveLength(3)
    layout.clusters.forEach((cluster, i) => {
      expect(cluster.startIndex).toBe(i)
      expect(cluster.endIndex).toBe(i)
      expect(cluster.top).toBeCloseTo([14.1666667, 47.5, 80.8333333][i], 5)
      expect(cluster.height).toBeCloseTo(5, 5)
      expect(cluster.dense).toBe(false)
    })

    const degenerate = computeMinimapLayout({
      scrollHeight: 0, railHeight: 100,
      landmarks: [landmark(0, 0)],
    })
    expect(degenerate.clusters).toEqual([])
  })

  it('collapses absurd density into ONE dense run — 30 sub-pixel ticks, every join satisfied', () => {
    // rail 20, 30 landmarks: slot 2/3 < 4, so the clickability pass joins
    // EVERY consecutive pair — the whole rail is ONE run, startIndex 0..
    // endIndex 29, dense (every 2/3px member is sub-4px). Under even
    // spacing a dense transcript naturally forms one all-prompts mega-run
    // whose bounded 60vh open-list menu handles any count.
    const layout = computeMinimapLayout({
      scrollHeight: 3000, railHeight: 20,
      landmarks: Array.from({ length: 30 }, (_, i) => landmark(i, i * 100)),
    })
    expect(layout.clusters).toHaveLength(1)
    expect(layout.clusters[0].startIndex).toBe(0)
    expect(layout.clusters[0].endIndex).toBe(29)
    expect(layout.clusters[0].dense).toBe(true)
    expect(layout.clusters[0].top).toBeCloseTo(0, 5)
    expect(layout.clusters[0].height).toBeCloseTo(20, 5)
  })

  it('keeps evenly-dense isolated ticks as dense singletons — every lone sub-4px tick is its own run', () => {
    // rail 200, 50 landmarks: slot 4, em = min(3, 4) = 3, cap =
    // max(4 - 1, 3) = 3, h = clamp(150*0.02 = 3, 3, 3) = 3, tops =
    // i*4 + (4 - 3)/2 = 4i + 0.5. The clickability pass joins NOTHING
    // (4.5 < 4.5 is false) — 50 singleton clusters, each dense (3 < 4):
    // lone sub-4px ticks, the geometry the component's loneDense hit
    // path is built for.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, railHeight: 200,
      landmarks: Array.from({ length: 50 }, (_, i) => landmark(i, i * 200, 150)),
    })
    expect(layout.clusters).toHaveLength(50)
    layout.clusters.forEach((cluster, i) => {
      expect(cluster.startIndex).toBe(i)
      expect(cluster.endIndex).toBe(i)
      expect(cluster.top).toBeCloseTo(i * 4 + 0.5, 5)
      expect(cluster.height).toBeCloseTo(3, 5)
      expect(cluster.dense).toBe(true)
    })
  })

  it('keeps a single landmark', () => {
    // N=1 -> slot 100: the 5px line centers in its slot at (100 - 5)/2 = 47.5.
    const layout = computeMinimapLayout({
      scrollHeight: 2000, railHeight: 100,
      landmarks: [landmark(2, 1000)],
    })
    expect(layout.ticks).toHaveLength(1)
    expect(layout.ticks[0].top).toBeCloseTo(47.5, 5)
  })

  it('keeps an out-of-range offsetTop in bounds — slot placement ignores the transcript position', () => {
    // offsetTop 2100 would map proportionally to 105 > rail 100; even
    // spacing never reads it for placement — the lone prompt centers in
    // its slot at (100 - 5)/2 = 47.5, in-bounds by construction.
    const layout = computeMinimapLayout({
      scrollHeight: 2000, railHeight: 100,
      landmarks: [landmark(6, 2100)],
    })
    expect(layout.ticks[0].top).toBeCloseTo(47.5, 5)
    expect(layout.ticks[0].top + layout.ticks[0].height).toBeLessThanOrEqual(100)
  })

  it('returns no ticks or slots for empty landmarks', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 1000, railHeight: 100,
      landmarks: [],
    })
    expect(layout.ticks).toEqual([])
    // No prompts -> no slots; 0 keeps the field finite (never NaN/Infinity).
    expect(layout.slotHeight).toBe(0)
  })

  it('returns empty geometry for degenerate inputs', () => {
    for (const input of [
      { scrollHeight: 0, railHeight: 100 },
      { scrollHeight: 1000, railHeight: 0 },
    ]) {
      const layout = computeMinimapLayout({ ...input, landmarks: [landmark(0, 0)] })
      expect(layout.ticks).toEqual([])
      expect(layout.railHeight).toBe(0)
      expect(layout.slotHeight).toBe(0)
    }
  })

  it('keeps a large landmark within its slot', () => {
    // The lone landmark's line: slot 100, raw 150*(100/150) = 100 clamps to cap
    // max(100 - 1, 3) = 99, centered at top 0.5.
    const layout = computeMinimapLayout({
      scrollHeight: 150, railHeight: 100,
      landmarks: [landmark(0, 0, 150)],
    })
    expect(layout.ticks[0].top).toBeCloseTo(0.5, 5)
    expect(layout.ticks[0].height).toBeCloseTo(99, 5)
  })
})

describe('computeTickHitBox', () => {
  it('sizes the hit box at 2x the line height, centered on the line', () => {
    // Line top 30, height 10 -> center 35; hit 2*10 = 20 fits the 50px
    // slot; top = 35 - 10 = 25. The line gets 50% of its height as padding
    // on each side.
    const box = computeTickHitBox({ index: 0, label: '', top: 30, height: 10 }, 50, 200, false)
    expect(box).toEqual({ top: 25, height: 20 })
  })

  it('exports the horizontal hit growth constants (12px rail + 50% padding per side)', () => {
    expect(MINIMAP_TICK_HIT_WIDTH_PX).toBe(18)
    expect(MINIMAP_TICK_HIT_LEFT_PX).toBe(-3)
  })

  it('clamps the hit height to the slot so adjacent boxes abut, never overlap', () => {
    // Two 8px lines in 10px slots (tops 1 / 11): each 2x hit (16) clamps
    // to its slot (10), centering on the line centers 5 / 15 -> boxes
    // {0, 10} and {10, 10}: box 0's bottom (10) is exactly box 1's top —
    // the non-overlap guarantee, with the line still centered in each.
    const tickA: MinimapTick = { index: 0, label: '', top: 1, height: 8 }
    const tickB: MinimapTick = { index: 1, label: '', top: 11, height: 8 }
    const boxA = computeTickHitBox(tickA, 10, 100, false)
    const boxB = computeTickHitBox(tickB, 10, 100, false)
    expect(boxA).toEqual({ top: 0, height: 10 })
    expect(boxB).toEqual({ top: 10, height: 10 })
    expect(boxA.top + boxA.height).toBeLessThanOrEqual(boxB.top)
  })

  it('proves the abut-not-overlap rule across a whole dense layout', () => {
    // The 50-tick even grid (slot 4, h 3, tops 4i + 0.5): every hit box is
    // slot-clamped to {4i, 4} — every adjacent pair abuts exactly and no
    // box escapes the rail.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, railHeight: 200,
      landmarks: Array.from({ length: 50 }, (_, i) => landmark(i, i * 200, 150)),
    })
    let prev: { top: number; height: number } | null = null
    for (const tick of layout.ticks) {
      const box = computeTickHitBox(tick, layout.slotHeight, layout.railHeight, false)
      expect(box.height).toBeLessThanOrEqual(layout.slotHeight + 1e-9)
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.top + box.height).toBeLessThanOrEqual(layout.railHeight + 1e-9)
      if (prev) expect(prev.top + prev.height).toBeLessThanOrEqual(box.top + 1e-9)
      prev = box
    }
  })

  it('floors a lone dense tick at the 4px clickable minimum instead of 2x', () => {
    // A lone dense tick is an isolated clickability singleton: isolation
    // guarantees >= 4px pitch to both neighbors, so the 4px floor can
    // never overlap. A 3px line's 2x hit (6) already exceeds the floor...
    const tall = computeTickHitBox({ index: 0, label: '', top: 20, height: 3 }, 10, 100, true)
    expect(tall).toEqual({ top: 18.5, height: 6 })
    // ...but a 1px line's 2x hit (2) floors UP to 4: line center 20.5 ->
    // top 18.5. (The 10px slot clamp stays inert above both.)
    const tiny = computeTickHitBox({ index: 0, label: '', top: 20, height: 1 }, 10, 100, true)
    expect(tiny).toEqual({ top: 18.5, height: 4 })
  })

  it('shrinks the box at the rail edges instead of overflowing', () => {
    // Bottom edge: a 2px line at top 8 (center 9) wants a 4px box at top
    // 7, but 7 + 4 > rail 10 — the box shrinks to railHeight - hitHeight
    // = 6, keeping its bottom at the rail edge.
    const bottom = computeTickHitBox({ index: 0, label: '', top: 8, height: 2 }, 4, 10, false)
    expect(bottom).toEqual({ top: 6, height: 4 })
    // Top edge: a 2px line at top 0 wants its box at -1; it shrinks to 0.
    const topEdge = computeTickHitBox({ index: 0, label: '', top: 0, height: 2 }, 4, 10, false)
    expect(topEdge).toEqual({ top: 0, height: 4 })
  })

  it('returns the whole rail when the hit exceeds a degenerate tiny rail', () => {
    // Pathological slot/rail (a hit taller than the rail itself): the box
    // degenerates to the full rail rather than a negative-height rect.
    const box = computeTickHitBox({ index: 0, label: '', top: 1, height: 2 }, 5, 3, false)
    expect(box).toEqual({ top: 0, height: 3 })
  })
})
