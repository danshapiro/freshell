import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('App.tsx memoized callbacks', () => {
  const sourcePath = path.resolve(__dirname, '../../../../src/App.tsx')
  const source = fs.readFileSync(sourcePath, 'utf-8')

  it('has a useCallback wrapping the setView terminal call', () => {
    expect(source).toMatch(/useCallback\(\s*\(\)\s*=>\s*setView\(\s*['"]terminal['"]\s*\)/)
  })

  it('TabsView does not receive an inline arrow function for onOpenTab', () => {
    // Should not contain: <TabsView onOpenTab={() => setView('terminal')} />
    expect(source).not.toMatch(/<TabsView\s[^>]*onOpenTab=\{\(\)\s*=>\s*setView/)
  })

  it('OverviewView does not receive an inline arrow function for onOpenTab', () => {
    // Should not contain: <OverviewView onOpenTab={() => setView('terminal')} />
    expect(source).not.toMatch(/<OverviewView\s[^>]*onOpenTab=\{\(\)\s*=>\s*setView/)
  })

  it('both components receive the same memoized callback variable', () => {
    // Extract the variable name used for TabsView and OverviewView onOpenTab
    const tabsMatch = source.match(/<TabsView\s[^>]*onOpenTab=\{(\w+)\}/)
    const overviewMatch = source.match(/<OverviewView\s[^>]*onOpenTab=\{(\w+)\}/)
    expect(tabsMatch).not.toBeNull()
    expect(overviewMatch).not.toBeNull()
    expect(tabsMatch![1]).toBe(overviewMatch![1])
  })
})
