import { describe, expect, it } from 'vitest'
import {
  createTerminalSurfaceCheckpoint,
  canUseCheckpointForDeltaReplay,
} from '@/lib/terminal-surface-checkpoint'

describe('terminal surface checkpoint', () => {
  it('accepts a compatible parser-applied checkpoint', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: true, sinceSeq: 42 })
  })

  it('rejects a checkpoint after geometry changes', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 100,
      rows: 40,
      geometryEpoch: 4,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'geometry_changed' })
  })

  it('rejects a checkpoint while parser work is still in flight', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: false,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'parser_busy' })
  })

  it('rejects a checkpoint from a different server instance', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-b',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'server_changed' })
  })

  it('rejects a checkpoint when only the checkpoint has a server boot id', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      serverBootId: 'boot-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'server_changed' })
  })

  it('rejects a checkpoint when only the current server has a boot id', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      serverBootId: 'boot-a',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'server_changed' })
  })
})
