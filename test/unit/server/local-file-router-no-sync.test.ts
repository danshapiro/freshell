import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('local-file-router no sync fs imports', () => {
  const sourcePath = path.resolve(__dirname, '../../../server/local-file-router.ts')
  const source = fs.readFileSync(sourcePath, 'utf-8')

  it('does not import fs from fs (sync)', () => {
    expect(source).not.toMatch(/import\s+fs\s+from\s+['"]fs['"]/)
  })

  it('does not contain existsSync', () => {
    expect(source).not.toContain('existsSync')
  })

  it('does not contain statSync', () => {
    expect(source).not.toContain('statSync')
  })

  it('imports from fs/promises', () => {
    expect(source).toMatch(/from\s+['"]fs\/promises['"]/)
  })
})
