import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('logger', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('log level configuration', () => {
    it('defaults to debug in non-production', async () => {
      delete process.env.LOG_LEVEL
      delete process.env.NODE_ENV

      const { logger } = await import('../../../server/logger')
      expect(logger.level).toBe('debug')
    })

    it('defaults to info in production', async () => {
      delete process.env.LOG_LEVEL
      process.env.NODE_ENV = 'production'

      const { logger } = await import('../../../server/logger')
      expect(logger.level).toBe('info')
    })

    it('respects LOG_LEVEL env var in development', async () => {
      process.env.LOG_LEVEL = 'warn'
      delete process.env.NODE_ENV

      const { logger } = await import('../../../server/logger')
      expect(logger.level).toBe('warn')
    })

    it('respects LOG_LEVEL env var in production', async () => {
      process.env.LOG_LEVEL = 'error'
      process.env.NODE_ENV = 'production'

      const { logger } = await import('../../../server/logger')
      expect(logger.level).toBe('error')
    })

    it('LOG_LEVEL takes precedence over NODE_ENV', async () => {
      process.env.LOG_LEVEL = 'trace'
      process.env.NODE_ENV = 'production'

      const { logger } = await import('../../../server/logger')
      expect(logger.level).toBe('trace')
    })
  })

  describe('logger interface', () => {
    it('exports a pino logger instance', async () => {
      const { logger } = await import('../../../server/logger')

      // Verify it has the expected pino logger methods
      expect(typeof logger.info).toBe('function')
      expect(typeof logger.debug).toBe('function')
      expect(typeof logger.warn).toBe('function')
      expect(typeof logger.error).toBe('function')
      expect(typeof logger.trace).toBe('function')
      expect(typeof logger.fatal).toBe('function')
    })

    it('can log with objects', async () => {
      const { logger } = await import('../../../server/logger')

      // This should not throw
      expect(() => {
        logger.info({ key: 'value' }, 'test message')
      }).not.toThrow()
    })

    it('can log with child loggers', async () => {
      const { logger } = await import('../../../server/logger')

      const childLogger = logger.child({ component: 'test' })
      expect(typeof childLogger.info).toBe('function')
    })
  })
})
