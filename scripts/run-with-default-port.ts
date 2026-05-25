import { spawn } from 'node:child_process'

const args = process.argv.slice(2)

if (args.length === 0) {
  console.error('run-with-default-port requires a command')
  process.exit(1)
}

const env = {
  ...process.env,
  PORT: process.env.PORT || '3002',
}

const child = spawn(args[0], args.slice(1), {
  env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
