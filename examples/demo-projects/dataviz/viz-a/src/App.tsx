import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

// ─── Types ───────────────────────────────────────────────

interface Planet {
  name: string
  hostname: string
  ra: number
  dec: number
  discYear: number
  method: string
  facility: string
  radiusJ: number
  eqTemp: number
  distance: number
  massE: number
  orbPer: number
  numPlanets: number
  px: number
  py: number
}

// ─── Constants ───────────────────────────────────────────

const MIN_YEAR = 1992
const MAX_YEAR = 2026
const PLAYBACK_SPEED = 3

const TEMP_STOPS = [
  { t: 0, r: 20, g: 10, b: 80 },
  { t: 200, r: 50, g: 70, b: 210 },
  { t: 400, r: 70, g: 160, b: 255 },
  { t: 700, r: 160, g: 230, b: 240 },
  { t: 1000, r: 255, g: 255, b: 240 },
  { t: 1500, r: 255, g: 220, b: 120 },
  { t: 2500, r: 255, g: 140, b: 60 },
  { t: 4100, r: 255, g: 60, b: 30 },
]

const METHOD_COLORS: Record<string, [number, number, number]> = {
  Transit: [79, 195, 247],
  'Radial Velocity': [255, 112, 67],
  Microlensing: [186, 104, 200],
  Imaging: [102, 187, 106],
  'Transit Timing Variations': [255, 167, 38],
  'Eclipse Timing Variations': [236, 64, 122],
  'Orbital Brightness Modulation': [255, 241, 118],
  'Pulsar Timing': [38, 198, 218],
  Astrometry: [129, 199, 132],
  'Pulsation Timing Variations': [186, 104, 200],
  'Disk Kinematics': [144, 164, 174],
}

const METHOD_SHORT: Record<string, string> = {
  Transit: 'Transit',
  'Radial Velocity': 'Radial Vel.',
  Microlensing: 'Microlens.',
  Imaging: 'Imaging',
  'Transit Timing Variations': 'TTV',
  'Eclipse Timing Variations': 'ETV',
  'Orbital Brightness Modulation': 'OBM',
  'Pulsar Timing': 'Pulsar',
  Astrometry: 'Astrometry',
  'Pulsation Timing Variations': 'Puls. TV',
  'Disk Kinematics': 'Disk Kin.',
}

// ─── Helpers ─────────────────────────────────────────────

function parseCSV(text: string): Planet[] {
  const lines = text.trim().split('\n')
  const headers = lines[0].split(',')
  const col = (name: string) => headers.indexOf(name)

  const c = {
    name: col('pl_name'),
    host: col('hostname'),
    ra: col('ra'),
    dec: col('dec'),
    year: col('disc_year'),
    method: col('discoverymethod'),
    facility: col('disc_facility'),
    radj: col('pl_radj'),
    eqt: col('pl_eqt'),
    dist: col('sy_dist'),
    masse: col('pl_bmasse'),
    orbper: col('pl_orbper'),
    npln: col('sy_pnum'),
  }

  return lines
    .slice(1)
    .map((line) => {
      const v = line.split(',')
      const num = (i: number) => {
        const val = parseFloat(v[i])
        return isNaN(val) ? 0 : val
      }
      const maybe = (i: number) =>
        v[i] !== '' && v[i] !== undefined ? parseFloat(v[i]) : NaN

      const ra = num(c.ra)
      const dec = num(c.dec)
      const [px, py] = hammer(ra, dec)

      return {
        name: v[c.name] || '',
        hostname: v[c.host] || '',
        ra,
        dec,
        discYear: num(c.year),
        method: v[c.method] || '',
        facility: v[c.facility] || '',
        radiusJ: maybe(c.radj),
        eqTemp: maybe(c.eqt),
        distance: maybe(c.dist),
        massE: maybe(c.masse),
        orbPer: maybe(c.orbper),
        numPlanets: num(c.npln),
        px,
        py,
      }
    })
    .filter((p) => (p.ra !== 0 || p.dec !== 0) && p.discYear > 0)
}

function hammer(raDeg: number, decDeg: number): [number, number] {
  let lon = raDeg > 180 ? raDeg - 360 : raDeg
  lon = (-lon * Math.PI) / 180
  const lat = (decDeg * Math.PI) / 180

  const cosLat = Math.cos(lat)
  const z = Math.sqrt(1 + cosLat * Math.cos(lon / 2))

  return [
    (2 * Math.SQRT2 * cosLat * Math.sin(lon / 2)) / z,
    (Math.SQRT2 * Math.sin(lat)) / z,
  ]
}

function tempToRGB(temp: number): [number, number, number] {
  if (isNaN(temp)) return [120, 120, 140]
  const t = Math.max(
    TEMP_STOPS[0].t,
    Math.min(TEMP_STOPS[TEMP_STOPS.length - 1].t, temp),
  )
  for (let i = 0; i < TEMP_STOPS.length - 1; i++) {
    if (t <= TEMP_STOPS[i + 1].t) {
      const f =
        (t - TEMP_STOPS[i].t) / (TEMP_STOPS[i + 1].t - TEMP_STOPS[i].t)
      return [
        Math.round(TEMP_STOPS[i].r + f * (TEMP_STOPS[i + 1].r - TEMP_STOPS[i].r)),
        Math.round(TEMP_STOPS[i].g + f * (TEMP_STOPS[i + 1].g - TEMP_STOPS[i].g)),
        Math.round(TEMP_STOPS[i].b + f * (TEMP_STOPS[i + 1].b - TEMP_STOPS[i].b)),
      ]
    }
  }
  const last = TEMP_STOPS[TEMP_STOPS.length - 1]
  return [last.r, last.g, last.b]
}

function methodToRGB(method: string): [number, number, number] {
  return METHOD_COLORS[method] || [120, 130, 150]
}

function dotSize(radiusJ: number): number {
  if (isNaN(radiusJ)) return 1.5
  return 1.2 + Math.log10(1 + radiusJ * 8) * 2
}

// Seeded PRNG for deterministic background stars
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── App ─────────────────────────────────────────────────

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [planets, setPlanets] = useState<Planet[]>([])
  const [allMethods, setAllMethods] = useState<string[]>([])
  const [enabledMethods, setEnabledMethods] = useState<Set<string>>(new Set())
  const [animYear, setAnimYear] = useState(MAX_YEAR)
  const [playing, setPlaying] = useState(false)
  const [colorMode, setColorMode] = useState<'temperature' | 'method'>(
    'temperature',
  )
  const [hovered, setHovered] = useState<Planet | null>(null)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [dims, setDims] = useState({
    w: window.innerWidth,
    h: window.innerHeight,
  })

  const animRef = useRef(0)
  const playStartRef = useRef({ time: 0, year: 0 })
  const bgStarsRef = useRef<{ x: number; y: number; b: number; s: number }[]>(
    [],
  )

  // ─── Load data ───
  useEffect(() => {
    fetch('./exoplanets.csv')
      .then((r) => r.text())
      .then((text) => {
        const parsed = parseCSV(text)
        setPlanets(parsed)

        const methods = [...new Set(parsed.map((p) => p.method))].filter(
          Boolean,
        )
        methods.sort(
          (a, b) =>
            parsed.filter((p) => p.method === b).length -
            parsed.filter((p) => p.method === a).length,
        )
        setAllMethods(methods)
        setEnabledMethods(new Set(methods))
      })
  }, [])

  // ─── Resize ───
  useEffect(() => {
    const onResize = () =>
      setDims({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ─── Playback ───
  useEffect(() => {
    if (!playing) return

    playStartRef.current = { time: performance.now(), year: animYear }

    const tick = (now: number) => {
      const elapsed = (now - playStartRef.current.time) / 1000
      const newYear = playStartRef.current.year + elapsed * PLAYBACK_SPEED

      if (newYear >= MAX_YEAR) {
        setAnimYear(MAX_YEAR)
        setPlaying(false)
        return
      }

      setAnimYear(newYear)
      animRef.current = requestAnimationFrame(tick)
    }

    animRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  // ─── Canvas rendering ───
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = window.devicePixelRatio || 1
    const w = dims.w
    const h = dims.h
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'

    const ctx = canvas.getContext('2d')!
    ctx.save()
    ctx.scale(dpr, dpr)

    // Background
    ctx.fillStyle = '#040410'
    ctx.fillRect(0, 0, w, h)

    // Background star field
    if (bgStarsRef.current.length === 0) {
      const rng = mulberry32(42)
      for (let i = 0; i < 3000; i++) {
        bgStarsRef.current.push({
          x: rng(),
          y: rng(),
          b: rng() * 0.25 + 0.03,
          s: rng() < 0.05 ? 1.5 : 1,
        })
      }
    }
    for (const star of bgStarsRef.current) {
      ctx.fillStyle = `rgba(180, 190, 220, ${star.b})`
      ctx.fillRect(star.x * w, star.y * h, star.s, star.s)
    }

    // Projection layout
    const projW = 2 * Math.SQRT2
    const projH = Math.SQRT2
    const padding = 60
    const scale = Math.min(
      (w - padding * 2) / (2 * projW),
      (h - padding * 2) / (2 * projH),
    )
    const cx = w / 2
    const cy = h / 2

    const toScreen = (px: number, py: number): [number, number] => [
      cx + px * scale,
      cy - py * scale,
    ]

    // Outline ellipse
    ctx.strokeStyle = 'rgba(70, 90, 140, 0.25)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.ellipse(cx, cy, projW * scale, projH * scale, 0, 0, Math.PI * 2)
    ctx.stroke()

    // Fill projection area with slightly lighter bg
    ctx.fillStyle = 'rgba(10, 14, 30, 0.5)'
    ctx.beginPath()
    ctx.ellipse(cx, cy, projW * scale, projH * scale, 0, 0, Math.PI * 2)
    ctx.fill()

    // Graticule
    ctx.strokeStyle = 'rgba(60, 80, 130, 0.13)'
    ctx.lineWidth = 0.5

    // Latitude lines
    for (let dec = -60; dec <= 60; dec += 30) {
      ctx.beginPath()
      for (let ra = 0; ra <= 360; ra += 2) {
        const [px, py] = hammer(ra, dec)
        const [sx, sy] = toScreen(px, py)
        ra === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy)
      }
      ctx.stroke()
    }

    // Longitude lines
    for (let ra = 0; ra < 360; ra += 30) {
      ctx.beginPath()
      for (let dec = -90; dec <= 90; dec += 2) {
        const [px, py] = hammer(ra, dec)
        const [sx, sy] = toScreen(px, py)
        dec === -90 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy)
      }
      ctx.stroke()
    }

    // RA labels along equator
    ctx.fillStyle = 'rgba(100, 120, 170, 0.35)'
    ctx.font = '10px Inter, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let ra = 0; ra < 360; ra += 60) {
      const [px, py] = hammer(ra, 0)
      const [sx, sy] = toScreen(px, py)
      const hours = ra / 15
      ctx.fillText(`${hours}h`, sx, sy + 6)
    }

    // Dec labels
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (let dec = -60; dec <= 60; dec += 30) {
      if (dec === 0) continue
      const [px, py] = hammer(0, dec)
      const [sx, sy] = toScreen(px, py)
      ctx.fillText(`${dec > 0 ? '+' : ''}${dec}\u00b0`, sx - 8, sy)
    }

    // Filter planets
    const visible = planets.filter(
      (p) => p.discYear <= animYear && enabledMethods.has(p.method),
    )

    // Sort far → near (nearby on top)
    visible.sort((a, b) => {
      const da = isNaN(a.distance) ? 1e9 : a.distance
      const db = isNaN(b.distance) ? 1e9 : b.distance
      return db - da
    })

    // Glow pass (additive blending)
    ctx.globalCompositeOperation = 'lighter'
    for (const p of visible) {
      const [sx, sy] = toScreen(p.px, p.py)
      const rgb =
        colorMode === 'temperature'
          ? tempToRGB(p.eqTemp)
          : methodToRGB(p.method)
      const size = dotSize(p.radiusJ)
      const age = animYear - p.discYear
      const fadeIn = Math.min(1, age / 0.3)
      const alpha = fadeIn * 0.1

      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`
      ctx.beginPath()
      ctx.arc(sx, sy, size * 3.5, 0, Math.PI * 2)
      ctx.fill()
    }

    // Core dot pass
    ctx.globalCompositeOperation = 'source-over'
    for (const p of visible) {
      const [sx, sy] = toScreen(p.px, p.py)
      const rgb =
        colorMode === 'temperature'
          ? tempToRGB(p.eqTemp)
          : methodToRGB(p.method)
      const size = dotSize(p.radiusJ)
      const age = animYear - p.discYear
      const fadeIn = Math.min(1, age / 0.3)
      const distAlpha = isNaN(p.distance)
        ? 0.5
        : 0.35 +
          0.65 * Math.max(0, 1 - Math.log10(Math.max(1, p.distance)) / 4)
      const alpha = fadeIn * distAlpha

      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`
      ctx.beginPath()
      ctx.arc(sx, sy, size, 0, Math.PI * 2)
      ctx.fill()
    }

    // Hovered planet highlight
    if (hovered) {
      const [sx, sy] = toScreen(hovered.px, hovered.py)
      const size = dotSize(hovered.radiusJ)
      const rgb =
        colorMode === 'temperature'
          ? tempToRGB(hovered.eqTemp)
          : methodToRGB(hovered.method)

      // Bright glow
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, size * 6)
      grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.5)`)
      grad.addColorStop(0.4, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.15)`)
      grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(sx, sy, size * 6, 0, Math.PI * 2)
      ctx.fill()

      // Ring
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(sx, sy, size + 5, 0, Math.PI * 2)
      ctx.stroke()

      // Crosshair lines
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'
      ctx.lineWidth = 0.5
      const arm = 20
      ctx.beginPath()
      ctx.moveTo(sx - arm, sy)
      ctx.lineTo(sx - size - 8, sy)
      ctx.moveTo(sx + arm, sy)
      ctx.lineTo(sx + size + 8, sy)
      ctx.moveTo(sx, sy - arm)
      ctx.lineTo(sx, sy - size - 8)
      ctx.moveTo(sx, sy + arm)
      ctx.lineTo(sx, sy + size + 8)
      ctx.stroke()
    }

    ctx.restore()
  }, [planets, animYear, enabledMethods, colorMode, hovered, dims])

  // ─── Mouse hover ───
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (planets.length === 0) return

      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      setMousePos({ x: e.clientX, y: e.clientY })

      const w = dims.w
      const h = dims.h
      const projW = 2 * Math.SQRT2
      const projH = Math.SQRT2
      const padding = 60
      const scale = Math.min(
        (w - padding * 2) / (2 * projW),
        (h - padding * 2) / (2 * projH),
      )
      const cx = w / 2
      const cy = h / 2

      let closest: Planet | null = null
      let closestDist = 18

      for (const p of planets) {
        if (p.discYear > animYear || !enabledMethods.has(p.method)) continue
        const sx = cx + p.px * scale
        const sy = cy - p.py * scale
        const d = Math.hypot(mx - sx, my - sy)
        if (d < closestDist) {
          closest = p
          closestDist = d
        }
      }

      setHovered(closest)
    },
    [planets, animYear, enabledMethods, dims],
  )

  // ─── Stats ───
  const visibleCount = useMemo(
    () =>
      planets.filter(
        (p) => p.discYear <= animYear && enabledMethods.has(p.method),
      ).length,
    [planets, animYear, enabledMethods],
  )

  const displayYear = Math.floor(animYear)

  const toggleMethod = (method: string) => {
    setEnabledMethods((prev) => {
      const next = new Set(prev)
      if (next.has(method)) next.delete(method)
      else next.add(method)
      return next
    })
  }

  const handlePlay = () => {
    if (animYear >= MAX_YEAR) {
      setAnimYear(MIN_YEAR)
      setTimeout(() => setPlaying(true), 50)
    } else {
      setPlaying(!playing)
    }
  }

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPlaying(false)
    setAnimYear(parseInt(e.target.value))
  }

  // Tooltip clamping
  const ttLeft = Math.min(mousePos.x + 16, dims.w - 280)
  const ttTop = Math.min(mousePos.y - 10, dims.h - 300)

  return (
    <div className="app">
      <canvas
        ref={canvasRef}
        className="sky-canvas"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHovered(null)}
      />

      {/* ─── Title + Year ─── */}
      <div className="panel top-panel">
        <h1 className="title">Exoplanet Nightsky</h1>
        <p className="subtitle">
          {visibleCount.toLocaleString()} worlds &middot; Hammer-Aitoff
          projection
        </p>

        <div className="year-controls">
          <button className="play-btn" onClick={handlePlay}>
            {playing ? '\u23F8' : animYear >= MAX_YEAR ? '\u23EE' : '\u25B6'}
          </button>
          <input
            type="range"
            className="year-slider"
            min={MIN_YEAR}
            max={MAX_YEAR}
            value={displayYear}
            onChange={handleSlider}
          />
          <span className="year-label">{displayYear}</span>
        </div>
      </div>

      {/* ─── Filters ─── */}
      <div className="panel bottom-panel">
        <div className="color-toggle">
          <span className="panel-label">Color by</span>
          <button
            className={`toggle-btn ${colorMode === 'temperature' ? 'active' : ''}`}
            onClick={() => setColorMode('temperature')}
          >
            Temperature
          </button>
          <button
            className={`toggle-btn ${colorMode === 'method' ? 'active' : ''}`}
            onClick={() => setColorMode('method')}
          >
            Method
          </button>
        </div>

        <div className="method-filters">
          <span className="panel-label">Discovery method</span>
          <div className="method-list">
            {allMethods.map((m) => {
              const rgb = METHOD_COLORS[m] || [120, 130, 150]
              const count = planets.filter(
                (p) => p.method === m && p.discYear <= animYear,
              ).length
              return (
                <button
                  key={m}
                  className={`method-btn ${enabledMethods.has(m) ? 'active' : ''}`}
                  onClick={() => toggleMethod(m)}
                  style={{
                    borderColor: enabledMethods.has(m)
                      ? `rgb(${rgb.join(',')})`
                      : 'transparent',
                  }}
                >
                  <span
                    className="method-dot"
                    style={{ background: `rgb(${rgb.join(',')})` }}
                  />
                  {METHOD_SHORT[m] || m}
                  <span className="method-count">{count}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* ─── Temperature legend ─── */}
      {colorMode === 'temperature' && (
        <div className="panel legend-panel">
          <span className="panel-label">Equilibrium temperature</span>
          <div className="temp-gradient" />
          <div className="temp-labels">
            <span>100 K</span>
            <span>1000 K</span>
            <span>2500 K</span>
            <span>4000 K</span>
          </div>
        </div>
      )}

      {/* ─── Size legend ─── */}
      <div className="panel size-panel">
        <span className="panel-label">Planet radius</span>
        <div className="size-legend">
          {[0.05, 0.3, 1.0, 5.0].map((r) => (
            <div key={r} className="size-item">
              <div
                className="size-circle"
                style={{
                  width: dotSize(r) * 2,
                  height: dotSize(r) * 2,
                }}
              />
              <span>
                {r < 0.1
                  ? `${(r * 11.2).toFixed(1)} R\u2295`
                  : `${r} R\u2C7C`}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ─── Tooltip ─── */}
      {hovered && (
        <div
          className="tooltip"
          style={{ left: ttLeft, top: ttTop }}
        >
          <div className="tooltip-name">{hovered.name}</div>
          <div className="tooltip-host">Host: {hovered.hostname}</div>
          <div className="tooltip-row">
            <span>Discovered</span>
            <span>
              {hovered.discYear} &middot; {hovered.method}
            </span>
          </div>
          <div className="tooltip-row">
            <span>Facility</span>
            <span>{hovered.facility}</span>
          </div>
          {!isNaN(hovered.eqTemp) && (
            <div className="tooltip-row">
              <span>Eq. Temp</span>
              <span>{Math.round(hovered.eqTemp)} K</span>
            </div>
          )}
          {!isNaN(hovered.massE) && (
            <div className="tooltip-row">
              <span>Mass</span>
              <span>
                {hovered.massE < 100
                  ? hovered.massE.toFixed(1) + ' M\u2295'
                  : (hovered.massE / 317.8).toFixed(2) + ' M\u2C7C'}
              </span>
            </div>
          )}
          {!isNaN(hovered.radiusJ) && (
            <div className="tooltip-row">
              <span>Radius</span>
              <span>
                {hovered.radiusJ < 0.1
                  ? (hovered.radiusJ * 11.2).toFixed(1) + ' R\u2295'
                  : hovered.radiusJ.toFixed(2) + ' R\u2C7C'}
              </span>
            </div>
          )}
          {!isNaN(hovered.orbPer) && (
            <div className="tooltip-row">
              <span>Orbit</span>
              <span>
                {hovered.orbPer < 365
                  ? hovered.orbPer.toFixed(1) + ' days'
                  : (hovered.orbPer / 365.25).toFixed(1) + ' years'}
              </span>
            </div>
          )}
          {!isNaN(hovered.distance) && (
            <div className="tooltip-row">
              <span>Distance</span>
              <span>{hovered.distance.toFixed(1)} pc</span>
            </div>
          )}
          <div className="tooltip-row">
            <span>System</span>
            <span>
              {hovered.numPlanets} planet
              {hovered.numPlanets !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="tooltip-coords">
            RA {hovered.ra.toFixed(2)}\u00b0 &nbsp; Dec{' '}
            {hovered.dec >= 0 ? '+' : ''}
            {hovered.dec.toFixed(2)}\u00b0
          </div>
        </div>
      )}
    </div>
  )
}
