import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('wsl-port-forward no sync imports', () => {
  const sourcePath = path.resolve(__dirname, '../../../server/wsl-port-forward.ts')
  const source = fs.readFileSync(sourcePath, 'utf-8')

  it('does not import execSync from child_process', () => {
    expect(source).not.toMatch(/import\s*\{[^}]*execSync[^}]*\}\s*from\s*['"]child_process['"]/)
  })

  it('does not import fs (sync variant)', () => {
    // Should not have: import fs from 'node:fs' or import fs from 'fs'
    // But should still have import fsp from 'node:fs/promises'
    expect(source).not.toMatch(/import\s+fs\s+from\s+['"]node:fs['"]/)
    expect(source).not.toMatch(/import\s+fs\s+from\s+['"]fs['"]/)
  })
})
