import { describe, it, expect } from 'vitest'
import { rewriteLocalhostUrl, isLoopbackHostname } from '@/lib/url-rewrite'

describe('isLoopbackHostname', () => {
  it('returns true for localhost', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
  })

  it('returns true for 127.0.0.1', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
  })

  it('returns true for ::1', () => {
    expect(isLoopbackHostname('::1')).toBe(true)
  })

  it('returns false for a LAN IP', () => {
    expect(isLoopbackHostname('192.168.1.100')).toBe(false)
  })

  it('returns false for a domain name', () => {
    expect(isLoopbackHostname('example.com')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isLoopbackHostname('')).toBe(false)
  })
})

describe('rewriteLocalhostUrl', () => {
  describe('when accessing from localhost (no rewrite needed)', () => {
    it('returns localhost URLs unchanged', () => {
      expect(rewriteLocalhostUrl('http://localhost:3000', 'localhost'))
        .toBe('http://localhost:3000')
    })

    it('returns 127.0.0.1 URLs unchanged', () => {
      expect(rewriteLocalhostUrl('http://127.0.0.1:3000', '127.0.0.1'))
        .toBe('http://127.0.0.1:3000')
    })

    it('returns ::1 URLs unchanged when accessing from ::1', () => {
      expect(rewriteLocalhostUrl('http://[::1]:3000', '::1'))
        .toBe('http://[::1]:3000')
    })
  })

  describe('when accessing remotely', () => {
    const remoteHost = '192.168.1.100'

    it('rewrites http://localhost:port to use the remote host', () => {
      expect(rewriteLocalhostUrl('http://localhost:3000', remoteHost))
        .toBe('http://192.168.1.100:3000/')
    })

    it('rewrites http://127.0.0.1:port to use the remote host', () => {
      expect(rewriteLocalhostUrl('http://127.0.0.1:3000', remoteHost))
        .toBe('http://192.168.1.100:3000/')
    })

    it('rewrites https://localhost:port to use the remote host', () => {
      expect(rewriteLocalhostUrl('https://localhost:3000', remoteHost))
        .toBe('https://192.168.1.100:3000/')
    })

    it('rewrites http://[::1]:port to use the remote host', () => {
      expect(rewriteLocalhostUrl('http://[::1]:3000', remoteHost))
        .toBe('http://192.168.1.100:3000/')
    })

    it('preserves path and query string', () => {
      expect(rewriteLocalhostUrl('http://localhost:3000/api/data?q=test&page=1', remoteHost))
        .toBe('http://192.168.1.100:3000/api/data?q=test&page=1')
    })

    it('preserves hash fragment', () => {
      expect(rewriteLocalhostUrl('http://localhost:3000/page#section', remoteHost))
        .toBe('http://192.168.1.100:3000/page#section')
    })

    it('handles localhost without explicit port', () => {
      expect(rewriteLocalhostUrl('http://localhost', remoteHost))
        .toBe('http://192.168.1.100/')
    })

    it('handles localhost with trailing path', () => {
      expect(rewriteLocalhostUrl('http://localhost:8080/index.html', remoteHost))
        .toBe('http://192.168.1.100:8080/index.html')
    })

    it('does not rewrite non-localhost URLs', () => {
      expect(rewriteLocalhostUrl('https://example.com/page', remoteHost))
        .toBe('https://example.com/page')
    })

    it('does not rewrite URLs with other hostnames', () => {
      expect(rewriteLocalhostUrl('http://10.0.0.5:3000', remoteHost))
        .toBe('http://10.0.0.5:3000')
    })

    it('returns invalid URLs unchanged', () => {
      expect(rewriteLocalhostUrl('not-a-url', remoteHost)).toBe('not-a-url')
    })

    it('returns empty string unchanged', () => {
      expect(rewriteLocalhostUrl('', remoteHost)).toBe('')
    })

    it('does not rewrite file:// URLs', () => {
      expect(rewriteLocalhostUrl('file:///home/user/index.html', remoteHost))
        .toBe('file:///home/user/index.html')
    })
  })
})
