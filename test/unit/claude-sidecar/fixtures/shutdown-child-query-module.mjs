import { spawn } from 'node:child_process'
import { query as streamingQuery } from './streaming-query-module.mjs'

// close():void initiates SDK cleanup without joining the child. Hold a real
// child after SIGTERM so the sidecar must keep owning it until it exits.
export function query({ prompt, options }) {
  const command = {
    command: process.execPath,
    args: ['-e', `
      const fs = require('node:fs'); const path = require('node:path');
      process.on('SIGTERM', () => process.stdout.write('stopping\\n', error => {
        if (error) process.exit(1);
        fs.writeFileSync(path.join(process.cwd(), 'native-terminated'), 'yes');
      }));
      process.stdin.resume();
      const timer = setInterval(() => {
        if (!fs.existsSync(path.join(process.cwd(), 'native-release'))) return;
        clearInterval(timer); fs.writeFileSync(path.join(process.cwd(), 'native-exited'), 'yes'); process.exit(0);
      }, 10);
      process.stdout.write('ready\\n');
    `],
    cwd: options.cwd,
    env: options.env,
    signal: new AbortController().signal,
  }
  const child = options.spawnClaudeCodeProcess
    ? options.spawnClaudeCodeProcess(command)
    : spawn(command.command, command.args, { ...command, stdio: ['pipe', 'pipe', 'pipe'] })
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
  })
  const sdk = streamingQuery({ prompt, options })
  const close = sdk.close.bind(sdk)
  return Object.assign(sdk, {
    async initializationResult() { await ready; return { pid: child.pid, commands: [] } },
    close() { close(); child.stdin.end() },
  })
}
