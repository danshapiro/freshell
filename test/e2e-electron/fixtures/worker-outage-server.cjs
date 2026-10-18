const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const shell = '<!doctype html><title>Freshell worker outage fixture</title><div id="root">owned cached shell</div>'
const worker = fs.readFileSync(path.resolve(__dirname, '../../../public/sw.js'))
const server = http.createServer((request, response) => {
  if (request.url === '/sw.js') {
    response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
    response.end(worker)
  } else if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    response.end(shell)
  } else {
    response.writeHead(404)
    response.end()
  }
})
server.listen(0, '127.0.0.1', () => process.send({ pid: process.pid, port: server.address().port }))
process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
  server.closeAllConnections()
})
