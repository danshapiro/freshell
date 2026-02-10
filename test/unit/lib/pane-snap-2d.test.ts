import { describe, it, expect } from 'vitest'
import {
  snap2D,
  computeDividerSegments,
  findIntersections,
} from '../../../src/lib/pane-snap'
import type { PaneNode } from '../../../src/store/paneTypes'
import type { DividerSegment } from '../../../src/lib/pane-snap'

// Helper to create a leaf node
function leaf(id: string): PaneNode {
  return {
    type: 'leaf',
    id,
    content: { kind: 'picker' },
  }
}

// Helper to create a horizontal split (left|right children, vertical divider bar)
function hSplit(
  id: string,
  sizes: [number, number],
  children: [PaneNode, PaneNode],
): PaneNode {
  return {
    type: 'split',
    id,
    direction: 'horizontal',
    sizes,
    children,
  }
}

// Helper to create a vertical split (top|bottom children, horizontal divider bar)
function vSplit(
  id: string,
  sizes: [number, number],
  children: [PaneNode, PaneNode],
): PaneNode {
  return {
    type: 'split',
    id,
    direction: 'vertical',
    sizes,
    children,
  }
}

describe('snap2D', () => {
  it('returns current when shift held', () => {
    const result = snap2D(55, 60, 50, 50, 4, true)
    expect(result).toEqual({ x: 55, y: 60 })
  })

  it('snaps X to original when within threshold', () => {
    const result = snap2D(52, 60, 50, 50, 4, false)
    expect(result).toEqual({ x: 50, y: 60 })
  })

  it('snaps Y to original when within threshold', () => {
    const result = snap2D(60, 52, 50, 50, 4, false)
    expect(result).toEqual({ x: 60, y: 50 })
  })

  it('snaps both X and Y independently', () => {
    const result = snap2D(51, 49, 50, 50, 4, false)
    expect(result).toEqual({ x: 50, y: 50 })
  })

  it('no snap when outside threshold', () => {
    const result = snap2D(60, 60, 50, 50, 4, false)
    expect(result).toEqual({ x: 60, y: 60 })
  })

  it('returns current when threshold is 0', () => {
    const result = snap2D(51, 49, 50, 50, 0, false)
    expect(result).toEqual({ x: 51, y: 49 })
  })

  it('handles exact threshold boundary', () => {
    const result = snap2D(54, 46, 50, 50, 4, false)
    expect(result).toEqual({ x: 50, y: 50 })
  })

  it('does not snap just beyond threshold', () => {
    const result = snap2D(54.1, 45.9, 50, 50, 4, false)
    expect(result).toEqual({ x: 54.1, y: 45.9 })
  })
})

describe('computeDividerSegments', () => {
  it('returns empty for leaf node', () => {
    expect(computeDividerSegments(leaf('a'), 800, 600)).toEqual([])
  })

  it('computes segment for single horizontal split', () => {
    // H-split(A, B) with sizes [60, 40] in 800x600 container
    // Divider: vertical bar at X=480 (60% of 800), from Y=0 to Y=600
    const root = hSplit('s1', [60, 40], [leaf('a'), leaf('b')])
    const segments = computeDividerSegments(root, 800, 600)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual({
      splitId: 's1',
      direction: 'horizontal',
      position: 480,
      start: 0,
      end: 600,
    })
  })

  it('computes segment for single vertical split', () => {
    // V-split(A, B) with sizes [50, 50] in 800x600 container
    // Divider: horizontal bar at Y=300 (50% of 600), from X=0 to X=800
    const root = vSplit('s1', [50, 50], [leaf('a'), leaf('b')])
    const segments = computeDividerSegments(root, 800, 600)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual({
      splitId: 's1',
      direction: 'vertical',
      position: 300,
      start: 0,
      end: 800,
    })
  })

  it('computes nested segments with correct absolute positions', () => {
    // V-split(H-split(A, B), H-split(C, D))  -- a 2x2 grid
    // sizes all [50, 50], container 800x600
    //
    // The outer V-split creates a horizontal bar at Y=300, X=0..800
    // Top H-split creates a vertical bar at X=400, Y=0..300
    // Bottom H-split creates a vertical bar at X=400, Y=300..600
    const root = vSplit('v1', [50, 50], [
      hSplit('h1', [50, 50], [leaf('a'), leaf('b')]),
      hSplit('h2', [50, 50], [leaf('c'), leaf('d')]),
    ])
    const segments = computeDividerSegments(root, 800, 600)
    expect(segments).toHaveLength(3)

    // Find by splitId for stable assertions
    const v1Seg = segments.find(s => s.splitId === 'v1')!
    const h1Seg = segments.find(s => s.splitId === 'h1')!
    const h2Seg = segments.find(s => s.splitId === 'h2')!

    // V-split: horizontal bar at Y=300, from X=0 to X=800
    expect(v1Seg).toEqual({
      splitId: 'v1',
      direction: 'vertical',
      position: 300,
      start: 0,
      end: 800,
    })

    // Top H-split: vertical bar at X=400, from Y=0 to Y=300
    expect(h1Seg).toEqual({
      splitId: 'h1',
      direction: 'horizontal',
      position: 400,
      start: 0,
      end: 300,
    })

    // Bottom H-split: vertical bar at X=400, from Y=300 to Y=600
    expect(h2Seg).toEqual({
      splitId: 'h2',
      direction: 'horizontal',
      position: 400,
      start: 300,
      end: 600,
    })
  })

  it('computes segments for asymmetric nested layout', () => {
    // H-split [70, 30] (V-split [40, 60] (A, B), C) in 1000x500 container
    // H-split divider: vertical bar at X=700, Y=0..500
    // V-split divider: horizontal bar at Y=200 (40% of 500), X=0..700
    const root = hSplit('h1', [70, 30], [
      vSplit('v1', [40, 60], [leaf('a'), leaf('b')]),
      leaf('c'),
    ])
    const segments = computeDividerSegments(root, 1000, 500)
    expect(segments).toHaveLength(2)

    const h1Seg = segments.find(s => s.splitId === 'h1')!
    const v1Seg = segments.find(s => s.splitId === 'v1')!

    expect(h1Seg).toEqual({
      splitId: 'h1',
      direction: 'horizontal',
      position: 700,
      start: 0,
      end: 500,
    })

    expect(v1Seg).toEqual({
      splitId: 'v1',
      direction: 'vertical',
      position: 200,
      start: 0,
      end: 700,
    })
  })

  it('computes deeply nested segments', () => {
    // H-split [50, 50] (A, V-split [50, 50] (B, H-split [50, 50] (C, D)))
    // Container 800x600
    //
    // Outer H: vertical bar at X=400, Y=0..600
    // Inner V: horizontal bar at Y=300, X=400..800
    // Inner H: vertical bar at X=600 (400 + 50% of 400), Y=300..600
    const root = hSplit('h1', [50, 50], [
      leaf('a'),
      vSplit('v1', [50, 50], [
        leaf('b'),
        hSplit('h2', [50, 50], [leaf('c'), leaf('d')]),
      ]),
    ])
    const segments = computeDividerSegments(root, 800, 600)
    expect(segments).toHaveLength(3)

    const h1Seg = segments.find(s => s.splitId === 'h1')!
    const v1Seg = segments.find(s => s.splitId === 'v1')!
    const h2Seg = segments.find(s => s.splitId === 'h2')!

    expect(h1Seg).toEqual({
      splitId: 'h1',
      direction: 'horizontal',
      position: 400,
      start: 0,
      end: 600,
    })

    expect(v1Seg).toEqual({
      splitId: 'v1',
      direction: 'vertical',
      position: 300,
      start: 400,
      end: 800,
    })

    expect(h2Seg).toEqual({
      splitId: 'h2',
      direction: 'horizontal',
      position: 600,
      start: 300,
      end: 600,
    })
  })
})

describe('findIntersections', () => {
  it('returns empty when no segments cross', () => {
    // Single segment has nothing to cross with
    const segments: DividerSegment[] = [
      {
        splitId: 's1',
        direction: 'horizontal',
        position: 400,
        start: 0,
        end: 600,
      },
    ]
    expect(findIntersections(segments)).toEqual([])
  })

  it('returns empty when two segments have same direction', () => {
    // Two horizontal-split segments (both vertical bars) don't cross
    const segments: DividerSegment[] = [
      { splitId: 's1', direction: 'horizontal', position: 200, start: 0, end: 600 },
      { splitId: 's2', direction: 'horizontal', position: 400, start: 0, end: 600 },
    ]
    expect(findIntersections(segments)).toEqual([])
  })

  it('finds cross intersection in 2x2 grid', () => {
    // Vertical bar at X=400, Y=0..600 (from horizontal split)
    // Horizontal bar at Y=300, X=0..800 (from vertical split)
    // Intersection at (400, 300)
    const segments: DividerSegment[] = [
      { splitId: 's1', direction: 'horizontal', position: 400, start: 0, end: 600 },
      { splitId: 's2', direction: 'vertical', position: 300, start: 0, end: 800 },
    ]
    const intersections = findIntersections(segments)
    expect(intersections).toHaveLength(1)
    expect(intersections[0].x).toBe(400)
    expect(intersections[0].y).toBe(300)
    expect(intersections[0].splitIds).toContain('s1')
    expect(intersections[0].splitIds).toContain('s2')
  })

  it('does not find intersection when segments do not overlap', () => {
    // Vertical bar at X=400, Y=0..200 (from horizontal split, only in top region)
    // Horizontal bar at Y=300, X=0..800 (from vertical split)
    // Y=300 is NOT within Y=0..200, so no intersection
    const segments: DividerSegment[] = [
      { splitId: 's1', direction: 'horizontal', position: 400, start: 0, end: 200 },
      { splitId: 's2', direction: 'vertical', position: 300, start: 0, end: 800 },
    ]
    expect(findIntersections(segments)).toEqual([])
  })

  it('finds T-intersection where two bars meet at a boundary', () => {
    // Two vertical bars (from H-splits) that span different Y ranges,
    // both at X=400, meeting a horizontal bar at Y=300
    //
    // Top H-split bar: vertical bar at X=400, Y=0..300
    // Bottom H-split bar: vertical bar at X=400, Y=300..600
    // V-split bar: horizontal bar at Y=300, X=0..800
    //
    // Both H-split bars meet the V-split bar at (400, 300)
    const segments: DividerSegment[] = [
      { splitId: 'h1', direction: 'horizontal', position: 400, start: 0, end: 300 },
      { splitId: 'h2', direction: 'horizontal', position: 400, start: 300, end: 600 },
      { splitId: 'v1', direction: 'vertical', position: 300, start: 0, end: 800 },
    ]
    const intersections = findIntersections(segments)
    // h1 meets v1 at (400, 300) - Y=300 is at end of h1's range (touching boundary)
    // h2 meets v1 at (400, 300) - Y=300 is at start of h2's range (touching boundary)
    // These should be merged into one intersection at (400, 300) with all three splitIds
    expect(intersections).toHaveLength(1)
    expect(intersections[0].x).toBe(400)
    expect(intersections[0].y).toBe(300)
    expect(intersections[0].splitIds).toContain('h1')
    expect(intersections[0].splitIds).toContain('h2')
    expect(intersections[0].splitIds).toContain('v1')
  })

  it('finds multiple intersections in complex layout', () => {
    // A 2x3 grid scenario with one vertical bar and two horizontal bars
    // Vertical bar at X=400, Y=0..600
    // Horizontal bar at Y=200, X=0..800
    // Horizontal bar at Y=400, X=0..800
    // Intersections at (400, 200) and (400, 400)
    const segments: DividerSegment[] = [
      { splitId: 'h1', direction: 'horizontal', position: 400, start: 0, end: 600 },
      { splitId: 'v1', direction: 'vertical', position: 200, start: 0, end: 800 },
      { splitId: 'v2', direction: 'vertical', position: 400, start: 0, end: 800 },
    ]
    const intersections = findIntersections(segments)
    expect(intersections).toHaveLength(2)

    const sorted = [...intersections].sort((a, b) => a.y - b.y)
    expect(sorted[0].x).toBe(400)
    expect(sorted[0].y).toBe(200)
    expect(sorted[1].x).toBe(400)
    expect(sorted[1].y).toBe(400)
  })
})
