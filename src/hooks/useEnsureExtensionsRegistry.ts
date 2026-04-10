import { useEffect, useRef, useState } from 'react'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { api } from '@/lib/api'
import { getAuthToken } from '@/lib/auth'
import { createLogger } from '@/lib/client-logger'
import { setRegistry } from '@/store/extensionsSlice'
import { useAppDispatch, useAppSelector } from '@/store/hooks'

const EMPTY_EXTENSION_ENTRIES: ClientExtensionEntry[] = []
const log = createLogger('useEnsureExtensionsRegistry')

type RegistryLoadRecord = {
  entries: ClientExtensionEntry[]
  promise: Promise<ClientExtensionEntry[]> | null
  status: 'loaded' | 'loading'
}

const registryLoadCache = new Map<string, RegistryLoadRecord>()

function resolveExtensionsRegistryPath(): string {
  if (typeof window === 'undefined') return '/api/extensions'
  const href = window.location?.href
  if (typeof href !== 'string' || !/^https?:/i.test(href)) {
    return '/api/extensions'
  }
  return new URL('/api/extensions', href).toString()
}

function resolveRegistryLoadKey(serverInstanceId: string): string {
  return serverInstanceId || '__default__'
}

export function resetEnsureExtensionsRegistryCacheForTests() {
  registryLoadCache.clear()
}

export function useEnsureExtensionsRegistry(enabled = true): boolean {
  const dispatch = useAppDispatch()
  const extensionEntries = useAppSelector((s) => s.extensions?.entries ?? EMPTY_EXTENSION_ENTRIES)
  const connectionStatus = useAppSelector((s) => s.connection?.status ?? 'disconnected')
  const serverInstanceId = useAppSelector((s) => s.connection?.serverInstanceId ?? '')
  const requestedRef = useRef<string | null>(null)
  const [loadSettled, setLoadSettled] = useState(false)

  const get = (api as { get?: (<T = unknown>(path: string) => Promise<T> | T) }).get
  const loadKey = resolveRegistryLoadKey(serverInstanceId)
  const canLoad = enabled
    && extensionEntries.length === 0
    && !!getAuthToken()
    && typeof get === 'function'

  useEffect(() => {
    if (!enabled || extensionEntries.length > 0) {
      setLoadSettled(true)
      return
    }
    if (!getAuthToken() || typeof get !== 'function') {
      setLoadSettled(true)
      return
    }
    let cancelled = false
    const currentRecord = registryLoadCache.get(loadKey)
    if (currentRecord?.status === 'loaded') {
      dispatch(setRegistry(currentRecord.entries))
      setLoadSettled(true)
      return
    }

    let promise = currentRecord?.promise
    if (!promise) {
      promise = Promise.resolve(get<ClientExtensionEntry[]>(resolveExtensionsRegistryPath()))
        .then((entries) => {
          const normalizedEntries = Array.isArray(entries) ? entries : []
          registryLoadCache.set(loadKey, {
            entries: normalizedEntries,
            promise: null,
            status: 'loaded',
          })
          return normalizedEntries
        })
        .catch((err) => {
          registryLoadCache.delete(loadKey)
          throw err
        })

      registryLoadCache.set(loadKey, {
        entries: [],
        promise,
        status: 'loading',
      })
    }

    requestedRef.current = loadKey
    setLoadSettled(false)

    promise
      .then((entries) => {
        if (cancelled || requestedRef.current !== loadKey) return
        dispatch(setRegistry(entries))
        setLoadSettled(true)
      })
      .catch((err) => {
        if (cancelled || requestedRef.current !== loadKey) return
        setLoadSettled(true)
        log.warn('Failed to load extension registry', err)
      })

    return () => {
      cancelled = true
    }
  }, [connectionStatus, dispatch, enabled, extensionEntries.length, get, loadKey])

  return !canLoad || loadSettled
}
