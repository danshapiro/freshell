import { describe, it, expect } from 'vitest'
import { snap1D, collectSameOrientationSizes, collectCollinearSnapTargets, convertThresholdToLocal } from '../../../src/lib/pane-snap'
import type { PaneNode } from '../../../src/store/paneTypes'

// Helper to create a leaf node
function leaf(id: string): PaneNode {
  return {
    type: 'leaf',
    id,
    content: { kind: 'picker' },
  }
}

describe('snap1D', () => {
  it('returns currentPercent when no snap targets are nearby', () => {
    expect(snap1D(65, 50, [], 4, false)).toBe(65)
  })

  it('snaps to original position when within threshold', () => {
    expect(snap1D(52, 50, [], 4, false)).toBe(50)
  })

  it('does not snap to original when outside threshold', () => {
    expect(snap1D(55, 50, [], 4, false)).toBe(55)
  })

  it('snaps to collinear seam when within threshold', () => {
    expect(snap1D(68, 50, [70], 4, false)).toBe(70)
  })

  it('does not snap to collinear seam when outside threshold', () => {
    expect(snap1D(60, 50, [70], 4, false)).toBe(60)
  })

  it('prefers nearest target when both original and collinear are in range', () => {
    // original=50, collinear=52, current=51 → original is 1 away, collinear is 1 away
    // tie goes to... let's test with unequal distances
    expect(snap1D(51, 50, [53], 4, false)).toBe(50) // original is 1 away, collinear is 2 away
  })

  it('prefers collinear when it is closer than original', () => {
    expect(snap1D(52, 50, [53], 4, false)).toBe(53) // original is 2 away, collinear is 1 away
  })

  it('bypasses all snapping when shift is held', () => {
    expect(snap1D(52, 50, [53], 4, true)).toBe(52)
  })

  it('returns currentPercent when threshold is 0 (snapping disabled)', () => {
    expect(snap1D(52, 50, [53], 0, false)).toBe(52)
  })

  it('snaps to nearest target when multiple collinear positions are in range', () => {
    // current=46, original=50 (4 away = at threshold), collinear=45 (1 away)
    expect(snap1D(46, 50, [45], 4, false)).toBe(45) // collinear is closer
  })

  it('handles exact threshold boundary (snaps at exactly threshold distance)', () => {
    // current=54, original=50, threshold=4 → distance is exactly 4
    expect(snap1D(54, 50, [], 4, false)).toBe(50)
  })

  it('does not snap when distance is just beyond threshold', () => {
    // current=54.1, original=50, threshold=4 → distance is 4.1
    expect(snap1D(54.1, 50, [], 4, false)).toBe(54.1)
  })

  it('works with multiple collinear targets, picking the closest', () => {
    // current=62, targets at 60, 65, 70; threshold=4
    expect(snap1D(62, 50, [60, 65, 70], 4, false)).toBe(60) // 60 is 2 away, 65 is 3 away
  })
})

describe('collectSameOrientationSizes', () => {
  it('returns empty array for a leaf node', () => {
    expect(collectSameOrientationSizes(leaf('a'), 'horizontal', 'x')).toEqual([])
  })

  it('returns empty when the only split of matching orientation is excluded', () => {
    const root: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      sizes: [60, 40],
      children: [leaf('a'), leaf('b')],
    }
    expect(collectSameOrientationSizes(root, 'horizontal', 's1')).toEqual([])
  })

  it('collects sizes from splits of the same orientation, excluding the dragged one', () => {
    // V-split(H-split(A, B), H-split(C, D))
    const topH: PaneNode = {
      type: 'split',
      id: 'top',
      direction: 'horizontal',
      sizes: [60, 40],
      children: [leaf('a'), leaf('b')],
    }
    const botH: PaneNode = {
      type: 'split',
      id: 'bot',
      direction: 'horizontal',
      sizes: [30, 70],
      children: [leaf('c'), leaf('d')],
    }
    const root: PaneNode = {
      type: 'split',
      id: 'root',
      direction: 'vertical',
      sizes: [50, 50],
      children: [topH, botH],
    }
    // Dragging 'top' bar: should see bot's size (30)
    expect(collectSameOrientationSizes(root, 'horizontal', 'top')).toEqual([30])
  })

  it('excludes splits of different orientation', () => {
    const root: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'vertical',
      sizes: [50, 50],
      children: [leaf('a'), leaf('b')],
    }
    expect(collectSameOrientationSizes(root, 'horizontal', 'x')).toEqual([])
  })

  it('collects from deeply nested splits of matching orientation', () => {
    // H-split(V-split(H-split(A,B), C), D)
    const innerH: PaneNode = {
      type: 'split',
      id: 'inner-h',
      direction: 'horizontal',
      sizes: [40, 60],
      children: [leaf('a'), leaf('b')],
    }
    const innerV: PaneNode = {
      type: 'split',
      id: 'inner-v',
      direction: 'vertical',
      sizes: [50, 50],
      children: [innerH, leaf('c')],
    }
    const root: PaneNode = {
      type: 'split',
      id: 'root-h',
      direction: 'horizontal',
      sizes: [70, 30],
      children: [innerV, leaf('d')],
    }
    // Dragging root-h: should see inner-h's size (40)
    expect(collectSameOrientationSizes(root, 'horizontal', 'root-h')).toEqual([40])
    // Dragging inner-h: should see root-h's size (70)
    expect(collectSameOrientationSizes(root, 'horizontal', 'inner-h')).toEqual([70])
  })

  it('collects multiple sizes from several same-orientation splits', () => {
    // V(H(A,B), V(H(C,D), H(E,F)))
    const h1: PaneNode = {
      type: 'split',
      id: 'h1',
      direction: 'horizontal',
      sizes: [30, 70],
      children: [leaf('a'), leaf('b')],
    }
    const h2: PaneNode = {
      type: 'split',
      id: 'h2',
      direction: 'horizontal',
      sizes: [60, 40],
      children: [leaf('c'), leaf('d')],
    }
    const h3: PaneNode = {
      type: 'split',
      id: 'h3',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [leaf('e'), leaf('f')],
    }
    const innerV: PaneNode = {
      type: 'split',
      id: 'inner-v',
      direction: 'vertical',
      sizes: [50, 50],
      children: [h2, h3],
    }
    const root: PaneNode = {
      type: 'split',
      id: 'root-v',
      direction: 'vertical',
      sizes: [50, 50],
      children: [h1, innerV],
    }
    // Dragging h1: should see h2 (60) and h3 (50)
    const result = collectSameOrientationSizes(root, 'horizontal', 'h1')
    expect(result).toEqual(expect.arrayContaining([60, 50]))
    expect(result).toHaveLength(2)
  })
})

describe('collectCollinearSnapTargets', () => {
  it('returns empty array for a leaf node', () => {
    expect(collectCollinearSnapTargets(leaf('a'), 'horizontal', 'x', 800, 600)).toEqual([])
  })

  it('returns empty when the only split of matching orientation is excluded', () => {
    const root: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      sizes: [60, 40],
      children: [leaf('a'), leaf('b')],
    }
    expect(collectCollinearSnapTargets(root, 'horizontal', 's1', 800, 600)).toEqual([])
  })

  it('converts nested split positions to dragged split local coordinates', () => {
    // H-split [70, 30] (V-split [50, 50] (H-split [40, 60] (A, B), C), D)
    // Container: 1000x500
    // root-h divider at X=700 (70% of 1000), full container
    // inner-h divider at X=280 (40% of 700), within the left 70% of container
    //
    // When dragging root-h, inner-h is at pixel 280.
    // root-h's parent container is the full 1000px.
    // local % = (280 / 1000) * 100 = 28%
    //
    // Old collectSameOrientationSizes would return 40 (wrong — that's inner-h's local %)
    const innerH: PaneNode = {
      type: 'split',
      id: 'inner-h',
      direction: 'horizontal',
      sizes: [40, 60],
      children: [leaf('a'), leaf('b')],
    }
    const innerV: PaneNode = {
      type: 'split',
      id: 'inner-v',
      direction: 'vertical',
      sizes: [50, 50],
      children: [innerH, leaf('c')],
    }
    const root: PaneNode = {
      type: 'split',
      id: 'root-h',
      direction: 'horizontal',
      sizes: [70, 30],
      children: [innerV, leaf('d')],
    }

    const targets = collectCollinearSnapTargets(root, 'horizontal', 'root-h', 1000, 500)
    // inner-h at pixel 280 → 28% of root-h's 1000px container
    expect(targets).toHaveLength(1)
    expect(targets[0]).toBeCloseTo(28, 5)
  })

  it('converts root position to nested split local coordinates', () => {
    // Same layout as above, but dragging inner-h
    // root-h divider at pixel 700 (70% of 1000)
    // inner-h's parent container is the left 70%: 700px wide, starting at x=0
    // local % = (700 / 700) * 100 = 100% — outside the valid 0-100 range, excluded
    const innerH: PaneNode = {
      type: 'split',
      id: 'inner-h',
      direction: 'horizontal',
      sizes: [40, 60],
      children: [leaf('a'), leaf('b')],
    }
    const innerV: PaneNode = {
      type: 'split',
      id: 'inner-v',
      direction: 'vertical',
      sizes: [50, 50],
      children: [innerH, leaf('c')],
    }
    const root: PaneNode = {
      type: 'split',
      id: 'root-h',
      direction: 'horizontal',
      sizes: [70, 30],
      children: [innerV, leaf('d')],
    }

    const targets = collectCollinearSnapTargets(root, 'horizontal', 'inner-h', 1000, 500)
    // root-h at pixel 700, inner-h parent is 700px wide starting at 0
    // 700/700 = 100% → at boundary, excluded (> 0 && < 100)
    expect(targets).toHaveLength(0)
  })

  it('produces correct targets for sibling same-orientation splits', () => {
    // V-split [50, 50] (H-split [60, 40] (A, B), H-split [30, 70] (C, D))
    // Container: 800x600
    // top H-split divider at pixel 480 (60% of 800), within top 300px
    // bot H-split divider at pixel 240 (30% of 800), within bottom 300px
    //
    // Both H-splits share the same parent container width (800px)
    // Dragging top: bot at 240px → (240/800)*100 = 30% local — matches because
    //   the sibling H-splits are at the same nesting level
    const topH: PaneNode = {
      type: 'split',
      id: 'top-h',
      direction: 'horizontal',
      sizes: [60, 40],
      children: [leaf('a'), leaf('b')],
    }
    const botH: PaneNode = {
      type: 'split',
      id: 'bot-h',
      direction: 'horizontal',
      sizes: [30, 70],
      children: [leaf('c'), leaf('d')],
    }
    const root: PaneNode = {
      type: 'split',
      id: 'root-v',
      direction: 'vertical',
      sizes: [50, 50],
      children: [topH, botH],
    }

    const targets = collectCollinearSnapTargets(root, 'horizontal', 'top-h', 800, 600)
    // bot-h at pixel 240 → (240/800)*100 = 30% in top-h's coordinate space
    expect(targets).toHaveLength(1)
    expect(targets[0]).toBeCloseTo(30, 5)
  })

  it('excludes targets outside the 0-100% valid range', () => {
    // H-split [50, 50] (A, H-split [50, 50] (B, C))
    // Container: 1000x500
    // outer divider at 500px
    // inner divider at 750px (50% of right 500px = 250px + 500px)
    //
    // Dragging inner: outer at pixel 500.
    // inner's parent is 500px starting at x=500.
    // (500 - 500) / 500 * 100 = 0% — at boundary, excluded
    const innerH: PaneNode = {
      type: 'split',
      id: 'inner-h',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [leaf('b'), leaf('c')],
    }
    const root: PaneNode = {
      type: 'split',
      id: 'outer-h',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [leaf('a'), innerH],
    }

    const targets = collectCollinearSnapTargets(root, 'horizontal', 'inner-h', 1000, 500)
    // outer-h at 500px. inner-h parent starts at 500px, width 500px.
    // (500 - 500) / 500 * 100 = 0% → excluded (must be > 0)
    expect(targets).toHaveLength(0)
  })
})

describe('convertThresholdToLocal', () => {
  it('converts threshold for square container', () => {
    // 4% of min(600, 600) = 24px. Local split axis is 600px.
    // 24/600 * 100 = 4%
    expect(convertThresholdToLocal(4, 600, 600, 600)).toBeCloseTo(4, 5)
  })

  it('converts threshold for wide container on horizontal axis', () => {
    // 4% of min(1200, 600) = 4% of 600 = 24px. Local split axis is 1200px.
    // 24/1200 * 100 = 2%
    expect(convertThresholdToLocal(4, 1200, 600, 1200)).toBeCloseTo(2, 5)
  })

  it('converts threshold for wide container on vertical axis', () => {
    // 4% of min(1200, 600) = 4% of 600 = 24px. Local split axis is 600px.
    // 24/600 * 100 = 4%
    expect(convertThresholdToLocal(4, 1200, 600, 600)).toBeCloseTo(4, 5)
  })

  it('converts threshold for nested split with smaller axis', () => {
    // 4% of min(800, 600) = 4% of 600 = 24px. Nested split axis is 400px.
    // 24/400 * 100 = 6%
    expect(convertThresholdToLocal(4, 800, 600, 400)).toBeCloseTo(6, 5)
  })

  it('returns 0 when split axis size is 0', () => {
    expect(convertThresholdToLocal(4, 800, 600, 0)).toBe(0)
  })

  it('returns 0 when threshold is 0 (disabled)', () => {
    expect(convertThresholdToLocal(0, 800, 600, 800)).toBe(0)
  })
})
