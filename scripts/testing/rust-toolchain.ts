import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MISE_RUST_VERSION = '1.96'
export const RUSTUP_TOOLCHAIN = '1.96.0'

export type PinnedRustCommand = {
  manager: 'mise' | 'rustup'
  executable: string
  prefixArgs: string[]
}

export function selectPinnedRustCommand(
  miseExecutable: string | undefined,
  rustupExecutable: string | undefined,
): PinnedRustCommand {
  if (miseExecutable) {
    return {
      manager: 'mise',
      executable: miseExecutable,
      prefixArgs: ['exec', `rust@${MISE_RUST_VERSION}`, '--'],
    }
  }
  if (rustupExecutable) {
    return {
      manager: 'rustup',
      executable: rustupExecutable,
      prefixArgs: ['run', RUSTUP_TOOLCHAIN],
    }
  }
  throw new Error(
    `Runtime parity tests require Rust ${RUSTUP_TOOLCHAIN}. Install mise and run `
    + `mise install rust@${MISE_RUST_VERSION}, or install rustup and run: `
    + `rustup toolchain install ${RUSTUP_TOOLCHAIN}.`,
  )
}

export function resolvePinnedRustCommand(env: NodeJS.ProcessEnv = process.env): PinnedRustCommand {
  const miseExecutable = findExecutable(path.join(os.homedir(), '.local', 'bin', 'mise'), env.PATH)
    ?? findExecutable('mise', env.PATH)
  const rustupExecutable = findExecutable('rustup', env.PATH)
  const command = selectPinnedRustCommand(miseExecutable, rustupExecutable)

  if (command.manager === 'rustup') {
    const probe = spawnSync(command.executable, [...command.prefixArgs, 'rustc', '--version'], {
      encoding: 'utf8',
      env,
    })
    const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim()
    const rustcVersion = (probe.stdout ?? '').trim()
    if (
      probe.status !== 0
      || (rustcVersion !== `rustc ${RUSTUP_TOOLCHAIN}` && !rustcVersion.startsWith(`rustc ${RUSTUP_TOOLCHAIN} `))
    ) {
      const detail = output ? ` ${output}` : ''
      throw new Error(
        `Rustup is available, but its pinned Rust ${RUSTUP_TOOLCHAIN} toolchain is not. `
        + `Install it with: rustup toolchain install ${RUSTUP_TOOLCHAIN}.${detail}`,
      )
    }
  }

  return command
}

function findExecutable(command: string, pathValue: string | undefined): string | undefined {
  const candidates = command.includes(path.sep)
    ? [command]
    : (pathValue ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command))
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}
