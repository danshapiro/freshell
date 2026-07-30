#!/usr/bin/env node
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const value = (flag) => {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 === args.length) throw new Error(`missing ${flag}`)
  return args[index + 1]
}
const maybeValue = (flag) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const checkout = maybeValue('--checkout') ?? process.env.FRESHELL_FIXTURE_CHECKOUT
const port = maybeValue('--port') ?? process.env.PORT
if (!checkout || !port) throw new Error('fixture controller requires checkout and port')

const log = process.env.FRESHELL_FIXTURE_LOG
if (log) appendFileSync(log, `${JSON.stringify({ command: 'controller', args, cwd: process.cwd() })}\n`)

const root = path.join(checkout, '.freshell-deploy', 'ports', port)
const generations = path.join(root, 'generations')
const stateFile = path.join(root, 'fixture-state.json')
const current = path.join(root, 'current')
mkdirSync(generations, { recursive: true, mode: 0o700 })

const atomicJson = (file, value) => {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}
const state = () => JSON.parse(readFileSync(stateFile, 'utf8'))
const save = (next) => atomicJson(stateFile, next)
const generationId = (label) => createHash('sha256').update(label).digest('hex')
const selectedId = () => path.basename(readlinkSync(current))
const select = (id) => {
  const temporary = `${current}.${process.pid}.tmp`
  try { symlinkSync(path.join('generations', id), temporary) } catch {}
  renameSync(temporary, current)
}
const installController = (id, source = process.argv[1]) => {
  const directory = path.join(generations, id, 'controller')
  mkdirSync(directory, { recursive: true })
  copyFileSync(source, path.join(directory, 'freshell-deploy'))
  chmodSync(path.join(directory, 'freshell-deploy'), 0o755)
}

if (args[0] === 'fixture-init') {
  const id = generationId(value('--label'))
  installController(id)
  mkdirSync(path.join(generations, id, 'client', 'assets'), { recursive: true })
  writeFileSync(path.join(generations, id, 'client', 'index.html'), `client:${value('--label')}\n`)
  writeFileSync(path.join(generations, id, 'client', 'assets', 'prior.js'), 'prior\n')
  select(id)
  save({
    selectedGenerationId: id,
    runningServerGenerationId: args.includes('--stopped') ? null : id,
    legacy: args.includes('--legacy'),
    stopCount: 0,
    startCount: args.includes('--stopped') ? 0 : 1,
  })
  process.stdout.write(`${id}\n`)
  process.exit(0)
}

if (args[0] === 'capture') {
  if (!existsSync(stateFile)) {
    const id = generationId('legacy')
    installController(id)
    select(id)
    save({
      selectedGenerationId: id,
      runningServerGenerationId: id,
      legacy: true,
      stopCount: 0,
      startCount: 1,
    })
  }
  process.exit(0)
}

if (args[0] === 'bootstrap-status') {
  if (!existsSync(stateFile)) {
    process.stdout.write('capture-required\n')
  } else if (state().legacy) {
    process.stdout.write('capture-required\n')
  } else {
    process.stdout.write('managed\n')
  }
  process.exit(0)
}

if (args[0] === 'deploy') {
  const before = state()
  const mode = value('--mode')
  if (before.legacy && mode !== 'full') {
    process.stderr.write('one-sided modes are unavailable before bootstrap\n')
    process.exit(1)
  }
  if (process.env.FRESHELL_FIXTURE_INCOMPATIBILITY) {
    process.stderr.write(`incompatible: ${process.env.FRESHELL_FIXTURE_INCOMPATIBILITY}\n`)
    process.exit(1)
  }
  const id = generationId(`${mode}:${randomUUID()}`)
  installController(id, maybeValue('--controller-executable') ?? process.argv[1])
  const client = path.join(generations, id, 'client')
  mkdirSync(path.join(client, 'assets'), { recursive: true })
  if (mode === 'server') {
    const priorClient = path.join(generations, before.selectedGenerationId, 'client')
    copyFileSync(path.join(priorClient, 'index.html'), path.join(client, 'index.html'))
    if (existsSync(path.join(priorClient, 'assets', 'prior.js'))) {
      copyFileSync(path.join(priorClient, 'assets', 'prior.js'), path.join(client, 'assets', 'prior.js'))
    }
  } else {
    const candidate = value('--client-dir')
    copyFileSync(path.join(candidate, 'index.html'), path.join(client, 'index.html'))
    copyFileSync(path.join(candidate, 'assets', 'candidate.js'), path.join(client, 'assets', 'candidate.js'))
    const priorAsset = path.join(generations, before.selectedGenerationId, 'client', 'assets', 'prior.js')
    if (existsSync(priorAsset)) copyFileSync(priorAsset, path.join(client, 'assets', 'prior.js'))
  }
  const candidate = {
    ...before,
    selectedGenerationId: id,
    runningServerGenerationId: mode === 'client-only' ? before.runningServerGenerationId : id,
    legacy: mode === 'client-only' ? before.legacy : false,
  }
  if (mode !== 'client-only') candidate.stopCount += 1
  const failpoint = process.env.FRESHELL_FIXTURE_FAILPOINT
  const afterCommit = new Set(['after_activation_receipt', 'after_activation_confirmed'])
  if (failpoint && !afterCommit.has(failpoint)) {
    save(before)
    process.stderr.write(`rolled back after ${failpoint}\n`)
    process.exit(1)
  }
  select(id)
  save(candidate)
  if (failpoint) {
    process.stderr.write(`replayed committed activation after ${failpoint}\n`)
  }
  process.stdout.write(`${id}\n`)
  process.exit(0)
}

if (args[0] === 'start-current') {
  const before = state()
  if (before.runningServerGenerationId) process.exit(0)
  save({
    ...before,
    runningServerGenerationId: selectedId(),
    legacy: false,
    startCount: before.startCount + 1,
  })
  process.exit(0)
}

if (args[0] === 'restart-current') {
  const before = state()
  save({
    ...before,
    runningServerGenerationId: selectedId(),
    legacy: false,
    stopCount: before.stopCount + (before.runningServerGenerationId ? 1 : 0),
    startCount: before.startCount + 1,
  })
  process.exit(0)
}

if (args[0] === 'stop-current') {
  const before = state()
  save({
    ...before,
    runningServerGenerationId: null,
    legacy: false,
    stopCount: before.stopCount + (before.runningServerGenerationId ? 1 : 0),
  })
  process.exit(0)
}

throw new Error(`unknown fixture controller command ${args[0]}`)
