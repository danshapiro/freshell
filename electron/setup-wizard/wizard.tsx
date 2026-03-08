import React, { useState, useCallback } from 'react'

export type ServerMode = 'daemon' | 'app-bound' | 'remote'

export interface WizardConfig {
  serverMode: ServerMode
  port: number
  remoteUrl: string
  remoteToken: string
  globalHotkey: string
}

interface WizardProps {
  onComplete?: (config: WizardConfig) => void
}

const STEPS = ['welcome', 'server-mode', 'configuration', 'hotkey', 'complete'] as const
type Step = typeof STEPS[number]

export function Wizard({ onComplete }: WizardProps) {
  const [currentStep, setCurrentStep] = useState<number>(0)
  const [serverMode, setServerMode] = useState<ServerMode>('app-bound')
  const [port, setPort] = useState<number>(3001)
  const [remoteUrl, setRemoteUrl] = useState<string>('')
  const [remoteToken, setRemoteToken] = useState<string>('')
  const [globalHotkey, setGlobalHotkey] = useState<string>('CommandOrControl+`')
  const [portError, setPortError] = useState<string>('')
  const [urlError, setUrlError] = useState<string>('')

  const step = STEPS[currentStep]

  const validatePort = useCallback((value: number): boolean => {
    if (isNaN(value) || value < 1024 || value > 65535) {
      setPortError('Port must be between 1024 and 65535')
      return false
    }
    setPortError('')
    return true
  }, [])

  const validateUrl = useCallback((value: string): boolean => {
    try {
      new URL(value)
      setUrlError('')
      return true
    } catch {
      setUrlError('Please enter a valid URL')
      return false
    }
  }, [])

  const handleNext = useCallback(() => {
    // Validate current step before proceeding
    if (step === 'configuration') {
      if (serverMode === 'remote' && !validateUrl(remoteUrl)) return
      if ((serverMode === 'daemon' || serverMode === 'app-bound') && !validatePort(port)) return
    }
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1)
    }
  }, [currentStep, step, serverMode, port, remoteUrl, validatePort, validateUrl])

  const handleBack = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1)
    }
  }, [currentStep])

  const handleComplete = useCallback(() => {
    onComplete?.({
      serverMode,
      port,
      remoteUrl,
      remoteToken,
      globalHotkey,
    })
  }, [onComplete, serverMode, port, remoteUrl, remoteToken, globalHotkey])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && step !== 'complete') {
      handleNext()
    } else if (e.key === 'Escape' && currentStep > 0) {
      handleBack()
    }
  }, [step, currentStep, handleNext, handleBack])

  return (
    <div
      className="dark min-h-screen bg-background text-foreground flex flex-col"
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label="Freshell Setup Wizard"
    >
      {/* Progress indicator */}
      <div className="flex justify-center gap-2 pt-6 pb-4" role="progressbar" aria-valuenow={currentStep + 1} aria-valuemin={1} aria-valuemax={STEPS.length}>
        {STEPS.map((_, i) => (
          <div
            key={i}
            className={`w-2 h-2 rounded-full ${i <= currentStep ? 'bg-primary' : 'bg-muted'}`}
          />
        ))}
      </div>

      {/* Step content */}
      <div className="flex-1 px-8 py-4">
        {step === 'welcome' && (
          <div className="text-center space-y-4">
            <h1 className="text-xl font-semibold">Welcome to Freshell</h1>
            <p className="text-muted-foreground">
              Freshell is a terminal multiplexer you can access from anywhere.
              Let's get you set up.
            </p>
          </div>
        )}

        {step === 'server-mode' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Server Mode</h2>
            <p className="text-sm text-muted-foreground">
              Choose how the Freshell server should run:
            </p>
            <div className="space-y-3">
              <label
                className={`block p-4 rounded-lg border cursor-pointer transition-colors ${
                  serverMode === 'app-bound' ? 'border-primary bg-muted' : 'border-border hover:border-muted-foreground'
                }`}
              >
                <input
                  type="radio"
                  name="serverMode"
                  value="app-bound"
                  checked={serverMode === 'app-bound'}
                  onChange={() => setServerMode('app-bound')}
                  className="sr-only"
                />
                <div className="font-medium">App-bound</div>
                <div className="text-sm text-muted-foreground">
                  Server starts when the app opens and stops when you quit. Simple and self-contained. Recommended for most users.
                </div>
              </label>

              <label
                className={`block p-4 rounded-lg border cursor-pointer transition-colors ${
                  serverMode === 'daemon' ? 'border-primary bg-muted' : 'border-border hover:border-muted-foreground'
                }`}
              >
                <input
                  type="radio"
                  name="serverMode"
                  value="daemon"
                  checked={serverMode === 'daemon'}
                  onChange={() => setServerMode('daemon')}
                  className="sr-only"
                />
                <div className="font-medium">Always-running daemon</div>
                <div className="text-sm text-muted-foreground">
                  Server runs as an OS service. Terminals survive app restarts and reboots. Best for power users.
                </div>
              </label>

              <label
                className={`block p-4 rounded-lg border cursor-pointer transition-colors ${
                  serverMode === 'remote' ? 'border-primary bg-muted' : 'border-border hover:border-muted-foreground'
                }`}
              >
                <input
                  type="radio"
                  name="serverMode"
                  value="remote"
                  checked={serverMode === 'remote'}
                  onChange={() => setServerMode('remote')}
                  className="sr-only"
                />
                <div className="font-medium">Remote only</div>
                <div className="text-sm text-muted-foreground">
                  Connect to a Freshell server running on another machine. No local server needed.
                </div>
              </label>
            </div>
          </div>
        )}

        {step === 'configuration' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Configuration</h2>
            {(serverMode === 'daemon' || serverMode === 'app-bound') && (
              <div className="space-y-2">
                <label htmlFor="port" className="block text-sm font-medium">
                  Port number
                </label>
                <input
                  id="port"
                  type="number"
                  min={1024}
                  max={65535}
                  value={port}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    setPort(val)
                    validatePort(val)
                  }}
                  className="w-full px-3 py-2 rounded-md border border-border bg-card text-foreground"
                  aria-describedby={portError ? 'port-error' : undefined}
                  aria-invalid={!!portError}
                />
                {portError && (
                  <p id="port-error" className="text-sm text-destructive" role="alert">{portError}</p>
                )}
              </div>
            )}
            {serverMode === 'remote' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="remote-url" className="block text-sm font-medium">
                    Server URL
                  </label>
                  <input
                    id="remote-url"
                    type="url"
                    placeholder="http://10.0.0.5:3001"
                    value={remoteUrl}
                    onChange={(e) => {
                      setRemoteUrl(e.target.value)
                      if (e.target.value) validateUrl(e.target.value)
                    }}
                    className="w-full px-3 py-2 rounded-md border border-border bg-card text-foreground"
                    aria-describedby={urlError ? 'url-error' : undefined}
                    aria-invalid={!!urlError}
                  />
                  {urlError && (
                    <p id="url-error" className="text-sm text-destructive" role="alert">{urlError}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <label htmlFor="remote-token" className="block text-sm font-medium">
                    Auth Token
                  </label>
                  <input
                    id="remote-token"
                    type="password"
                    value={remoteToken}
                    onChange={(e) => setRemoteToken(e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-border bg-card text-foreground"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'hotkey' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Global Hotkey</h2>
            <p className="text-sm text-muted-foreground">
              Press this shortcut anywhere to toggle the Freshell window:
            </p>
            <div className="p-4 rounded-lg border border-border bg-card text-center">
              <span className="font-mono text-lg">{globalHotkey}</span>
            </div>
            <div className="space-y-2">
              <label htmlFor="hotkey-input" className="block text-sm font-medium">
                Custom shortcut
              </label>
              <input
                id="hotkey-input"
                type="text"
                value={globalHotkey}
                onChange={(e) => setGlobalHotkey(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-card text-foreground"
              />
            </div>
          </div>
        )}

        {step === 'complete' && (
          <div className="text-center space-y-4">
            <h2 className="text-lg font-semibold">Ready to go!</h2>
            <div className="text-left space-y-2 bg-card p-4 rounded-lg">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Server mode:</span>
                <span className="font-medium">{serverMode}</span>
              </div>
              {serverMode !== 'remote' && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Port:</span>
                  <span className="font-medium">{port}</span>
                </div>
              )}
              {serverMode === 'remote' && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Remote URL:</span>
                  <span className="font-medium">{remoteUrl}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Hotkey:</span>
                <span className="font-medium font-mono">{globalHotkey}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Navigation buttons */}
      <div className="flex justify-between px-8 py-6">
        <button
          onClick={handleBack}
          disabled={currentStep === 0}
          className="px-4 py-2 rounded-md text-sm border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Go back"
        >
          Back
        </button>
        {step === 'complete' ? (
          <button
            onClick={handleComplete}
            className="px-6 py-2 rounded-md text-sm bg-primary text-primary-foreground hover:opacity-90"
            aria-label="Launch Freshell"
          >
            Launch Freshell
          </button>
        ) : (
          <button
            onClick={handleNext}
            className="px-6 py-2 rounded-md text-sm bg-primary text-primary-foreground hover:opacity-90"
            aria-label={step === 'welcome' ? 'Get Started' : 'Next'}
          >
            {step === 'welcome' ? 'Get Started' : 'Next'}
          </button>
        )}
      </div>
    </div>
  )
}
