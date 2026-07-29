import { useState } from 'react'
import { cn } from '@/lib/utils'

export interface RepoIconInfo {
  /** Canonical repo identity (repoRoot when known, else the cwd hint). */
  repoKey: string
  /** Display name — basename of the repo root (all worktrees share it). */
  repoName: string
  /** Set when the server reports a detected icon. */
  iconUrl?: string
}

interface RepoIconProps {
  info: RepoIconInfo
  className?: string
}

/** djb2 string hash -> stable hue in [0, 360). */
export function hueFromString(input: string): number {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 360
}

/**
 * Decorative repo identity icon: the repo's own icon via the server when
 * available, else a letter avatar (uppercase first letter on a circle with a
 * deterministic per-repo hue). Rendered ONLY via <img src> for server bytes —
 * remote SVG is never inlined into the DOM.
 */
export default function RepoIcon({ info, className }: RepoIconProps) {
  const [imgFailed, setImgFailed] = useState(false)
  if (info.iconUrl && !imgFailed) {
    return (
      <img
        src={info.iconUrl}
        alt=""
        aria-hidden="true"
        className={cn('shrink-0 rounded-[2px] object-contain', className)}
        onError={() => setImgFailed(true)}
      />
    )
  }
  const letter = (info.repoName.trim()[0] || '?').toUpperCase()
  // 60% saturation / 42% lightness keeps white text readable on the circle
  // in both light and dark themes.
  const hue = hueFromString(info.repoName)
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn('shrink-0', className)}>
      <circle cx="8" cy="8" r="8" fill={`hsl(${hue}, 60%, 42%)`} />
      {/*
        Optical centering: place the alphabetic baseline so the CAP box (the
        uppercase glyph spans baseline..cap-height ≈ 0.70em) is centered on the
        circle: y = 8 + (0.70 * 9) / 2 = 11.15. dominant-baseline="central" is
        deliberately NOT used — it centers the em box (which reserves empty
        descender space below a capital), rendering the letter ~1px low, and
        has cross-browser interop quirks.
      */}
      <text
        x="8"
        y="11.15"
        textAnchor="middle"
        fontSize="9"
        fontWeight="600"
        fill="white"
      >
        {letter}
      </text>
    </svg>
  )
}
