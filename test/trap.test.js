// синтетический трэп: 808 с глайдом, бочка синкопой, снейр на 3-ю долю (half-time), хэты 1/8 с роллами 1/16 и 1/32
const assert = require('assert');
const { analyzeMono, generateMap, DIFFS } = require('../src/core');
function trap(bpm, dur, off, sr) {
  const n = Math.floor(dur * sr), a = new Float32Array(n), B = 60 / bpm;
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 1073741823.5 - 1;
  const add = (t, len, fn) => { const s0 = Math.floor(t * sr); for (let k = 0; k < len * sr && s0 + k < n; k++) a[s0 + k] += fn(k / sr); };
  const truth = { kick: [], snare: [], hat: [] };
  const kickPat = [0, 0.75, 2.5, 3.25]; // доли внутри такта 4/4 (в битах 140 BPM)
  for (let bar = 0; off + bar * 4 * B < dur; bar++) {
    const t0 = off + bar * 4 * B;
    for (const k of kickPat) { const t = t0 + k * B; truth.kick.push(t * 1000); let ph = 0; add(t, 0.9, (x) => { ph += (40 + 60 * Math.exp(-x * 30)) / sr; return 0.8 * Math.sin(2 * Math.PI * ph) * Math.exp(-x * 2.5); }); }
    const ts = t0 + 2 * B; truth.snare.push(ts * 1000); add(ts, 0.2, (x) => (0.6 * rnd() + 0.3 * Math.sin(2 * Math.PI * 200 * x)) * Math.exp(-x * 20));
    for (let h = 0; h < 8; h++) {
      const roll = (bar % 2 === 1 && h === 7) ? 4 : (h === 3 ? 2 : 1);
      for (let r = 0; r < roll; r++) { const t = t0 + h * B / 2 + r * B / 2 / roll; truth.hat.push(t * 1000); let p = 0; add(t, 0.04, (x) => { const v = rnd(); const hp = v - p; p = v; return 0.18 * hp * Math.exp(-x * 90); }); }
    }
  }
  return { a, truth };
}
(async () => {
  for (const bpm of [140, 150, 130]) {
    const sr = 22050, { a, truth } = trap(bpm, 50, 0.43, sr);
    const an = await analyzeMono(a, sr);
    const near = (t, arr, tol) => arr.some((x) => Math.abs(x - t) <= tol);
    const drums = [...truth.kick, ...truth.snare];
    let line = `bpm ${bpm} -> ${an.bpm} phase ${an.phase.toFixed(0)} (kick0 ${(truth.kick[0] % an.period).toFixed(0)}) grid=${an.gridOk}`;
    for (const d of DIFFS) {
      const m = generateMap(an, d, 1);
      const ts = m.objects.flatMap((o) => (o.type === 's' ? [o.t] : o.type === 'p' ? [] : [o.t]));
      const onDrum = ts.filter((t) => near(t, drums, 30)).length / ts.length;
      const onAny = ts.filter((t) => near(t, [...drums, ...truth.hat], 30)).length / ts.length;
      line += ` | ${d.id} ${ts.length} drum ${(onDrum * 100).toFixed(0)}% any ${(onAny * 100).toFixed(0)}%`;
      assert(onAny >= 0.95, `${bpm} ${d.id}: ноты мимо звуков`);
    }
    assert(Math.abs(an.bpm - bpm) < 1.5, `темп ${bpm} определился как ${an.bpm}`);
    console.log(line);
  }
  console.log('trap: ok');
})().catch((e) => { console.error(e); process.exit(1); });
