import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type AmplifierEnvironmentClone = {
  prefix: string
  interpreter: string
  dispose: () => Promise<void>
}

export type IsolatedAmplifierCli = AmplifierEnvironmentClone & {
  command: string
  baseArgs: string[]
}

function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

export async function cloneAmplifierEnvironment(input: {
  sourcePrefix: string
  sourceInterpreter: string
}): Promise<AmplifierEnvironmentClone> {
  const sourcePrefix = path.resolve(input.sourcePrefix)
  const sourceInterpreter = path.resolve(input.sourceInterpreter)
  if (!pathIsInside(sourcePrefix, sourceInterpreter)) {
    throw new Error(
      `Amplifier's Python interpreter must be inside the Amplifier environment: ${sourceInterpreter}`,
    )
  }
  try {
    await fs.access(path.join(sourcePrefix, 'pyvenv.cfg'))
  } catch {
    throw new Error(
      `Refusing to copy a non-virtual Python environment for Amplifier: ${sourcePrefix}`,
    )
  }

  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amplifier-tool-'))
  const prefix = path.join(sandboxRoot, 'environment')
  const interpreter = path.join(prefix, path.relative(sourcePrefix, sourceInterpreter))
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await fs.rm(sandboxRoot, { recursive: true, force: true })
  }

  try {
    await fs.cp(sourcePrefix, prefix, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
    return { prefix, interpreter, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

async function findExecutable(command: string): Promise<string> {
  const { stdout } = await execFileAsync('which', [command], {
    timeout: 15_000,
  })
  const executable = stdout.trim()
  if (!executable) throw new Error(`Could not resolve ${command} on PATH`)
  return fs.realpath(executable)
}

async function readAbsoluteShebangInterpreter(executable: string): Promise<string> {
  const firstLine = (await fs.readFile(executable, 'utf8')).split(/\r?\n/, 1)[0]
  if (!firstLine?.startsWith('#!')) {
    throw new Error(`Amplifier launcher has no shebang: ${executable}`)
  }

  const interpreter = firstLine.slice(2).trim()
  if (!path.isAbsolute(interpreter) || interpreter.includes(' ')) {
    throw new Error(
      `Amplifier launcher must use one absolute Python interpreter: ${firstLine}`,
    )
  }
  return interpreter
}

export async function createIsolatedAmplifierCli(
  command = 'amplifier',
): Promise<IsolatedAmplifierCli> {
  // Real Amplifier contracts run in WSL/Linux. Resolve the console-script
  // shebang so the clone uses the exact installed build instead of fetching a
  // potentially different revision from the network.
  const executable = await findExecutable(command)
  const sourceInterpreter = await readAbsoluteShebangInterpreter(executable)
  const { stdout } = await execFileAsync(
    sourceInterpreter,
    ['-c', 'import sys; print(sys.prefix)'],
    { timeout: 15_000 },
  )
  const sourcePrefix = stdout.trim()
  if (!sourcePrefix) {
    throw new Error(`Could not resolve Amplifier's Python environment from ${sourceInterpreter}`)
  }

  const isolated = await cloneAmplifierEnvironment({
    sourcePrefix,
    sourceInterpreter,
  })
  try {
    const { stdout: isolatedPrefixOutput } = await execFileAsync(
      isolated.interpreter,
      ['-c', 'import sys; print(sys.prefix)'],
      { timeout: 15_000 },
    )
    if (path.resolve(isolatedPrefixOutput.trim()) !== path.resolve(isolated.prefix)) {
      throw new Error(
        `Copied Amplifier interpreter did not adopt its private environment: ${isolatedPrefixOutput.trim()}`,
      )
    }
    return {
      ...isolated,
      command: isolated.interpreter,
      baseArgs: ['-m', 'amplifier_app_cli'],
    }
  } catch (error) {
    await isolated.dispose()
    throw error
  }
}
