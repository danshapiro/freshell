import type { ITheme } from '@xterm/xterm'
import type { TerminalTheme } from '@/store/types'

// Full xterm theme with ANSI colors for proper syntax highlighting
interface FullTheme extends ITheme {
  name: string
  isDark: boolean
}

const dracula: FullTheme = {
  name: 'Dracula',
  isDark: true,
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: 'rgba(248, 248, 242, 0.2)',
  selectionForeground: '#f8f8f2',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
}

const oneDark: FullTheme = {
  name: 'One Dark',
  isDark: true,
  background: '#282c34',
  foreground: '#abb2bf',
  cursor: '#528bff',
  cursorAccent: '#282c34',
  selectionBackground: 'rgba(171, 178, 191, 0.2)',
  selectionForeground: '#abb2bf',
  black: '#282c34',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
}

const solarizedDark: FullTheme = {
  name: 'Solarized Dark',
  isDark: true,
  background: '#002b36',
  foreground: '#839496',
  cursor: '#839496',
  cursorAccent: '#002b36',
  selectionBackground: 'rgba(131, 148, 150, 0.2)',
  selectionForeground: '#93a1a1',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
}

const githubDark: FullTheme = {
  name: 'GitHub Dark',
  isDark: true,
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#c9d1d9',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(56, 139, 253, 0.3)',
  selectionForeground: '#c9d1d9',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
}

const oneLight: FullTheme = {
  name: 'One Light',
  isDark: false,
  background: '#fafafa',
  foreground: '#383a42',
  cursor: '#526eff',
  cursorAccent: '#fafafa',
  selectionBackground: 'rgba(56, 58, 66, 0.1)',
  selectionForeground: '#383a42',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#a0a1a7',
  brightBlack: '#696c77',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#fafafa',
}

const solarizedLight: FullTheme = {
  name: 'Solarized Light',
  isDark: false,
  background: '#fdf6e3',
  foreground: '#657b83',
  cursor: '#657b83',
  cursorAccent: '#fdf6e3',
  selectionBackground: 'rgba(101, 123, 131, 0.15)',
  selectionForeground: '#586e75',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
}

const githubLight: FullTheme = {
  name: 'GitHub Light',
  isDark: false,
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#24292f',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(33, 136, 255, 0.15)',
  selectionForeground: '#24292f',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
}

export type ConcreteTerminalTheme = Exclude<TerminalTheme, 'auto'>

export const terminalThemes: Record<ConcreteTerminalTheme, FullTheme> = {
  'dracula': dracula,
  'one-dark': oneDark,
  'solarized-dark': solarizedDark,
  'github-dark': githubDark,
  'one-light': oneLight,
  'solarized-light': solarizedLight,
  'github-light': githubLight,
}

export const darkThemes: ConcreteTerminalTheme[] = ['dracula', 'one-dark', 'solarized-dark', 'github-dark']
export const lightThemes: ConcreteTerminalTheme[] = ['one-light', 'solarized-light', 'github-light']

export function getTerminalTheme(
  themeSetting: TerminalTheme | string | undefined,
  appTheme: 'dark' | 'light' | 'system'
): ITheme {
  // Handle 'auto', undefined, or legacy 'default'/'dark'/'light' values
  const shouldFollowApp = !themeSetting || themeSetting === 'auto' ||
    themeSetting === 'default' || !(themeSetting in terminalThemes)

  if (shouldFollowApp) {
    // Follow app theme
    const isDark =
      appTheme === 'dark' ? true : appTheme === 'light' ? false : getSystemPrefersDark()
    return isDark ? terminalThemes['github-dark'] : terminalThemes['github-light']
  }
  return terminalThemes[themeSetting as Exclude<TerminalTheme, 'auto'>]
}

function getSystemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
}

export function getThemeDisplayName(theme: TerminalTheme): string {
  if (theme === 'auto') return 'Auto (follow app)'
  return terminalThemes[theme].name
}
