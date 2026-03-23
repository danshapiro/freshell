import type { ClaudePermissionMode } from '../../shared/settings.js'
import type { ExtensionRegistryEntry } from '../extension-manager.js'
import type { CodingCliCommandSpec } from '../terminal-registry.js'

function compileArgTemplate(
  template: string[] | undefined,
  placeholder: string,
): ((value: string) => string[]) | undefined {
  if (!template) return undefined
  return (value: string) => template.map((arg) => arg.replaceAll(placeholder, value))
}

function clonePermissionModeArgsByValue(
  permissionModeArgsByValue: Partial<Record<ClaudePermissionMode, string[]>> | undefined,
): Partial<Record<ClaudePermissionMode, string[]>> | undefined {
  if (!permissionModeArgsByValue) return undefined
  return Object.fromEntries(
    Object.entries(permissionModeArgsByValue).map(([mode, args]) => [mode, [...args]]),
  ) as Partial<Record<ClaudePermissionMode, string[]>>
}

export function buildCliCommandSpecsFromEntries(
  entries: ExtensionRegistryEntry[],
): Map<string, CodingCliCommandSpec> {
  const cliCommandsMap = new Map<string, CodingCliCommandSpec>()

  for (const entry of entries) {
    if (entry.manifest.category !== 'cli' || !entry.manifest.cli) continue

    const cli = entry.manifest.cli
    const spec: CodingCliCommandSpec = {
      label: entry.manifest.label,
      envVar: cli.envVar || '',
      defaultCommand: cli.command,
      args: cli.args,
      env: cli.env,
      modelArgs: compileArgTemplate(cli.modelArgs, '{{model}}'),
      sandboxArgs: compileArgTemplate(cli.sandboxArgs, '{{sandbox}}'),
      permissionModeArgs: compileArgTemplate(cli.permissionModeArgs, '{{permissionMode}}'),
      permissionModeArgsByValue: clonePermissionModeArgsByValue(cli.permissionModeArgsByValue),
      permissionModeEnvVar: cli.permissionModeEnvVar,
      permissionModeEnvValues: cli.permissionModeValues,
    }

    if (cli.resumeArgs) {
      spec.resumeArgs = compileArgTemplate(cli.resumeArgs, '{{sessionId}}')
    }

    cliCommandsMap.set(entry.manifest.name, spec)
  }

  return cliCommandsMap
}
