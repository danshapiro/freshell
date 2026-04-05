import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('config-writer spin lock removal', () => {
  const sourcePath = path.resolve(__dirname, '../../../../server/mcp/config-writer.ts')
  const source = fs.readFileSync(sourcePath, 'utf-8')

  it('does not contain CPU-burning busy-wait pattern', () => {
    expect(source).not.toContain('while (Date.now()')
  })

  it('uses Atomics.wait for synchronous sleep', () => {
    expect(source).toContain('Atomics.wait')
  })
})
