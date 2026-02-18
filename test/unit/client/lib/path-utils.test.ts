import { describe, expect, it } from 'vitest'
import { findLocalFilePaths } from '@/lib/path-utils'

function extractPaths(line: string): string[] {
  return findLocalFilePaths(line).map((m) => m.path)
}

describe('findLocalFilePaths', () => {
  it('detects tilde and absolute local paths in one line', () => {
    const line = 'Open ~/work/app.ts then inspect /var/log/system.log.'
    expect(extractPaths(line)).toEqual(['~/work/app.ts', '/var/log/system.log'])
  })

  it('skips URL paths and keeps real local paths', () => {
    const line = 'See https://example.com/docs/path plus /tmp/report.txt'
    expect(extractPaths(line)).toEqual(['/tmp/report.txt'])
  })

  it('strips trailing punctuation from path matches', () => {
    const line = 'Error at /tmp/build/output.txt, then retry.'
    expect(extractPaths(line)).toEqual(['/tmp/build/output.txt'])
  })

  it('rejects root slash and single-segment absolute words without extension', () => {
    const line = 'ignore / and ignore /tmp but keep /tmp/data.json'
    expect(extractPaths(line)).toEqual(['/tmp/data.json'])
  })
})
