import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'

// Preloading runs before Node resolves its entrypoint. Both dispatcher seams
// can use the real Node executable on every platform, without shell wrappers
// or mocking child-process buffering/stdio behavior.
if (process.argv[1] === path.resolve('run')) {
  const config = JSON.parse(process.env.CLOUD_OUTPUT_FIXTURE)
  const cloud = process.argv.includes('--cloud')
  const role = cloud ? 'cloud' : 'companion'
  const record = event => appendFileSync(config.events, JSON.stringify({ role, event, args: process.argv.slice(2) }) + '\n')
  record('start')
  writeFileSync(path.join(config.root, role + '.started'), '')

  if (config.concurrent) {
    const peer = path.join(config.root, (cloud ? 'companion' : 'cloud') + '.started')
    const deadline = Date.now() + 3000
    while (!existsSync(peer)) {
      if (Date.now() > deadline) throw new Error(role + ' did not start concurrently')
      await setTimeout(10)
    }
  }

  const write = (stream, value) => new Promise((resolve, reject) => stream.write(value, error => error ? reject(error) : resolve()))
  if (cloud && config.largeOutput) {
    await write(process.stdout, 'CLOUD_STDOUT_BEGIN\n' + 'o'.repeat(config.outputSize) + '\nCLOUD_STDOUT_END\n')
    await write(process.stderr, 'CLOUD_STDERR_BEGIN\n' + 'e'.repeat(config.outputSize) + '\nAssertionError: expected 4 sessions, received 3\nCLOUD_STDERR_END\n')
  } else {
    await write(process.stdout, role + ' stdout diagnostic\n')
    await write(process.stderr, role + ' stderr diagnostic\n')
  }
  record('complete')
  process.exit(cloud ? config.cloudExit : config.companionExit)
}
