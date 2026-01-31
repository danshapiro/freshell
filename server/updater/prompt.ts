// server/updater/prompt.ts
import * as readline from 'readline'

const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

/** Fixed width of the banner content area (between box borders) */
const BANNER_WIDTH = 45

/**
 * Centers text within the banner width, accounting for ANSI escape codes.
 * Handles cases where the visible text exceeds the banner width by
 * using a minimum padding of 0 to prevent negative repeat counts.
 *
 * @param text - The text to center (may include ANSI codes)
 * @param visibleLength - The visible length of the text (excluding ANSI codes)
 * @returns The text padded with spaces on both sides to center it
 */
function centerInBanner(text: string, visibleLength: number): string {
  const totalPadding = BANNER_WIDTH - visibleLength
  const leftPad = Math.max(0, Math.floor(totalPadding / 2))
  const rightPad = Math.max(0, totalPadding - leftPad)
  return ' '.repeat(leftPad) + text + ' '.repeat(rightPad)
}

/**
 * Formats a colorful ASCII banner announcing a new version is available.
 * @param currentVersion - The currently installed version
 * @param latestVersion - The latest available version
 * @returns Formatted banner string with ANSI color codes
 */
export function formatUpdateBanner(currentVersion: string, latestVersion: string): string {
  const titleText = `${GREEN}${BOLD}There's a new Freshell waiting for you!${RESET}`
  const titleVisible = "There's a new Freshell waiting for you!"

  const versionText = `${currentVersion} → ${YELLOW}${latestVersion}${RESET}`
  const versionVisible = `${currentVersion} → ${latestVersion}`

  const lines = [
    '',
    `${CYAN}╭${'─'.repeat(BANNER_WIDTH)}╮${RESET}`,
    `${CYAN}│${RESET}${' '.repeat(BANNER_WIDTH)}${CYAN}│${RESET}`,
    `${CYAN}│${RESET}${centerInBanner(titleText, titleVisible.length)}${CYAN}│${RESET}`,
    `${CYAN}│${RESET}${' '.repeat(BANNER_WIDTH)}${CYAN}│${RESET}`,
    `${CYAN}│${RESET}${centerInBanner(versionText, versionVisible.length)}${CYAN}│${RESET}`,
    `${CYAN}│${RESET}${' '.repeat(BANNER_WIDTH)}${CYAN}│${RESET}`,
    `${CYAN}╰${'─'.repeat(BANNER_WIDTH)}╯${RESET}`,
    ''
  ]
  return lines.join('\n')
}

/**
 * Prompts the user interactively to confirm whether to update.
 * Displays the update banner and waits for user input.
 *
 * In non-interactive mode (e.g., piped input, CI environments),
 * returns false immediately to skip the update.
 *
 * @param currentVersion - The currently installed version
 * @param latestVersion - The latest available version
 * @returns Promise that resolves to true if user confirms, false otherwise
 */
export async function promptForUpdate(
  currentVersion: string,
  latestVersion: string
): Promise<boolean> {
  const banner = formatUpdateBanner(currentVersion, latestVersion)
  console.log(banner)

  // Skip prompt in non-interactive mode
  if (!process.stdin.isTTY) {
    console.log('Non-interactive mode detected, skipping update prompt.')
    return false
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return new Promise((resolve) => {
    // Handle EOF (Ctrl+D) or unexpected close
    rl.on('close', () => {
      resolve(false)
    })

    rl.question(`Upgrade now? [${GREEN}Y${RESET}/n] `, (answer) => {
      rl.close()
      const normalized = answer.trim().toLowerCase()
      // Default to yes (empty input = yes)
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes')
    })
  })
}
