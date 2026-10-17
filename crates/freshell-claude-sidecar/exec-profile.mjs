// Final exec accounting for the pinned SDK's supported spawn callback.
// Expanded values remain in process memory; errors contain classifications.
import { spawn } from 'node:child_process'
import { openSync, readSync, closeSync, statSync, accessSync, constants } from 'node:fs'
import { endianness } from 'node:os'
import path from 'node:path'

const fail = kind => { throw new Error(`provider exec profile ${kind}: repair inputs before dispatch`) }
function readBounded(file, limit) {
  let fd
  try {
    fd = openSync(file, 'r')
    const data = Buffer.alloc(limit)
    return data.subarray(0, readSync(fd, data, 0, limit, 0))
  } catch { return fail('executable-or-native-profile') }
  finally { if (fd !== undefined) closeSync(fd) }
}
function nativeProfile() {
  const pointerBytes = ['ia32', 'arm'].includes(process.arch) ? 4 : 8
  const data = readBounded('/proc/self/auxv', 4096)
  const little = endianness() === 'LE'
  const read = offset => pointerBytes === 4
    ? (little ? data.readUInt32LE(offset) : data.readUInt32BE(offset))
    : Number(little ? data.readBigUInt64LE(offset) : data.readBigUInt64BE(offset))
  let pageBytes
  for (let offset = 0; offset + 2 * pointerBytes <= data.length; offset += 2 * pointerBytes) {
    if (read(offset) === 6) { pageBytes = read(offset + pointerBytes); break }
  }
  const limits = readBounded('/proc/self/limits', 16384).toString()
  const soft = limits.split('\n').find(line => line.startsWith('Max stack size'))?.slice('Max stack size'.length).trim().split(/\s+/)[0]
  const stackBytes = soft === 'unlimited' ? Infinity : Number(soft)
  if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0 || !soft || Number.isNaN(stackBytes)) fail('native-profile')
  if (stackBytes < 8 * 1024 * 1024) fail('stack')
  return { pointerBytes, pageBytes }
}
function resolveProgram(command, cwd, environment) {
  if (command.includes('/')) return path.resolve(cwd || process.cwd(), command)
  for (const directory of (environment.PATH ?? '/usr/bin:/bin').split(':')) {
    const candidate = path.resolve(cwd || process.cwd(), directory, command)
    try { if (!statSync(candidate).isFile()) continue; accessSync(candidate, constants.X_OK); return candidate } catch {}
  }
  return fail('executable')
}

export function checkSdkExec(options) {
  const profile = nativeProfile()
  let bytes = 0
  let strings = 0
  const account = text => {
    if (typeof text !== 'string' || text.includes('\0')) fail('string')
    const size = Buffer.byteLength(text) + 1
    if (size > 32 * profile.pageBytes) fail('string')
    bytes += size
    strings += 1
    if (bytes + (strings + 2) * profile.pointerBytes > 1024 * 1024) fail('total')
  }
  account(options.command)
  for (const arg of options.args) account(arg)
  const environment = options.env ?? process.env
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue
    if (!name || name.includes('=') || name.includes('\0')) fail('string')
    account(`${name}=${value}`)
  }
  const executable = (program, depth = 0) => {
    if (depth > 4) fail('interpreter')
    account(program)
    const header = readBounded(program, 256)
    if (header.subarray(0, 2).toString() !== '#!') return
    const line = header.subarray(2).toString().split(/[\n\0]/)[0].replace(/^[ \t]+|[ \t]+$/g, '')
    const split = line.search(/[ \t]/)
    const interpreter = split < 0 ? line : line.slice(0, split)
    if (!interpreter) fail('interpreter')
    const argument = split < 0 ? '' : line.slice(split).replace(/^[ \t]+|[ \t]+$/g, '')
    if (argument) account(argument)
    executable(interpreter, depth + 1)
  }
  executable(resolveProgram(options.command, options.cwd, environment))
}

export function managedSdkSpawn(stderr, environment = process.env) {
  if (process.platform !== 'linux' || environment.FRESHELL_HOSTED_FRESH_AGENT !== 'claude') return undefined
  return options => {
    checkSdkExec(options)
    const child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    child.stderr.on('data', stderr)
    return child
  }
}
