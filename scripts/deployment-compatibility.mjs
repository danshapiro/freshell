import { createHash, randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const JSON_NUMBER_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/
const MAX_COMPONENT = 4294967295n
const COMPONENTS = new Set(['client', 'server'])
const textEncoder = new TextEncoder()

export class CompatibilityError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CompatibilityError'
    this.code = code
  }
}

function fail(code, message) {
  throw new CompatibilityError(code, message)
}

function rejectDuplicateKeys(raw) {
  let offset = 0

  function isWhitespace(character) {
    return (
      character === ' ' ||
      character === '\t' ||
      character === '\r' ||
      character === '\n'
    )
  }

  function whitespace() {
    while (offset < raw.length && isWhitespace(raw[offset])) offset += 1
  }

  function stringToken() {
    const start = offset
    offset += 1
    while (offset < raw.length) {
      if (raw[offset] === '\\') {
        offset += 2
      } else if (raw[offset] === '"') {
        offset += 1
        return JSON.parse(raw.slice(start, offset))
      } else {
        offset += 1
      }
    }
    fail('INVALID_JSON', 'unterminated JSON string')
  }

  function value() {
    whitespace()
    if (raw[offset] === '{') {
      object()
      return
    }
    if (raw[offset] === '[') {
      array()
      return
    }
    if (raw[offset] === '"') {
      stringToken()
      return
    }
    const start = offset
    while (
      offset < raw.length &&
      !isWhitespace(raw[offset]) &&
      ![',', ']', '}'].includes(raw[offset])
    ) {
      offset += 1
    }
    if (offset === start) fail('INVALID_JSON', 'expected JSON value')
    const token = raw.slice(start, offset)
    if (!['null', 'true', 'false'].includes(token) && !JSON_NUMBER_PATTERN.test(token)) {
      fail('INVALID_JSON', 'invalid JSON primitive')
    }
  }

  function object() {
    offset += 1
    whitespace()
    const keys = new Set()
    if (raw[offset] === '}') {
      offset += 1
      return
    }
    while (offset < raw.length) {
      whitespace()
      if (raw[offset] !== '"') fail('INVALID_JSON', 'expected JSON object key')
      const key = stringToken()
      if (keys.has(key)) fail('DUPLICATE_KEY', `duplicate JSON key: ${key}`)
      keys.add(key)
      whitespace()
      if (raw[offset] !== ':') fail('INVALID_JSON', 'expected colon after JSON object key')
      offset += 1
      value()
      whitespace()
      if (raw[offset] === '}') {
        offset += 1
        return
      }
      if (raw[offset] !== ',') fail('INVALID_JSON', 'expected comma in JSON object')
      offset += 1
    }
    fail('INVALID_JSON', 'unterminated JSON object')
  }

  function array() {
    offset += 1
    whitespace()
    if (raw[offset] === ']') {
      offset += 1
      return
    }
    while (offset < raw.length) {
      value()
      whitespace()
      if (raw[offset] === ']') {
        offset += 1
        return
      }
      if (raw[offset] !== ',') fail('INVALID_JSON', 'expected comma in JSON array')
      offset += 1
    }
    fail('INVALID_JSON', 'unterminated JSON array')
  }

  try {
    value()
    whitespace()
    if (offset !== raw.length) fail('INVALID_JSON', 'unexpected content after JSON value')
  } catch (error) {
    if (error instanceof CompatibilityError) throw error
    fail('INVALID_JSON', 'invalid JSON string escape')
  }
}

function parseJson(raw) {
  if (typeof raw !== 'string') fail('INVALID_JSON', 'JSON input must be a string')
  rejectDuplicateKeys(raw)
  try {
    return JSON.parse(raw)
  } catch {
    fail('INVALID_JSON', 'invalid JSON')
  }
}

function objectValue(value, context) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail('INVALID_SHAPE', `${context} must be an object`)
  }
  return value
}

function exactKeys(value, expected, context) {
  const object = objectValue(value, context)
  const allowed = new Set(expected)
  const unknown = Object.keys(object).find((key) => !allowed.has(key))
  if (unknown !== undefined) fail('UNKNOWN_KEY', `unknown ${context} key: ${unknown}`)
  const missing = expected.find((key) => !Object.hasOwn(object, key))
  if (missing !== undefined) fail('MISSING_KEY', `missing ${context} key: ${missing}`)
  return object
}

function schemaVersion(value) {
  if (value !== '1') fail('UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion must be "1"')
  return value
}

function version(value) {
  if (typeof value !== 'string') fail('INVALID_VERSION', 'version must be a string')
  const match = VERSION_PATTERN.exec(value)
  if (match === null) fail('INVALID_VERSION', `invalid version: ${value}`)
  const components = match.slice(1).map((component) => BigInt(component))
  if (components.some((component) => component > MAX_COMPONENT)) {
    fail('VERSION_COMPONENT_OVERFLOW', `version component exceeds ${MAX_COMPONENT}`)
  }
  return { raw: value, components }
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

function bounds(value, context) {
  const object = exactKeys(value, ['minInclusive', 'maxExclusive'], context)
  const minimum = version(object.minInclusive)
  const maximum = version(object.maxExclusive)
  if (compareVersions(minimum.components, maximum.components) >= 0) {
    fail('INVALID_VERSION_RANGE', `${context} must be a non-empty half-open range`)
  }
  return {
    minInclusive: minimum.raw,
    maxExclusive: maximum.raw,
  }
}

function componentContract(value, component) {
  const peerName = component === 'client' ? 'supportsServer' : 'supportsClient'
  const object = exactKeys(value, ['version', peerName], component)
  return {
    version: version(object.version).raw,
    [peerName]: bounds(object[peerName], `${component}.${peerName}`),
  }
}

export function parseContract(raw) {
  const object = exactKeys(parseJson(raw), ['schemaVersion', 'client', 'server'], 'contract')
  const contract = {
    schemaVersion: schemaVersion(object.schemaVersion),
    client: componentContract(object.client, 'client'),
    server: componentContract(object.server, 'server'),
  }
  assertMutuallyCompatible(
    projectDeclaration(contract, 'client'),
    projectDeclaration(contract, 'server'),
  )
  return contract
}

export function parseDeclaration(raw, suppliedDigest) {
  const object = exactKeys(
    parseJson(raw),
    ['schemaVersion', 'component', 'version', 'supports'],
    'declaration',
  )
  schemaVersion(object.schemaVersion)
  if (!COMPONENTS.has(object.component)) {
    fail('INVALID_COMPONENT', 'component must be "client" or "server"')
  }
  const peer = object.component === 'client' ? 'server' : 'client'
  const reciprocal = objectValue(object.supports, 'supports')
  if (!Object.hasOwn(reciprocal, peer) && Object.hasOwn(reciprocal, object.component)) {
    fail('RECIPROCAL_KEY_MISMATCH', `supports must contain the ${peer} range`)
  }
  const supports = exactKeys(object.supports, [peer], 'supports')
  const declaration = {
    schemaVersion: '1',
    component: object.component,
    version: version(object.version).raw,
    supports: {
      [peer]: bounds(supports[peer], `supports.${peer}`),
    },
  }
  if (suppliedDigest !== undefined && suppliedDigest !== declarationDigest(declaration)) {
    fail('DIGEST_MISMATCH', 'supplied declaration digest does not match canonical bytes')
  }
  return declaration
}

export function projectDeclaration(contract, component) {
  if (!COMPONENTS.has(component)) {
    fail('INVALID_COMPONENT', 'component must be "client" or "server"')
  }
  if (component === 'client') {
    return {
      schemaVersion: '1',
      component,
      version: contract.client.version,
      supports: { server: { ...contract.client.supportsServer } },
    }
  }
  return {
    schemaVersion: '1',
    component,
    version: contract.server.version,
    supports: { client: { ...contract.server.supportsClient } },
  }
}

export function canonicalDeclarationBytes(declaration) {
  const peer = declaration.component === 'client' ? 'server' : 'client'
  const canonical = {
    schemaVersion: declaration.schemaVersion,
    component: declaration.component,
    version: declaration.version,
    supports: {
      [peer]: {
        minInclusive: declaration.supports[peer].minInclusive,
        maxExclusive: declaration.supports[peer].maxExclusive,
      },
    },
  }
  return textEncoder.encode(JSON.stringify(canonical))
}

export function declarationDigest(declaration) {
  return createHash('sha256').update(canonicalDeclarationBytes(declaration)).digest('hex')
}

function containsVersion(range, candidate) {
  const parsedCandidate = version(candidate).components
  const minimum = version(range.minInclusive).components
  const maximum = version(range.maxExclusive).components
  return (
    compareVersions(minimum, parsedCandidate) <= 0 &&
    compareVersions(parsedCandidate, maximum) < 0
  )
}

export function assertMutuallyCompatible(client, server) {
  if (client.component !== 'client') {
    fail('EXPECTED_CLIENT_DECLARATION', 'first declaration must describe the client')
  }
  if (server.component !== 'server') {
    fail('EXPECTED_SERVER_DECLARATION', 'second declaration must describe the server')
  }
  if (!containsVersion(client.supports.server, server.version)) {
    fail('CLIENT_DOES_NOT_SUPPORT_SERVER', 'client does not support the server version')
  }
  if (!containsVersion(server.supports.client, client.version)) {
    fail('SERVER_DOES_NOT_SUPPORT_CLIENT', 'server does not support the client version')
  }
}

function hasUnsupportedJsonValue(value, seen = new Set()) {
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    return true
  }
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  const invalid = Object.values(value).some((child) => hasUnsupportedJsonValue(child, seen))
  seen.delete(value)
  return invalid
}

export function serializeEvent(event) {
  if (
    event === null ||
    Array.isArray(event) ||
    typeof event !== 'object' ||
    hasUnsupportedJsonValue(event)
  ) {
    fail('INVALID_EVENT', 'event must be a JSON object without lossy values')
  }
  return `${JSON.stringify(event)}\n`
}

async function writeAtomic(path, content) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  )
  await writeFile(temporary, content, { flag: 'wx' })
  await rename(temporary, path)
}

async function runCli(argv) {
  const [command, ...args] = argv
  if (command === 'project' && args.length === 3) {
    const [contractPath, component, outputPath] = args
    const contract = parseContract(await readFile(contractPath, 'utf8'))
    const declaration = projectDeclaration(contract, component)
    await writeAtomic(outputPath, canonicalDeclarationBytes(declaration))
    return
  }
  if (command === 'check' && args.length === 3) {
    const [clientPath, serverPath, outputPath] = args
    const client = parseDeclaration(await readFile(clientPath, 'utf8'))
    const server = parseDeclaration(await readFile(serverPath, 'utf8'))
    assertMutuallyCompatible(client, server)
    await writeAtomic(
      outputPath,
      serializeEvent({
        compatible: true,
        clientDigest: declarationDigest(client),
        serverDigest: declarationDigest(server),
      }),
    )
    return
  }
  if (command === 'event' && args.length === 2) {
    const [eventJson, outputPath] = args
    await writeAtomic(outputPath, serializeEvent(parseJson(eventJson)))
    return
  }
  fail(
    'INVALID_ARGUMENTS',
    'usage: deployment-compatibility.mjs project <contract> <component> <output> | check <client> <server> <output> | event <json> <output>',
  )
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof CompatibilityError ? error.code : 'UNEXPECTED_ERROR'
    process.stderr.write(`${code}: ${error.message}\n`)
    process.exitCode = 1
  })
}
