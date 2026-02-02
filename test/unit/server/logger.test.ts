import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import os from "os"
import path from "path"
import fsp from "fs/promises"

describe("logger", () => {
  const originalEnv = { ...process.env }
  const TEST_TIMEOUT_MS = 15000

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe("log level configuration", () => {
    it(
      "defaults to debug in non-production",
      async () => {
        delete process.env.LOG_LEVEL
        delete process.env.NODE_ENV

        const { logger } = await import("../../../server/logger")
        expect(logger.level).toBe("debug")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "defaults to debug in production",
      async () => {
        delete process.env.LOG_LEVEL
        process.env.NODE_ENV = "production"

        const { logger } = await import("../../../server/logger")
        expect(logger.level).toBe("debug")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "respects LOG_LEVEL env var in development",
      async () => {
        process.env.LOG_LEVEL = "warn"
        delete process.env.NODE_ENV

        const { logger } = await import("../../../server/logger")
        expect(logger.level).toBe("warn")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "respects LOG_LEVEL env var in production",
      async () => {
        process.env.LOG_LEVEL = "error"
        process.env.NODE_ENV = "production"

        const { logger } = await import("../../../server/logger")
        expect(logger.level).toBe("error")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "LOG_LEVEL takes precedence over NODE_ENV",
      async () => {
        process.env.LOG_LEVEL = "trace"
        process.env.NODE_ENV = "production"

        const { logger } = await import("../../../server/logger")
        expect(logger.level).toBe("trace")
      },
      TEST_TIMEOUT_MS,
    )
  })

  describe("logger interface", () => {
    it(
      "exports a pino logger instance",
      async () => {
        const { logger } = await import("../../../server/logger")

        // Verify it has the expected pino logger methods
        expect(typeof logger.info).toBe("function")
        expect(typeof logger.debug).toBe("function")
        expect(typeof logger.warn).toBe("function")
        expect(typeof logger.error).toBe("function")
        expect(typeof logger.trace).toBe("function")
        expect(typeof logger.fatal).toBe("function")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "can log with objects",
      async () => {
        const { logger } = await import("../../../server/logger")

        // This should not throw
        expect(() => {
          logger.info({ key: "value" }, "test message")
        }).not.toThrow()
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "can log with child loggers",
      async () => {
        const { logger } = await import("../../../server/logger")

        const childLogger = logger.child({ component: "test" })
        expect(typeof childLogger.info).toBe("function")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "can update log level at runtime",
      async () => {
        const { logger, setLogLevel } = await import("../../../server/logger")

        setLogLevel("info")
        expect(logger.level).toBe("info")
      },
      TEST_TIMEOUT_MS,
    )
  })

  describe("debug log path resolution", () => {
    it(
      "skips debug log path when running under vitest",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          { VITEST: "true", NODE_ENV: "production" } as NodeJS.ProcessEnv,
          "/home/test",
        )
        expect(resolved).toBeNull()
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "prefers LOG_DEBUG_PATH when provided",
      async () => {
        const customPath = path.join(os.tmpdir(), "freshell-debug.jsonl")
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath({ LOG_DEBUG_PATH: customPath } as NodeJS.ProcessEnv, "/home/test")
        expect(resolved).toBe(path.resolve(customPath))
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "uses FRESHELL_LOG_DIR when set",
      async () => {
        const logDir = path.join(os.tmpdir(), "freshell-logs")
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          { FRESHELL_LOG_DIR: logDir, NODE_ENV: "development" } as NodeJS.ProcessEnv,
          "/home/test",
        )
        expect(resolved).toBe(path.join(path.resolve(logDir), "server-debug.jsonl"))
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "skips default path in test env without explicit override",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath({ NODE_ENV: "test" } as NodeJS.ProcessEnv, "/home/test")
        expect(resolved).toBeNull()
      },
      TEST_TIMEOUT_MS,
    )
  })

  describe("debug log file stream", () => {
    it(
      "writes log entries to the debug file",
      async () => {
        const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "freshell-logs-"))
        const filePath = path.join(tempDir, "server-debug.jsonl")
        const { createDebugFileStream } = await import("../../../server/logger")
        const stream = createDebugFileStream(filePath, { size: "1K", maxFiles: 2 })

        stream.write("{\"event\":\"test\"}\n")
        await new Promise<void>((resolve) => stream.end(resolve))

        const content = await fsp.readFile(filePath, "utf-8")
        expect(content).toContain("\"event\":\"test\"")

        await fsp.rm(tempDir, { recursive: true, force: true })
      },
      TEST_TIMEOUT_MS,
    )
  })
})
