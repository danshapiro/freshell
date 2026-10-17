import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const PINNED_VERSION = '1.18.21'
const PINNED_PACKAGE_MANAGER = '10.34.5'
const PACKAGE_PROVISION_TIMEOUT_MS = 5 * 60 * 1000
const CONTRACT_TIMEOUT_MS = 120 * 1000

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(OPENCODE_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|GEMINI_API_KEY$)/.test(key)) {
      delete env[key]
    }
  }
  env.HOME = path.join(root, 'home')
  env.XDG_CONFIG_HOME = path.join(root, 'config')
  env.XDG_DATA_HOME = path.join(root, 'data')
  env.XDG_STATE_HOME = path.join(root, 'state')
  env.XDG_CACHE_HOME = path.join(root, 'cache')
  env.CI = '1'
  env.NO_COLOR = '1'
  return env
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; label: string },
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ }
      setTimeout(() => {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
        }
      }, 2_000).unref()
    } else {
      child.kill('SIGTERM')
    }
  }, options.timeoutMs)
  timer.unref()

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  }).finally(() => clearTimeout(timer))
  if (timedOut) throw new Error(`${options.label} exceeded ${options.timeoutMs}ms`)
  if (exitCode !== 0) {
    throw new Error(`${options.label} exited ${exitCode}\n${stderr.trim() || stdout.trim()}`)
  }
  return { stdout, stderr, exitCode }
}

function packageIntegrity(lock: string): string {
  const packagesIndex = lock.indexOf('\npackages:')
  if (packagesIndex < 0) throw new Error('pnpm lockfile has no packages section')
  const packages = lock.slice(packagesIndex)
  const block = packages.match(
    new RegExp(`(?:^|\\n)  opencode-ai@${PINNED_VERSION.replaceAll('.', '\\.')}:[\\s\\S]*?(?=\\n  [^ ]|$)`),
  )?.[0]
  // pnpm emits this as an inline YAML map (`resolution: {integrity: ...}`),
  // so the trailing map brace is not part of the SRI value.
  const integrity = block?.match(/integrity:\s*(sha512-[A-Za-z0-9+/]+={0,2})(?:\s|})/)?.[1]
  if (!integrity) throw new Error(`could not read opencode-ai@${PINNED_VERSION} integrity`)
  return integrity
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-checkpoint-'))
  await chmod(tempRoot, 0o700)
  const toolRoot = path.join(tempRoot, 'tool')
  await mkdir(toolRoot, { mode: 0o700 })
  for (const directory of ['home', 'config', 'data', 'state', 'cache']) {
    await mkdir(path.join(tempRoot, directory), { mode: 0o700 })
  }
  const env = isolatedEnvironment(tempRoot)
  const receipt = {
    contract: 'opencode_checkpoint_message_id_persists_after_prompt',
    package: `opencode-ai@${PINNED_VERSION}`,
    packageIntegrity: '',
    binaryVersion: '',
    testCommand: '',
    testsExecuted: 0,
    testsPassed: 0,
    testsFailed: 0,
  }
  const receiptPath = path.resolve(
    path.join(
      path.resolve(process.cwd(), '..', '..'),
      '.worktrees/.the-usual-logs/managed-provider-environment/reports/opencode-checkpoint-contract.json',
    ),
  )
  let failure: unknown

  try {
    await writeFile(path.join(toolRoot, 'package.json'), `${JSON.stringify({
      name: 'freshell-opencode-checkpoint-contract-tool',
      version: '1.0.0',
      private: true,
      packageManager: `pnpm@${PINNED_PACKAGE_MANAGER}`,
    }, null, 2)}\n`, { mode: 0o600 })
    await writeFile(path.join(toolRoot, 'pnpm-workspace.yaml'), [
      'packages: []',
      'allowBuilds:',
      '  opencode-ai: true',
      '',
    ].join('\n'), { mode: 0o600 })

    const pnpmVersion = await runCommand('pnpm', ['--version'], {
      cwd: toolRoot,
      env,
      timeoutMs: 30_000,
      label: 'pnpm version check',
    })
    if (pnpmVersion.stdout.trim() !== PINNED_PACKAGE_MANAGER) {
      throw new Error(`runner requires pnpm ${PINNED_PACKAGE_MANAGER}; found ${pnpmVersion.stdout.trim()}`)
    }

    await runCommand('pnpm', ['add', '--save-exact', '--workspace-root', `opencode-ai@${PINNED_VERSION}`], {
      cwd: toolRoot,
      env,
      timeoutMs: PACKAGE_PROVISION_TIMEOUT_MS,
      label: 'pinned OpenCode package provisioning',
    })
    await runCommand('pnpm', ['install', '--frozen-lockfile'], {
      cwd: toolRoot,
      env,
      timeoutMs: PACKAGE_PROVISION_TIMEOUT_MS,
      label: 'frozen pinned OpenCode install',
    })

    const packageJson = JSON.parse(await readFile(path.join(toolRoot, 'node_modules/opencode-ai/package.json'), 'utf8')) as {
      version?: string
    }
    if (packageJson.version !== PINNED_VERSION) {
      throw new Error(`installed opencode-ai package is ${packageJson.version ?? 'unknown'}, expected ${PINNED_VERSION}`)
    }
    receipt.packageIntegrity = packageIntegrity(await readFile(path.join(toolRoot, 'pnpm-lock.yaml'), 'utf8'))

    const binary = path.join(toolRoot, 'node_modules/.bin/opencode')
    await realpath(binary)
    const version = await runCommand(binary, ['--version'], {
      cwd: toolRoot,
      env,
      timeoutMs: 30_000,
      label: 'run pinned OpenCode version',
    })
    receipt.binaryVersion = version.stdout.trim()
    if (receipt.binaryVersion !== PINNED_VERSION) {
      throw new Error(`selected OpenCode binary is ${receipt.binaryVersion}, expected ${PINNED_VERSION}`)
    }

    const rustCommand = [
      'mise', 'exec', 'rust@1.96', '--', 'cargo', 'test',
      '-p', 'freshell-opencode',
      '--features', 'real-provider-contract-tests',
      '--locked',
      '--test', 'checkpoint_message_id_contract',
      'opencode_checkpoint_message_id_persists_after_prompt',
      '--', '--exact', '--nocapture',
    ]
    receipt.testCommand = rustCommand.join(' ')
    const contractEnv: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(contractEnv)) {
      if (/^(OPENCODE_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|GEMINI_API_KEY$)/.test(key)) {
        delete contractEnv[key]
      }
    }
    const result = await runCommand(rustCommand[0]!, rustCommand.slice(1), {
      cwd: process.cwd(),
      env: {
        ...contractEnv,
        FRESHELL_OPENCODE_CONTRACT_BIN: binary,
        FRESHELL_OPENCODE_CONTRACT_ROOT: tempRoot,
      },
      timeoutMs: CONTRACT_TIMEOUT_MS + 15_000,
      label: 'pinned OpenCode messageID persistence contract',
    })
    const output = `${result.stdout}\n${result.stderr}`
    const summary = output.match(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/)
    if (!summary) throw new Error('contract test output has no successful positive-count result summary')
    receipt.testsExecuted = Number(summary[1]) + Number(summary[2]) + Number(summary[3])
    receipt.testsPassed = Number(summary[1])
    receipt.testsFailed = Number(summary[2])
    if (receipt.testsExecuted !== 1 || receipt.testsPassed !== 1 || receipt.testsFailed !== 0) {
      throw new Error(`expected exactly one passing contract test, got ${receipt.testsExecuted} executed`)
    }
  } catch (error) {
    failure = error
  } finally {
    await mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 })
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
  }

  if (failure) throw failure
  process.stdout.write(`OpenCode checkpoint identity contract passed; private receipt: ${receiptPath}\n`)
}

await main()
