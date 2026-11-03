import { describe, expect, it } from 'vitest'
import {
  classifySupervisorGdbFailure,
  summarizeSupervisorGdbAttachFacts,
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

  it('reports the observer stage and bounded process facts without raw kernel values', () => {
    const facts = summarizeSupervisorGdbAttachFacts({
      stage: 'gdb_attach',
      markers: { wrapperStarted: true, scriptStarted: true, attached: false, exited: false, exitCode: undefined },
      container: { verified: true, running: true },
      gdb: {
        present: true,
        identityMatches: true,
        state: 'D (disk sleep)',
        waitChannel: 'do_wait_for_common',
        threads: 2,
        capEff: '0000000000080000',
        tracerPid: 0,
      },
      target: {
        present: true,
        identityMatches: true,
        state: 't (tracing stop)',
        waitChannel: 'ptrace_stop',
        threads: 96,
        capEff: '0000000000080000',
        tracerPid: 12345,
      },
    })

    expect(facts).toEqual({
      stage: 'gdb_attach',
      markers: { wrapperStarted: true, scriptStarted: true, attached: false, exited: false, exitStatus: 'unknown' },
      container: { verified: true, running: true },
      gdb: {
        present: true, identityMatches: true, state: 'disk_sleep', waitClass: 'wait',
        threadCount: '2_to_8', hasSysPtrace: true, tracerPresent: false,
      },
      target: {
        present: true, identityMatches: true, state: 'tracing_stop', waitClass: 'ptrace',
        threadCount: '33_to_128', hasSysPtrace: true, tracerPresent: true,
      },
    })
    expect(JSON.stringify(facts)).not.toMatch(/do_wait_for_common|ptrace_stop|0000000000080000|12345|96/)
  })

  it('withholds process details when a recorded pid no longer matches the owned process', () => {
    const facts = summarizeSupervisorGdbAttachFacts({
      stage: 'gdb_script_start',
      markers: { wrapperStarted: true, scriptStarted: false, attached: false, exited: false },
      container: { verified: true, running: true },
      gdb: {
        present: true,
        identityMatches: false,
        state: 'R (running)',
        waitChannel: '/private/kernel/secret',
        threads: 12,
        capEff: '0000000000080000',
        tracerPid: 789,
      },
      target: {
        present: true,
        identityMatches: true,
        state: 'S (sleeping)',
        waitChannel: 'ep_poll',
        threads: 4,
        capEff: '0000000000000000',
        tracerPid: 0,
      },
    })

    expect(facts.gdb).toEqual({
      present: true, identityMatches: false, state: 'unavailable', waitClass: 'unavailable',
      threadCount: 'unavailable', hasSysPtrace: null, tracerPresent: null,
    })
    expect(JSON.stringify(facts)).not.toMatch(/private\/kernel|0000000000080000|0000000000000000|789|12/)
  })
})
