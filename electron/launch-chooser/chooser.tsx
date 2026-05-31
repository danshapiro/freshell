import { useEffect, useState } from 'react'
import type { LaunchChoice, LaunchChoiceResult, LaunchServerCandidate } from '../types.js'
import {
  buildConnectChoice,
  buildRemoteChoice,
  buildStartLocalChoice,
  formatLaunchReason,
  validateLaunchPort,
  validateRemoteLaunchUrl,
} from './chooser-logic.js'

declare global {
  interface Window {
    freshellDesktop?: {
      getLaunchOptions: () => Promise<{
        candidates: LaunchServerCandidate[]
        reason: string
        alwaysAskOnLaunch: boolean
        port: number
        remoteUrl?: string
      }>
      chooseLaunchOption: (choice: LaunchChoice) => Promise<LaunchChoiceResult | void>
    }
  }
}

export function LaunchChooser() {
  const [candidates, setCandidates] = useState<LaunchServerCandidate[]>([])
  const [reason, setReason] = useState('')
  const [port, setPort] = useState(3001)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteToken, setRemoteToken] = useState('')
  const [candidateTokens, setCandidateTokens] = useState<Record<string, string>>({})
  const [alwaysAskOnLaunch, setAlwaysAskOnLaunch] = useState(false)
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.freshellDesktop?.getLaunchOptions().then((options) => {
      setCandidates(options.candidates)
      setReason(options.reason)
      setAlwaysAskOnLaunch(options.alwaysAskOnLaunch)
      setPort(options.port)
      setRemoteUrl(options.remoteUrl ?? '')
    })
  }, [])

  const choose = async (choice: LaunchChoice) => {
    setError('')
    const result = await window.freshellDesktop?.chooseLaunchOption(choice)
    if (result && !result.ok) {
      setError(result.error)
    }
  }

  const candidateLabel = (candidate: LaunchServerCandidate) => candidate.label ?? candidate.url
  const candidateNeedsToken = (candidate: LaunchServerCandidate) => candidate.requiresAuth !== false && !candidate.token

  const connectCandidate = async (candidate: LaunchServerCandidate) => {
    const token = candidate.token ?? candidateTokens[candidate.id]?.trim()
    if (candidateNeedsToken(candidate) && !token) {
      setError(`Enter a token for ${candidateLabel(candidate)}`)
      return
    }

    await choose(buildConnectChoice({
      url: candidate.url,
      token,
      requiresAuth: candidate.requiresAuth,
      alwaysAskOnLaunch,
      remember,
    }))
  }

  const connectRemote = async () => {
    const validation = validateRemoteLaunchUrl(remoteUrl)
    if (validation) {
      setError(validation)
      return
    }
    if (!remoteToken.trim()) {
      setError('Enter a token for the remote server')
      return
    }
    await choose(buildRemoteChoice({ url: remoteUrl, token: remoteToken, alwaysAskOnLaunch, remember }))
  }

  const startLocal = async () => {
    // Only basic range validation here. Whether the port is actually free is
    // decided authoritatively by the main process at choose time (a fresh bind
    // test), so the renderer never false-rejects from a stale candidate list.
    const portError = validateLaunchPort(port)
    if (portError) {
      setError(portError)
      return
    }
    await choose(buildStartLocalChoice({ port, alwaysAskOnLaunch, remember }))
  }

  return (
    <main className="launch-shell">
      <section className="launch-panel" aria-labelledby="launch-title">
        <h1 id="launch-title">Choose Freshell server</h1>
        <p className="launch-reason">{formatLaunchReason(reason)}</p>

        <div className="launch-section">
          <h2>Local servers</h2>
          {candidates.length === 0 ? (
            <p>No running local Freshell servers were detected.</p>
          ) : (
            <ul>
              {candidates.map((candidate) => (
                <li key={candidate.id} className="server-candidate">
                  <div className="candidate-summary">
                    <strong>{candidateLabel(candidate)}</strong>
                    <span>{candidate.version ? `Version ${candidate.version}` : candidate.url}</span>
                  </div>
                  <div className="candidate-actions">
                    {candidateNeedsToken(candidate) ? (
                      <label>
                        Token for {candidateLabel(candidate)}
                        <input
                          type="password"
                          value={candidateTokens[candidate.id] ?? ''}
                          onChange={(event) => setCandidateTokens({
                            ...candidateTokens,
                            [candidate.id]: event.target.value,
                          })}
                        />
                      </label>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Connect to ${candidateLabel(candidate)}`}
                      onClick={() => void connectCandidate(candidate)}
                    >
                      Connect
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="launch-section">
          <h2>Remote server</h2>
          <label>
            URL
            <input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="http://10.0.0.5:3001" />
          </label>
          <label>
            Token
            <input value={remoteToken} onChange={(event) => setRemoteToken(event.target.value)} type="password" />
          </label>
          <button type="button" onClick={connectRemote}>Connect remote</button>
        </div>

        <div className="launch-section">
          <h2>New local server</h2>
          <label>
            Port
            <input type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} />
          </label>
          <button type="button" onClick={() => void startLocal()}>
            Start local
          </button>
        </div>

        <div className="launch-options">
          <label>
            <input type="checkbox" checked={alwaysAskOnLaunch} onChange={(event) => setAlwaysAskOnLaunch(event.target.checked)} />
            Always ask on launch
          </label>
          <label>
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Remember this choice
          </label>
        </div>

        {error ? <p role="alert" className="launch-error">{error}</p> : null}
      </section>
    </main>
  )
}
