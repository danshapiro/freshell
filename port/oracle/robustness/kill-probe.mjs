import WebSocket from 'ws';
const [port, token] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const frames = [];
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, protocolVersion: 7 })));
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.type === 'terminal.output' || m.type === 'terminal.output.batch') return;
  frames.push(m);
  if (m.type === 'ready') ws.send(JSON.stringify({ type: 'terminal.create', requestId: `k-${Date.now()}`, mode: 'shell', shell: 'system' }));
  else if (m.type === 'terminal.created') {
    const id = m.terminalId;
    setTimeout(() => ws.send(JSON.stringify({ type: 'terminal.kill', terminalId: id })), 1500);
    // also try an invalid kill after
    setTimeout(() => ws.send(JSON.stringify({ type: 'terminal.kill', terminalId: 'nonexistent-id-123' })), 3000);
    setTimeout(() => { console.log(JSON.stringify({ frames: frames.map(f => f.type==='terminals.changed'?f:{type:f.type}) })); process.exit(0); }, 5000);
  }
});
setTimeout(() => { console.log(JSON.stringify({ timeout: true })); process.exit(1); }, 15000);
