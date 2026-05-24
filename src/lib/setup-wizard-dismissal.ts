const SETUP_WIZARD_AUTO_DISMISSED_KEY = 'freshell.setupWizardAutoDismissed'

export function hasDismissedAutoSetupWizard(): boolean {
  try {
    return sessionStorage.getItem(SETUP_WIZARD_AUTO_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function markAutoSetupWizardDismissed(): void {
  try {
    sessionStorage.setItem(SETUP_WIZARD_AUTO_DISMISSED_KEY, 'true')
  } catch {
    // Session storage can be unavailable in hardened browser contexts.
  }
}
