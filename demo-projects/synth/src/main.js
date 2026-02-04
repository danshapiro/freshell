import './style.css';

// ===========================================================================
// CONSTANTS
// ===========================================================================

const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const BLACK_INDICES = new Set([1, 3, 6, 8, 10]);

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function midiToName(m) { return NOTES[m % 12] + (Math.floor(m / 12) - 1); }

// Computer keyboard → MIDI note mapping
// Lower octave (Z row): C3-B3   Upper octave (Q row): C4-B4
const KEY_MAP = {
  'z':48,'s':49,'x':50,'d':51,'c':52,'v':53,
  'g':54,'b':55,'h':56,'n':57,'j':58,'m':59,
  'q':60,'2':61,'w':62,'3':63,'e':64,'r':65,
  '5':66,'t':67,'6':68,'y':69,'7':70,'u':71,
};
const MIDI_LABEL = {};
Object.entries(KEY_MAP).forEach(([k, v]) => { MIDI_LABEL[v] = k.toUpperCase(); });

// Black key visual offsets (in white-key-width units) within one octave
const BLACK_OFFSETS = [
  { semi: 1, pos: 0.62 },
  { semi: 3, pos: 1.62 },
  { semi: 6, pos: 3.58 },
  { semi: 8, pos: 4.58 },
  { semi: 10, pos: 5.58 },
];

// SVG paths for waveform icons
const WAVE_PATHS = {
  sine:     'M2,12 C6,2 14,2 20,12 C26,22 34,22 38,12',
  square:   'M2,20 V4 H11 V20 H20 V4 H29 V20 H38',
  sawtooth: 'M2,20 L13,4 V20 L27,4 V20 L38,4',
  triangle: 'M2,20 L11,4 L20,20 L29,4 L38,20',
};

// Sequencer note rows (high to low): C4 down to C3
const SEQ_NOTES = [60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49, 48];
const SEQ_ROWS = SEQ_NOTES.length;

// ===========================================================================
// STATE
// ===========================================================================

let audioCtx = null;
let analyser = null;
const voices = new Map();
const activeEnvelopes = [];
let waveform = 'sawtooth';
const adsr = { attack: 0.05, decay: 0.2, sustain: 0.6, release: 0.3 };

// Effects state
let reverbMix = 0.25;
let delayTime = 0.3;
let delayFeedback = 0.35;
let masterVolume = 0.5;

// Audio nodes
let masterGain, dryGain, reverbWet, convolver, delayNode, delayFbGain, delayOut;

// Sequencer
let seqPlaying = false;
let bpm = 128;
let seqStep = 0;
let nextStepTime = 0;
let seqTimerId = null;
let drawStep = -1;
const seqData = Array.from({ length: SEQ_ROWS }, () => Array(16).fill(false));

// Interaction
const keyboardHeld = new Set();
let mouseMidi = null;
let mouseIsDown = false;

// DOM refs
const keyEls = new Map();
let adsrCanvas, adsrCtx;
let vizCanvas, vizCtx;
const seqCells = [];
let playBtn;
let bpmValEl;

// ===========================================================================
// AUDIO ENGINE
// ===========================================================================

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    initAudio();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function createImpulse(dur, decay) {
  const len = audioCtx.sampleRate * dur;
  const buf = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function initAudio() {
  // Master gain
  masterGain = audioCtx.createGain();
  masterGain.gain.value = masterVolume;

  // Analyser for visualizer
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;

  // Dry path
  dryGain = audioCtx.createGain();
  dryGain.gain.value = 1 - reverbMix;
  masterGain.connect(dryGain);

  // Reverb (ConvolverNode)
  convolver = audioCtx.createConvolver();
  convolver.buffer = createImpulse(2.5, 3);
  reverbWet = audioCtx.createGain();
  reverbWet.gain.value = reverbMix;
  masterGain.connect(convolver);
  convolver.connect(reverbWet);

  // Delay
  delayNode = audioCtx.createDelay(2.0);
  delayNode.delayTime.value = delayTime;
  delayFbGain = audioCtx.createGain();
  delayFbGain.gain.value = delayFeedback;
  delayOut = audioCtx.createGain();
  delayOut.gain.value = 0.4;
  masterGain.connect(delayNode);
  delayNode.connect(delayOut);
  delayNode.connect(delayFbGain);
  delayFbGain.connect(delayNode);

  // Route all through analyser → destination
  dryGain.connect(analyser);
  reverbWet.connect(analyser);
  delayOut.connect(analyser);
  analyser.connect(audioCtx.destination);
}

function noteOn(midi) {
  ensureAudio();
  if (voices.has(midi)) noteOff(midi);
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = waveform;
  osc.frequency.value = midiToFreq(midi);
  const env = audioCtx.createGain();
  env.gain.setValueAtTime(0.001, now);
  env.gain.linearRampToValueAtTime(1.0, now + adsr.attack);
  env.gain.linearRampToValueAtTime(Math.max(adsr.sustain, 0.001), now + adsr.attack + adsr.decay);
  osc.connect(env);
  env.connect(masterGain);
  osc.start(now);
  const voice = { osc, env, startTime: now, midi };
  voices.set(midi, voice);
  activeEnvelopes.push(voice);
  const el = keyEls.get(midi);
  if (el) el.classList.add('active');
}

function noteOff(midi) {
  const voice = voices.get(midi);
  if (!voice) return;
  const now = audioCtx.currentTime;
  voice.env.gain.cancelScheduledValues(now);
  voice.env.gain.setValueAtTime(voice.env.gain.value, now);
  voice.env.gain.linearRampToValueAtTime(0.001, now + adsr.release);
  voice.osc.stop(now + adsr.release + 0.05);
  voice.releaseTime = now;
  voices.delete(midi);
  const el = keyEls.get(midi);
  if (el) el.classList.remove('active');
  setTimeout(() => {
    try { voice.osc.disconnect(); voice.env.disconnect(); } catch (_) {}
    const idx = activeEnvelopes.indexOf(voice);
    if (idx >= 0) activeEnvelopes.splice(idx, 1);
  }, (adsr.release + 0.2) * 1000);
}

function scheduleSeqNote(midi, time, gate) {
  const osc = audioCtx.createOscillator();
  osc.type = waveform;
  osc.frequency.value = midiToFreq(midi);
  const env = audioCtx.createGain();
  const vol = 0.5;
  env.gain.setValueAtTime(0.001, time);
  env.gain.linearRampToValueAtTime(vol, time + Math.min(adsr.attack, gate));
  const adsEnd = time + adsr.attack + adsr.decay;
  if (adsEnd < time + gate) {
    env.gain.linearRampToValueAtTime(Math.max(adsr.sustain * vol, 0.001), adsEnd);
    env.gain.setValueAtTime(Math.max(adsr.sustain * vol, 0.001), time + gate);
  }
  env.gain.linearRampToValueAtTime(0.001, time + gate + adsr.release);
  osc.connect(env);
  env.connect(masterGain);
  osc.start(time);
  osc.stop(time + gate + adsr.release + 0.05);
}

// ===========================================================================
// DOM HELPERS
// ===========================================================================

function mk(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function svgEl(tag, attrs) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  return e;
}

// ===========================================================================
// BUILD UI
// ===========================================================================

function buildUI() {
  const app = document.getElementById('app');

  // Header
  const header = mk('header', 'header', app);
  const h1 = mk('h1', null, header);
  h1.textContent = 'SYNTHWAVE';
  const sub = mk('span', 'subtitle', header);
  sub.textContent = 'web audio synthesizer';

  // Visualizer
  buildVisualizer(app);

  // Controls row
  const row = mk('div', 'controls-row', app);
  buildOscPanel(row);
  buildEnvelopePanel(row);
  buildEffectsPanel(row);

  // Keyboard
  const kbSection = mk('div', 'keyboard-section', app);
  buildKeyboard(kbSection);

  // Sequencer
  buildSequencer(app);
}

// ---------- Visualizer ----------
function buildVisualizer(parent) {
  const panel = mk('section', 'panel visualizer-panel', parent);
  const h2 = mk('h2', null, panel);
  h2.textContent = 'Analyser';
  vizCanvas = mk('canvas', null, panel);
  vizCanvas.id = 'visualizer-canvas';
  vizCtx = vizCanvas.getContext('2d');
}

// ---------- Oscillator ----------
function buildOscPanel(parent) {
  const panel = mk('section', 'panel', parent);
  const h2 = mk('h2', null, panel);
  h2.textContent = 'Oscillator';
  const sel = mk('div', 'waveform-selector', panel);

  Object.entries(WAVE_PATHS).forEach(([type, path]) => {
    const btn = mk('div', 'wave-btn', sel);
    if (type === waveform) btn.classList.add('active');
    btn.innerHTML = `<svg viewBox="0 0 40 24"><path d="${path}"/></svg><span class="wave-name">${type}</span>`;
    btn.addEventListener('click', () => {
      waveform = type;
      sel.querySelectorAll('.wave-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// ---------- Envelope ----------
function buildEnvelopePanel(parent) {
  const panel = mk('section', 'panel', parent);
  const h2 = mk('h2', null, panel);
  h2.textContent = 'Envelope';
  const inner = mk('div', 'envelope-inner', panel);
  const sliders = mk('div', 'adsr-sliders', inner);

  const params = [
    { key: 'attack',  label: 'A', min: 0.005, max: 2,   fmt: v => v < 1 ? (v * 1000).toFixed(0) + 'ms' : v.toFixed(1) + 's' },
    { key: 'decay',   label: 'D', min: 0.005, max: 2,   fmt: v => v < 1 ? (v * 1000).toFixed(0) + 'ms' : v.toFixed(1) + 's' },
    { key: 'sustain', label: 'S', min: 0,     max: 1,   fmt: v => (v * 100).toFixed(0) + '%' },
    { key: 'release', label: 'R', min: 0.01,  max: 3,   fmt: v => v < 1 ? (v * 1000).toFixed(0) + 'ms' : v.toFixed(1) + 's' },
  ];

  params.forEach(p => {
    const grp = mk('div', 'slider-group', sliders);
    const valSpan = mk('span', 'slider-val', grp);
    valSpan.textContent = p.fmt(adsr[p.key]);
    const track = mk('div', 'slider-track', grp);
    const fill = mk('div', 'slider-fill', track);
    const thumb = mk('div', 'slider-thumb', track);
    const lbl = mk('label', null, grp);
    lbl.textContent = p.label;

    function setVal(v) {
      v = Math.max(p.min, Math.min(p.max, v));
      adsr[p.key] = v;
      const pct = (v - p.min) / (p.max - p.min);
      fill.style.height = (pct * 100) + '%';
      thumb.style.bottom = (pct * 100) + '%';
      valSpan.textContent = p.fmt(v);
    }
    setVal(adsr[p.key]);

    setupVerticalDrag(track, pct => {
      setVal(p.min + pct * (p.max - p.min));
    });
  });

  adsrCanvas = mk('canvas', null, inner);
  adsrCanvas.id = 'adsr-canvas';
  adsrCtx = adsrCanvas.getContext('2d');
}

function setupVerticalDrag(track, onChange) {
  function pctFromEvent(e) {
    const rect = track.getBoundingClientRect();
    return 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  }
  track.addEventListener('pointerdown', e => {
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    onChange(pctFromEvent(e));
    function onMove(ev) { onChange(pctFromEvent(ev)); }
    function onUp() {
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', onUp);
    }
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
  });
}

// ---------- Effects ----------
function buildEffectsPanel(parent) {
  const panel = mk('section', 'panel', parent);
  const h2 = mk('h2', null, panel);
  h2.textContent = 'Effects';
  const inner = mk('div', 'effects-inner', panel);

  // Reverb
  const revGrp = mk('div', 'fx-group', inner);
  mk('span', 'fx-group-label', revGrp).textContent = 'REVERB';
  buildKnob(revGrp, 'Mix', reverbMix, 0, 1, v => {
    reverbMix = v;
    if (dryGain) { dryGain.gain.value = 1 - v; reverbWet.gain.value = v; }
  });

  // Delay
  const delGrp = mk('div', 'fx-group', inner);
  mk('span', 'fx-group-label', delGrp).textContent = 'DELAY';
  const delKnobs = mk('div', 'knobs-row', delGrp);
  buildKnob(delKnobs, 'Time', delayTime, 0.01, 1.0, v => {
    delayTime = v;
    if (delayNode) delayNode.delayTime.value = v;
  });
  buildKnob(delKnobs, 'Fdbk', delayFeedback, 0, 0.9, v => {
    delayFeedback = v;
    if (delayFbGain) delayFbGain.gain.value = v;
  });

  // Master Volume
  const volGrp = mk('div', 'fx-group', inner);
  mk('span', 'fx-group-label', volGrp).textContent = 'MASTER';
  buildKnob(volGrp, 'Vol', masterVolume, 0, 1, v => {
    masterVolume = v;
    if (masterGain) masterGain.gain.value = v;
  }, 'vol-knob');
}

// ---------- Knob ----------
function buildKnob(parent, label, initial, min, max, onChange, extraClass) {
  const R = 20;
  const C = 2 * Math.PI * R;
  const ARC = C * 0.75;

  const container = mk('div', 'knob-container' + (extraClass ? ' ' + extraClass : ''), parent);
  const ring = mk('div', 'knob-ring', container);

  const svg = svgEl('svg', { viewBox: '0 0 52 52' });
  svg.classList.add('knob-svg');
  const bgCirc = svgEl('circle', { cx: '26', cy: '26', r: String(R), 'stroke-dasharray': `${ARC} ${C}` });
  bgCirc.classList.add('track-bg');
  const fillCirc = svgEl('circle', { cx: '26', cy: '26', r: String(R) });
  fillCirc.classList.add('track-fill');
  svg.appendChild(bgCirc);
  svg.appendChild(fillCirc);
  ring.appendChild(svg);

  const body = mk('div', 'knob-body', ring);
  mk('div', 'knob-indicator', body);

  const lblEl = mk('span', 'knob-label', container);
  lblEl.textContent = label;
  const valEl = mk('span', 'knob-value', container);

  let value = initial;
  function update(v) {
    value = Math.max(min, Math.min(max, v));
    const pct = (value - min) / (max - min);
    const rot = -135 + pct * 270;
    body.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
    fillCirc.setAttribute('stroke-dasharray', `${pct * ARC} ${C}`);
    valEl.textContent = value < 0.01 ? '0' : value >= 1 ? value.toFixed(1) : value.toFixed(2);
    onChange(value);
  }
  update(initial);

  let startY, startVal;
  body.addEventListener('pointerdown', e => {
    e.preventDefault();
    body.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startVal = value;
    function onMove(ev) {
      const dy = startY - ev.clientY;
      update(startVal + (dy / 150) * (max - min));
    }
    function onUp() {
      body.removeEventListener('pointermove', onMove);
      body.removeEventListener('pointerup', onUp);
    }
    body.addEventListener('pointermove', onMove);
    body.addEventListener('pointerup', onUp);
  });

  return { update, getValue: () => value };
}

// ---------- Keyboard ----------
function buildKeyboard(parent) {
  const kb = mk('div', 'keyboard', parent);
  const whiteNotes = [0, 2, 4, 5, 7, 9, 11];

  // White keys — CSS flex handles sizing
  for (let oct = 0; oct < 2; oct++) {
    const base = 48 + oct * 12;
    whiteNotes.forEach((semi) => {
      const midi = base + semi;
      const key = mk('div', 'key white', kb);
      key.dataset.midi = midi;
      const note = mk('span', 'key-note', key);
      note.textContent = midiToName(midi);
      const lbl = mk('span', 'key-label', key);
      lbl.textContent = MIDI_LABEL[midi] || '';
      keyEls.set(midi, key);
    });
  }

  // Black keys — percentage positioned
  for (let oct = 0; oct < 2; oct++) {
    const base = 48 + oct * 12;
    BLACK_OFFSETS.forEach(({ semi, pos }) => {
      const midi = base + semi;
      const key = mk('div', 'key black', kb);
      key.dataset.midi = midi;
      key.style.left = ((oct * 7 + pos) / 14 * 100) + '%';
      const lbl = mk('span', 'key-label', key);
      lbl.textContent = MIDI_LABEL[midi] || '';
      keyEls.set(midi, key);
    });
  }

  // Mouse interaction
  kb.addEventListener('pointerdown', e => {
    const k = e.target.closest('.key');
    if (!k) return;
    e.preventDefault();
    mouseIsDown = true;
    const midi = +k.dataset.midi;
    mouseMidi = midi;
    ensureAudio();
    noteOn(midi);
  });
  document.addEventListener('pointerup', () => {
    if (mouseIsDown && mouseMidi != null) {
      if (!keyboardHeld.has(mouseMidi)) noteOff(mouseMidi);
      mouseMidi = null;
    }
    mouseIsDown = false;
  });
  kb.addEventListener('pointerover', e => {
    if (!mouseIsDown) return;
    const k = e.target.closest('.key');
    if (!k) return;
    const midi = +k.dataset.midi;
    if (midi !== mouseMidi) {
      if (mouseMidi != null && !keyboardHeld.has(mouseMidi)) noteOff(mouseMidi);
      mouseMidi = midi;
      noteOn(midi);
    }
  });
}

// ---------- Sequencer ----------
function buildSequencer(parent) {
  const panel = mk('section', 'panel seq-panel', parent);
  const hdr = mk('div', 'seq-header', panel);
  const h2 = mk('h2', null, hdr);
  h2.textContent = 'Step Sequencer';

  const ctrls = mk('div', 'seq-controls', hdr);
  playBtn = mk('button', 'seq-btn', ctrls);
  playBtn.textContent = 'PLAY';
  playBtn.addEventListener('click', toggleSeq);

  // BPM with knob
  const bpmGrp = mk('div', 'bpm-group', ctrls);
  mk('label', null, bpmGrp).textContent = 'BPM';
  bpmValEl = mk('span', 'knob-value', bpmGrp);
  bpmValEl.textContent = bpm;
  buildKnob(bpmGrp, '', bpm, 60, 200, v => {
    bpm = Math.round(v);
    bpmValEl.textContent = bpm;
  });

  // Scrollable area for grid
  const scroll = mk('div', 'seq-scroll', panel);

  // Step numbers
  const stepNums = mk('div', 'step-numbers', scroll);
  for (let c = 0; c < 16; c++) {
    const sn = mk('span', 'step-num', stepNums);
    sn.textContent = c + 1;
    if (c % 4 === 0) sn.classList.add('beat');
  }

  const wrapper = mk('div', 'seq-grid-wrapper', scroll);

  // Labels
  const labels = mk('div', 'seq-labels', wrapper);
  for (let r = 0; r < SEQ_ROWS; r++) {
    const midi = SEQ_NOTES[r];
    const name = midiToName(midi);
    const lbl = mk('div', 'seq-label', labels);
    lbl.textContent = name;
    if (BLACK_INDICES.has(midi % 12)) lbl.classList.add('sharp');
  }

  // Grid
  const grid = mk('div', 'seq-grid', wrapper);
  for (let r = 0; r < SEQ_ROWS; r++) {
    seqCells[r] = [];
    for (let c = 0; c < 16; c++) {
      const cell = mk('div', 'seq-cell', grid);
      if (c % 4 === 0 && c > 0) cell.classList.add('beat-start');
      cell.addEventListener('click', () => {
        seqData[r][c] = !seqData[r][c];
        cell.classList.toggle('on');
      });
      seqCells[r][c] = cell;
    }
  }
}

// ===========================================================================
// SEQUENCER PLAYBACK
// ===========================================================================

function toggleSeq() {
  if (seqPlaying) stopSeq(); else startSeq();
}

function startSeq() {
  ensureAudio();
  seqPlaying = true;
  playBtn.classList.add('active');
  playBtn.textContent = 'STOP';
  seqStep = 0;
  nextStepTime = audioCtx.currentTime;
  seqTimerId = setInterval(seqScheduler, 25);
}

function stopSeq() {
  seqPlaying = false;
  playBtn.classList.remove('active');
  playBtn.textContent = 'PLAY';
  clearInterval(seqTimerId);
  clearStepHighlight();
  drawStep = -1;
}

function seqScheduler() {
  while (nextStepTime < audioCtx.currentTime + 0.1) {
    playStepAt(seqStep, nextStepTime);
    nextStepTime += 60 / bpm / 4;
    seqStep = (seqStep + 1) % 16;
  }
}

function playStepAt(step, time) {
  const gate = (60 / bpm / 4) * 0.8;
  for (let r = 0; r < SEQ_ROWS; r++) {
    if (seqData[r][step]) {
      scheduleSeqNote(SEQ_NOTES[r], time, gate);
    }
  }
  const ms = Math.max(0, (time - audioCtx.currentTime) * 1000);
  setTimeout(() => highlightStep(step), ms);
}

function highlightStep(step) {
  clearStepHighlight();
  for (let r = 0; r < SEQ_ROWS; r++) {
    seqCells[r][step].classList.add('step-active');
  }
  drawStep = step;
}

function clearStepHighlight() {
  if (drawStep >= 0) {
    for (let r = 0; r < SEQ_ROWS; r++) {
      seqCells[r][drawStep].classList.remove('step-active');
    }
  }
}

// ===========================================================================
// CANVAS RESIZE
// ===========================================================================

function syncCanvasSize(canvas) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
}

// ===========================================================================
// ADSR VISUALIZER
// ===========================================================================

function drawADSR() {
  if (!adsrCtx) return;
  syncCanvasSize(adsrCanvas);
  const w = adsrCanvas.width;
  const h = adsrCanvas.height;
  if (w === 0 || h === 0) return;
  const pad = 12;
  const dw = w - 2 * pad;
  const dh = h - 2 * pad;
  adsrCtx.clearRect(0, 0, w, h);

  // Proportional segment widths
  const total = adsr.attack + adsr.decay + 0.3 + adsr.release;
  const aW = (adsr.attack / total) * dw;
  const decW = (adsr.decay / total) * dw;
  const sW = (0.3 / total) * dw;
  const rW = (adsr.release / total) * dw;

  // Envelope keypoints
  const pts = [
    [pad, pad + dh],
    [pad + aW, pad],
    [pad + aW + decW, pad + dh * (1 - adsr.sustain)],
    [pad + aW + decW + sW, pad + dh * (1 - adsr.sustain)],
    [pad + aW + decW + sW + rW, pad + dh],
  ];

  // Phase labels
  adsrCtx.font = '8px sans-serif';
  adsrCtx.fillStyle = '#8a7a66';
  adsrCtx.textAlign = 'center';
  adsrCtx.fillText('A', pad + aW / 2, h - 2);
  adsrCtx.fillText('D', pad + aW + decW / 2, h - 2);
  adsrCtx.fillText('S', pad + aW + decW + sW / 2, h - 2);
  adsrCtx.fillText('R', pad + aW + decW + sW + rW / 2, h - 2);

  // Gradient fill under curve
  adsrCtx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? adsrCtx.moveTo(x, y) : adsrCtx.lineTo(x, y)));
  adsrCtx.lineTo(pts[4][0], pad + dh);
  adsrCtx.lineTo(pad, pad + dh);
  adsrCtx.closePath();
  const grad = adsrCtx.createLinearGradient(0, pad, 0, pad + dh);
  grad.addColorStop(0, 'rgba(212, 162, 76, 0.18)');
  grad.addColorStop(1, 'rgba(212, 162, 76, 0.02)');
  adsrCtx.fillStyle = grad;
  adsrCtx.fill();

  // Amber envelope line
  adsrCtx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? adsrCtx.moveTo(x, y) : adsrCtx.lineTo(x, y)));
  adsrCtx.strokeStyle = '#d4a24c';
  adsrCtx.lineWidth = 2;
  adsrCtx.lineJoin = 'round';
  adsrCtx.stroke();

  // Animated playhead dot on the most recent voice
  const voice = activeEnvelopes.length > 0 ? activeEnvelopes[activeEnvelopes.length - 1] : null;
  if (voice && audioCtx) {
    const now = audioCtx.currentTime;
    let x, y;

    if (voice.releaseTime) {
      const rp = Math.min((now - voice.releaseTime) / adsr.release, 1);
      x = pts[3][0] + rp * rW;
      const amp = adsr.sustain * (1 - rp);
      y = pad + dh * (1 - amp);
    } else {
      const elapsed = now - voice.startTime;
      if (elapsed < adsr.attack) {
        const p = elapsed / adsr.attack;
        x = pad + p * aW;
        y = pad + dh * (1 - p);
      } else if (elapsed < adsr.attack + adsr.decay) {
        const p = (elapsed - adsr.attack) / adsr.decay;
        x = pad + aW + p * decW;
        y = pad + (1 - adsr.sustain) * dh * p;
      } else {
        const p = Math.min((elapsed - adsr.attack - adsr.decay) / 0.3, 1);
        x = pad + aW + decW + p * sW;
        y = pad + dh * (1 - adsr.sustain);
      }
    }

    // Playhead vertical line
    adsrCtx.beginPath();
    adsrCtx.moveTo(x, pad);
    adsrCtx.lineTo(x, pad + dh);
    adsrCtx.strokeStyle = 'rgba(184, 85, 42, 0.4)';
    adsrCtx.lineWidth = 1;
    adsrCtx.stroke();

    // Dot
    adsrCtx.beginPath();
    adsrCtx.arc(x, y, 4, 0, Math.PI * 2);
    adsrCtx.fillStyle = '#b8552a';
    adsrCtx.fill();
    adsrCtx.beginPath();
    adsrCtx.arc(x, y, 7, 0, Math.PI * 2);
    adsrCtx.strokeStyle = 'rgba(184, 85, 42, 0.35)';
    adsrCtx.lineWidth = 2;
    adsrCtx.stroke();
  }
}

// ===========================================================================
// WAVEFORM / SPECTRUM VISUALIZER
// ===========================================================================

function drawVisualizer() {
  if (!vizCtx) return;
  syncCanvasSize(vizCanvas);
  const w = vizCanvas.width;
  const h = vizCanvas.height;
  if (w === 0 || h === 0) return;
  vizCtx.clearRect(0, 0, w, h);

  if (!analyser) {
    // Draw idle state - flat line
    vizCtx.beginPath();
    vizCtx.moveTo(0, h / 2);
    vizCtx.lineTo(w, h / 2);
    vizCtx.strokeStyle = 'rgba(212, 162, 76, 0.15)';
    vizCtx.lineWidth = 1;
    vizCtx.stroke();
    return;
  }

  // Frequency spectrum bars (background)
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freqData);
  const barCount = 64;
  const barW = w / barCount;
  const step = Math.floor(freqData.length / barCount);

  for (let i = 0; i < barCount; i++) {
    const val = freqData[i * step] / 255;
    const barH = val * h * 0.85;
    const x = i * barW;

    const grd = vizCtx.createLinearGradient(x, h, x, h - barH);
    grd.addColorStop(0, 'rgba(212, 162, 76, 0.14)');
    grd.addColorStop(0.5, 'rgba(212, 162, 76, 0.06)');
    grd.addColorStop(1, 'rgba(184, 85, 42, 0.04)');
    vizCtx.fillStyle = grd;
    vizCtx.fillRect(x + 1, h - barH, barW - 2, barH);
  }

  // Waveform line (foreground)
  const waveData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(waveData);

  vizCtx.beginPath();
  const sliceW = w / waveData.length;
  for (let i = 0; i < waveData.length; i++) {
    const v = waveData[i] / 128.0;
    const y = (v * h) / 2;
    if (i === 0) vizCtx.moveTo(0, y);
    else vizCtx.lineTo(i * sliceW, y);
  }
  vizCtx.strokeStyle = '#d4a24c';
  vizCtx.lineWidth = 1.5;
  vizCtx.shadowColor = 'rgba(212, 162, 76, 0.5)';
  vizCtx.shadowBlur = 6;
  vizCtx.stroke();
  vizCtx.shadowBlur = 0;
}

// ===========================================================================
// KEYBOARD INPUT
// ===========================================================================

document.addEventListener('keydown', e => {
  if (e.repeat || e.target.tagName === 'INPUT') return;
  const midi = KEY_MAP[e.key.toLowerCase()];
  if (midi != null) {
    e.preventDefault();
    keyboardHeld.add(midi);
    noteOn(midi);
  }
  // Space toggles sequencer
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    toggleSeq();
  }
});

document.addEventListener('keyup', e => {
  const midi = KEY_MAP[e.key.toLowerCase()];
  if (midi != null) {
    keyboardHeld.delete(midi);
    if (midi !== mouseMidi) noteOff(midi);
  }
});

window.addEventListener('blur', () => {
  keyboardHeld.forEach(midi => noteOff(midi));
  keyboardHeld.clear();
  if (mouseMidi != null) { noteOff(mouseMidi); mouseMidi = null; }
  mouseIsDown = false;
});

// ===========================================================================
// ANIMATION LOOP
// ===========================================================================

function tick() {
  drawADSR();
  drawVisualizer();
  requestAnimationFrame(tick);
}

// ===========================================================================
// INIT
// ===========================================================================

buildUI();
requestAnimationFrame(tick);
