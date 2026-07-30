#!/usr/bin/env node
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const log = process.env.FRESHELL_FIXTURE_LOG
if (!log) throw new Error('FRESHELL_FIXTURE_LOG is required')

appendFileSync(log, `${JSON.stringify({
  command: 'npm',
  args: process.argv.slice(2),
  cwd: process.cwd(),
  clientOut: process.env.FRESHELL_CLIENT_OUT_DIR ?? null,
})}\n`)

const args = process.argv.slice(2)
if (args[0] === 'run' && args[1] === 'build:client') {
  const output = process.env.FRESHELL_CLIENT_OUT_DIR
  if (!output || !path.isAbsolute(output)) throw new Error('private client output is required')
  mkdirSync(path.join(output, 'assets'), { recursive: true })
  writeFileSync(path.join(output, 'index.html'), `client:${process.env.FRESHELL_FIXTURE_CLIENT ?? 'next'}\n`)
  writeFileSync(path.join(output, 'assets', 'candidate.js'), 'candidate\n')
  writeFileSync(path.join(output, 'deployment-compatibility.json'), '{}\n')
}

if (args[0] === 'run' && args[1] === 'build:server') {
  const outIndex = args.indexOf('--outDir')
  const output = outIndex === -1 ? undefined : args[outIndex + 1]
  if (!output || !path.isAbsolute(output)) throw new Error('private server output is required')
  mkdirSync(path.join(output, 'server', 'mcp'), { recursive: true })
  writeFileSync(path.join(output, 'server', 'index.js'), 'export {}\n')
  writeFileSync(path.join(output, 'server', 'mcp', 'server.js'), 'export {}\n')
}

if (args[0] === 'ci') {
  const prefixIndex = args.indexOf('--prefix')
  const prefix = prefixIndex === -1 ? undefined : args[prefixIndex + 1]
  if (!prefix || !path.isAbsolute(prefix)) throw new Error('private npm prefix is required')
  mkdirSync(path.join(prefix, 'node_modules', 'fixture-package'), { recursive: true })
  writeFileSync(path.join(prefix, 'node_modules', 'fixture-package', 'package.json'), '{}\n')
  if (process.env.FRESHELL_FIXTURE_PACKAGE_JSON) {
    cpSync(process.env.FRESHELL_FIXTURE_PACKAGE_JSON, path.join(prefix, 'package.json'))
  }
  if (process.env.FRESHELL_FIXTURE_PACKAGE_LOCK) {
    cpSync(process.env.FRESHELL_FIXTURE_PACKAGE_LOCK, path.join(prefix, 'package-lock.json'))
  }
}
