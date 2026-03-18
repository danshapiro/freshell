// Status dashboard — a server extension that shows live system info.
// Freshell spawns this process and allocates a port via the {{port}} template.

const http = require('http')
const os = require('os')

const port = process.env.PORT || 3000

function getSystemInfo() {
  const uptime = os.uptime()
  const hours = Math.floor(uptime / 3600)
  const minutes = Math.floor((uptime % 3600) / 60)
  const totalMem = (os.totalmem() / 1073741824).toFixed(1)
  const freeMem = (os.freemem() / 1073741824).toFixed(1)
  const usedMem = (totalMem - freeMem).toFixed(1)
  const loadAvg = os.loadavg().map(n => n.toFixed(2))

  return { hours, minutes, totalMem, freeMem, usedMem, loadAvg, cpus: os.cpus().length }
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(getSystemInfo()))
    return
  }

  const info = getSystemInfo()
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Status Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a; color: #e2e8f0;
      padding: 1.5rem;
    }
    h1 { font-size: 1.25rem; color: #94a3b8; margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
    .card {
      background: #1e293b; border-radius: 8px; padding: 1rem;
      border: 1px solid #334155;
    }
    .card-label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    .card-value { font-size: 1.5rem; font-weight: 600; margin-top: 0.25rem; }
    .bar-track { background: #334155; border-radius: 4px; height: 8px; margin-top: 0.5rem; }
    .bar-fill { background: #22d3ee; border-radius: 4px; height: 100%; transition: width 0.5s; }
    .bar-fill.warn { background: #f59e0b; }
    .bar-fill.crit { background: #ef4444; }
    .updated { font-size: 0.7rem; color: #475569; margin-top: 1rem; text-align: right; }
  </style>
</head>
<body>
  <h1>System Status</h1>
  <div class="grid">
    <div class="card">
      <div class="card-label">Uptime</div>
      <div class="card-value" id="uptime">${info.hours}h ${info.minutes}m</div>
    </div>
    <div class="card">
      <div class="card-label">Memory</div>
      <div class="card-value" id="mem">${info.usedMem} / ${info.totalMem} GB</div>
      <div class="bar-track"><div class="bar-fill" id="mem-bar" style="width: ${(info.usedMem / info.totalMem * 100).toFixed(0)}%"></div></div>
    </div>
    <div class="card">
      <div class="card-label">CPU Cores</div>
      <div class="card-value">${info.cpus}</div>
    </div>
    <div class="card">
      <div class="card-label">Load Average (1m / 5m / 15m)</div>
      <div class="card-value" id="load">${info.loadAvg.join(' / ')}</div>
    </div>
  </div>
  <div class="updated" id="updated">Updated: just now</div>
  <script>
    async function refresh() {
      try {
        const res = await fetch('/api/status')
        const info = await res.json()
        document.getElementById('uptime').textContent = info.hours + 'h ' + info.minutes + 'm'
        document.getElementById('mem').textContent = info.usedMem + ' / ' + info.totalMem + ' GB'
        document.getElementById('load').textContent = info.loadAvg.join(' / ')
        const pct = (info.usedMem / info.totalMem * 100)
        const bar = document.getElementById('mem-bar')
        bar.style.width = pct.toFixed(0) + '%'
        bar.className = 'bar-fill' + (pct > 90 ? ' crit' : pct > 70 ? ' warn' : '')
        document.getElementById('updated').textContent = 'Updated: ' + new Date().toLocaleTimeString()
      } catch (e) { /* ignore fetch errors */ }
    }
    setInterval(refresh, 5000)
  </script>
</body>
</html>`)
})

server.listen(port, '127.0.0.1', () => console.log(`Listening on port ${port}`))
