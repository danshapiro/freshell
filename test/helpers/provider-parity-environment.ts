import fs from 'node:fs'
import path from 'node:path'

/** Select each managed environment scenario's own relative configuration. */
export function managedEnvironmentOpencodeSelection(): Record<string, string> {
  return {}
}

/** Establish selected fixture roots before the harness captures its policy. */
export function prepareProviderParityUserRoots(home: string, xdgConfigHome: string): void {
  for (const root of ['.claude', '.codex', '.amplifier']) {
    fs.mkdirSync(path.join(home, root), { recursive: true })
  }
  fs.mkdirSync(path.join(xdgConfigHome, 'opencode'), { recursive: true })
}

/** Retain only fixed classifications from the owned host's existing logs. */
export function providerParityFailureDiagnostics(logs: string) {
  const events = logs.split('\n').flatMap(line => {
    try {
      const value = JSON.parse(line)
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? [value] : []
    } catch { return [] }
  })
  const classify = (cause: unknown) => {
    const message = typeof cause === 'string' ? cause : ''
    const operations = [
      ['provider transaction backup ', 'backup'], ['provider transaction install ', 'install'],
      ['provider transaction create ', 'create'], ['provider transaction remove directory ', 'remove_directory'],
      ['provider transaction publish manifest:', 'manifest'], ['provider transaction mounted file ', 'mounted_file'],
      ['provider refresh control ', 'control'], ['provider refresh transaction creation ', 'create_stage'],
    ] as const
    const errors = [
      ['(os error 18)', 'cross_device'], ['(os error 13)', 'permission_denied'],
      ['(os error 2)', 'missing'], ['(os error 30)', 'read_only'],
      ['(os error 16)', 'busy'], ['(os error 1)', 'operation_not_permitted'],
    ] as const
    return {
      operation: operations.find(([prefix]) => message.startsWith(prefix))?.[1] ?? 'unknown',
      errno: errors.find(([marker]) => message.includes(marker))?.[1] ?? 'unknown',
    }
  }
  return {
    transactionEvents: events.flatMap(value => {
      return ['provider.projection.transaction.started', 'provider.projection.transaction.failed',
          'provider.projection.transaction.rollback', 'provider.projection.transaction.committed'].includes(value.event)
          && ['stage', 'validate', 'publish', 'rollback', 'commit'].includes(value.stage)
          ? [{ event: value.event, stage: value.stage }] : []
    }).slice(-16),
    transactionFailures: events.flatMap(value => value.event === 'provider.projection.transaction.failed'
      && ['stage', 'validate', 'publish'].includes(value.stage)
      ? [{ stage: value.stage, ...classify(value.cause) }] : []).slice(-16),
    workerFailures: events.filter(value => value.event === 'session_host.fatal')
      .slice(-16).map(value => classify(value.error)),
    filesystemCause: {
      permissionDenied: logs.includes('Permission denied'), missingPath: logs.includes('No such file or directory'),
      readOnly: logs.includes('Read-only file system'), unownedDestination: logs.includes('provider-created'),
    },
  }
}

/** Make only the owned fixture's selected resources readable to its child. */
export function makeProviderParityResourcesReadable(directory: string): void {
  fs.chmodSync(directory, 0o755)
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) makeProviderParityResourcesReadable(file)
    else {
      const source = fs.lstatSync(file)
      if (!source.isFile()) throw new Error('selected fixture resource is not a physical regular file')
      fs.chmodSync(file, 0o644 | (source.mode & 0o111))
    }
  }
}

/** Build installed, offline resources; the child must execute and import them. */
export function writeProviderParityEnvironment(providerRoot: string, relative: string): void {
  const selected = path.join(providerRoot, relative)
  const dependency = path.join(selected, 'node_modules/parity-installed')
  fs.mkdirSync(path.join(dependency, 'entries'), { recursive: true })
  // The executable keeps its module format when selected from an ESM project.
  fs.writeFileSync(path.join(selected, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'parity-installed', main: 'index.cjs' }))
  fs.writeFileSync(path.join(dependency, 'index.cjs'), "module.exports=require('./entries/entry-4200.cjs')\n")
  for (let index = 0; index <= 4200; index++) {
    fs.writeFileSync(path.join(dependency, `entries/entry-${index}.cjs`), "module.exports='installed-dependency-nonce'\n")
  }
  fs.writeFileSync(path.join(selected, 'asset'), 'selected-resource-nonce')
  fs.writeFileSync(path.join(selected, 'references.json'), JSON.stringify({ resource: './asset' }))
  fs.writeFileSync(path.join(selected, 'command'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'references.json'),'utf8'));
process.stdout.write(JSON.stringify({dependency:require('parity-installed'),resource:fs.readFileSync(path.resolve(__dirname,config.resource),'utf8'),entries:fs.readdirSync(path.join(__dirname,'node_modules/parity-installed/entries')).length}));
`, { mode: 0o751 })
}

/** Provider commands and OpenCode selection for the owned fixture workspace. */
export function providerParityCommands(workspace: string): Record<string, string> {
  const commands = Object.fromEntries(['claude', 'codex', 'opencode', 'amplifier'].map(provider => [
    `${provider.toUpperCase()}_CMD`, path.join(workspace, `parity-${provider}`),
  ]))
  return {
    ...commands,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_CONFIG_DIR: path.join(workspace, '.opencode'),
    OPENCODE_CONFIG: path.join(workspace, 'opencode.jsonc'),
  }
}
