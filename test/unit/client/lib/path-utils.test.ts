import { describe, expect, it } from 'vitest'
import { isImageFilePath, findLocalFilePaths } from '@/lib/path-utils'

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

describe('isImageFilePath', () => {
  it('detects common image extensions case-insensitively', () => {
    expect(isImageFilePath('/tmp/shot.png')).toBe(true)
    expect(isImageFilePath('~/Pictures/Photo.JPG')).toBe(true)
    expect(isImageFilePath('/repo/assets/icon.SvG')).toBe(true)
    expect(isImageFilePath('C:\\img\\logo.webp')).toBe(true)
    expect(isImageFilePath('/x/a.avif')).toBe(true)
    expect(isImageFilePath('/x/a.bmp')).toBe(true)
    expect(isImageFilePath('/x/a.ico')).toBe(true)
  })

  it('rejects text-like, extensionless, and dotfile paths', () => {
    expect(isImageFilePath('/tmp/example.txt')).toBe(false)
    expect(isImageFilePath('/src/index.ts')).toBe(false)
    expect(isImageFilePath('/x/Makefile')).toBe(false)
    expect(isImageFilePath('/x/archive.png.bak')).toBe(false)
    expect(isImageFilePath('/x/.png')).toBe(false)
  })
})
