import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import RepoIcon, { hueFromString } from '@/components/icons/RepoIcon'

afterEach(cleanup)

describe('RepoIcon', () => {
  it('renders an <img> when iconUrl is provided', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell', iconUrl: '/api/repo-icon?cwd=%2Fr' }} className="h-3 w-3" />)
    const img = document.querySelector('img')!
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('/api/repo-icon?cwd=%2Fr')
    expect(img.getAttribute('aria-hidden')).toBe('true')
    expect(img.getAttribute('alt')).toBe('')
  })

  it('falls back to the letter avatar when the image errors', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell', iconUrl: '/api/repo-icon?cwd=%2Fr' }} />)
    fireEvent.error(document.querySelector('img')!)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('F')).toBeTruthy()
  })

  it('renders the uppercased first letter when no iconUrl', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell' }} />)
    expect(screen.getByText('F')).toBeTruthy()
    const svg = document.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('uses a deterministic hue per repo name', () => {
    expect(hueFromString('freshell')).toBe(hueFromString('freshell'))
    expect(hueFromString('freshell')).not.toBe(hueFromString('other-repo'))
    const h = hueFromString('anything at all')
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(360)
  })

  it('renders ? for an empty repo name', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: '' }} />)
    expect(screen.getByText('?')).toBeTruthy()
  })

  it('optically centers the letter (alphabetic baseline at cap-height/2 below center, no dominant-baseline)', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell' }} />)
    const text = document.querySelector('svg text')!
    expect(text).toBeTruthy()
    // Cap-centered placement: y = 8 (circle center) + (0.70 * 9)/2 = 11.15.
    expect(text.getAttribute('y')).toBe('11.15')
    // dominant-baseline must be gone: 'central' centers the em box, which sits
    // ~0.05em below a capital glyph's optical center and is a browser-interop hazard.
    expect(text.getAttribute('dominant-baseline')).toBeNull()
    expect(text.getAttribute('text-anchor')).toBe('middle')
  })
})
