import { describe, it, expect } from 'vitest'
import { findUrls } from '@/lib/url-utils'

describe('findUrls', () => {
  it('finds a simple https URL', () => {
    const results = findUrls('Visit https://example.com for info')
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ url: 'https://example.com', startIndex: 6, endIndex: 25 })
  })

  it('finds a simple http URL', () => {
    const results = findUrls('See http://example.org/page')
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ url: 'http://example.org/page', startIndex: 4, endIndex: 27 })
  })

  it('finds multiple URLs on one line', () => {
    const results = findUrls('Links: https://a.com and https://b.com/path')
    expect(results).toHaveLength(2)
    expect(results[0].url).toBe('https://a.com')
    expect(results[1].url).toBe('https://b.com/path')
  })

  it('strips trailing period from URL', () => {
    const results = findUrls('Go to https://example.com/path.')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/path')
  })

  it('strips trailing comma', () => {
    const results = findUrls('See https://example.com/path, then continue')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/path')
  })

  it('strips trailing semicolon', () => {
    const results = findUrls('URL: https://example.com;')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com')
  })

  it('strips trailing closing parenthesis', () => {
    const results = findUrls('(see https://example.com/page)')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/page')
  })

  it('strips trailing exclamation mark', () => {
    const results = findUrls('Check https://example.com!')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com')
  })

  it('preserves URL with query string', () => {
    const results = findUrls('https://example.com/search?q=test&page=1')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/search?q=test&page=1')
  })

  it('preserves URL with fragment', () => {
    const results = findUrls('https://example.com/docs#section-2')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/docs#section-2')
  })

  it('preserves URL with port number', () => {
    const results = findUrls('http://localhost:3000/api/health')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('http://localhost:3000/api/health')
  })

  it('preserves URL with path and trailing slash', () => {
    const results = findUrls('https://example.com/path/')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/path/')
  })

  it('returns empty array for line with no URLs', () => {
    expect(findUrls('Just a normal line of text')).toEqual([])
  })

  it('does not match ftp or other schemes', () => {
    expect(findUrls('Download from ftp://files.example.com/data')).toEqual([])
  })

  it('handles URL at start of line', () => {
    const results = findUrls('https://example.com is great')
    expect(results).toHaveLength(1)
    expect(results[0].startIndex).toBe(0)
  })

  it('handles URL at end of line', () => {
    const results = findUrls('Visit https://example.com')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com')
    expect(results[0].endIndex).toBe(25)
  })

  it('handles URL that is the entire line', () => {
    const line = 'https://example.com/path/to/resource'
    const results = findUrls(line)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe(line)
    expect(results[0].startIndex).toBe(0)
    expect(results[0].endIndex).toBe(line.length)
  })

  it('does not match bare domains without scheme', () => {
    expect(findUrls('Go to example.com for info')).toEqual([])
  })

  it('handles multiple trailing punctuation characters', () => {
    const results = findUrls('See https://example.com/page.),')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/page')
  })

  it('preserves URL with encoded characters', () => {
    const results = findUrls('https://example.com/path%20with%20spaces')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/path%20with%20spaces')
  })

  it('preserves balanced parentheses in Wikipedia-style URLs', () => {
    const results = findUrls('See https://en.wikipedia.org/wiki/Foo_(bar) for details')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })

  it('preserves nested balanced parentheses', () => {
    const results = findUrls('https://example.com/path_(a_(b))')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/path_(a_(b))')
  })

  it('strips unbalanced trailing paren when URL has no open paren', () => {
    const results = findUrls('(see https://example.com/page)')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/page')
  })

  it('strips trailing punctuation after balanced parens', () => {
    const results = findUrls('https://en.wikipedia.org/wiki/Foo_(bar).')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })
})
