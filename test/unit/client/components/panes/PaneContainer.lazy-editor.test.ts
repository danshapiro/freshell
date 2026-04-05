import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('PaneContainer lazy EditorPane import', () => {
  const sourcePath = path.resolve(__dirname, '../../../../../src/components/panes/PaneContainer.tsx')
  const source = fs.readFileSync(sourcePath, 'utf-8')

  it('uses React.lazy for EditorPane import', () => {
    expect(source).toMatch(/lazy\(\s*\(\)\s*=>\s*import\(\s*['"]\.\/EditorPane['"]\s*\)\s*\)/)
  })

  it('does not have a static import of EditorPane', () => {
    expect(source).not.toMatch(/^import\s+EditorPane\s+from\s+['"]\.\/EditorPane['"]/m)
  })

  it('wraps EditorPane in a Suspense boundary', () => {
    expect(source).toContain('<Suspense')
  })
})
