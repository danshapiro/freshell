import { describe, it, expect, vi } from 'vitest'
import {
  BrowserSdkMessageSchema,
} from '../../../server/sdk-bridge-types.js'
import type {
  SDKMessage,
  PermissionResult,
  SdkSessionState,
} from '../../../server/sdk-bridge-types.js'

describe('SDK Protocol Types', () => {
  describe('SDK re-exports', () => {
    it('re-exports SDKMessage union type', () => {
      // Type-level test: verify the re-export compiles
      const msg: SDKMessage = {
        type: 'assistant',
        message: {} as any,
        parent_tool_use_id: null,
        uuid: 'test' as any,
        session_id: 'test',
      }
      expect(msg.type).toBe('assistant')
    })

    it('re-exports PermissionResult discriminated union', () => {
      const allow: PermissionResult = {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
        updatedPermissions: [],
      }
      const deny: PermissionResult = {
        behavior: 'deny',
        message: 'User denied',
        interrupt: true,
      }
      expect(allow.behavior).toBe('allow')
      expect(deny.behavior).toBe('deny')
    })
  })

  describe('SdkSessionState', () => {
    it('pendingPermissions stores resolve function and SDK context', () => {
      const state: SdkSessionState = {
        sessionId: 'test',
        status: 'connected',
        createdAt: Date.now(),
        messages: [],
        pendingPermissions: new Map(),
        costUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }
      const resolveFn = vi.fn()
      state.pendingPermissions.set('req-1', {
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseID: 'tool-1',
        resolve: resolveFn,
      })
      const pending = state.pendingPermissions.get('req-1')!
      pending.resolve({ behavior: 'allow' })
      expect(resolveFn).toHaveBeenCalledWith({ behavior: 'allow' })
    })
  })

  describe('BrowserSdkMessageSchema', () => {
    it('validates sdk.create message', () => {
      const msg = {
        type: 'sdk.create',
        requestId: 'req-1',
        cwd: '/home/user/project',
        resumeSessionId: 'session-abc',
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates sdk.send message', () => {
      const msg = {
        type: 'sdk.send',
        sessionId: 'sess-1',
        text: 'Write a hello world function',
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates sdk.permission.respond message', () => {
      const msg = {
        type: 'sdk.permission.respond',
        sessionId: 'sess-1',
        requestId: 'perm-1',
        behavior: 'allow',
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates sdk.permission.respond with updatedPermissions', () => {
      const msg = {
        type: 'sdk.permission.respond',
        sessionId: 'sess-1',
        requestId: 'perm-1',
        behavior: 'allow',
        updatedPermissions: [{ tool: 'Bash', permission: 'allow' }],
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates sdk.permission.respond deny with message', () => {
      const msg = {
        type: 'sdk.permission.respond',
        sessionId: 'sess-1',
        requestId: 'perm-1',
        behavior: 'deny',
        message: 'Not allowed',
        interrupt: true,
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates sdk.interrupt message', () => {
      const msg = {
        type: 'sdk.interrupt',
        sessionId: 'sess-1',
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates sdk.create with effort field', () => {
      const msg = {
        type: 'sdk.create',
        requestId: 'req-1',
        effort: 'high',
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveProperty('effort', 'high')
      }
    })

    it('rejects sdk.create with invalid effort value', () => {
      const msg = {
        type: 'sdk.create',
        requestId: 'req-1',
        effort: 'turbo',
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(false)
    })

    it('validates sdk.set-model message', () => {
      const result = BrowserSdkMessageSchema.safeParse({
        type: 'sdk.set-model',
        sessionId: 'sess-1',
        model: 'claude-sonnet-4-5-20250929',
      })
      expect(result.success).toBe(true)
    })

    it('rejects sdk.set-model with empty model', () => {
      const result = BrowserSdkMessageSchema.safeParse({
        type: 'sdk.set-model',
        sessionId: 'sess-1',
        model: '',
      })
      expect(result.success).toBe(false)
    })

    it('validates sdk.set-permission-mode message', () => {
      const result = BrowserSdkMessageSchema.safeParse({
        type: 'sdk.set-permission-mode',
        sessionId: 'sess-1',
        permissionMode: 'default',
      })
      expect(result.success).toBe(true)
    })

    it('rejects sdk.set-permission-mode with empty permissionMode', () => {
      const result = BrowserSdkMessageSchema.safeParse({
        type: 'sdk.set-permission-mode',
        sessionId: 'sess-1',
        permissionMode: '',
      })
      expect(result.success).toBe(false)
    })
  })
})
