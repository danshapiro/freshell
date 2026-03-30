import { describe, expect, it } from 'vitest'
import { getLeafDirectoryName, matchTitleTierMetadata } from '../../../shared/session-title-search.js'

describe('getLeafDirectoryName', () => {
  it('extracts a POSIX leaf directory name and trims trailing separators', () => {
    expect(getLeafDirectoryName('/home/user/code/trycycle')).toBe('trycycle')
    expect(getLeafDirectoryName('/home/user/code/trycycle/')).toBe('trycycle')
  })

  it('extracts a Windows leaf directory name and trims trailing separators', () => {
    expect(getLeafDirectoryName('C:\\Users\\me\\code\\trycycle')).toBe('trycycle')
    expect(getLeafDirectoryName('C:\\Users\\me\\code\\trycycle\\')).toBe('trycycle')
  })
})

describe('matchTitleTierMetadata', () => {
  it('matches title metadata before directory, summary, and first-user-message metadata', () => {
    expect(matchTitleTierMetadata({
      title: 'Trycycle planning notes',
      projectPath: '/repo/trycycle',
      cwd: '/repo/work/trycycle',
      summary: 'Summary mentions trycycle too',
      firstUserMessage: 'Need help with trycycle rollout',
    }, 'trycycle')).toEqual({
      matchedIn: 'title',
      matchedValue: 'Trycycle planning notes',
    })
  })

  it('matches the indexed project-path leaf before a deeper cwd leaf and later metadata fields', () => {
    expect(matchTitleTierMetadata({
      title: 'Routine work',
      projectPath: '/repo/trycycle',
      cwd: '/repo/trycycle/server',
      summary: 'Summary mentions trycycle too',
      firstUserMessage: 'Need help with trycycle rollout',
    }, 'trycycle')).toEqual({
      matchedIn: 'title',
      matchedValue: 'trycycle',
    })
  })

  it('matches a distinct cwd leaf before summary and first-user-message metadata', () => {
    expect(matchTitleTierMetadata({
      title: 'Routine work',
      projectPath: '/repo/alpha',
      cwd: '/repo/alpha/trycycle',
      summary: 'Summary mentions trycycle too',
      firstUserMessage: 'Need help with trycycle rollout',
    }, 'trycycle')).toEqual({
      matchedIn: 'title',
      matchedValue: 'trycycle',
    })
  })

  it('matches summary metadata before first-user-message metadata', () => {
    expect(matchTitleTierMetadata({
      title: 'Routine work',
      summary: 'Summary mentions trycycle first',
      firstUserMessage: 'Trycycle also appears here',
    }, 'trycycle')).toEqual({
      matchedIn: 'summary',
      matchedValue: 'Summary mentions trycycle first',
    })
  })

  it('matches a cwd leaf for fallback-only metadata when no project path is available', () => {
    expect(matchTitleTierMetadata({
      cwd: '/repo/trycycle',
      firstUserMessage: 'No other metadata matches',
    }, 'trycycle')).toEqual({
      matchedIn: 'title',
      matchedValue: 'trycycle',
    })
  })

  it('returns a non-null metadata match for directory-only metadata', () => {
    expect(matchTitleTierMetadata({
      title: 'Routine work',
      projectPath: '/repo/trycycle',
    }, 'trycycle')).toEqual({
      matchedIn: 'title',
      matchedValue: 'trycycle',
    })
  })

  it('does not match ancestor-only path segments when no other metadata contains the query', () => {
    expect(matchTitleTierMetadata({
      title: 'Routine work',
      projectPath: '/home/user/code/trycycle',
      cwd: '/home/user/code/trycycle/server',
      summary: 'Summary without the search term',
      firstUserMessage: 'No match here either',
    }, 'code')).toBeNull()
  })
})
