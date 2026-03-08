import React from 'react'
import { createRoot } from 'react-dom/client'
import { Wizard } from './wizard.js'
import type { WizardConfig } from './wizard-logic.js'
import './wizard.css'

// Type-safe declaration for the preload-exposed API on the window object.
// In production, contextBridge.exposeInMainWorld('freshellDesktop', ...) makes
// this available. See electron/preload.ts for the full shape.
declare global {
  interface Window {
    freshellDesktop?: {
      completeSetup: (config: WizardConfig) => Promise<void>
    }
  }
}

async function handleComplete(config: WizardConfig): Promise<void> {
  await window.freshellDesktop?.completeSetup(config)
  window.close()
}

createRoot(document.getElementById('wizard-root')!).render(
  <Wizard onComplete={handleComplete} />,
)
