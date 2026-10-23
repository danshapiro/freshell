import fs from 'node:fs'
import path from 'node:path'

/** Select each managed environment scenario's own relative configuration. */
export function managedEnvironmentOpencodeSelection(): Record<string, string> {
  return {
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_CONFIG: './opencode.json',
    // Keep OpenCode's update dialog from taking over the alternate screen.
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  }
}

/** Establish selected fixture roots before the harness captures its policy. */
export function prepareProviderParityUserRoots(home: string, xdgConfigHome: string): void {
  for (const root of ['.claude', '.codex', '.amplifier']) {
    fs.mkdirSync(path.join(home, root), { recursive: true })
  }
  fs.mkdirSync(path.join(xdgConfigHome, 'opencode'), { recursive: true })
}

const providerFailureOperations = [
  ['provider transaction backup ', 'backup'], ['provider transaction install ', 'install'],
  ['provider transaction create ', 'create'], ['provider transaction remove directory ', 'remove_directory'],
  ['provider transaction publish manifest:', 'manifest'], ['provider transaction mounted file ', 'mounted_file'],
  ['provider refresh control ', 'control'], ['provider refresh transaction creation ', 'create_stage'],
  ['resolve managed provider credentials:', 'credential_resolution'],
  ['prepare OneCLI provider files:', 'provider_files'], ['prepare hosted OneCLI provider files:', 'provider_files'],
  ['prepare managed provider:', 'provider_launch'], ['spawn managed terminal:', 'pty_spawn'],
  ['prepare provider config:', 'provider_config'], ['prepare hosted provider config:', 'provider_config'],
  ['prepare managed provider state:', 'provider_state'], ['prepare managed Amplifier state:', 'provider_state'],
  ['prepare hosted fresh-agent provider state failed:', 'provider_state'],
  ['transfer managed provider state:', 'provider_state_transfer'],
] as const

export function summarizeProviderFailureOperation(message: string) {
  return providerFailureOperations.find(([prefix]) =>
    message.startsWith(prefix) || message.includes(`: ${prefix}`))?.[1]
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
    const errors = [
      ['(os error 18)', 'cross_device'], ['(os error 13)', 'permission_denied'],
      ['(os error 2)', 'missing'], ['(os error 30)', 'read_only'],
      ['(os error 16)', 'busy'], ['(os error 1)', 'operation_not_permitted'],
    ] as const
    return {
      operation: summarizeProviderFailureOperation(message) ?? 'unknown',
      errno: errors.find(([marker]) => message.includes(marker))?.[1] ?? 'unknown',
    }
  }
  return {
    directoryResourceSelections: events.filter(value => value.event === 'provider.opencode.resource.directory_selected')
      .slice(-32).map(value => ({
        field: typeof value.field === 'string' ? value.field : undefined,
        resourceLeaf: typeof value.resource_leaf === 'string' ? value.resource_leaf : undefined,
        sourceConfigLeaf: typeof value.source_config_leaf === 'string' ? value.source_config_leaf : undefined,
        sourceConfigParentLeaf: typeof value.source_config_parent_leaf === 'string'
          ? value.source_config_parent_leaf : undefined,
        sourceConfigGrandparentLeaf: typeof value.source_config_grandparent_leaf === 'string'
          ? value.source_config_grandparent_leaf : undefined,
        resourceParentLeaf: typeof value.resource_parent_leaf === 'string' ? value.resource_parent_leaf : undefined,
        resourceGrandparentLeaf: typeof value.resource_grandparent_leaf === 'string'
          ? value.resource_grandparent_leaf : undefined,
      })),
    resourceCopyFailures: events.filter(value => value.event === 'provider.environment.copy.failed')
      .slice(-16).map(value => ({
        provider: typeof value.provider === 'string' ? value.provider : undefined,
        operation: typeof value.operation === 'string' ? value.operation : undefined,
        relativePath: typeof value.relative_path === 'string' ? value.relative_path : undefined,
        sourceScope: typeof value.resource_source_scope === 'string' ? value.resource_source_scope : undefined,
        sourceLeaf: typeof value.resource_source_leaf === 'string' ? value.resource_source_leaf : undefined,
        sourceOrigin: typeof value.resource_source_origin === 'string' ? value.resource_source_origin : undefined,
        sourceLane: typeof value.resource_source_lane === 'string' ? value.resource_source_lane : undefined,
        sourceConfigLeaf: typeof value.resource_source_config_leaf === 'string' ? value.resource_source_config_leaf : undefined,
        sourceConfigScope: typeof value.resource_source_config_scope === 'string' ? value.resource_source_config_scope : undefined,
        limitKind: typeof value.limit_kind === 'string' ? value.limit_kind : undefined,
        observed: typeof value.observed === 'number' ? value.observed : undefined,
        permitted: typeof value.permitted === 'number' ? value.permitted : undefined,
      })),
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
    OPENCODE_CONFIG: path.join(workspace, 'opencode.jsonc'),
  }
}

/**
 * The command the parity tests run in the supervisor container: exits 4 when
 * a supervisor registry file (`runtime.sqlite3` and its `-wal`, `-shm` and
 * `-journal` files) contains one of `markers`. SQLite can delete a `-wal`,
 * `-shm` or `-journal` file between the listing and the read (after a
 * checkpoint its bytes are in the main file); a vanished file restarts the
 * whole scan, so every byte present is still read.
 */
export function supervisorRegistrySecretScan(markers: string[], directory = '/var/lib/freshell-supervisor'): string[] {
  return ['node', '-e', `const fs=require('fs');const p=${JSON.stringify(directory)};const markers=${JSON.stringify(markers)};`
    + 'for(let attempt=0;;attempt++){try{'
    + `for(const f of fs.readdirSync(p).filter(x=>x.startsWith('runtime.sqlite3'))){const value=fs.readFileSync(p+'/'+f);if(markers.some(marker=>value.includes(marker)))process.exit(4)}`
    + "break}catch(error){if(error.code!=='ENOENT'||attempt>=20)throw error}}"]
}
