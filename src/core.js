// ===== Hitwave core: анализ песни и генератор карт. Без DOM, проверяется в node (test.js) =====

/** Радикс-2 FFT на месте; re/im длины n (степень двойки) */
function makeFFT(n) {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  return (re, im) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step];
          const a = i + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

const yieldNow = () => new Promise((r) => setTimeout(r, 0));

/**
 * Разбор моно-сигнала: удары (onsets) с силой и полосой, темп и фаза сетки битов, громкость.
 * Все времена в миллисекундах.
 */
async function analyzeMono(mono, sr, onProgress) {
  const N = 1024, H = 256, fps = sr / H;
  const frames = Math.max(0, Math.floor((mono.length - N) / H));
  const fft = makeFFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float32Array(N), im = new Float32Array(N);
  const bins = N / 2;
  const hz = sr / N;
  const lowEnd = Math.ceil(180 / hz), midEnd = Math.ceil(2200 / hz);
  let prev = new Float32Array(bins), cur = new Float32Array(bins);
  const hiFrac = new Float32Array(frames), flux = new Float32Array(frames), drums = new Float32Array(frames), low = new Float32Array(frames), mid = new Float32Array(frames), high = new Float32Array(frames), rms = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const o = f * H;
    let e = 0;
    for (let i = 0; i < N; i++) { const v = mono[o + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    rms[f] = Math.sqrt(e / N);
    fft(re, im);
    let fl = 0, fm = 0, fh = 0;
    for (let k = 1; k < bins; k++) {
      const m = Math.log(1 + 100 * Math.hypot(re[k], im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0) { if (k < lowEnd) fl += d; else if (k < midEnd) fm += d; else fh += d; }
    }
    low[f] = fl; mid[f] = fm; high[f] = fh;
    hiFrac[f] = fh / (fl + fm + fh + 1e-9); // доля верхов: у хэтов почти вся энергия наверху
    const t = prev; prev = cur; cur = t;
    if ((f & 511) === 511) { if (onProgress) onProgress(f / frames * 0.85); await yieldNow(); }
  }

  // каждая полоса нормируется сама по себе: тихая бочка не тонет в громких хэтах
  const pct = (arr, q) => { const s = Array.from(arr).sort((a, b) => a - b); return s[Math.floor(s.length * q)] || 1e-6; };
  const nl = pct(low, 0.97), nm = pct(mid, 0.97), nh = pct(high, 0.97);
  for (let f = 0; f < frames; f++) {
    low[f] /= nl; mid[f] /= nm; high[f] /= nh;
    drums[f] = Math.max(low[f], mid[f] * 0.9);
    flux[f] = low[f] + mid[f] * 0.8 + high[f] * 0.5;
  }
  // пики потока выше скользящего порога — это удары
  const W = 12, onsets = [];
  let sorted = Array.from(flux).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const floor = sorted[Math.floor(sorted.length * 0.5)] || 0;
  let lastF = -99;
  for (let f = 2; f < frames - 2; f++) {
    const v = flux[f];
    if (v <= floor) continue;
    let isMax = true;
    for (let k = -3; k <= 3 && isMax; k++) if (k && flux[f + k] > v) isMax = false;
    if (!isMax) continue;
    let s = 0, c = 0;
    for (let k = Math.max(0, f - W); k <= Math.min(frames - 1, f + W); k++) { s += flux[k]; c++; }
    if (v < (s / c) * 1.25 + p95 * 0.04) continue;
    if (f - lastF < fps * 0.07) continue; // ближе 70 мс — это один удар
    lastF = f;
    const around = (arr) => Math.max(arr[f - 1], arr[f], arr[f + 1]);
    const dr = Math.min(1.5, around(drums)) * (hiFrac[f] > 0.6 ? 0.35 : 1), hh = Math.min(1.5, around(high));
    // d — сила удара барабана или ноты в середине, h — сила хэта/тарелки
    onsets.push({ t: (f * H + N / 2) / sr * 1000, s: Math.min(1, v / p95), d: dr, h: hh, b: dr >= hh * 0.7 ? 0 : 1 });
  }
  if (onProgress) onProgress(0.9);

  // темп: автокорреляция огибающей с мягким предпочтением 120 BPM
  const env = new Float32Array(frames);
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += flux[f];
  mean /= Math.max(1, frames);
  for (let f = 0; f < frames; f++) env[f] = Math.max(0, flux[f] - mean);
  const minL = Math.floor(fps * 60 / 200), maxL = Math.ceil(fps * 60 / 60);
  const ac = new Float32Array(maxL + 2);
  for (let L = minL - 1; L <= maxL + 1; L++) { let s = 0; for (let f = 0; f + L < frames; f++) s += env[f] * env[f + L]; ac[L] = s; }
  const acAt = (x) => { if (x < 1 || x >= frames - 1) return 0; let s2 = 0; const L2 = Math.round(x); for (let f = 0; f + L2 < frames; f++) s2 += env[f] * env[f + L2]; return s2; };
  const acCache = new Map();
  const AC = (x) => { const k = Math.round(x); if (!acCache.has(k)) acCache.set(k, k >= minL - 1 && k <= maxL + 1 ? ac[k] : acAt(k)); return acCache.get(k); };
  let bestL = minL, bestV = -1;
  for (let L = minL; L <= maxL; L++) {
    const bpm = 60 * fps / L;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.9, 2));
    // настоящий бит подтверждается и на два бита, и на такт, и на половинках
    const v = (AC(L) + 0.5 * AC(2 * L) + 0.35 * AC(4 * L) + 0.5 * AC(L / 2)) * w;
    if (v > bestV) { bestV = v; bestL = L; }
  }
  const a = ac[bestL - 1], b = ac[bestL], c2 = ac[bestL + 1];
  const shift = (a - 2 * b + c2) !== 0 ? 0.5 * (a - c2) / (a - 2 * b + c2) : 0;
  let period = bestL + Math.max(-0.5, Math.min(0.5, shift)); // в кадрах
  await yieldNow();

  // точная подгонка периода и фазы по всей песне: где сетка ловит больше всего энергии
  let best = { score: -1, P: period, phi: 0 };
  // фаза по барабанам: сетка должна стоять на бочке и снейре, а не на хэтах между ними
  let dm = 0;
  for (let f = 0; f < frames; f++) dm += drums[f];
  dm /= Math.max(1, frames);
  const denv = new Float32Array(frames);
  for (let f = 0; f < frames; f++) denv[f] = Math.max(0, drums[f] - dm) + env[f] * 0.15;
  const strengthAt = (x) => { const i = Math.round(x); return Math.max(denv[i - 1] || 0, denv[i] || 0, denv[i + 1] || 0); };
  for (let k = -24; k <= 24; k++) {
    const P = period * (1 + k * 0.0006);
    for (let phi = 0; phi < P; phi += 0.5) {
      let s = 0;
      for (let x = phi; x < frames; x += P) s += strengthAt(x);
      if (s > best.score) best = { score: s, P, phi };
    }
  }
  let periodMs = best.P / fps * 1000;
  // трэп и фонк часто «в половину»: играем в полном темпе, как и ставят карты
  while (60000 / periodMs < 88) { periodMs /= 2; best.phi = best.phi % (best.P / 2); best.P /= 2; }
  let bpm = 60000 / periodMs;
  const phaseMs = (best.phi * H + N / 2) / sr * 1000;

  // громкость каждые ~46 мс, нормированная к 0..1
  const step = 4, energy = [];
  let maxE = 1e-9;
  for (let f = 0; f < frames; f += step) { let s = 0; for (let k = f; k < Math.min(frames, f + step); k++) s += rms[k]; const v = s / step; energy.push(v); if (v > maxE) maxE = v; }
  for (let i = 0; i < energy.length; i++) energy[i] = Math.round(energy[i] / maxE * 1000) / 1000;
  // ложится ли песня на ровную сетку (живые барабаны и плавающий темп — нет)
  const strong = onsets.filter((o) => o.s > 0.35);
  const q = periodMs / 4;
  const onGrid = strong.filter((o) => { const r = ((o.t - phaseMs) % q + q) % q; return Math.min(r, q - r) <= 35; }).length;
  const gridOk = strong.length < 8 || onGrid / strong.length >= 0.6;
  if (onProgress) onProgress(1);

  return {
    gridOk,
    duration: mono.length / sr * 1000,
    bpm: Math.round(bpm * 10) / 10,
    period: periodMs,
    phase: phaseMs % periodMs,
    onsets,
    energy,
    energyStep: step * H / sr * 1000,
  };
}

/** Детерминированный генератор случайных чисел: одна и та же песня — одна и та же карта */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function hashStr(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; }

const DIFFS = [
  // spacing — сколько диаметров круга проходит курсор за один бит
  { id: 'easy', name: 'Лёгкая', ar: 1400, r: 46, od: 3, drain: 0.02, sub: 1, minGap: 1, q: 0.35, spacing: 1.0, spin: 1.1, slider: 2 },
  { id: 'normal', name: 'Нормальная', ar: 1100, r: 40, od: 5, drain: 0.03, sub: 2, minGap: 0.5, q: 0.3, spacing: 1.2, spin: 1.5, slider: 1 },
  { id: 'hard', name: 'Сложная', ar: 820, r: 35, od: 7, drain: 0.045, sub: 2, minGap: 0.5, q: 0.08, spacing: 1.5, spin: 1.9, slider: 1 },
  { id: 'insane', name: 'Безумная', ar: 620, r: 31, od: 8.5, drain: 0.06, sub: 4, minGap: 0.25, q: 0.12, spacing: 1.75, spin: 2.3, slider: 0.5 },
];
const PF_W = 512, PF_H = 384;

/** Окна попадания (мс) для 300 / 100 / 50 по сложности OD */
function hitWindows(od) { return { w300: 80 - 6 * od, w100: 140 - 8 * od, w50: 200 - 10 * od }; }

function quantile(arr, q) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

/** Точка на квадратичной кривой Безье */
function bez(p, u) { const v = 1 - u; return { x: v * v * p[0].x + 2 * v * u * p[1].x + u * u * p[2].x, y: v * v * p[0].y + 2 * v * u * p[1].y + u * u * p[2].y }; }

/**
 * Карта из анализа: круги ('c'), слайдеры ('s'), спиннеры ('p').
 * Каждый объект: t (мс), x, y в поле 512×384, combo (номер в связке), color, newCombo.
 */
function generateMap(an, diff, seed) {
  const R = rng(seed ^ hashStr(diff.id));
  const P = an.period, u = P / diff.sub;
  const energyAt = (t) => an.energy[Math.max(0, Math.min(an.energy.length - 1, Math.round(t / an.energyStep)))] || 0;
  const medE = quantile(an.energy, 0.5);

  // 1. удары прилипают к сетке битов; мимо сетки — выкидываем
  // сила ноты: барабаны и мелодия главные; хэты — только на сложной и безумной
  const hats = diff.sub >= 2 && diff.q < 0.2;
  const power = (o) => (o.d !== undefined ? Math.max(o.d, hats ? o.h * 0.55 : o.h * 0.2) : o.s);
  const slots = new Map();
  const gridOk = an.gridOk !== false;
  for (const o of an.onsets) {
    let k, t;
    if (gridOk) {
      k = Math.round((o.t - an.phase) / u);
      t = an.phase + k * u;
      // нота ставится на сетку, только если удар реально рядом: иначе она будет «мимо музыки»
      if (Math.abs(o.t - t) > Math.min(40, u * 0.4) || t < 0) continue;
    } else { k = Math.round(o.t / 10); t = o.t; } // песня без ровной сетки: ноты прямо на удары
    const cur = slots.get(k), pw = power(o);
    if (!cur || cur.s < pw) slots.set(k, { k, t, s: pw, b: o.b });
  }
  let cand = [...slots.values()].sort((a, b) => a.t - b.t);
  // на лёгкой и нормальной слабые доли берём только если удар сильный
  const thr = quantile(cand.map((c) => c.s), diff.q);
  cand = cand.filter((c) => c.s >= thr || (c.k % diff.sub === 0 && c.s >= thr * 0.7));

  // 2. минимальный интервал между нотами
  const notes = [];
  const minGap = Math.max(diff.minGap * P, diff.sub === 4 ? 105 : 0) - 2; // стримы быстрее ~9 нот/с не ставим
  for (const c of cand) {
    const last = notes[notes.length - 1];
    if (last && c.t - last.t < minGap) { if (c.s > last.s * 1.4 && notes.length > 1 && c.t - notes[notes.length - 2].t >= minGap) notes[notes.length - 1] = c; continue; }
    notes.push(c);
  }

  // 3. дыры там, где музыка играет, а ударов нет (пэды, вокал): ставим ноты по битам
  const filled = [];
  const firstT = notes.length ? notes[0].t : an.phase;
  for (let i = 0; i < notes.length; i++) {
    filled.push(notes[i]);
    const next = notes[i + 1];
    if (!next) break;
    const gapBeats = (next.t - notes[i].t) / P;
    if (gapBeats >= 6 && energyAt((notes[i].t + next.t) / 2) > medE * 0.9) {
      // длинная громкая пауза — оставим под спиннер, если хватит длины
      if (gapBeats >= 8) continue;
      const every = diff.sub === 1 ? 2 : 1;
      for (let t = notes[i].t + every * P; t < next.t - P * 0.75; t += every * P) filled.push({ t, s: 0.3, b: 0, k: -1, fill: true });
    }
  }
  if (!filled.length) return { objects: [], diff, stars: 0 };

  // 4. превращаем ноты в объекты: длинный громкий интервал — слайдер или спиннер
  const objects = [];
  for (let i = 0; i < filled.length; i++) {
    const n = filled[i], next = filled[i + 1];
    const gap = next ? next.t - n.t : P * 2;
    const loud = energyAt(n.t + gap / 2) >= medE * 0.85;
    if (next && gap >= 8 * P && loud && i > 0) {
      objects.push({ type: 'c', t: n.t, s: n.s });
      const t0 = n.t + P, t1 = next.t - P;
      if (t1 - t0 >= 3 * P) objects.push({ type: 'p', t: t0, end: t1 });
      continue;
    }
    if (next && gap >= diff.slider * P + 1 && loud && R() < 0.62) {
      const beats = Math.max(diff.slider / 2, Math.floor((gap / P - 0.5) * 2) / 2);
      objects.push({ type: 's', t: n.t, end: n.t + Math.min(beats, 4) * P, s: n.s });
      continue;
    }
    // слайдер до следующего удара, «съедая» его: так слайдеры идут и в плотных местах, как на обычных картах
    const after = filled[i + 2];
    if (next && gap >= diff.slider * P / 2 - 1 && gap <= 2 * P + 1 && (!after || after.t - next.t >= Math.max(diff.minGap * P, P / 2) - 1) && R() < 0.33) {
      objects.push({ type: 's', t: n.t, end: next.t, s: Math.max(n.s, next.s) });
      i++;
      continue;
    }
    objects.push({ type: 'c', t: n.t, s: n.s });
  }

  // 5. раскладка по полю: расстояние растёт с интервалом, направление плавно поворачивает
  const r = diff.r, margin = r + 6;
  const inside = (p) => p.x >= margin && p.x <= PF_W - margin && p.y >= margin && p.y <= PF_H - margin;
  let pos = { x: PF_W / 2, y: PF_H / 2 }, ang = R() * Math.PI * 2, turn = R() < 0.5 ? 1 : -1, sinceFlip = 0;
  let prevEndT = 0;
  for (const o of objects) {
    if (o.type === 'p') { o.x = PF_W / 2; o.y = PF_H / 2; pos = { x: o.x, y: o.y }; prevEndT = o.end; continue; }
    const gap = Math.max(1, o.t - prevEndT);
    const strong = (o.s || 0) > 0.75;
    const beats = gap / P;
    // расстояние растёт с паузой между нотами; ноты не налезают друг на друга
    let d = Math.min(300, Math.max(r * 2.1, beats * diff.spacing * 2 * r * (strong ? 1.2 : 1)));
    if (beats < 0.3) d = r * 1.5; // стримы — плотной цепочкой
    if (++sinceFlip > 4 + Math.floor(R() * 5)) { turn = -turn; sinceFlip = 0; }
    ang += turn * (0.35 + R() * 0.9);
    let p = null;
    for (let tries = 0; tries < 14; tries++) {
      const a = ang + (tries % 2 ? 1 : -1) * Math.ceil(tries / 2) * 0.55;
      const q = { x: pos.x + Math.cos(a) * d, y: pos.y + Math.sin(a) * d };
      if (inside(q)) { p = q; ang = a; break; }
    }
    if (!p) { // упёрлись в край — идём к центру
      ang = Math.atan2(PF_H / 2 - pos.y, PF_W / 2 - pos.x);
      p = { x: pos.x + Math.cos(ang) * d, y: pos.y + Math.sin(ang) * d };
      p.x = Math.max(margin, Math.min(PF_W - margin, p.x)); p.y = Math.max(margin, Math.min(PF_H - margin, p.y));
    }
    o.x = p.x; o.y = p.y;
    pos = p;
    prevEndT = o.t;
    if (o.type === 's') {
      const len = Math.max(r * 2.5, Math.min(240, (o.end - o.t) / P * diff.spacing * 2 * r * 0.85));
      let path = null;
      for (let tries = 0; tries < 16 && !path; tries++) {
        const a = ang + turn * 0.4 + (tries % 2 ? 1 : -1) * Math.ceil(tries / 2) * 0.5;
        const end = { x: p.x + Math.cos(a) * len, y: p.y + Math.sin(a) * len };
        const bend = (R() - 0.5) * len * 0.9;
        const mid = { x: (p.x + end.x) / 2 - Math.sin(a) * bend, y: (p.y + end.y) / 2 + Math.cos(a) * bend };
        if (inside(end) && inside(mid)) path = [{ x: p.x, y: p.y }, mid, end];
      }
      if (!path) { o.type = 'c'; delete o.end; continue; }
      o.path = path;
      // длина дуги для равномерного движения шарика
      const pts = [];
      let L = 0, last = path[0];
      for (let k = 0; k <= 40; k++) { const q = bez(path, k / 40); L += Math.hypot(q.x - last.x, q.y - last.y); pts.push({ x: q.x, y: q.y, l: L }); last = q; }
      o.pts = pts; o.len = L;
      pos = path[2];
      ang = Math.atan2(path[2].y - path[1].y, path[2].x - path[1].x);
      prevEndT = o.end;
    }
  }

  // 6. связки (комбо-цвета): новая после паузы, на сильной доле или когда связка длинная
  let combo = 0, color = 0, lastT = -1e9;
  for (const o of objects) {
    const beatIdx = Math.round((o.t - an.phase) / P);
    const onBar = Math.abs(o.t - (an.phase + beatIdx * P)) < 5 && beatIdx % 4 === 0;
    if (o.type === 'p' || o.t - lastT >= 2 * P || (onBar && combo >= 4) || combo >= 12) { combo = 0; color++; o.newCombo = true; }
    o.combo = ++combo;
    o.color = color;
    lastT = o.end || o.t;
  }

  // примерная сложность для звёздочек
  const len = Math.max(1, (objects[objects.length - 1].end || objects[objects.length - 1].t) - objects[0].t) / 1000;
  const dens = objects.length / len;
  const stars = Math.round((0.4 + dens * 0.7 + (diff.od - 3) * 0.15 + (1400 - diff.ar) / 1000) * 10) / 10;
  return { objects, diff, stars };
}

if (typeof module !== 'undefined') module.exports = { analyzeMono, generateMap, DIFFS, hitWindows, makeFFT, rng, hashStr, bez, PF_W, PF_H };
