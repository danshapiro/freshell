import { describe, expect, it } from 'vitest'
import {
  classifySupervisorGdbFailure,
  summarizeSupervisorGdbFailureOutput,
  summarizeSupervisorGdbOutput,
} from '../../helpers/supervisor-crash-diagnostics.js'

describe('supervisor crash diagnostic parsing', () => {
  it('keeps signal, thread, and symbol evidence while removing addresses and paths', () => {
    const summary = summarizeSupervisorGdbOutput([
      'FRESHELL_GDB_ATTACHED',
      'Program received signal SIGSEGV, Segmentation fault.',
      'Thread 3 (Thread 0x00007fff12345678 (LWP 97)):',
      '#0  0x00007fff00112233 in worker () at /private/build/worker.rs:17',
      '#1  0x00007fff00445566 in std::thread::start_thread () from /lib/private/libstd.so',
      'Thread 1 (Thread 0x00007fff87654321 (LWP 91)):',
      '#0  0x00007fff00778899 in supervisor_main () at /private/build/main.rs:8',
      '#2  /private/build/worker.rs:17',
    ].join('\n'))

    expect(summary).toMatchObject({
      available: true,
      attached: true,
      signal: 'SIGSEGV',
      threadCount: 2,
      threadDebugUnavailable: false,
    })
    expect(summary.frames).toEqual([
      { thread: 3, frame: 0, symbol: 'worker' },
      { thread: 3, frame: 1, symbol: 'std::thread::start_thread' },
      { thread: 1, frame: 0, symbol: 'supervisor_main' },
      { thread: 1, frame: 2, symbol: 'unknown' },
    ])
    expect(JSON.stringify(summary)).not.toMatch(/0x[0-9a-f]+|private\/build|private\/lib/)
  })

  it('summarizes startup failures without retaining addresses or filesystem paths', () => {
    const failure = summarizeSupervisorGdbFailureOutput(
      'warning: Could not attach to process 1 at 0x00007fff00112233\n'
        + 'ptrace: Operation not permitted. See /private/build/supervisor.rs:18',
      'gdb: /private/toolchain/bin/gdb: attach failed for /home/user/session',
    )

    expect(failure).toMatchObject({
      category: 'ptrace-denied',
      log: { available: true, attached: false },
    })
    expect(failure.diagnosticLines).toContain('ptrace: Operation not permitted. See <path>')
    expect(JSON.stringify(failure)).not.toMatch(/0x[0-9a-f]+|private\/build|private\/toolchain|home\/user/)
  })

  it('classifies common GDB setup failures without retaining their raw output', () => {
    expect(classifySupervisorGdbFailure('ptrace: Operation not permitted')).toBe('ptrace-denied')
    expect(classifySupervisorGdbFailure('Unable to find libthread_db')).toBe('thread-db-unavailable')
    expect(classifySupervisorGdbFailure('error while loading shared libraries')).toBe('missing-shared-library')
    expect(classifySupervisorGdbFailure('Could not attach to process')).toBe('attach-rejected')
    expect(classifySupervisorGdbFailure('')).toBe('empty-output')
  })
})
