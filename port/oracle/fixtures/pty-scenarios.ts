/**
 * Deterministic PTY capture scenarios for the equivalence oracle's T1 rung.
 *
 * Each scenario drives a REAL pseudo-terminal (node-pty, spawned by the original
 * server) with a short, byte-stable sequence of shell commands and captures the
 * exact terminal output bytes between two sentinels. The captured bytes become a
 * committed golden that the Rust port must reproduce byte-for-byte.
 *
 * DETERMINISM RULES for every scenario (why these commands and not others):
 *   - ASCII-only, fixed output. NEVER date/hostname/pwd/ls/random/$RANDOM or
 *     anything that emits the isolated temp path, a pid, or a clock value.
 *   - Lines stay well under the capture width (120 cols) so the pty never wraps.
 *   - `printf` (a bash builtin) and `seq` (coreutils) are locale-invariant for
 *     the ASCII payloads used here, so LANG/LC_ALL do not perturb the bytes.
 *
 * SHELL / ARGV / ENV PINNING NOTE:
 *   `terminal.create` (shared/ws-protocol.ts TerminalCreateSchema, `.strict()`)
 *   only accepts a shell *enum* (`ShellSchema` = system|cmd|powershell|wsl) — it
 *   cannot set argv or env directly. On this Linux host `shell: 'system'`
 *   resolves to `/bin/bash -l` (terminal-registry.ts getSystemShell/buildSpawnSpec).
 *   The controlled, echo-free, prompt-free environment the strategy calls for is
 *   therefore established by the capture harness's *setup line* (see
 *   pty-capture.ts DEFAULT_SETUP_COMMAND), whose output is deliberately EXCLUDED
 *   from the golden window by the sentinels. Scenarios only carry the payload.
 */

export type OracleShell = 'system' | 'cmd' | 'powershell' | 'wsl'

export interface PtyScenario {
  /** Filesystem-safe id — also the golden basename (`<name>.golden`). */
  name: string
  /** Human-readable description of what byte-stable behaviour this pins. */
  description: string
  /** Shell enum passed to `terminal.create` (ShellSchema). */
  shell: OracleShell
  /** Terminal mode passed to `terminal.create` (plain interactive shell). */
  mode: string
  /**
   * Ordered payload command lines. Each is sent as one `terminal.input`
   * (the harness appends the submitting newline) and runs BETWEEN the
   * start/end sentinels. Keep byte-stable, ASCII, path-free.
   */
  inputLines: string[]
  /**
   * The exact bytes the payload is expected to emit between the sentinels, as a
   * readable literal. Documentation + a coarse sanity anchor for the test; the
   * authoritative golden is the captured file. `\r\n` because the pty line
   * discipline (ONLCR, default-on) translates the shell's `\n` to CR-LF on read.
   */
  expectedGolden: string
}

/**
 * The T1 scenario set. Small, portable, path-free. Names double as golden
 * basenames under `port/oracle/baselines/pty/`.
 */
export const PTY_SCENARIOS: readonly PtyScenario[] = [
  {
    name: 'echo-hello',
    description: 'single fixed-string line via printf',
    shell: 'system',
    mode: 'shell',
    inputLines: [String.raw`printf 'hello\n'`],
    expectedGolden: 'hello\r\n',
  },
  {
    name: 'seq-3',
    description: 'multi-line numeric output from coreutils seq',
    shell: 'system',
    mode: 'shell',
    inputLines: ['seq 3'],
    expectedGolden: '1\r\n2\r\n3\r\n',
  },
  {
    name: 'fixed-width-fill',
    description: 'fixed-width run of a single character (no wrap at 120 cols)',
    shell: 'system',
    mode: 'shell',
    inputLines: [String.raw`printf 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n'`],
    expectedGolden: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\r\n',
  },
  {
    name: 'multi-line',
    description: 'two separate input lines producing two output lines in order',
    shell: 'system',
    mode: 'shell',
    inputLines: [String.raw`printf 'line-1\n'`, String.raw`printf 'line-2\n'`],
    expectedGolden: 'line-1\r\nline-2\r\n',
  },
] as const

/** Look a scenario up by name (used by the equals-committed golden test). */
export function scenarioByName(name: string): PtyScenario | undefined {
  return PTY_SCENARIOS.find((s) => s.name === name)
}
