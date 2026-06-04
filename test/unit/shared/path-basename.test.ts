import { describe, it, expect } from 'vitest'
import { basenameSegment } from '../../../shared/path-basename'

describe('basenameSegment', () => {
  it('returns the last segment of a unix path', () => {
    expect(basenameSegment('/home/dan/code/freshell')).toBe('freshell')
  })

  it('ignores trailing slashes', () => {
    expect(basenameSegment('/home/dan/code/freshell/')).toBe('freshell')
    expect(basenameSegment('/home/dan/code/freshell///')).toBe('freshell')
  })

  it('returns "/" for the unix root', () => {
    expect(basenameSegment('/')).toBe('/')
  })

  it('handles Windows paths and drive roots', () => {
    expect(basenameSegment('C:\\Users\\dan\\proj')).toBe('proj')
    expect(basenameSegment('C:\\')).toBe('C:\\')
    expect(basenameSegment('C:')).toBe('C:\\')
  })

  it('returns the segment for a bare name', () => {
    expect(basenameSegment('freshell')).toBe('freshell')
  })

  it('returns null for an empty string', () => {
    expect(basenameSegment('')).toBeNull()
  })
})
