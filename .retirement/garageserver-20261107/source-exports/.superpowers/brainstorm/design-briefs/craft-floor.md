# Craft Floor — mandatory rules for all fresh-agent redesign comps

Derived from pbakaus/impeccable. Every comp must pass this floor. Violations will be sent back for fixes.

## The gating question
"Could an unrelated product use this design unchanged?" If yes, it fails. Each design needs at least 2–3 own-world signatures (structural, typographic, or material moves that belong unmistakably to THIS direction). Earned familiarity: a developer should trust it instantly — strangeness needs purpose. This is an **Operate** surface (a tool, used daily, for hours): consistency over surprise, density permitted, delight saved for moments.

## Typography
- Never use: Inter, Geist, Space Grotesk, Instrument Sans/Serif. Strongly avoid without justification: Fraunces, Playfair, Cormorant, Lora, Newsreader, IBM Plex, DM Sans/Serif, Outfit, Plus Jakarta Sans, Space Mono.
- Product UI: usually one family + one mono. Fixed rem scale, steps at ≥1.125–1.2 ratio.
- Body text 15–16px; functional/label text ≥11px; prose line-height 1.5–1.7; UI line-height ≥1.3.
- Prose measure 60–75ch (tables/data may run wider). Tracking never tighter than −0.03em.
- NO all-caps passages (short 1–3 word labels in caps are OK only when the material genuinely calls for it, e.g. engraved hardware, stamped labels — and always with letter-spacing ≥0.08em).
- Tabular numerals (`font-variant-numeric: tabular-nums`) for ALL data: times, tokens, costs, percentages, line numbers.
- Monospace only for code, data, file paths, commands — never as a costume for body text.

## Color
- Commit to a strategy: Restrained (neutrals + ONE accent) / Committed (one saturated color owns 30–60% of surface) / Full palette (3–4 named roles). State which.
- Never pure #000 black or pure #fff white — tint everything toward the design's temperature. Never gray text on a colored background (tint secondary text from the hue).
- Contrast ≥4.5:1 body, ≥3:1 large/UI. Check your pairs.
- Accent = primary actions, selection, state. Not decoration. Status colors (busy/waiting/error/success) are a separate, standardized vocabulary — defined once, used consistently.
- A second neutral layer (slightly cooler or warmer than ground) for sidebars/rails/panels.

## Layout & elevation
- Tight groups, generous separation between groups. More space above a heading than below it. No monotonous same-gap-everywhere rhythm.
- NO nested cards. Cards are the lazy container — prefer ruled sections, rows, plates, panels. If a card appears, radius ≤16px, and it may not contain another card.
- 1px hairline borders BEFORE shadows. No zero-offset colored shadow halos (glow). No hard offset `4px 4px 0` shadows unless the material is genuinely that (zine/print).
- ≥8px (ideally 12–16px) padding inside bordered containers. Text never flush to the container edge.
- Slop bans (hard): purple/violet gradients; cyan-on-dark neon; glowing edges; gradient text; decorative grid backgrounds (unless the surface IS a real drawing/schematic surface); repeating diagonal stripes; eyebrow/kicker above every heading; "01 / 02 / 03" decorative section markers; rounded-square icon tiles above headings; side accent stripes >1px on cards.
- Do NOT copy the current Freshell left-border turn articles — redesign replaces, not preserves.

## Motion (annotate in comps; most comps are static)
- If you include any CSS animation: transform/opacity only, 150–250ms, `cubic-bezier(0.16,1,0.3,1)`-family easing, no bounce/elastic, and a `prefers-reduced-motion` fallback. No pulsing dots on static data, no fake terminal cursors blinking everywhere, no marquee.

## Browser surfaces (the cheapest craft signal)
- Theme, per design: `::selection`, `caret-color`, scrollbar (thin, tinted), `:focus-visible` ring (2px, offset, accent), underline-offset on links. These must be specified IN the CSS, visibly consistent with the direction.

## Interaction & a11y (even in static mockups)
- Controls name their action ("Allow once", not "OK"). Errors name problem + recovery.
- Touch targets ≥44px in phone frames. Buttons look like buttons. Use real semantic elements (`<button>`, `<details>`, `<nav>`) — this is a static comp but the DOM should be honest.
- No modals-by-reflex: settings = popover on desktop, sheet on phone; turn actions = context menu desktop / bottom sheet phone.

## Scope honesty
- Features that don't exist yet in Freshell carry a small `soon` tag (per the content spec). They must look designed, not greyed-out.

## Technical
- ONE self-contained HTML file per design, starting with `<!DOCTYPE html>`. All CSS inline in `<style>`. No frameworks, no build. Minimal vanilla JS only if structural (keep it under ~30 lines; CSS-only interaction preferred — `<details>`, `:checked`, `:target`).
- Google Fonts via `<link>` (build the css2 URL correctly; include `display=swap`) with real fallback stacks.
- Page renders at ~1500px CSS width without horizontal scroll; individual frames sized per content spec.
- `$schema` n/a. Keep file tidy: it will be read by a designer-developer later.
- Direction contract (≤150 words: THESIS / OWN-WORLD / STORY / FIRST VIEWPORT / FORM+FINISH) as an HTML comment at top of file.
