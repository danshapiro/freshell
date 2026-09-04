import { useEffect, useState } from 'react'

declare global {
  interface Window {
    freshellDesktop?: {
      getProfiles?: () => Promise<{ id: string; label: string }[]>
      chooseProfile?: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>
    }
  }
}

interface PickerEntry {
  id: string
  label: string
}

export function ProfilePicker() {
  const [entries, setEntries] = useState<PickerEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.freshellDesktop?.getProfiles?.().then((list) => {
      if (!cancelled) setEntries(list ?? [])
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load profiles')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const choose = async (id: string) => {
    setError(null)
    try {
      const result = await window.freshellDesktop?.chooseProfile?.(id)
      if (result && !result.ok) setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to choose profile')
    }
  }

  return (
    <main className="picker">
      <h1>Choose a Freshell profile</h1>
      <p className="picker-subtitle">
        This machine has more than one Freshell profile. Each profile keeps its
        own settings and can connect to a different server.
      </p>
      {error ? (
        <p role="alert" className="picker-error">{error}</p>
      ) : null}
      <ul className="picker-list">
        {(entries ?? []).map((entry) => (
          <li key={entry.id}>
            <button type="button" onClick={() => { void choose(entry.id) }}>
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
