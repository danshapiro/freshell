import { describe, it, expect } from 'vitest'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-ignore — untyped ESM .js module; loaded so the test runs the REAL tailwind config
import tailwindConfig from '../../../../tailwind.config.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * Run the real Tailwind compiler against the real config and content globs —
 * the same generation the production build performs. A utility class used in
 * src only ships to the browser when it resolves to a real color token here;
 * otherwise the generated stylesheet silently contains no rule for it and the
 * element renders with a transparent background (the fresh-agent turn
 * context-menu bug).
 */
async function generateUtilitiesCss(): Promise<string> {
  const content = (tailwindConfig.content as string[]).map((p: string) => path.resolve(projectRoot, p))
  const result = await postcss([tailwindcss({ ...tailwindConfig, content })]).process('@tailwind utilities;', { from: undefined })
  return result.css
}

/** Collect the custom properties defined by one theme block (:root / .dark). */
function themeBlockVars(themeCss: postcss.Root, selector: string): Set<string> {
  const vars = new Set<string>()
  themeCss.walkRules(selector, (rule) => {
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) vars.add(decl.prop)
    })
  })
  return vars
}

describe('tailwind theme tokens', () => {
  it('generates rules for the popover surface tokens used by fresh-agent overlays', async () => {
    const css = await generateUtilitiesCss()
    // Used by FreshAgentTurnActions (turn right-click menu + hover toolbar),
    // FreshAgentActionSheet, and the FreshAgentComposer slash-command menu.
    for (const utility of ['bg-popover', 'text-popover-foreground']) {
      expect(css, `${utility} must generate a real rule`).toMatch(new RegExp(`\\.${utility}\\s*\\{`))
    }
  })

  it('defines every CSS variable referenced by theme colors in both :root and .dark', () => {
    const colors: Record<string, string> = tailwindConfig.theme?.extend?.colors ?? {}
    const referenced = new Set<string>()
    for (const value of Object.values(colors)) {
      for (const match of String(value).matchAll(/var\((--[\w-]+)\)/g)) {
        referenced.add(match[1])
      }
    }
    expect(referenced.size).toBeGreaterThan(0)
    const themeCss = postcss.parse(readFileSync(path.join(projectRoot, 'src/theme-variables.css'), 'utf8'))
    const rootVars = themeBlockVars(themeCss, ':root')
    const darkVars = themeBlockVars(themeCss, '.dark')
    for (const varName of referenced) {
      expect(rootVars.has(varName), `${varName} must be defined in :root`).toBe(true)
      expect(darkVars.has(varName), `${varName} must be defined in .dark`).toBe(true)
    }
  })
})
