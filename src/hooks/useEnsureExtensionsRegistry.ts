import { useEffect, useRef } from 'react'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { api } from '@/lib/api'
import { getAuthToken } from '@/lib/auth'
import { createLogger } from '@/lib/client-logger'
import { setRegistry } from '@/store/extensionsSlice'
import { useAppDispatch, useAppSelector } from '@/store/hooks'

const EMPTY_EXTENSION_ENTRIES: ClientExtensionEntry[] = []
const log = createLogger('useEnsureExtensionsRegistry')

function resolveExtensionsRegistryPath(): string {
  if (typeof window === 'undefined') return '/api/extensions'
  const href = window.location?.href
  if (typeof href !== 'string' || !/^https?:/i.test(href)) {
    return '/api/extensions'
  }
  return new URL('/api/extensions', href).toString()
}

export function useEnsureExtensionsRegistry(enabled = true) {
  const dispatch = useAppDispatch()
  const extensionEntries = useAppSelector((s) => s.extensions?.entries ?? EMPTY_EXTENSION_ENTRIES)
  const connectionStatus = useAppSelector((s) => s.connection?.status ?? 'disconnected')
  const serverInstanceId = useAppSelector((s) => s.connection?.serverInstanceId ?? '')
  const requestedRef = useRef(false)

  useEffect(() => {
    if (!enabled || extensionEntries.length > 0 || requestedRef.current) return
    if (!getAuthToken()) return
    const get = (api as { get?: (<T = unknown>(path: string) => Promise<T> | T) }).get
    if (typeof get !== 'function') return

    requestedRef.current = true
    let cancelled = false

    Promise.resolve(get<ClientExtensionEntry[]>(resolveExtensionsRegistryPath()))
      .then((entries) => {
        if (cancelled) return
        dispatch(setRegistry(Array.isArray(entries) ? entries : []))
      })
      .catch((err) => {
        requestedRef.current = false
        if (!cancelled) {
          log.warn('Failed to load extension registry', err)
        }
      })

    return () => {
      cancelled = true
    }
  }, [connectionStatus, dispatch, enabled, extensionEntries.length, serverInstanceId])
}
