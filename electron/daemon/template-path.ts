import path from 'path'

/**
 * Resolves the path to an installer template file.
 *
 * In a packaged Electron app, templates are placed in extraResources under
 * `{process.resourcesPath}/installers/...`. In development, they live relative
 * to the source tree at `../../installers/...` from the daemon module directory.
 *
 * @param templateSubpath - Path segments under `installers/`, e.g. `['windows', 'freshell-task.xml.template']`
 * @param moduleDir - The __dirname of the calling module (used for dev fallback)
 * @param resourcesPath - process.resourcesPath in packaged Electron, undefined in dev
 */
export function resolveTemplatePath(
  templateSubpath: string[],
  moduleDir: string,
  resourcesPath?: string,
): string {
  if (resourcesPath) {
    return path.join(resourcesPath, 'installers', ...templateSubpath)
  }
  return path.join(moduleDir, '..', '..', 'installers', ...templateSubpath)
}
