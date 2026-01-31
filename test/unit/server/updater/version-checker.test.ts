// test/unit/server/updater/version-checker.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkForUpdate, parseVersion, isNewerVersion, GitHubReleaseSchema } from '../../../../server/updater/version-checker.js'

describe('version-checker', () => {
  describe('parseVersion', () => {
    it('strips v prefix from version string', () => {
      expect(parseVersion('v1.2.3')).toBe('1.2.3')
    })

    it('returns version unchanged if no prefix', () => {
      expect(parseVersion('1.2.3')).toBe('1.2.3')
    })
  })

  describe('isNewerVersion', () => {
    it('returns true when remote is newer major', () => {
      expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true)
    })

    it('returns true when remote is newer minor', () => {
      expect(isNewerVersion('1.0.0', '1.1.0')).toBe(true)
    })

    it('returns true when remote is newer patch', () => {
      expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true)
    })

    it('returns false when versions are equal', () => {
      expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
    })

    it('returns false when local is newer', () => {
      expect(isNewerVersion('2.0.0', '1.0.0')).toBe(false)
    })

    // Edge cases for two-part versions
    it('handles two-part versions (treats missing patch as 0)', () => {
      expect(isNewerVersion('1.0', '1.0.1')).toBe(true)
      expect(isNewerVersion('1.0.0', '1.1')).toBe(true)
      expect(isNewerVersion('1.0', '1.0')).toBe(false)
    })

    it('handles single-part versions (treats missing minor/patch as 0)', () => {
      expect(isNewerVersion('1', '2')).toBe(true)
      expect(isNewerVersion('1', '1.0.0')).toBe(false)
      expect(isNewerVersion('1.0.0', '2')).toBe(true)
    })

    // Edge cases for malformed versions (non-numeric parts treated as 0)
    it('treats non-numeric version parts as 0', () => {
      // "x" becomes 0, so "1.x.0" is treated as "1.0.0"
      expect(isNewerVersion('1.x.0', '1.1.0')).toBe(true)
      expect(isNewerVersion('1.0.0', '1.x.0')).toBe(false)
    })

    it('handles completely malformed versions gracefully', () => {
      // "abc" becomes 0.0.0
      expect(isNewerVersion('abc', '1.0.0')).toBe(true)
      expect(isNewerVersion('1.0.0', 'abc')).toBe(false)
    })

    it('handles empty string as 0.0.0', () => {
      expect(isNewerVersion('', '0.0.1')).toBe(true)
      expect(isNewerVersion('', '')).toBe(false)
    })
  })

  describe('checkForUpdate', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn())
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('returns updateAvailable: true when remote version is newer', async () => {
      const mockRelease = {
        tag_name: 'v1.1.0',
        html_url: 'https://github.com/danshapiro/freshell/releases/tag/v1.1.0',
        published_at: '2026-01-29T00:00:00Z',
        body: 'Release notes'
      }

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockRelease)
      } as Response)

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(true)
      expect(result.currentVersion).toBe('0.1.0')
      expect(result.latestVersion).toBe('1.1.0')
      expect(result.releaseUrl).toBe('https://github.com/danshapiro/freshell/releases/tag/v1.1.0')
      expect(result.error).toBeNull()
    })

    it('returns updateAvailable: false when versions match', async () => {
      const mockRelease = {
        tag_name: 'v0.1.0',
        html_url: 'https://github.com/danshapiro/freshell/releases/tag/v0.1.0',
        published_at: '2026-01-29T00:00:00Z',
        body: 'Release notes'
      }

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockRelease)
      } as Response)

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(false)
      expect(result.latestVersion).toBe('0.1.0')
    })

    it('returns error when fetch fails', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 404
      } as Response)

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(false)
      expect(result.error).toContain('404')
    })

    it('returns error when network fails', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'))

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(false)
      expect(result.error).toBe('Network error')
    })

    it('returns error when GitHub API response is invalid', async () => {
      const invalidResponse = {
        // missing required fields
        tag_name: 'v1.0.0'
        // html_url is missing
      }

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(invalidResponse)
      } as Response)

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(false)
      expect(result.error).toContain('Invalid GitHub API response')
    })

    it('returns error when GitHub API response has wrong types', async () => {
      const invalidResponse = {
        tag_name: 123, // should be string
        html_url: 'not-a-url', // should be valid URL
        published_at: '2026-01-29T00:00:00Z',
        body: 'Release notes'
      }

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(invalidResponse)
      } as Response)

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(false)
      expect(result.error).toContain('Invalid GitHub API response')
    })

    it('handles non-Error thrown objects', async () => {
      vi.mocked(global.fetch).mockRejectedValue('string error')

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(false)
      expect(result.error).toBe('string error')
    })
  })

  describe('GitHubReleaseSchema', () => {
    it('validates a correct release object', () => {
      const validRelease = {
        tag_name: 'v1.0.0',
        html_url: 'https://github.com/danshapiro/freshell/releases/tag/v1.0.0',
        published_at: '2026-01-29T00:00:00Z',
        body: 'Release notes'
      }

      const result = GitHubReleaseSchema.safeParse(validRelease)
      expect(result.success).toBe(true)
    })

    it('rejects release with missing fields', () => {
      const invalidRelease = {
        tag_name: 'v1.0.0'
      }

      const result = GitHubReleaseSchema.safeParse(invalidRelease)
      expect(result.success).toBe(false)
    })

    it('rejects release with invalid URL', () => {
      const invalidRelease = {
        tag_name: 'v1.0.0',
        html_url: 'not-a-valid-url',
        published_at: '2026-01-29T00:00:00Z',
        body: 'Release notes'
      }

      const result = GitHubReleaseSchema.safeParse(invalidRelease)
      expect(result.success).toBe(false)
    })
  })
})
