const assert = require('assert');
const { analyzeMono, generateMap, DIFFS, PF_W, PF_H } = require('../src/core');
function synth(bpm, dur, off, sr) {
  const n = Math.floor(dur * sr), a = new Float32Array(n), P = 60 / bpm;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let t = off, i = 0; t < dur; t += P / 2, i++) {
    const s0 = Math.floor(t * sr);
    for (let k = 0; k < sr * 0.12 && s0 + k < n; k++) {
      const x = k / sr;
      if (i % 2 === 0) a[s0 + k] += 0.8 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-x * 30)) * x) * Math.exp(-x * 18); // бочка
      if (i % 4 === 2) a[s0 + k] += 0.4 * rnd() * Math.exp(-x * 25); // снейр
      a[s0 + k] += 0.12 * rnd() * Math.exp(-x * 80); // хэт
    }
  }
  for (let i = 0; i < n; i++) a[i] += 0.05 * Math.sin(2 * Math.PI * 110 * i / sr); // пэд
  return a;
}
(async () => {
  for (const [bpm, off] of [[128, 0.37], [95, 0.12], [174, 0.5], [140, 0.05]]) {
    const sr = 22050;
    const t0 = Date.now();
    const an = await analyzeMono(synth(bpm, 60, off, sr), sr);
    const ms = Date.now() - t0;
    const phaseErr = Math.min(Math.abs(an.phase - (off * 1000) % an.period), an.period - Math.abs(an.phase - (off * 1000) % an.period));
    console.log(`bpm ${bpm} -> ${an.bpm}, phase err ${phaseErr.toFixed(1)} ms, onsets ${an.onsets.length}, ${ms} ms`);
    assert(Math.abs(an.bpm - bpm) < 1 || Math.abs(an.bpm - bpm * 2) < 2 || Math.abs(an.bpm * 2 - bpm) < 2, 'bpm');
    assert(phaseErr < 25 || Math.abs(phaseErr - an.period / 2) < 25, 'phase');
    for (const d of DIFFS) {
      const m = generateMap(an, d, 12345);
      const types = m.objects.reduce((c, o) => (c[o.type] = (c[o.type] || 0) + 1, c), {});
      for (const o of m.objects) {
        assert(Number.isFinite(o.t) && Number.isFinite(o.x) && Number.isFinite(o.y), 'finite');
        assert(o.x >= 0 && o.x <= PF_W && o.y >= 0 && o.y <= PF_H, 'inside');
        if (o.type === 's') assert(o.end > o.t && o.len > 0, 'slider');
      }
      for (let i = 1; i < m.objects.length; i++) assert(m.objects[i].t >= m.objects[i - 1].t, 'sorted');
      console.log(`  ${d.id}: ${m.objects.length} obj ${JSON.stringify(types)} stars ${m.stars}`);
    }
  }
  console.log('core: ok');
})().catch((e) => { console.error(e); process.exit(1); });
