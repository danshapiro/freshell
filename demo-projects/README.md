# Demo Projects

Pre-built interactive demos that run as freshell client extensions. Each is a
standalone Vite app that builds to static HTML/JS/CSS and loads in a freshell
pane via an iframe.

## Quick Start

Pick a project, build it, symlink it, and restart freshell:

```bash
cd demo-projects/synth
npm install
npx vite build
ln -sf "$(pwd)" ~/.freshell/extensions/synth
```

After restarting freshell, the extension appears in the **New Tab** pane picker.

Repeat for any other demo project — each one is independent.

## Projects

### Synth

A Web Audio synthesizer with a two-octave keyboard (playable via mouse or
computer keyboard), four oscillator waveforms, ADSR envelope with live
visualization, reverb/delay effects with rotary knobs, a real-time waveform
analyser, and a 16-step sequencer with adjustable BPM.

- **Stack:** Vanilla JS, CSS, Vite
- **Extension name:** `synth`

```bash
cd demo-projects/synth
npm install && npx vite build
ln -sf "$(pwd)" ~/.freshell/extensions/synth
```

### Exoplanet Nightsky

An interactive sky map plotting thousands of confirmed exoplanets on a
Hammer-Aitoff projection. Color by equilibrium temperature or discovery
method, filter by method, scrub through discovery year with playback
animation, and hover for per-planet detail tooltips.

- **Stack:** React 18, TypeScript, Canvas 2D, Vite
- **Extension name:** `exoplanet-nightsky`
- **Data:** `public/exoplanets.csv` (bundled)

```bash
cd demo-projects/dataviz/viz-a
npm install && npx vite build
ln -sf "$(pwd)" ~/.freshell/extensions/exoplanet-nightsky
```

### Exoplanet Clusters

A force-directed bubble chart grouping exoplanets into clusters. Switch
between five grouping modes (physical size, temperature zone, discovery
method, discovery decade, system multiplicity) and watch the bubbles
reorganize with smooth d3-force animations. Hover for tooltips, click for
a detail panel with size comparison to Earth.

- **Stack:** React 19, TypeScript, d3-force, Canvas 2D, Vite
- **Extension name:** `exoplanet-clusters`
- **Data:** `public/data/exoplanets-clean.csv` (bundled)

```bash
cd demo-projects/dataviz/viz-b
npm install && npx vite build
ln -sf "$(pwd)" ~/.freshell/extensions/exoplanet-clusters
```

## How They Work

Each project has a `freshell.json` manifest with `category: "client"` and
`client.entry` pointing at `dist/index.html`. Freshell serves the built
static files directly — no runtime server process needed.

All Vite configs use `base: './'` so that built assets use relative paths,
which is required for the iframe proxy path that freshell serves client
extensions through.

## Agent Workflow

If you're an AI agent setting up these demos, here's the full sequence:

```bash
# From the freshell repo root
for project in demo-projects/synth demo-projects/dataviz/viz-a demo-projects/dataviz/viz-b; do
  cd "$project"
  npm install
  npx vite build
  cd -
done

# Symlink all three
ln -sf "$(pwd)/demo-projects/synth" ~/.freshell/extensions/synth
ln -sf "$(pwd)/demo-projects/dataviz/viz-a" ~/.freshell/extensions/exoplanet-nightsky
ln -sf "$(pwd)/demo-projects/dataviz/viz-b" ~/.freshell/extensions/exoplanet-clusters
```

Then restart freshell. The three extensions appear in the pane picker alongside
the built-in pane types.

## Development

To work on a demo with hot reload, run the Vite dev server directly:

```bash
cd demo-projects/synth
npm install
npx vite          # opens on the port configured in vite.config
```

When you're done, rebuild (`npx vite build`) so the extension picks up your
changes.
