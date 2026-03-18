// Live counter — a server extension demonstrating WebSocket support.
// Multiple panes share a single counter via real-time WebSocket updates.

const http = require('http')
const { WebSocketServer } = require('ws')

const port = process.env.PORT || 3000
let counter = 0

const server = http.createServer((req, res) => {
  if (req.url === '/api/counter') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ counter }))
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Live Counter</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a; color: #e2e8f0;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; height: 100vh; gap: 1.5rem;
    }
    h1 { font-size: 1rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; }
    .counter { font-size: 4rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .buttons { display: flex; gap: 0.75rem; }
    button {
      background: #1e293b; color: #e2e8f0; border: 1px solid #334155;
      border-radius: 8px; padding: 0.75rem 1.5rem; font-size: 1.25rem;
      cursor: pointer; transition: background 0.15s;
    }
    button:hover { background: #334155; }
    button:active { background: #475569; }
    .status { font-size: 0.75rem; color: #475569; }
    .status.connected { color: #22d3ee; }
  </style>
</head>
<body>
  <h1>Live Counter</h1>
  <div class="counter" id="count">0</div>
  <div class="buttons">
    <button id="dec" aria-label="Decrement counter">-</button>
    <button id="reset" aria-label="Reset counter">Reset</button>
    <button id="inc" aria-label="Increment counter">+</button>
  </div>
  <div class="status" id="status">Connecting...</div>
  <script>
    const countEl = document.getElementById('count')
    const statusEl = document.getElementById('status')

    // WebSocket URL relative to the current page — works through the proxy
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = wsProto + '//' + location.host + location.pathname.replace(/\\/$/, '') + '/ws'

    let ws
    function connect() {
      ws = new WebSocket(wsUrl)
      ws.onopen = () => {
        statusEl.textContent = 'Connected'
        statusEl.className = 'status connected'
      }
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data)
        countEl.textContent = data.counter
      }
      ws.onclose = () => {
        statusEl.textContent = 'Reconnecting...'
        statusEl.className = 'status'
        setTimeout(connect, 2000)
      }
    }
    connect()

    document.getElementById('inc').onclick = () => ws.readyState === 1 && ws.send(JSON.stringify({ action: 'increment' }))
    document.getElementById('dec').onclick = () => ws.readyState === 1 && ws.send(JSON.stringify({ action: 'decrement' }))
    document.getElementById('reset').onclick = () => ws.readyState === 1 && ws.send(JSON.stringify({ action: 'reset' }))
  </script>
</body>
</html>`)
})

const wss = new WebSocketServer({ server, path: '/ws' })

function broadcast() {
  const msg = JSON.stringify({ counter })
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg)
  }
}

wss.on('connection', (ws) => {
  // Send current state on connect
  ws.send(JSON.stringify({ counter }))

  ws.on('message', (data) => {
    try {
      const { action } = JSON.parse(data.toString())
      if (action === 'increment') counter++
      else if (action === 'decrement') counter--
      else if (action === 'reset') counter = 0
      broadcast()
    } catch { /* ignore malformed messages */ }
  })
})

server.listen(port, '127.0.0.1', () => console.log(`Listening on port ${port}`))
