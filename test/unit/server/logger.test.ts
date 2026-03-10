import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import os from "os"
import path from "path"
import fsp from "fs/promises"
import { Writable } from "stream"

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
      "uses warn as the default non-debug log level",
      async () => {
        const { DEFAULT_NON_DEBUG_LOG_LEVEL } = await import("../../../server/logger")

        expect(DEFAULT_NON_DEBUG_LOG_LEVEL).toBe("warn")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "resolves warn when debug logging is disabled",
      async () => {
        const { resolveRuntimeLogLevel } = await import("../../../server/logger")

        expect(resolveRuntimeLogLevel(false)).toBe("warn")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "resolves debug when debug logging is enabled",
      async () => {
        const { resolveRuntimeLogLevel } = await import("../../../server/logger")

        expect(resolveRuntimeLogLevel(true)).toBe("debug")
      },
      TEST_TIMEOUT_MS,
    )

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
          { FRESHELL_LOG_DIR: logDir, NODE_ENV: "development", PORT: "3001" } as NodeJS.ProcessEnv,
          "/home/test",
        )
        expect(resolved).toBe(
          path.join(
            path.resolve(logDir),
            "server-debug.development.3001.jsonl",
          ),
        )
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "uses explicit mode over NODE_ENV when computing defaults",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          { FRESHELL_LOG_MODE: "development", NODE_ENV: "production", PORT: "3001" } as NodeJS.ProcessEnv,
          "/home/test",
        )
        expect(resolved).toContain("server-debug.development.3001.jsonl")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "infers development from source entry in argv",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          { NODE_ENV: "production", PORT: "3001" } as NodeJS.ProcessEnv,
          "/home/test",
          ["node", "node_modules/.bin/tsx", "watch", "server/index.ts"],
        )
        expect(resolved).toContain("server-debug.development.3001.jsonl")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "infers production from dist entry in argv",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          { NODE_ENV: "development", PORT: "3001" } as NodeJS.ProcessEnv,
          "/home/test",
          ["node", "C:/repo/dist/server/index.js"],
        )
        expect(resolved).toContain("server-debug.production.3001.jsonl")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "handles windows-style dist args during inference",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          { NODE_ENV: "development", PORT: "3001" } as NodeJS.ProcessEnv,
          "/home/test",
          ["node", "C:\\repo\\dist\\server\\index.js"],
        )
        expect(resolved).toContain("server-debug.production.3001.jsonl")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "treats unknown FRESHELL_LOG_MODE as invalid and falls back to argv inference",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          { FRESHELL_LOG_MODE: "staging", NODE_ENV: "production", PORT: "3001" } as NodeJS.ProcessEnv,
          "/home/test",
          ["node", "node_modules/.bin/tsx", "watch", "server/index.ts"],
        )
        expect(resolved).toContain("server-debug.development.3001.jsonl")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "uses explicit FRESHELL_LOG_INSTANCE_ID for filename suffix",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const alpha = resolveDebugLogPath(
          { FRESHELL_LOG_INSTANCE_ID: "alpha", PORT: "3001" } as NodeJS.ProcessEnv,
          "/home/test",
        )
        const beta = resolveDebugLogPath(
          { FRESHELL_LOG_INSTANCE_ID: "beta", PORT: "3001" } as NodeJS.ProcessEnv,
          "/home/test",
        )
        expect(alpha).toContain("server-debug.development.alpha.jsonl")
        expect(beta).toContain("server-debug.development.beta.jsonl")
        expect(alpha).not.toBe(beta)
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "falls back to process PID for instance tag when no instance env vars are set",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          { NODE_ENV: "production", FRESHELL_LOG_DIR: "/tmp/freshell-logs" } as NodeJS.ProcessEnv,
          "/home/test",
        )
        expect(resolved).toContain(`server-debug.production.${process.pid}.jsonl`)
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "sanitizes unsafe instance IDs in debug log filenames",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          {
            FRESHELL_LOG_INSTANCE_ID: "..\\..\\tmp\\unsafe\\path",
            FRESHELL_LOG_DIR: "/var/freshell/logs",
            PORT: "3001",
          } as NodeJS.ProcessEnv,
          "/home/test",
        )
        expect(resolved).toBe(path.join(path.resolve("/var/freshell/logs"), "server-debug.development.path.jsonl"))
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "uses legacy instance variable before PORT fallback",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          { FRESHELL_DEBUG_STREAM_INSTANCE: "ci-run-1", PORT: "3001" } as NodeJS.ProcessEnv,
          "/home/test",
        )
        expect(resolved).toContain("server-debug.development.ci-run-1.jsonl")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "falls back to PORT or VITE_PORT for instance suffix deterministically",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const portBased = resolveDebugLogPath({ PORT: "3001" } as NodeJS.ProcessEnv, "/home/test")
        const vitePortBased = resolveDebugLogPath({ VITE_PORT: "3101" } as NodeJS.ProcessEnv, "/home/test")
        expect(portBased).toContain("server-debug.development.3001.jsonl")
        expect(vitePortBased).toContain("server-debug.development.3101.jsonl")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "uses FRESHELL_LOG_INSTANCE_ID over legacy stream instance",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          {
            FRESHELL_LOG_INSTANCE_ID: "explicit",
            FRESHELL_DEBUG_STREAM_INSTANCE: "legacy",
            PORT: "3001",
          } as NodeJS.ProcessEnv,
          "/home/test",
        )
        expect(resolved).toContain("server-debug.development.explicit.jsonl")
      },
      TEST_TIMEOUT_MS,
    )

    it(
      "logs resolved debug path format with mode and instance",
      async () => {
        const { resolveDebugLogPath } = await import("../../../server/logger")
        const resolved = resolveDebugLogPath(
          {
            NODE_ENV: "production",
            FRESHELL_DEBUG_STREAM_INSTANCE: "abc",
            PORT: "3001",
          } as NodeJS.ProcessEnv,
          "/tmp",
          ["node", "/workspace/dist/server/index.js"],
        )
        expect(resolved).toContain("server-debug.production.abc.jsonl")
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

  describe("single output per log call", () => {
    it(
      "produces exactly one output per log message with a custom destination",
      async () => {
        const chunks: string[] = []
        const dest = new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(chunk.toString())
            callback()
          },
        })

        const { createLogger } = await import("../../../server/logger")
        const testLogger = createLogger(dest)

        testLogger.info("single message test")

        // Pino batches writes; flush by waiting a tick
        await new Promise((resolve) => setTimeout(resolve, 50))

        // Each chunk should contain exactly one JSON log line
        const lines = chunks.join("").split("\n").filter(Boolean)
        expect(lines).toHaveLength(1)
        expect(JSON.parse(lines[0])).toHaveProperty("msg", "single message test")
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
