import { useEffect, useRef, useState, useCallback } from 'react'
import {
  forceSimulation,
  forceX,
  forceY,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'

/* ═══════════════════════════════════════════
   Types
   ═══════════════════════════════════════════ */
interface PlanetNode extends SimulationNodeDatum {
  id: number
  name: string
  hostname: string
  discYear: number
  method: string
  methodRaw: string
  rade: number
  masse: number
  eqt: number
  orbper: number
  orbsmax: number
  stTeff: number
  syDist: number
  syPnum: number
  sizeClass: string
  tempClass: string
  decade: string
  multClass: string
  vr: number
  color: string
  rgb: [number, number, number]
}

type GroupMode = 'size' | 'temperature' | 'method' | 'decade' | 'multiplicity'

/* ═══════════════════════════════════════════
   Constants & Config
   ═══════════════════════════════════════════ */
const SIZE_ORDER = ['Sub-Earth', 'Earth-like', 'Super-Earth', 'Sub-Neptune', 'Neptune-like', 'Gas Giant']
const TEMP_ORDER = ['Frozen', 'Cold', 'Temperate', 'Warm', 'Hot', 'Scorching', 'Unknown']
const METHOD_ORDER = ['Transit', 'Radial Velocity', 'Microlensing', 'Imaging', 'Other']
const DECADE_ORDER = ['1990s', '2000s', '2010s', '2020s']
const MULT_ORDER = ['Single', 'Binary', 'Triple', 'Rich (4+)']

const GROUP_META: Record<GroupMode, { order: string[]; label: string; desc: string }> = {
  size:          { order: SIZE_ORDER,   label: 'Physical Size',     desc: 'Grouped by planet radius relative to Earth and Neptune' },
  temperature:   { order: TEMP_ORDER,   label: 'Temperature',       desc: 'Grouped by equilibrium temperature zone' },
  method:        { order: METHOD_ORDER, label: 'Discovery Method',  desc: 'Grouped by the technique used to detect each world' },
  decade:        { order: DECADE_ORDER, label: 'Discovery Decade',  desc: 'Grouped by when each world was first confirmed' },
  multiplicity:  { order: MULT_ORDER,   label: 'System Size',       desc: 'Grouped by how many planets orbit the same star' },
}

function groupKey(p: PlanetNode, mode: GroupMode): string {
  switch (mode) {
    case 'size': return p.sizeClass
    case 'temperature': return p.tempClass
    case 'method': return p.method
    case 'decade': return p.decade
    case 'multiplicity': return p.multClass
  }
}

/* ═══════════════════════════════════════════
   Color: temperature → warm palette
   ═══════════════════════════════════════════ */
const TEMP_STOPS = [
  { t: 0,    r: 56,  g: 82,  b: 130 },
  { t: 250,  r: 69,  g: 123, b: 157 },
  { t: 450,  r: 109, g: 170, b: 122 },
  { t: 700,  r: 220, g: 196, b: 96  },
  { t: 1100, r: 234, g: 155, b: 82  },
  { t: 1800, r: 216, g: 96,  b: 68  },
  { t: 3500, r: 168, g: 38,  b: 48  },
]

function tempToRgb(temp: number): [number, number, number] {
  if (!temp || temp <= 0) return [175, 168, 155]
  const s = TEMP_STOPS
  if (temp <= s[0].t) return [s[0].r, s[0].g, s[0].b]
  if (temp >= s[s.length - 1].t) return [s[s.length - 1].r, s[s.length - 1].g, s[s.length - 1].b]
  for (let i = 0; i < s.length - 1; i++) {
    if (temp <= s[i + 1].t) {
      const f = (temp - s[i].t) / (s[i + 1].t - s[i].t)
      return [
        Math.round(s[i].r + f * (s[i + 1].r - s[i].r)),
        Math.round(s[i].g + f * (s[i + 1].g - s[i].g)),
        Math.round(s[i].b + f * (s[i + 1].b - s[i].b)),
      ]
    }
  }
  return [175, 168, 155]
}

/* ═══════════════════════════════════════════
   Classification helpers
   ═══════════════════════════════════════════ */
function classifySize(rade: number): string {
  if (rade < 0.5) return 'Sub-Earth'
  if (rade < 1.25) return 'Earth-like'
  if (rade < 2.5) return 'Super-Earth'
  if (rade < 5) return 'Sub-Neptune'
  if (rade < 10) return 'Neptune-like'
  return 'Gas Giant'
}

function classifyTemp(eqt: number): string {
  if (!eqt || eqt <= 0) return 'Unknown'
  if (eqt < 200) return 'Frozen'
  if (eqt < 350) return 'Cold'
  if (eqt < 450) return 'Temperate'
  if (eqt < 800) return 'Warm'
  if (eqt < 1500) return 'Hot'
  return 'Scorching'
}

function classifyDecade(year: number): string {
  if (year < 2000) return '1990s'
  if (year < 2010) return '2000s'
  if (year < 2020) return '2010s'
  return '2020s'
}

function classifyMult(n: number): string {
  if (n <= 1) return 'Single'
  if (n === 2) return 'Binary'
  if (n === 3) return 'Triple'
  return 'Rich (4+)'
}

function simplifyMethod(m: string): string {
  if (m === 'Transit' || m === 'Radial Velocity' || m === 'Microlensing' || m === 'Imaging') return m
  return 'Other'
}

/* ═══════════════════════════════════════════
   CSV parsing
   ═══════════════════════════════════════════ */
function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') q = false
      else cur += ch
    } else {
      if (ch === '"') q = true
      else if (ch === ',') { result.push(cur); cur = '' }
      else cur += ch
    }
  }
  result.push(cur)
  return result
}

async function loadData(): Promise<PlanetNode[]> {
  const resp = await fetch('./data/exoplanets-clean.csv')
  const text = await resp.text()
  const lines = text.split('\n')
  const headers = parseCSVLine(lines[0])
  const planets: PlanetNode[] = []

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const vals = parseCSVLine(lines[i])
    const r: Record<string, string> = {}
    headers.forEach((h, j) => (r[h] = vals[j] || ''))

    const rade = parseFloat(r.pl_rade) || 0
    if (!rade || !r.pl_name) continue

    const eqt = parseFloat(r.pl_eqt) || 0
    const rgb = tempToRgb(eqt)
    const discYear = parseInt(r.disc_year) || 0
    const syPnum = parseInt(r.sy_pnum) || 1

    planets.push({
      id: i,
      name: r.pl_name,
      hostname: r.hostname || '',
      discYear,
      method: simplifyMethod(r.discoverymethod || ''),
      methodRaw: r.discoverymethod || '',
      rade,
      masse: parseFloat(r.pl_bmasse) || 0,
      eqt,
      orbper: parseFloat(r.pl_orbper) || 0,
      orbsmax: parseFloat(r.pl_orbsmax) || 0,
      stTeff: parseFloat(r.st_teff) || 0,
      syDist: parseFloat(r.sy_dist) || 0,
      syPnum,
      sizeClass: classifySize(rade),
      tempClass: classifyTemp(eqt),
      decade: classifyDecade(discYear),
      multClass: classifyMult(syPnum),
      vr: Math.max(1.8, Math.min(10, Math.sqrt(rade) * 2.6)),
      color: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
      rgb,
      x: 0,
      y: 0,
    })
  }
  return planets
}

/* ═══════════════════════════════════════════
   Layout: compute cluster centers
   ═══════════════════════════════════════════ */
function computeCenters(order: string[], w: number, h: number): Map<string, { x: number; y: number }> {
  const m = new Map<string, { x: number; y: number }>()
  const n = order.length
  const px = w * 0.1
  const py = h * 0.15

  if (n <= 5) {
    const usable = w - px * 2
    order.forEach((name, i) => {
      m.set(name, { x: px + usable * (i + 0.5) / n, y: h * 0.5 })
    })
  } else {
    const cols = Math.ceil(n / 2)
    const usable = w - px * 2
    order.forEach((name, i) => {
      const row = i < cols ? 0 : 1
      const col = i < cols ? i : i - cols
      const rowN = row === 0 ? cols : n - cols
      m.set(name, {
        x: px + usable * (col + 0.5) / rowN,
        y: py + (h - py * 2) * (row === 0 ? 0.33 : 0.72),
      })
    })
  }
  return m
}

/* ═══════════════════════════════════════════
   Format helpers
   ═══════════════════════════════════════════ */
function fmtN(n: number, d = 1): string {
  if (!n && n !== 0) return '\u2014'
  return n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : n.toFixed(d)
}
function fmtPeriod(days: number): string {
  if (!days) return '\u2014'
  if (days < 1) return (days * 24).toFixed(1) + ' hours'
  if (days > 800) return (days / 365.25).toFixed(1) + ' years'
  return days.toFixed(1) + ' days'
}

/* ═══════════════════════════════════════════
   App
   ═══════════════════════════════════════════ */
export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simRef = useRef<Simulation<PlanetNode, never> | null>(null)
  const nodesRef = useRef<PlanetNode[]>([])
  const centersRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const countsRef = useRef<Map<string, number>>(new Map())

  const [mode, setMode] = useState<GroupMode>('size')
  const [hovered, setHovered] = useState<PlanetNode | null>(null)
  const [selected, setSelected] = useState<PlanetNode | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [total, setTotal] = useState(0)
  const [tipPos, setTipPos] = useState({ x: 0, y: 0 })

  /* ── Canvas render ── */
  const paint = useCallback((hovId: number) => {
    const cvs = canvasRef.current
    if (!cvs) return
    const ctx = cvs.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const w = cvs.width / dpr
    const h = cvs.height / dpr

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    // Cream background
    ctx.fillStyle = '#faf7f2'
    ctx.fillRect(0, 0, w, h)

    // Subtle dot grid
    ctx.fillStyle = 'rgba(195,185,170,0.22)'
    for (let gx = 32; gx < w; gx += 32) {
      for (let gy = 32; gy < h; gy += 32) {
        ctx.fillRect(gx, gy, 0.8, 0.8)
      }
    }

    const nodes = nodesRef.current

    // ── Draw bubbles ──
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i]
      const px = p.x!, py = p.y!, r = p.vr
      const [cr, cg, cb] = p.rgb
      const isHov = p.id === hovId

      // Hover glow
      if (isHov) {
        const g = ctx.createRadialGradient(px, py, r * 0.5, px, py, r * 4.5)
        g.addColorStop(0, `rgba(${cr},${cg},${cb},0.35)`)
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(px, py, r * 4.5, 0, Math.PI * 2)
        ctx.fill()
      }

      // Sphere gradient
      const g = ctx.createRadialGradient(px - r * 0.3, py - r * 0.35, r * 0.05, px, py, r)
      g.addColorStop(0, `rgb(${Math.min(255, cr + 55)},${Math.min(255, cg + 55)},${Math.min(255, cb + 55)})`)
      g.addColorStop(0.65, `rgb(${cr},${cg},${cb})`)
      g.addColorStop(1, `rgb(${Math.max(0, cr - 35)},${Math.max(0, cg - 35)},${Math.max(0, cb - 35)})`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(px, py, r, 0, Math.PI * 2)
      ctx.fill()

      // Hover ring
      if (isHov) {
        ctx.strokeStyle = '#2d2520'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }

    // ── Cluster labels ──
    const centers = centersRef.current
    const counts = countsRef.current
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'

    for (const [name, pos] of centers) {
      const count = counts.get(name) || 0
      if (!count) continue
      const cr = Math.sqrt(count) * 4 + 22

      ctx.font = '600 13px "IBM Plex Sans", system-ui, sans-serif'
      ctx.fillStyle = '#2d2520'
      ctx.fillText(name, pos.x, pos.y - cr - 14)

      ctx.font = '300 11px "IBM Plex Sans", system-ui, sans-serif'
      ctx.fillStyle = '#9a8e82'
      ctx.fillText(`${count.toLocaleString()}`, pos.x, pos.y - cr - 1)
    }

    ctx.restore()
  }, [])

  /* ── Resize canvas ── */
  const resize = useCallback((): { w: number; h: number } => {
    const cvs = canvasRef.current!
    const dpr = window.devicePixelRatio || 1
    const w = window.innerWidth
    const h = window.innerHeight
    cvs.width = w * dpr
    cvs.height = h * dpr
    cvs.style.width = w + 'px'
    cvs.style.height = h + 'px'
    return { w, h }
  }, [])

  /* ── Apply grouping forces ── */
  const applyGrouping = useCallback((m: GroupMode, w: number, h: number) => {
    const sim = simRef.current
    const nodes = nodesRef.current
    if (!sim || !nodes.length) return

    const meta = GROUP_META[m]
    const centers = computeCenters(meta.order, w, h)
    centersRef.current = centers

    const counts = new Map<string, number>()
    meta.order.forEach(k => counts.set(k, 0))
    nodes.forEach(p => {
      const k = groupKey(p, m)
      counts.set(k, (counts.get(k) || 0) + 1)
    })
    countsRef.current = counts

    sim
      .force('x', forceX<PlanetNode>().x(p => centers.get(groupKey(p, m))?.x ?? w / 2).strength(0.065))
      .force('y', forceY<PlanetNode>().y(p => centers.get(groupKey(p, m))?.y ?? h / 2).strength(0.065))
      .alpha(0.75)
      .restart()
  }, [])

  /* ── Init ── */
  useEffect(() => {
    let dead = false

    loadData().then(planets => {
      if (dead) return
      nodesRef.current = planets
      setTotal(planets.length)

      const { w, h } = resize()

      // Scatter from center
      planets.forEach(p => {
        p.x = w / 2 + (Math.random() - 0.5) * 100
        p.y = h / 2 + (Math.random() - 0.5) * 100
      })

      const sim = forceSimulation(planets)
        .force('collide', forceCollide<PlanetNode>().radius(p => p.vr + 0.5).iterations(3))
        .velocityDecay(0.32)
        .alphaDecay(0.007)
        .on('tick', () => paint(hoverIdRef.current))

      simRef.current = sim
      applyGrouping('size', w, h)
      setLoaded(true)
    })

    const onResize = () => {
      const { w, h } = resize()
      if (simRef.current) applyGrouping(modeRef.current, w, h)
    }
    window.addEventListener('resize', onResize)

    return () => {
      dead = true
      window.removeEventListener('resize', onResize)
      simRef.current?.stop()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Refs for stable access inside sim tick
  const hoverIdRef = useRef(-1)
  const modeRef = useRef<GroupMode>('size')

  useEffect(() => { hoverIdRef.current = hovered?.id ?? -1 }, [hovered])
  useEffect(() => { modeRef.current = mode }, [mode])

  /* ── Mode change ── */
  useEffect(() => {
    if (!loaded) return
    applyGrouping(mode, window.innerWidth, window.innerHeight)
  }, [mode, loaded, applyGrouping])

  /* ── Repaint on hover when sim is settled ── */
  useEffect(() => {
    const sim = simRef.current
    if (sim && sim.alpha() < 0.02) paint(hovered?.id ?? -1)
  }, [hovered, paint])

  /* ── Mouse ── */
  const onMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    let best: PlanetNode | null = null
    let bestD = Infinity
    for (const p of nodesRef.current) {
      const dx = p.x! - mx, dy = p.y! - my
      const d2 = dx * dx + dy * dy
      const thr = (p.vr + 5) ** 2
      if (d2 < thr && d2 < bestD) { bestD = d2; best = p }
    }
    setHovered(best)
    if (best) setTipPos({ x: e.clientX, y: e.clientY })
  }, [])

  const onClick = useCallback(() => {
    setSelected(prev => {
      if (hovered) return prev?.id === hovered.id ? null : hovered
      return null
    })
  }, [hovered])

  /* ═══════════════════════════════════════════
     JSX
     ═══════════════════════════════════════════ */
  const meta = GROUP_META[mode]

  return (
    <div className="app">
      <canvas ref={canvasRef} className="main-canvas" onMouseMove={onMove} onClick={onClick}
        style={{ cursor: hovered ? 'pointer' : 'default' }} />

      {/* ── Header ── */}
      <header className="hdr">
        <h1 className="hdr-title">{total.toLocaleString()} Worlds</h1>
        <p className="hdr-sub">{meta.desc}</p>
      </header>

      {/* ── Group buttons ── */}
      <nav className="grp-nav">
        <span className="grp-label">Group by</span>
        <div className="grp-btns">
          {(Object.keys(GROUP_META) as GroupMode[]).map(m => (
            <button key={m} className={`grp-btn${mode === m ? ' on' : ''}`} onClick={() => setMode(m)}>
              {GROUP_META[m].label}
            </button>
          ))}
        </div>
      </nav>

      {/* ── Temperature legend ── */}
      <div className="tleg">
        <span className="tleg-label">Temperature</span>
        <div className="tleg-bar-wrap">
          <span className="tleg-tick">Cold</span>
          <div className="tleg-bar" />
          <span className="tleg-tick">Hot</span>
        </div>
        <span className="tleg-note">Gray = unknown</span>
      </div>

      {/* ── Size legend ── */}
      <div className="sleg">
        <span className="sleg-label">Radius</span>
        <div className="sleg-row">
          {[
            { r: 0.5, label: '0.5 R\u2295' },
            { r: 2, label: '2 R\u2295' },
            { r: 10, label: '10 R\u2295' },
          ].map(s => {
            const vr = Math.max(1.8, Math.min(10, Math.sqrt(s.r) * 2.6))
            return (
              <div key={s.label} className="sleg-item">
                <div className="sleg-circle" style={{ width: vr * 2, height: vr * 2 }} />
                <span>{s.label}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Tooltip ── */}
      {hovered && (
        <div className="tip" style={{
          left: Math.min(tipPos.x + 16, window.innerWidth - 240),
          top: Math.min(tipPos.y - 10, window.innerHeight - 120),
        }}>
          <div className="tip-name">{hovered.name}</div>
          <div className="tip-host">{hovered.hostname}</div>
          <div className="tip-meta">{hovered.discYear} &middot; {hovered.methodRaw}</div>
          <div className="tip-stats">
            {hovered.eqt > 0 && <span>{Math.round(hovered.eqt)} K</span>}
            <span>{fmtN(hovered.rade)} R&#x2295;</span>
            {hovered.masse > 0 && <span>{fmtN(hovered.masse)} M&#x2295;</span>}
          </div>
        </div>
      )}

      {/* ── Detail panel ── */}
      <div className={`det${selected ? ' open' : ''}`}>
        {selected && <>
          <button className="det-x" onClick={() => setSelected(null)}>&times;</button>
          <h2 className="det-name">{selected.name}</h2>
          <p className="det-host">orbiting <strong>{selected.hostname}</strong></p>

          {/* Size comparison */}
          <div className="det-comp">
            <div className="det-comp-item">
              <div className="det-comp-circ" style={{
                width: Math.min(100, Math.max(6, selected.rade * 10)),
                height: Math.min(100, Math.max(6, selected.rade * 10)),
                background: selected.color,
              }} />
              <span>{selected.name.split(' ').pop()}</span>
            </div>
            <div className="det-comp-item">
              <div className="det-comp-circ earth" style={{ width: 10, height: 10 }} />
              <span>Earth</span>
            </div>
          </div>

          <div className="det-grid">
            {([
              ['Discovery', `${selected.discYear}`],
              ['Method', selected.methodRaw],
              ['Radius', `${fmtN(selected.rade)} R\u2295`],
              ['Mass', selected.masse ? `${fmtN(selected.masse)} M\u2295` : '\u2014'],
              ['Temperature', selected.eqt ? `${Math.round(selected.eqt)} K` : '\u2014'],
              ['Period', fmtPeriod(selected.orbper)],
              ['Semi-major axis', selected.orbsmax ? `${fmtN(selected.orbsmax, 3)} AU` : '\u2014'],
              ['Distance', selected.syDist ? `${fmtN(selected.syDist, 0)} pc` : '\u2014'],
              ['Star temp', selected.stTeff ? `${Math.round(selected.stTeff)} K` : '\u2014'],
              ['Planets in system', `${selected.syPnum}`],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} className="det-stat">
                <span className="det-stat-l">{label}</span>
                <span className="det-stat-v">{value}</span>
              </div>
            ))}
          </div>

          <div className="det-tags">
            <span className="det-tag">{selected.sizeClass}</span>
            <span className="det-tag">{selected.tempClass}</span>
          </div>
        </>}
      </div>

      {/* ── Loading ── */}
      {!loaded && <div className="loading"><p>Loading worlds&hellip;</p></div>}
    </div>
  )
}
