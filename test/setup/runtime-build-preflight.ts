import type { TestProject } from 'vitest/node'
import {
  RUNTIME_BUILD_MANIFEST_ENV,
  hasPreparedRuntimeBuilds,
  prepareRuntimeBuilds,
  runtimeBuildRecipesForFiles,
  type RuntimeBuildCommand,
} from '../../scripts/testing/runtime-build-preflight.js'

type Project = {
  config: { root: string; env?: NodeJS.ProcessEnv }
  vitest: { state: { getPaths(): string[] } }
  onTestsRerun(callback: () => void): void
}

export async function setupRuntimeBuildPreflight(project: Project, options: { command?: RuntimeBuildCommand } = {}): Promise<(() => void) | undefined> {
  const env = { ...process.env, ...project.config.env }
  const selected = runtimeBuildRecipesForFiles(project.config.root, project.vitest.state.getPaths(), env)
  if (selected.length === 0 || hasPreparedRuntimeBuilds(project.config.root, selected, env)) return
  let prepared = prepareRuntimeBuilds(project.config.root, selected, { env, ...options })
  const projectEnv = project.config.env ??= {}
  const inherited = projectEnv[RUNTIME_BUILD_MANIFEST_ENV]
  projectEnv[RUNTIME_BUILD_MANIFEST_ENV] = prepared.manifestPath
  project.onTestsRerun(() => {
    const next = prepareRuntimeBuilds(project.config.root, selected, { env, ...options })
    prepared.cleanup()
    prepared = next
    projectEnv[RUNTIME_BUILD_MANIFEST_ENV] = prepared.manifestPath
  })
  return () => {
    prepared.cleanup()
    if (inherited === undefined) delete projectEnv[RUNTIME_BUILD_MANIFEST_ENV]
    else projectEnv[RUNTIME_BUILD_MANIFEST_ENV] = inherited
  }
}

export default function setup(project: TestProject): Promise<(() => void) | undefined> {
  return setupRuntimeBuildPreflight(project)
}
