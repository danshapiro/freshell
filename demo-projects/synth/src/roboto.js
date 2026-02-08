// "Domo Arigato Mr. Roboto" by Styx — paste into browser console
// Key of E minor, ~104 BPM

(async () => {
  const BPM = 104;
  const Q = 60000 / BPM;
  const E = Q / 2;
  const S = Q / 4;
  const DQ = Q * 1.5;
  const H = Q * 2;

  const M = {
    'E3':52,'F#3':54,'G3':55,'A3':57,'B3':59,
    'C4':60,'D4':62,'E4':64,'F#4':66,'G4':67,'A4':69,'B4':71,
  };
  const K = {
    52:'c',54:'g',55:'b',57:'n',59:'m',
    60:'q',62:'w',64:'e',66:'5',67:'t',69:'y',71:'u',
  };

  const dn = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const up = k => document.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));

  const note = (n, dur, gate = 0.8) => new Promise(r => {
    const k = K[M[n]];
    if (k) { dn(k); setTimeout(() => up(k), dur * gate); }
    setTimeout(r, dur);
  });

  const rest = ms => new Promise(r => setTimeout(r, ms));

  const seq = async (...items) => {
    for (const [n, d] of items)
      n ? await note(n, d) : await rest(d);
  };

  // ---- Intro: pulsing synth on B ----
  for (let i = 0; i < 16; i++) await note('B3', S, 0.5);
  for (let i = 0; i < 16; i++) await note('B3', S, 0.5);

  // Descending intro lick
  await seq(
    ['B3',E],['A3',E],['G3',E],['F#3',E],
    ['E3',Q],[null,E],
    ['E3',E],['F#3',E],['G3',E],['F#3',E],
    ['E3',H],
    [null,Q],
  );

  // ---- "Domo arigato, Mr. Roboto" (1st) ----
  await seq(
    ['B3',E],['B3',E],                                // Do-mo
    ['B3',E],['A3',E],['G3',E],['F#3',DQ],            // a-ri-ga-to
    ['E3',E],['F#3',E],                                // Mis-ter
    ['G3',E],['F#3',E],['E3',Q],                       // Ro-bo-to
    [null,Q],
  );

  // ---- "Domo arigato, Mr. Roboto" (2nd) ----
  await seq(
    ['B3',E],['B3',E],
    ['B3',E],['A3',E],['G3',E],['F#3',DQ],
    ['E3',E],['F#3',E],
    ['G3',E],['F#3',E],['E3',Q],
    [null,Q],
  );

  // ---- "Mata au hi made" ----
  await seq(
    ['B3',E],['B3',E],
    ['A3',E],['G3',E],
    ['F#3',E],['E3',DQ],
    [null,Q],
  );

  // ---- "Domo arigato, Mr. Roboto" (higher octave) ----
  await seq(
    ['E4',E],['E4',E],
    ['E4',E],['D4',E],['C4',E],['B3',DQ],
    ['A3',E],['B3',E],
    ['C4',E],['B3',E],['A3',Q],
    [null,Q],
  );

  // ---- "Himitsu wo shiritai" ----
  await seq(
    ['E4',E],['E4',E],
    ['D4',E],['C4',E],
    ['B3',E],['A3',DQ],
    [null,H],
  );

  // ---- Final "Domo arigato, Mr. Roboto" ----
  await seq(
    ['B3',E],['B3',E],
    ['B3',E],['A3',E],['G3',E],['F#3',DQ],
    ['E3',E],['F#3',E],
    ['G3',E],['F#3',E],['E3',H],
  );

  console.log('🤖 Domo arigato!');
})();
