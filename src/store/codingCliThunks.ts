import { createAsyncThunk } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'
import { addTab, updateTab } from './tabsSlice'
import { createCodingCliSession, registerCodingCliRequest, resolveCodingCliRequest } from './codingCliSlice'
import type { RootState } from './store'
import type { CodingCliProviderName } from '@/lib/coding-cli-types'
import { nanoid } from 'nanoid'

const CODING_CLI_CREATE_TIMEOUT_MS = 30_000
const CODING_CLI_CREATE_TIMEOUT_CLEANUP_MS = 60_000

export const createCodingCliTab = createAsyncThunk(
  'codingCli/createTab',
  async (
    { provider, prompt, cwd }: { provider: CodingCliProviderName; prompt: string; cwd?: string },
    { dispatch, getState }
  ) => {
    const requestId = nanoid()

    dispatch(registerCodingCliRequest({ requestId, provider, prompt, cwd }))

    dispatch(
      addTab({
        title: prompt.slice(0, 30) + (prompt.length > 30 ? '...' : ''),
        mode: provider,
        status: 'creating',
        initialCwd: cwd,
        codingCliProvider: provider,
        codingCliSessionId: requestId,
        createRequestId: requestId,
      })
    )

    const state = getState() as RootState
    const createdTabId = state.tabs.tabs.find((t) => t.codingCliSessionId === requestId)?.id

    const ws = getWsClient()
    try {
      await ws.connect()
    } catch (err) {
      dispatch(resolveCodingCliRequest({ requestId }))
      if (createdTabId) {
        dispatch(updateTab({ id: createdTabId, updates: { status: 'error' } }))
      }
      throw err
    }

    let unsub: (() => void) | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let timeoutCleanupId: ReturnType<typeof setTimeout> | undefined
    let timedOut = false

    const mainPromise = new Promise<string>((resolve, reject) => {
      unsub = ws.onMessage((msg) => {
        if (msg.type === 'codingcli.created' && msg.requestId === requestId) {
          if (timedOut) {
            // Late success after timeout: best effort cleanup to avoid orphan sessions.
            ws.send({ type: 'codingcli.kill', sessionId: msg.sessionId })
            unsub?.()
            return
          }

          clearTimeout(timeoutId)
          clearTimeout(timeoutCleanupId)
          const canceled = (getState() as RootState).codingCli.pendingRequests[requestId]?.canceled
          dispatch(resolveCodingCliRequest({ requestId }))
          unsub?.()
          if (canceled) {
            ws.send({ type: 'codingcli.kill', sessionId: msg.sessionId })
            reject(new Error('Canceled'))
            return
          }
          dispatch(
            createCodingCliSession({
              sessionId: msg.sessionId,
              provider,
              prompt,
              cwd,
            })
          )
          if (createdTabId) {
            dispatch(
              updateTab({
                id: createdTabId,
                updates: {
                  codingCliSessionId: msg.sessionId,
                  codingCliProvider: provider,
                  status: 'running',
                },
              })
            )
          }
          resolve(msg.sessionId)
        }
        if (msg.type === 'error' && msg.requestId === requestId) {
          if (timedOut) {
            unsub?.()
            return
          }

          clearTimeout(timeoutId)
          clearTimeout(timeoutCleanupId)
          const canceled = (getState() as RootState).codingCli.pendingRequests[requestId]?.canceled
          dispatch(resolveCodingCliRequest({ requestId }))
          unsub?.()
          if (!canceled && createdTabId) {
            dispatch(
              updateTab({
                id: createdTabId,
                updates: { status: 'error' },
              })
            )
          }
          reject(new Error(canceled ? 'Canceled' : msg.message))
        }
      })

      ws.send({
        type: 'codingcli.create',
        requestId,
        provider,
        prompt,
        cwd,
      })
    })

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        dispatch(resolveCodingCliRequest({ requestId }))
        if (createdTabId) {
          dispatch(updateTab({ id: createdTabId, updates: { status: 'error' } }))
        }

        // Allow a short grace period to receive a late codingcli.created and kill it.
        timeoutCleanupId = setTimeout(() => {
          unsub?.()
        }, CODING_CLI_CREATE_TIMEOUT_CLEANUP_MS)

        reject(new Error('Coding CLI creation timed out after 30 seconds'))
      }, CODING_CLI_CREATE_TIMEOUT_MS)
    })

    return Promise.race([mainPromise, timeoutPromise])
  }
)
