import fs from 'node:fs/promises'

export interface CloudExecutionDispatch {
  jobName: string
  executionName: string
  acceptedAt: string
}

export const CLOUD_BUILD_AND_DISPATCH_TIMEOUT_MS = 30 * 60_000

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

async function readDispatchReceipt(receiptPath: string): Promise<CloudExecutionDispatch | undefined> {
  let contents: string
  try { contents = await fs.readFile(receiptPath, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const receipt: unknown = JSON.parse(contents)
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('Cloud Run dispatch receipt is not an object')
  }
  const { jobName, executionName, acceptedAt } = receipt as Record<string, unknown>
  if (typeof jobName !== 'string' || !/^[a-z][a-z0-9-]{0,48}$/.test(jobName)
    || typeof executionName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(executionName)
    || typeof acceptedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(acceptedAt)) {
    throw new Error('Cloud Run dispatch receipt does not identify an accepted job execution')
  }
  return { jobName, executionName, acceptedAt }
}

export async function waitForCloudExecutionDispatch(
  receiptPath: string,
  isBrowserRunning: () => boolean,
  timeoutMs = CLOUD_BUILD_AND_DISPATCH_TIMEOUT_MS,
  pollIntervalMs = 250,
): Promise<CloudExecutionDispatch> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const receipt = await readDispatchReceipt(receiptPath)
    if (receipt) return receipt
    if (!isBrowserRunning()) throw new Error('Cloud browser exited before its Cloud Run execution was accepted')
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }
  throw new Error('Managed environment timed out: Cloud image build and execution dispatch')
}
