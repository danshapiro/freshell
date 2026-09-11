import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { ManagedRuntimeMetrics, ManagedRuntimeSoul } from '@shared/managed-runtime'
import {
  getManagedRuntimeSoul,
  updateManagedRuntimeLimits,
} from '@/lib/api'

const MIB = 1024 * 1024

function wholeNumber(value: number | undefined, fallback: number): string {
  return String(Math.max(0, Math.round(value ?? fallback)))
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return 'Not reported'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  return `${(bytes / MIB).toFixed(0)} MiB`
}

function formatCpu(milli: number | undefined): string {
  return milli === undefined ? 'Not reported' : `${milli} millicores`
}

function formatPids(pids: number | undefined): string {
  return pids === undefined ? 'Not reported' : `${pids} processes`
}

function Usage({ metrics }: { metrics?: ManagedRuntimeMetrics }) {
  if (!metrics) return <span>Not reported</span>
  return (
    <span>
      {formatBytes(metrics.memoryCurrentBytes)} memory · {metrics.pidsCurrent} processes ·{' '}
      {(metrics.cpuUsageUsec / 1_000_000).toFixed(1)} CPU seconds
    </span>
  )
}

export function AgentResourceLimits({
  soul,
  onSaved,
}: {
  soul: ManagedRuntimeSoul
  onSaved: () => void | Promise<void>
}) {
  const source = soul.configuredLimits ?? soul.effectiveLimits
  const [cpuMilli, setCpuMilli] = useState(() => wholeNumber(source?.cpuMilli, 2_000))
  const [memoryMiB, setMemoryMiB] = useState(() => wholeNumber(
    source ? source.memoryBytes / MIB : undefined,
    4_096,
  ))
  const [swapMiB, setSwapMiB] = useState(() => wholeNumber(
    source ? source.swapBytes / MIB : undefined,
    0,
  ))
  const [pidsMax, setPidsMax] = useState(() => wholeNumber(source?.pidsMax, 512))
  const [actual, setActual] = useState<ManagedRuntimeMetrics | undefined>()
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    const next = soul.configuredLimits ?? soul.effectiveLimits
    setCpuMilli(wholeNumber(next?.cpuMilli, 2_000))
    setMemoryMiB(wholeNumber(next ? next.memoryBytes / MIB : undefined, 4_096))
    setSwapMiB(wholeNumber(next ? next.swapBytes / MIB : undefined, 0))
    setPidsMax(wholeNumber(next?.pidsMax, 512))
  }, [soul.soulId, soul.intentRevision, soul.configuredLimits, soul.effectiveLimits])

  useEffect(() => {
    let cancelled = false
    getManagedRuntimeSoul(soul.soulId)
      .then((detail) => {
        if (!cancelled) setActual(detail.actualUsage ?? undefined)
      })
      .catch(() => {
        if (!cancelled) setActual(undefined)
      })
    return () => { cancelled = true }
  }, [soul.soulId, soul.incarnationId])

  const validation = useMemo(() => {
    const values = [Number(cpuMilli), Number(memoryMiB), Number(swapMiB), Number(pidsMax)]
    if (!values.every(Number.isSafeInteger)) return 'Limits must be whole numbers.'
    if (values[0] <= 0) return 'CPU must be greater than zero.'
    if (values[1] <= 0) return 'Memory must be greater than zero.'
    if (values[2] < 0) return 'Swap cannot be negative.'
    if (values[3] <= 0) return 'PID limit must be greater than zero.'
    return undefined
  }, [cpuMilli, memoryMiB, swapMiB, pidsMax])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (validation || saving) return
    setSaving(true)
    setMessage(undefined)
    try {
      const result = await updateManagedRuntimeLimits(
        soul.soulId,
        soul.intentRevision,
        {
          cpuMilli: Number(cpuMilli),
          memoryBytes: Number(memoryMiB) * MIB,
          swapBytes: Number(swapMiB) * MIB,
          pidsMax: Number(pidsMax),
        },
      )
      setMessage(
        result.application === 'applied_now'
          ? 'Limits applied to the running agent.'
          : 'Limits saved. They will apply to the next agent incarnation.',
      )
      await onSaved()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <details className="mt-2 rounded-md border border-border p-2 text-xs">
      <summary className="cursor-pointer font-medium">Resource limits and usage</summary>
      <dl className="mt-2 grid gap-1 text-muted-foreground">
        <div>
          <dt className="inline font-medium text-foreground">Configured: </dt>
          <dd className="inline">
            {formatCpu(soul.configuredLimits?.cpuMilli)} ·{' '}
            {formatBytes(soul.configuredLimits?.memoryBytes)} ·{' '}
            {formatPids(soul.configuredLimits?.pidsMax)}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-foreground">Effective: </dt>
          <dd className="inline">
            {formatCpu(soul.effectiveLimits?.cpuMilli)} ·{' '}
            {formatBytes(soul.effectiveLimits?.memoryBytes)} ·{' '}
            {formatPids(soul.effectiveLimits?.pidsMax)}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-foreground">Actual: </dt>
          <dd className="inline"><Usage metrics={actual} /></dd>
        </div>
      </dl>
      <form className="mt-3 grid grid-cols-2 gap-2" onSubmit={submit}>
        <label className="grid gap-1">
          <span>CPU (millicores)</span>
          <input
            className="rounded border border-border bg-background px-2 py-1"
            inputMode="numeric"
            min={1}
            type="number"
            value={cpuMilli}
            onChange={(event) => setCpuMilli(event.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span>Memory (MiB)</span>
          <input
            className="rounded border border-border bg-background px-2 py-1"
            inputMode="numeric"
            min={1}
            type="number"
            value={memoryMiB}
            onChange={(event) => setMemoryMiB(event.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span>Swap (MiB)</span>
          <input
            className="rounded border border-border bg-background px-2 py-1"
            inputMode="numeric"
            min={0}
            type="number"
            value={swapMiB}
            onChange={(event) => setSwapMiB(event.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span>PID limit</span>
          <input
            className="rounded border border-border bg-background px-2 py-1"
            inputMode="numeric"
            min={1}
            type="number"
            value={pidsMax}
            onChange={(event) => setPidsMax(event.target.value)}
          />
        </label>
        <div className="col-span-2 flex items-center justify-between gap-2">
          <span className="text-destructive" role={validation ? 'alert' : undefined}>
            {validation}
          </span>
          <button
            className="rounded border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50"
            disabled={Boolean(validation) || saving}
            type="submit"
          >
            {saving ? 'Saving…' : 'Save limits'}
          </button>
        </div>
        {message && (
          <p className="col-span-2 text-muted-foreground" role="status" aria-live="polite">
            {message}
          </p>
        )}
      </form>
    </details>
  )
}
