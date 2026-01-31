import { createAsyncThunk } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'
import { addTab, updateTab } from './tabsSlice'
import { createCodingCliSession, registerCodingCliRequest, resolveCodingCliRequest } from './codingCliSlice'
import type { RootState } from './store'
import type { CodingCliProviderName } from '@/lib/coding-cli-types'
import { nanoid } from 'nanoid'

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

    return new Promise<string>((resolve, reject) => {
      const unsub = ws.onMessage((msg) => {
        if (msg.type === 'codingcli.created' && msg.requestId === requestId) {
          const canceled = (getState() as RootState).codingCli.pendingRequests[requestId]?.canceled
          dispatch(resolveCodingCliRequest({ requestId }))
          unsub()
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
          const canceled = (getState() as RootState).codingCli.pendingRequests[requestId]?.canceled
          dispatch(resolveCodingCliRequest({ requestId }))
          unsub()
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
  }
)
