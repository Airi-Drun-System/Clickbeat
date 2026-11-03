'use strict';
const $ = (id) => document.getElementById(id);
let COLORS = ['#FF4D8D', '#7C5CFF', '#29D3C0', '#FFB23F']; // цвета связок: на каждую песню свои, из обложки
const AN_VER = 2; // версия разбора: старые песни переразбираются новым алгоритмом
const MODS = [
  { id: 'EZ', name: 'Легче', mult: 0.5, off: ['HR'] },
  { id: 'HT', name: 'Медленнее', mult: 0.3, off: ['DT'] },
  { id: 'DT', name: 'Быстрее', mult: 1.12, off: ['HT'] },
  { id: 'HD', name: 'Скрытые', mult: 1.06 },
  { id: 'HR', name: 'Жёстче', mult: 1.06, off: ['EZ'] },
  { id: 'NF', name: 'Без поражения', mult: 0.5 },
];

// ---------- хранилище: всё в try/catch, без него игра тоже работает ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
const settings = Object.assign({ music: 0.8, sfx: 0.6, offset: 0, dim: 0.65, cursor: 1, trail: 0.5, quality: 'auto' }, store.get('hw.settings', {}));
const saveSettings = () => store.set('hw.settings', settings);

const DB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('hitwave', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('songs', mode);
      const req = fn(t.objectStore('songs'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => tx('readonly', (s) => s.getAll()).catch(() => []),
    put: (v) => tx('readwrite', (s) => s.put(v)).catch(() => {}),
    del: (id) => tx('readwrite', (s) => s.delete(id)).catch(() => {}),
  };
})();

// ---------- звук ----------
let actx = null, musicGain, sfxGain, analyser, freq, sfx = {};
function ensureAudio() {
  if (actx) { if (actx.state === 'suspended' && !paused) actx.resume(); return actx; }
  actx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  musicGain = actx.createGain();
  sfxGain = actx.createGain();
  analyser = actx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.75;
  freq = new Uint8Array(analyser.frequencyBinCount);
  musicGain.connect(analyser);
  analyser.connect(actx.destination);
  sfxGain.connect(actx.destination);
  applyVolumes();
  // звуки ударов синтезируем сами: короткий тон и щелчок шума
  const make = (dur, fn) => {
    const b = actx.createBuffer(1, Math.ceil(dur * actx.sampleRate), actx.sampleRate);
    const d = b.getChannelData(0);
    let prev = 0;
    for (let i = 0; i < d.length; i++) { const x = i / actx.sampleRate; const n = Math.random() * 2 - 1; d[i] = fn(x, n - prev); prev = n; }
    return b;
  };
  sfx.hit = make(0.09, (x, hn) => (0.5 * Math.sin(2 * Math.PI * 1180 * x) * Math.exp(-x * 60) + 0.35 * Math.sin(2 * Math.PI * 240 * x) * Math.exp(-x * 45) + 0.25 * hn * Math.exp(-x * 120)));
  sfx.end = make(0.08, (x, hn) => (0.4 * Math.sin(2 * Math.PI * 1720 * x) * Math.exp(-x * 70) + 0.2 * hn * Math.exp(-x * 140)));
  sfx.brk = make(0.18, (x) => 0.55 * Math.sin(2 * Math.PI * (150 - 260 * x) * x) * Math.exp(-x * 18));
  sfx.spin = make(0.06, (x) => 0.3 * Math.sin(2 * Math.PI * 2400 * x) * Math.exp(-x * 70));
  return actx;
}
function applyVolumes() {
  if (!actx) return;
  musicGain.gain.value = settings.music;
  sfxGain.gain.value = settings.sfx;
}
function play(name, x) {
  if (!actx || !sfx[name]) return;
  const s = actx.createBufferSource();
  s.buffer = sfx[name];
  if (actx.createStereoPanner && x !== undefined) {
    const p = actx.createStereoPanner();
    p.pan.value = (x / PF_W - 0.5) * 0.7; // звук идёт с той стороны, где нота
    s.connect(p); p.connect(sfxGain);
  } else s.connect(sfxGain);
  s.start();
}

// ---------- демо-трек: синтезируем сэмплы прямо в коде, чтобы играть можно было сразу ----------
function makeDemoSamples() {
  const sr = 44100, bpm = 128, beat = 60 / bpm, bars = 44;
  const len = Math.ceil((1 + bars * 4 * beat + 2) * sr);
  const out = new Float32Array(len);
  let seed = 99;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 1073741823.5 - 1;
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const add = (t, dur, fn) => { const s0 = Math.floor(t * sr), n = Math.floor(dur * sr); for (let i = 0; i < n && s0 + i < len; i++) out[s0 + i] += fn(i / sr); };
  const kick = (t) => { let ph = 0; add(t, 0.38, (x) => { ph += (45 + 105 * Math.exp(-x * 25)) / sr; return 0.9 * Math.sin(2 * Math.PI * ph) * Math.exp(-x * 9); }); };
  const snare = (t) => { let lp = 0; add(t, 0.2, (x) => { const n = rnd(); lp += (n - lp) * 0.35; return (0.45 * (n - lp) + 0.25 * Math.sin(2 * Math.PI * 185 * x)) * Math.exp(-x * 22); }); };
  const hat = (t, v) => { let prev = 0; add(t, 0.05, (x) => { const n = rnd(), h = n - prev; prev = n; return v * h * Math.exp(-x * 70); }); };
  const synth = (t, f, dur, v, shape, cut) => { let lp = 0; const k = 1 - Math.exp(-2 * Math.PI * cut / sr); add(t, dur, (x) => { const ph = (f * x) % 1; const w = shape === 'saw' ? 2 * ph - 1 : shape === 'sq' ? (ph < 0.5 ? 1 : -1) : 1 - 4 * Math.abs(ph - 0.5); lp += (w - lp) * k; const e = Math.min(1, x / 0.006) * Math.exp(-x * 3 / dur); return v * lp * e; }); };
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  for (let bar = 0; bar < bars; bar++) {
    const t0 = 1 + bar * 4 * beat, ch = chords[bar % 4];
    const intro = bar < 8, brk = bar >= 24 && bar < 32, drop = bar >= 32;
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * beat;
      if (!intro && !brk) kick(t);
      if (!intro && !brk && (b === 1 || b === 3)) snare(t);
      hat(t + beat / 2, intro ? 0.12 : 0.2);
      if (drop) hat(t + beat * 0.75, 0.1);
      if (!intro) synth(t + beat / 2, hz(ch[0] - 24), beat * 0.45, 0.32, 'saw', 420);
    }
    // арпеджио: восьмыми в куплете, шестнадцатыми в брейке и дропе
    if (bar >= 8) for (let k = 0; k < 16; k++) {
      if (!drop && !brk && k % 2) continue;
      synth(t0 + k * beat / 4, hz(ch[k % 3] + 12 + (k % 8 === 7 ? 12 : 0)), beat * 0.22, drop ? 0.12 : 0.09, 'sq', 2400);
    }
    for (const n of ch) synth(t0, hz(n), beat * 3.8, intro || brk ? 0.1 : 0.05, 'tri', 1600);
  }
  let peak = 0;
  for (let i = 0; i < len; i++) { out[i] = Math.tanh(out[i] * 1.2); peak = Math.max(peak, Math.abs(out[i])); }
  for (let i = 0; i < len; i++) out[i] *= 0.85 / peak;
  return { data: out, sr };
}
function makeDemo() {
  const { data, sr } = makeDemoSamples();
  const buf = new AudioBuffer({ length: data.length, sampleRate: sr, numberOfChannels: 1 });
  buf.copyToChannel(data, 0);
  // для разбора хватит половинной частоты: усредняем соседние сэмплы
  const mono = new Float32Array(data.length >> 1);
  for (let i = 0; i < mono.length; i++) mono[i] = (data[2 * i] + data[2 * i + 1]) / 2;
  return { buf, mono, sr: sr / 2 };
}

// ---------- песни ----------
const songs = [];            // {id, name, blob?, buffer?, an?, demo?}
const maps = new Map();      // id|diff -> карта
let selId = store.get('hw.sel', 'demo');
let selDiff = store.get('hw.diff', 1);

async function decode(ab) {
  const off = new OfflineAudioContext(1, 1, 44100);
  return off.decodeAudioData(ab);
}
async function toMono(buffer) {
  const sr = 22050;
  const off = new OfflineAudioContext(1, Math.ceil(buffer.duration * sr), sr);
  const s = off.createBufferSource();
  s.buffer = buffer; s.connect(off.destination); s.start();
  return { mono: (await off.startRendering()).getChannelData(0), sr };
}
function showLoading(title, text, p) {
  $('loading').hidden = false;
  $('loadTitle').textContent = title;
  $('loadText').textContent = text;
  $('loadBar').style.width = Math.round((p || 0) * 100) + '%';
}
async function analyzeBuffer(buffer, title) {
  showLoading(title, 'Ищу удары и темп…', 0.02);
  const { mono, sr } = await toMono(buffer);
  const an = await analyzeMono(mono, sr, (p) => showLoading(title, p < 0.88 ? 'Ищу удары и темп…' : 'Строю сетку битов…', p));
  $('loading').hidden = true;
  return an;
}
const fmtDur = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const cleanName = (n) => n.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || 'Без названия';

// ---------- теги mp3: название, исполнитель и обложка из ID3 ----------
async function readTags(file) {
  const out = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out;
    const ver = head[3];
    const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
    const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const size = syncsafe(head, 6);
    const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    if (ver < 3) return out; // ID3v2.2 почти не встречается
    let p = 0;
    if (head[5] & 0x40) p = ver === 4 ? syncsafe(buf, 0) : be32(buf, 0) + 4;
    const text = (b) => {
      const enc = b[0], body = b.subarray(1);
      const dec = new TextDecoder(enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : enc === 3 ? 'utf-8' : 'latin1');
      return dec.decode(body).replace(/\0+$/g, '').split('\0')[0].trim();
    };
    while (p + 10 < buf.length) {
      const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fsz = ver === 4 ? syncsafe(buf, p + 4) : be32(buf, p + 4);
      const start = p + 10, data = buf.subarray(start, start + fsz);
      if (id === 'TIT2') out.title = text(data);
      else if (id === 'TPE1') out.artist = text(data);
      else if (id === 'APIC' && !out.cover) {
        const enc = data[0];
        let q = 1, mime = '';
        while (q < data.length && data[q]) mime += String.fromCharCode(data[q++]);
        q += 2; // ноль и тип картинки
        if (enc === 1 || enc === 2) { while (q + 1 < data.length && (data[q] || data[q + 1])) q += 2; q += 2; } else { while (q < data.length && data[q]) q++; q++; }
        out.cover = new Blob([data.slice(q)], { type: /\//.test(mime) ? mime : 'image/jpeg' });
      }
      p = start + fsz;
    }
  } catch { /* битые теги — просто без них */ }
  return out;
}

// ---------- цвета песни: из обложки, как в музыкальных плеерах ----------
function hsl(h, s, l) { return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`; }
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, '0');
  return '#' + f(0) + f(8) + f(4);
}
function paletteFromHues(h1, h2) {
  // четыре цвета связок: два главных из обложки и два соседних по кругу
  const hs = [h1, h2, (h1 + 150) % 360, (h2 + 200) % 360];
  return hs.map((h) => hslToHex(h, 88, 64));
}
function paletteOf(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 32, 32);
    const d = x.getImageData(0, 0, 32, 32).data, bins = new Array(18).fill(0);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
      if (sat < 0.25 || mx < 0.2) continue;
      let h = 0;
      if (mx !== mn) h = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
      bins[Math.floor(((h * 60 + 360) % 360) / 20)] += sat * mx;
    }
    const order = bins.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    if (order[0][0] < 1) return null; // почти серая обложка
    const h1 = order[0][1] * 20 + 10;
    const second = order.find(([v, i]) => v > 0 && Math.min(Math.abs(i * 20 + 10 - h1), 360 - Math.abs(i * 20 + 10 - h1)) >= 50);
    return paletteFromHues(h1, second ? second[1] * 20 + 10 : (h1 + 60) % 360);
  } catch { return null; }
}
const paletteOfId = (id) => { const h = hashStr(id); return paletteFromHues(h % 360, (h % 360 + 70 + (h >> 9) % 80) % 360); };

// обложка для песни без картинки: своя генеративная картинка из колец-нот в цветах песни
function makeArt(song) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d'), pal = song.pal, R = rng(hashStr(song.id));
  x.fillStyle = '#101018'; x.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 3; i++) {
    const gr = x.createRadialGradient(R() * 512, R() * 512, 0, R() * 512, R() * 512, 300 + R() * 200);
    gr.addColorStop(0, pal[i] + 'cc'); gr.addColorStop(1, pal[i] + '00');
    x.fillStyle = gr; x.fillRect(0, 0, 512, 512);
  }
  for (let i = 0; i < 9; i++) {
    const cx = R() * 512, cy = R() * 512, r = 24 + R() * 70;
    x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = r * 0.14;
    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
    x.strokeStyle = pal[i % 4]; x.lineWidth = 3;
    x.beginPath(); x.arc(cx, cy, r * (1.4 + R()), 0, Math.PI * 2); x.stroke();
  }
  x.font = '900 120px "Dela Gothic One", "Arial Black", sans-serif';
  x.fillStyle = 'rgba(255,255,255,0.92)';
  x.textBaseline = 'alphabetic';
  x.fillText((song.name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase(), 30, 480);
  return c.toDataURL('image/jpeg', 0.85);
}

// картинка песни: из тегов, своя или сгенерированная; цвета берутся из неё
function songImage(song) {
  if (song.imgPromise) return song.imgPromise;
  song.imgPromise = new Promise((resolve) => {
    const blob = song.customBg || song.cover;
    if (!song.pal) song.pal = paletteOfId(song.id);
    const url = blob ? URL.createObjectURL(blob) : makeArt(song);
    const img = new Image();
    img.onload = () => { const p = blob ? paletteOf(img) : null; if (p) song.pal = p; song.img = img; song.imgUrl = url; resolve(img); };
    img.onerror = () => { song.imgUrl = makeArt(song); const i2 = new Image(); i2.onload = () => { song.img = i2; resolve(i2); }; i2.src = song.imgUrl; };
    img.src = url;
  });
  return song.imgPromise;
}

// ---------- слова: формат .lrc с метками [мм:сс.сс] ----------
function parseLRC(textIn) {
  const lines = [];
  let offset = 0;
  for (const raw of textIn.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) { offset = Number(off[1]); continue; }
    const tags = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim();
    for (const m of tags) {
      const frac = m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0;
      lines.push({ t: (Number(m[1]) * 60 + Number(m[2]) + frac) * 1000 - offset, text: words });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}


async function addFile(file) {
  if (!file) return;
  const id = 'f' + hashStr(`${file.name}|${file.size}|${file.lastModified}`).toString(36);
  if (songs.some((s) => s.id === id)) { select(id); return; }
  try {
    showLoading(cleanName(file.name), 'Открываю файл…', 0);
    const tags = await readTags(file);
    const name = tags.title ? tags.title : cleanName(file.name);
    const buffer = await decode(await file.arrayBuffer());
    const an = await analyzeBuffer(buffer, name);
    if (an.onsets.length < 20) throw new Error('В этом треке почти нет ударов, уровень не построить.');
    const song = { id, name, artist: tags.artist || '', cover: tags.cover || null, blob: file, an, anVer: AN_VER, added: Date.now() };
    await DB.put(song);
    song.buffer = buffer;
    $('loading').hidden = true;
    songs.splice(1, 0, song);
    select(id);
    if (tags.title) findLyrics(song, true).then((ok) => { if (ok && plSong === song) renderLines(); }); // слова подтянутся сами, если найдутся
    if (plOpen() && !plSong) plLoad(song, true); else plUpText();
  } catch (e) {
    showLoading('Не получилось', e.message && !/decode/i.test(e.message) ? e.message : 'Браузер не смог прочитать этот файл. Попробуй mp3, ogg или wav.', 0);
    setTimeout(() => { $('loading').hidden = true; }, 3200);
  }
}
async function addFiles(list) { for (const f of list) await addFile(f); } // по одной: разбор тяжёлый
$('file').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
for (const ev of ['dragenter', 'dragover']) window.addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) window.addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); });
window.addEventListener('drop', (e) => { addFiles([...(e.dataTransfer?.files || [])].filter((x) => /^audio\//.test(x.type) || /\.(mp3|ogg|wav|flac|m4a)$/i.test(x.name))); });

function getMap(song, d) {
  const key = song.id + '|' + d;
  if (!maps.has(key) && song.an) maps.set(key, generateMap(song.an, DIFFS[d], hashStr(song.id)));
  return maps.get(key);
}
const bestOf = (id, d) => store.get(`hw.best.${id}.${d}`, null);

const saveSong = (song) => { const { buffer, img, imgUrl, imgPromise, ...rec } = song; if (!song.demo) DB.put(rec); };
let mods = new Set(store.get('hw.mods', []));

function select(id) {
  selId = id;
  store.set('hw.sel', id);
  renderSongs();
  renderHero(true);
}
// цвета песни на весь интерфейс
function applyPalette(song) {
  COLORS = song.pal || paletteOfId(song.id);
  const r = document.documentElement.style;
  r.setProperty('--a1', COLORS[0]); r.setProperty('--a2', COLORS[1]); r.setProperty('--a3', COLORS[2]);
  const n = parseInt(COLORS[0].slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  r.setProperty('--on-a1', lum > 0.62 ? '#16070C' : '#FFFFFF');
  if (song.an) r.setProperty('--beat', (song.an.period / 1000).toFixed(3) + 's');
  spriteCache.clear();
}
async function renderHero(swap) {
  const song = songs.find((s) => s.id === selId);
  if (!song) return;
  const info = $('info');
  if (swap) { info.classList.remove('swap'); void info.offsetWidth; info.classList.add('swap'); }
  $('hTitle').textContent = song.name;
  $('hArtist').textContent = song.demo ? 'Встроенный трек Clickbeat' : song.artist || 'Твой трек';
  const chips = $('hChips');
  chips.textContent = '';
  const chip = (t, a) => { const c = document.createElement('span'); c.className = 'chip' + (a ? ' a' : ''); c.textContent = t; chips.appendChild(c); };
  if (song.an) { chip(`${song.an.bpm} BPM`, true); chip(fmtDur(song.an.duration)); }
  if (song.lyrics && song.lyrics.length) chip('со словами');
  $('bgBtn').classList.toggle('set', !!song.customBg);
  $('bgBtn').textContent = song.customBg ? 'Картинка: убрать' : 'Своя картинка';
  $('lrcBtn').classList.toggle('set', !!(song.lyrics && song.lyrics.length));
  $('lrcBtn').textContent = song.lyrics && song.lyrics.length ? 'Слова: убрать' : window.cbApp ? 'Найти слова' : 'Слова (.lrc)';
  document.querySelector('.extras').hidden = !!song.demo;
  renderDiffs();
  renderMods();
  await songImage(song);
  if (selId !== song.id) return;
  applyPalette(song);
  $('coverImg').src = song.imgUrl;
  $('bgImg').style.backgroundImage = `url("${song.imgUrl}")`;
  renderSongs();
}
function renderSongs() {
  const box = $('songs');
  const keep = box.scrollTop;
  box.textContent = '';
  if (!songs.some((s) => s.id === selId)) selId = songs[0] && songs[0].id;
  songs.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'song' + (s.id === selId ? ' on' : '');
    el.style.setProperty('--i', i);
    el.tabIndex = 0;
    el.innerHTML = '<img alt=""><b></b><span></span><small></small>';
    const img = el.querySelector('img');
    if (s.imgUrl) img.src = s.imgUrl; else songImage(s).then(() => { img.src = s.imgUrl; });
    el.querySelector('b').textContent = s.name;
    el.querySelector('small').textContent = s.an ? `${s.artist ? s.artist + ' · ' : ''}${s.an.bpm} BPM · ${fmtDur(s.an.duration)}` : 'Готовлю…';
    if (!s.demo) {
      const del = document.createElement('button');
      del.className = 'del';
      del.title = 'Убрать песню';
      del.textContent = '×';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!del.classList.contains('sure')) { del.classList.add('sure'); del.textContent = 'Убрать?'; setTimeout(() => { del.classList.remove('sure'); del.textContent = '×'; }, 2500); return; }
        await DB.del(s.id);
        songs.splice(songs.indexOf(s), 1);
        renderSongs(); renderHero(true);
      });
      el.replaceChild(del, el.children[2]);
    } else el.children[2].remove();
    el.addEventListener('click', () => { if (selId !== s.id) select(s.id); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { select(s.id); startGame(); } });
    el.addEventListener('dblclick', () => startGame());
    box.appendChild(el);
  });
  box.scrollTop = keep;
}
function renderDiffs() {
  const song = songs.find((s) => s.id === selId);
  const box = $('diffs');
  box.textContent = '';
  DIFFS.forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'diff' + (i === selDiff ? ' on' : '');
    const m = song && song.an && getMap(song, i);
    const best = song && bestOf(song.id, i);
    b.innerHTML = '<b></b><small></small><span class="grade"></span>';
    b.querySelector('b').textContent = d.name;
    b.querySelector('small').textContent = m ? `★ ${m.stars.toFixed(1)} · ${m.objects.length} нот` : '…';
    if (best) { b.querySelector('.grade').textContent = best.grade; b.querySelector('.grade').style.color = GRADE[best.grade][0]; b.title = `Рекорд: ${best.score.toLocaleString('ru-RU')}, ${(best.acc * 100).toFixed(1)}%`; }
    b.addEventListener('click', () => { selDiff = i; store.set('hw.diff', i); renderDiffs(); });
    box.appendChild(b);
  });
  $('playBtn').disabled = $('watchBtn').disabled = !song || !song.an;
}
function renderMods() {
  const box = $('mods');
  box.textContent = '';
  let mult = 1;
  for (const m of MODS) {
    const b = document.createElement('button');
    b.className = 'mod' + (mods.has(m.id) ? ' on' : '');
    b.innerHTML = '<span></span> <small></small>';
    b.firstChild.textContent = m.name;
    b.lastChild.textContent = '×' + m.mult;
    b.addEventListener('click', () => {
      if (mods.has(m.id)) mods.delete(m.id); else { mods.add(m.id); (m.off || []).forEach((o) => mods.delete(o)); }
      store.set('hw.mods', [...mods]);
      renderMods();
    });
    if (mods.has(m.id)) mult *= m.mult;
    box.appendChild(b);
  }
  const t = document.createElement('span');
  t.className = 'chip';
  t.textContent = `очки ×${mult.toFixed(2)}`;
  box.appendChild(t);
}

// песни, разобранные старой версией, переразбираются один раз при запуске
async function ensureFresh(song) {
  if (song.demo || song.anVer === AN_VER) return true;
  try {
    if (!song.buffer) song.buffer = await decode(await song.blob.arrayBuffer());
    song.an = await analyzeBuffer(song.buffer, song.name);
    song.anVer = AN_VER;
    for (let d = 0; d < DIFFS.length; d++) maps.delete(song.id + '|' + d);
    saveSong(song);
    return true;
  } catch { $('loading').hidden = true; return false; }
}

// своя картинка и слова для выбранной песни
$('bgBtn').addEventListener('click', () => {
  const song = songs.find((s) => s.id === selId);
  if (song.customBg) { song.customBg = null; song.imgPromise = null; song.pal = null; saveSong(song); renderHero(false); }
  else $('imgFile').click();
});
$('imgFile').addEventListener('change', (e) => {
  const f = e.target.files[0], song = songs.find((s) => s.id === selId);
  e.target.value = '';
  if (!f || !song) return;
  song.customBg = f; song.imgPromise = null; song.pal = null;
  saveSong(song);
  renderHero(false);
});
// в программе для Windows слова ищутся сами на lrclib.net; в браузере — только из файла
async function findLyrics(song, quiet) {
  if (!window.cbApp || !song.an) return false;
  try {
    const r = await window.cbApp.findLyrics({ title: song.name, artist: song.artist || '', duration: Math.round(song.an.duration / 1000) });
    const lines = r && r.synced ? parseLRC(r.synced) : [];
    if (!lines.length) { if (r && r.plain) { song.plain = r.plain; saveSong(song); } return false; }
    song.lyrics = lines;
    saveSong(song);
    if (selId === song.id) renderHero(false);
    return true;
  } catch { return false; } finally { if (!quiet) $('loading').hidden = true; }
}
$('lrcBtn').addEventListener('click', async () => {
  const song = songs.find((s) => s.id === selId);
  if (song.lyrics && song.lyrics.length) { song.lyrics = null; saveSong(song); renderHero(false); return; }
  if (window.cbApp) {
    showLoading('Ищу слова', `«${song.name}» на lrclib.net…`, 0.5);
    if (await findLyrics(song)) return;
    showLoading('Слова не нашлись', 'Выбери файл .lrc сам: его можно скачать на lrclib.net по названию песни.', 0);
    setTimeout(() => { $('loading').hidden = true; $('lrcFile').click(); }, 1800);
    return;
  }
  $('lrcFile').click();
});
$('lrcFile').addEventListener('change', async (e) => {
  const f = e.target.files[0], song = songs.find((s) => s.id === selId);
  e.target.value = '';
  if (!f || !song) return;
  const lines = parseLRC(await f.text());
  if (!lines.length) { showLoading('Не те слова', 'В файле нет меток времени вида [01:23.45]. Нужен файл .lrc — его можно найти на lrclib.net по названию песни.', 0); setTimeout(() => { $('loading').hidden = true; }, 4500); return; }
  song.lyrics = lines;
  saveSong(song);
  renderHero(false);
  if (plSong === song) renderLines();
});

async function loadLibrary() {
  songs.push({ id: 'demo', name: 'Neon Steps', demo: true });
  const saved = (await DB.all()).sort((a, b) => b.added - a.added);
  songs.push(...saved);
  renderSongs();
  // демо собираем и разбираем в фоне, пока человек смотрит меню
  renderHero(true);
  const demo = songs[0];
  const { buf, mono, sr } = makeDemo();
  demo.buffer = buf;
  demo.an = await analyzeMono(mono, sr);
  renderSongs(); renderHero(false);
}

// ==================== игра ====================
const cv = $('cv'), g0 = cv.getContext('2d');
let g = g0;
let W = 0, H = 0, DPR = 1;
// качество графики: на слабом устройстве игра сама гасит свечение и снижает чёткость, чтобы держать FPS
const touchDevice = matchMedia('(pointer: coarse)').matches;
const fx = { level: settings.quality === 'low' ? 2 : 0 };
let frameTimes = [];
function qualityTick(dt) {
  if (settings.quality !== 'auto' || state !== 'play' || paused) return;
  frameTimes.push(dt);
  if (frameTimes.length < 90) return;
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  frameTimes = [];
  if (avg > 21 && fx.level < 2) { fx.level++; resize(); }
}
const GLOW = (v) => (fx.level ? 0 : v);
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  if (fx.level >= 2) DPR = 1; else if (touchDevice) DPR = Math.min(DPR, 1.5);
  W = innerWidth; H = innerHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  g0.setTransform(DPR, 0, 0, DPR, 0, 0);
  spriteCache.clear();
  bgFor = '';
  if (game) prepBackground(game.song);
}
addEventListener('resize', resize);

let state = 'menu'; // menu | play | results
let game = null, paused = false, src = null, songStart = 0, lastCt = 0, lastPerf = 0, rate = 1;
const mouse = { x: innerWidth / 2, y: innerHeight / 2 }, trail = [];
let held = 0;
const heldKeys = new Set();
const keysUI = [{ label: 'Z', down: false, n: 0, t: -1e9 }, { label: 'X', down: false, n: 0, t: -1e9 }];
const ripples = [];
function keyState(i, down) {
  const k = keysUI[i];
  if (down && !k.down) { k.n++; k.t = performance.now(); ripples.push({ x: mouse.x, y: mouse.y, t: performance.now() }); }
  k.down = down;
}

function field() {
  // на низком экране (телефон боком) поле занимает почти всю высоту
  const vy = H < 560 ? 56 : 150, vx = W < 900 ? 150 : 80;
  const s = Math.min((W - vx) / PF_W, (H - vy) / PF_H);
  return { s, ox: (W - PF_W * s) / 2, oy: (H - PF_H * s) / 2 + (H < 560 ? 8 : 14) };
}
function songTime() {
  const ct = actx.currentTime, now = performance.now();
  if (ct !== lastCt) { lastCt = ct; lastPerf = now; }
  const est = ct + (actx.state === 'running' ? Math.min(0.04, (now - lastPerf) / 1000) : 0);
  return (est - (actx.outputLatency || 0) - songStart) * 1000 * rate - settings.offset;
}
function startAudio(fromMs) {
  if (src) { try { src.stop(); } catch { /* уже остановлен */ } }
  src = actx.createBufferSource();
  src.buffer = game.song.buffer;
  src.playbackRate.value = rate;
  src.connect(musicGain);
  const when = actx.currentTime + 0.08;
  songStart = when - fromMs / 1000 / rate;
  src.start(Math.max(when, songStart), Math.max(0, fromMs / 1000));
}

async function startGame(auto) {
  if (auto !== true) auto = false;
  if (!auto && !store.get('hw.tut', false)) { openHowto(true); return; }
  plAudio.pause();
  const song = songs.find((s) => s.id === selId);
  if (!song || !song.an) return;
  ensureAudio();
  if (actx.state === 'suspended') await actx.resume();
  if (!song.buffer) {
    showLoading(song.name, 'Загружаю трек…', 0.3);
    try { song.buffer = await decode(await song.blob.arrayBuffer()); } catch { showLoading('Не получилось', 'Файл песни испорчен или удалён из браузера.', 0); setTimeout(() => { $('loading').hidden = true; }, 3000); return; }
    $('loading').hidden = true;
  }
  if (!(await ensureFresh(song))) return;
  const map = getMap(song, selDiff);
  if (!map || !map.objects.length) return;
  // моды меняют размер нот, скорость появления, окна попадания и жизнь
  const diff = { ...DIFFS[selDiff] };
  let mult = 1;
  for (const m of MODS) if (mods.has(m.id)) mult *= m.mult;
  if (mods.has('EZ')) { diff.r *= 1.3; diff.od *= 0.5; diff.ar *= 1.25; diff.drain *= 0.5; }
  if (mods.has('HR')) { diff.r *= 0.78; diff.od = Math.min(10, diff.od * 1.4); diff.ar *= 0.8; diff.drain *= 1.4; }
  rate = mods.has('DT') ? 1.5 : mods.has('HT') ? 0.75 : 1;
  diff.spin /= rate;
  const objs = map.objects.map((o) => ({ ...o }));
  if (mods.has('HR')) for (const o of objs) { o.y = PF_H - o.y; if (o.pts) o.pts = o.pts.map((q) => ({ ...q, y: PF_H - q.y })); }
  applyPalette(song);
  prepBackground(song);
  const last = objs[objs.length - 1];
  game = {
    song, diff, objs, win: hitWindows(diff.od), first: 0,
    score: 0, combo: 0, maxCombo: 0, hp: 1, counts: { 300: 0, 100: 0, 50: 0, 0: 0 }, judged: 0, accSum: 0,
    errors: [], popups: [], lastT: -1e9, comboPop: 0, failed: false, failT: 0, endT: (last.end || last.t) + 1300,
    shownScore: 0, mult, auto, hidden: mods.has('HD'), nofail: mods.has('NF'), lyric: 0,
    modsText: MODS.filter((m) => mods.has(m.id)).map((m) => m.name).join(', '),
  };
  paused = false;
  state = 'play';
  keysUI.forEach((k) => { k.n = 0; k.down = false; });
  fingers.clear(); held = 0; frameTimes = [];
  document.body.classList.add('playing');
  document.body.classList.remove('results');
  $('menu').hidden = true; $('results').hidden = true; $('pause').hidden = true;
  musicGain.gain.cancelScheduledValues(actx.currentTime);
  applyVolumes();
  startAudio(Math.min(0, objs[0].t - diff.ar - 1500));
}

function judge(o, res, t, delta) {
  const G = game;
  o.judged = true; o.res = res; o.hitT = t;
  G.counts[res]++;
  G.judged++;
  G.accSum += res;
  if (res > 0) {
    G.combo++;
    G.maxCombo = Math.max(G.maxCombo, G.combo);
    G.score += Math.round(res * (1 + Math.min(G.combo, 400) / 25) * G.mult);
    G.hp = Math.min(1, G.hp + (res === 300 ? 0.06 : res === 100 ? 0.025 : 0.008));
    G.comboPop = t;
    if (delta !== undefined) G.errors.push({ d: delta, t });
  } else {
    if (G.combo >= 10) play('brk');
    G.combo = 0;
    G.hp -= 0.08 + G.diff.drain * 2;
  }
  const p = o.type === 's' ? o.pts[o.pts.length - 1] : o;
  if (res !== 300) G.popups.push({ x: p.x, y: p.y, res, t });
}
function breakCombo(x, y, t) {
  const G = game;
  if (G.combo >= 10) play('brk');
  G.combo = 0;
  G.hp -= 0.04;
  G.popups.push({ x, y, res: 0, t });
}

function sliderPos(o, t) {
  const u = Math.max(0, Math.min(1, (t - o.t) / (o.end - o.t)));
  const target = u * o.len, pts = o.pts;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].l >= target) {
      const a = pts[i - 1], b = pts[i], k = (target - a.l) / Math.max(1e-6, b.l - a.l);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
}
function cursorPF() { const f = field(); return { x: (mouse.x - f.ox) / f.s, y: (mouse.y - f.oy) / f.s }; }

function press() {
  if (state !== 'play' || paused || !game || game.failed) return;
  const G = game, t = songTime(), c = cursorPF(), r = G.diff.r;
  // строго по очереди, как в классике: нажатие относится к самой ранней ноте
  let o = null;
  for (let i = G.first; i < G.objs.length; i++) {
    const x = G.objs[i];
    if (x.t - G.diff.ar > t) break;
    if ((x.type === 'c' && !x.judged) || (x.type === 's' && !x.headDone)) { o = x; break; }
  }
  if (!o) return;
  const d = t - o.t, w = G.win;
  if (Math.hypot(c.x - o.x, c.y - o.y) > r * (inputTouch ? 1.3 : 1.05)) { // пальцем попасть труднее: допуск шире
    // нажал вовремя, но курсор не на круге — подсказываем, без штрафа
    if (Math.abs(d) <= w.w50 + 120) G.popups.push({ x: c.x, y: c.y, txt: 'Мимо круга', col: '#FFC24B', t });
    return;
  }
  if (d < -w.w50) { // слишком рано: нота дрожит, без штрафа
    o.shakeT = t;
    if (!o.earlyShown || t - o.earlyShown > 300) { o.earlyShown = t; G.popups.push({ x: o.x, y: o.y, txt: 'Рано, жди кольцо', col: '#FFC24B', t }); }
    return;
  }
  const ad = Math.abs(d);
  const res = ad <= w.w300 ? 300 : ad <= w.w100 ? 100 : ad <= w.w50 ? 50 : 0;
  if (o.type === 'c') { judge(o, res, t, d); if (res) play('hit', o.x); }
  else {
    o.headDone = true; o.headHit = res > 0; o.hitT = t;
    if (res) { G.combo++; G.maxCombo = Math.max(G.maxCombo, G.combo); G.score += 30; G.comboPop = t; G.errors.push({ d, t }); play('hit', o.x); G.hp = Math.min(1, G.hp + 0.02); }
    else breakCombo(o.x, o.y, t);
  }
}

function update(t, dt) {
  const G = game, w = G.win, r = G.diff.r, c = cursorPF();
  const holding = held > 0;
  for (let i = G.first; i < G.objs.length; i++) {
    const o = G.objs[i];
    if (o.t - G.diff.ar > t) break;
    if (o.type === 'c') {
      if (!o.judged && t > o.t + w.w50) judge(o, 0, t);
    } else if (o.type === 's') {
      if (!o.headDone && t > o.t + w.w50) { o.headDone = true; o.headHit = false; breakCombo(o.x, o.y, t); }
      if (!o.judged && t >= o.t) {
        const b = sliderPos(o, t);
        const inside = Math.hypot(c.x - b.x, c.y - b.y) <= (o.tracking ? r * 2.4 : r * (inputTouch ? 1.4 : 1.05));
        o.tracking = holding && inside;
        if (o.tracking) o.tracked = (o.tracked || 0) + dt;
        if (o.tracking) o.lastTrack = t;
        if (t >= o.end) {
          const ratio = (o.tracked || 0) / Math.max(1, o.end - o.t);
          const endOk = o.lastTrack !== undefined && t - o.lastTrack < 80;
          const parts = (o.headHit ? 1 : 0) + (ratio >= 0.5 ? 1 : 0) + (endOk ? 1 : 0) + (ratio >= 0.9 ? 1 : 0);
          const res = parts >= 4 ? 300 : parts >= 3 ? 100 : parts >= 1 ? 50 : 0;
          judge(o, res, t);
          if (endOk) play('end', o.pts[o.pts.length - 1].x);
        }
      }
    } else if (o.type === 'p') {
      if (!o.judged && t >= o.t) {
        const f = field();
        const ang = Math.atan2(mouse.y - (f.oy + PF_H / 2 * f.s), mouse.x - (f.ox + PF_W / 2 * f.s));
        if (holding && o.lastAng !== undefined) {
          let d = ang - o.lastAng;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          d = Math.max(-0.6, Math.min(0.6, d)); // не больше ~6 оборотов в секунду
          o.acc = (o.acc || 0) + Math.abs(d);
          o.spinV = Math.abs(d) / Math.max(1, dt) * 1000;
          const need = (o.end - o.t) / 1000 * G.diff.spin * Math.PI * 2;
          const turns = Math.floor((o.acc - need) / (Math.PI * 2));
          if (turns > (o.bonus || 0)) { o.bonus = turns; G.score += 100; play('spin'); }
        }
        o.lastAng = ang;
        if (t >= o.end) {
          const ratio = (o.acc || 0) / ((o.end - o.t) / 1000 * G.diff.spin * Math.PI * 2);
          judge(o, ratio >= 1 ? 300 : ratio >= 0.75 ? 100 : ratio >= 0.4 ? 50 : 0, t);
          if (ratio >= 0.4) play('end');
        }
      }
    }
  }
  while (G.first < G.objs.length && G.objs[G.first].judged && t > (G.objs[G.first].end || G.objs[G.first].t) + 400) G.first++;

  // жизнь тает, пока идут ноты; в длинных паузах не тает
  const next = G.objs[G.first];
  const active = next && next.t - t < 2500 && t > G.objs[0].t - 500;
  if (active) G.hp -= G.diff.drain * dt / 1000;
  G.hp = Math.max(0, Math.min(1, G.hp));
  if (G.hp <= 0 && !G.nofail && !G.auto && !G.failed) fail(t);
  if (!G.failed && t > G.endT) finish();
}

function fail() {
  const G = game;
  G.failed = true;
  G.failT = performance.now();
  // музыка «сдувается» вниз, как пластинка
  const now = actx.currentTime;
  src.playbackRate.setValueAtTime(1, now);
  src.playbackRate.linearRampToValueAtTime(0.25, now + 1.4);
  musicGain.gain.setValueAtTime(settings.music, now);
  musicGain.gain.linearRampToValueAtTime(0.0001, now + 1.5);
  setTimeout(() => showResults(true), 1600);
}
function finish() {
  const now = actx.currentTime;
  musicGain.gain.setValueAtTime(settings.music, now);
  musicGain.gain.linearRampToValueAtTime(0.0001, now + 1.2);
  showResults(false);
}

const GRADE = { SS: ['#FFE2A8'], S: ['#FFAE1F'], A: ['#B7F04A'], B: ['#2FD3F5'], C: ['#FF4FA8'], D: ['#FF4B3A'], F: ['#8A8F9C'] };
function gradeOf(G, failed) {
  const acc = G.judged ? G.accSum / (300 * G.judged) : 0;
  if (failed) return 'F';
  if (acc === 1) return 'SS';
  if (acc > 0.95 && !G.counts[0]) return 'S';
  if (acc > 0.9) return 'A';
  if (acc > 0.8) return 'B';
  if (acc > 0.7) return 'C';
  return 'D';
}
function showResults(failed) {
  const G = game;
  state = 'results';
  document.body.classList.remove('playing');
  document.body.classList.add('results');
  const total = G.objs.length;
  const acc = G.judged ? G.accSum / (300 * G.judged) : 0;
  const grade = gradeOf(G, failed);
  $('rGrade').textContent = grade;
  $('rGrade').style.setProperty('--gc', GRADE[grade][0]);
  $('rTitle').textContent = [G.song.name, G.diff.name, G.modsText].filter(Boolean).join(' · ');
  $('rScore').textContent = G.score.toLocaleString('ru-RU');
  $('rAcc').textContent = (acc * 100).toFixed(2) + '%';
  $('rCombo').textContent = `${G.maxCombo} / ${total}`;
  $('rHits').textContent = `${G.counts[300]} / ${G.counts[100]} / ${G.counts[50]}`;
  $('rMiss').textContent = G.counts[0];
  const sub = $('rSub');
  sub.textContent = '';
  if (G.auto) { sub.className = 'newBest'; sub.textContent = 'Это была автоигра: так выглядит идеальное прохождение. Теперь попробуй сам.'; }
  else if (failed) { sub.className = 'newBest'; sub.textContent = `Шкала жизни кончилась на ${Math.round(G.judged / total * 100)}% песни`; }
  else {
    const best = bestOf(G.song.id, selDiff);
    if (!best || G.score > best.score) {
      store.set(`hw.best.${G.song.id}.${selDiff}`, { score: G.score, acc, grade, combo: G.maxCombo });
      if (best) { sub.className = 'newBest'; sub.textContent = `Новый рекорд, прошлый был ${best.score.toLocaleString('ru-RU')}`; }
    }
  }
  // подсказка по сдвигу звука: если человек стабильно жмёт раньше или позже
  const errs = G.errors.map((e) => e.d);
  const avg = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0;
  $('rHint').hidden = G.auto || !(errs.length >= 20 && Math.abs(avg) >= 10);
  if (!$('rHint').hidden) {
    $('rHintText').textContent = `Ты жмёшь в среднем на ${Math.round(Math.abs(avg))} мс ${avg < 0 ? 'раньше' : 'позже'} музыки. Подстроить сдвиг звука?`;
    $('rFix').onclick = () => { settings.offset = Math.max(-150, Math.min(150, Math.round(settings.offset + avg))); saveSettings(); $('rHint').hidden = true; };
  }
  $('results').hidden = false;
}

function stopGame() {
  if (src) { try { src.stop(); } catch { /* уже */ } src = null; }
  if (actx && actx.state === 'suspended') actx.resume();
  paused = false;
  game = null;
  state = 'menu';
  rate = 1;
  document.body.classList.remove('playing', 'results');
  if (songs.length) applyPalette(songs.find((s) => s.id === selId) || songs[0]);
  $('pause').hidden = true; $('results').hidden = true; $('countdown').hidden = true;
  $('menu').hidden = false;
  renderDiffs();
}
function pauseGame() {
  if (state !== 'play' || paused || game.failed) return;
  paused = true;
  actx.suspend();
  $('pause').hidden = false;
  document.body.classList.remove('playing');
}
let countTimer = 0;
function resumeGame() {
  $('pause').hidden = true;
  $('countdown').hidden = false;
  document.body.classList.add('playing');
  let n = 3;
  $('countNum').textContent = n;
  clearInterval(countTimer);
  countTimer = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(countTimer); $('countdown').hidden = true; paused = false; actx.resume(); return; }
    const el = $('countNum');
    el.textContent = n;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  }, 450);
}
function skipIntro() {
  if (state !== 'play' || paused || !game) return;
  const t = songTime(), first = game.objs[0];
  if (first.t - t > 3000) startAudio(first.t - game.diff.ar - 1200);
}

// ---------- ввод ----------
addEventListener('pointermove', (e) => {
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const c of evs.length ? evs : [e]) trail.push({ x: c.clientX, y: c.clientY, t: performance.now() });
  if (trail.length > 400) trail.splice(0, trail.length - 400);
  if (game && game.auto && state === 'play') return;
  mouse.x = e.clientX; mouse.y = e.clientY;
});
// касания: каждый палец — своё нажатие, курсор там, где палец
let inputTouch = false, lastTouch = 0;
const fingers = new Map(); // pointerId -> 0 / 1 (какой «пэд» подсвечивать)
cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') { if (inputTouch) { inputTouch = false; document.body.classList.remove('touch'); } return; }
  e.preventDefault();
  lastTouch = performance.now();
  if (!inputTouch) { inputTouch = true; document.body.classList.add('touch'); }
  if (state !== 'play' || paused || !game || game.auto) return;
  const idx = fingers.size ? 1 - [...fingers.values()][0] : 0;
  fingers.set(e.pointerId, idx);
  try { cv.setPointerCapture(e.pointerId); } catch { /* нет захвата — не страшно */ }
  mouse.x = e.clientX; mouse.y = e.clientY;
  keyState(idx, true);
  held++; press();
}, { passive: false });
const fingerUp = (e) => {
  if (!fingers.has(e.pointerId)) return;
  keyState(fingers.get(e.pointerId), false);
  fingers.delete(e.pointerId);
  held = Math.max(0, held - 1);
};
cv.addEventListener('pointerup', fingerUp);
cv.addEventListener('pointercancel', fingerUp);
addEventListener('mousedown', (e) => {
  if (performance.now() - lastTouch < 800) return; // мышиное эхо от касания
  if (state !== 'play' || paused || (e.button !== 0 && e.button !== 2) || (game && game.auto)) return;
  if (e.target !== cv) return;
  keyState(e.button === 2 ? 1 : 0, true);
  held++; press();
});
addEventListener('mouseup', (e) => { if (e.button === 0 || e.button === 2) { keyState(e.button === 2 ? 1 : 0, false); held = Math.max(0, held - 1); } });
addEventListener('contextmenu', (e) => { if (state === 'play') e.preventDefault(); });
addEventListener('keydown', (e) => {
  if (state === 'menu' && plOpen()) { plKey(e); return; }
  if (state === 'play') {
    if ((e.code === 'KeyZ' || e.code === 'KeyX') && !(game && game.auto)) { // по коду клавиши: работает и в русской раскладке
      e.preventDefault();
      if (e.repeat || heldKeys.has(e.code)) return;
      heldKeys.add(e.code); keyState(e.code === 'KeyX' ? 1 : 0, true); held++; press();
    } else if (e.code === 'Escape') { e.preventDefault(); if (paused) { if ($('countdown').hidden) resumeGame(); } else pauseGame(); }
    else if (e.code === 'Space') { e.preventDefault(); skipIntro(); }
  } else if (state === 'results') {
    if (e.code === 'Escape') stopGame();
    if (e.code === 'Enter' || e.code === 'KeyR') { stopGame(); startGame(); }
  } else if (state === 'menu' && e.code === 'Enter' && document.activeElement === document.body) startGame();
});
addEventListener('keyup', (e) => { if (heldKeys.delete(e.code)) { keyState(e.code === 'KeyX' ? 1 : 0, false); held = Math.max(0, held - 1); } });
addEventListener('blur', () => { heldKeys.clear(); held = 0; keysUI.forEach((k) => { k.down = false; }); if (state === 'play') pauseGame(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'play') pauseGame(); });

$('playBtn').addEventListener('click', () => startGame(false));
$('tPause').addEventListener('click', () => pauseGame());
$('tSkip').addEventListener('click', () => skipIntro());
addEventListener('resize', () => { if (state === 'play' && touchDevice && innerHeight > innerWidth) pauseGame(); });
$('watchBtn').addEventListener('click', () => startGame(true));
$('resumeBtn').addEventListener('click', resumeGame);
$('retryBtn').addEventListener('click', () => { const a = game && game.auto; stopGame(); startGame(a); });
$('quitBtn').addEventListener('click', stopGame);
$('rRetry').addEventListener('click', () => { const a = game && game.auto; stopGame(); startGame(a); });
$('rMenu').addEventListener('click', stopGame);
$('fsBtn').addEventListener('click', () => { const r = document.documentElement.requestFullscreen?.(); if (r) r.catch(() => {}); });

// ---------- настройки ----------
const SET = [
  ['sMusic', 'music', (v) => Math.round(v * 100) + '%'],
  ['sSfx', 'sfx', (v) => Math.round(v * 100) + '%'],
  ['sOffset', 'offset', (v) => (v > 0 ? '+' : '') + v + ' мс'],
  ['sDim', 'dim', (v) => Math.round(v * 100) + '%'],
  ['sCursor', 'cursor', (v) => '×' + Number(v).toFixed(1)],
  ['sTrail', 'trail', (v) => (v > 0 ? Math.round(v * 100) + '%' : 'выкл')],
];
$('sQuality').addEventListener('change', () => { settings.quality = $('sQuality').value; fx.level = settings.quality === 'low' ? 2 : 0; saveSettings(); resize(); });
for (const [id, key, fmt] of SET) {
  const el = $(id), out = $('o' + id.slice(1));
  el.addEventListener('input', () => { settings[key] = Number(el.value); out.textContent = fmt(settings[key]); applyVolumes(); saveSettings(); });
}

$('setBtn').addEventListener('click', () => {
  for (const [id, key, fmt] of SET) { $(id).value = settings[key]; $('o' + id.slice(1)).textContent = fmt(settings[key]); }
  $('sQuality').value = settings.quality;

  $('settings').hidden = false;
});
$('setClose').addEventListener('click', () => { $('settings').hidden = true; });
let howtoThenPlay = false;
function openHowto(thenPlay) { howtoThenPlay = thenPlay; $('howGo').textContent = thenPlay ? 'Понятно, играть' : 'Понятно'; $('howto').hidden = false; }
$('howBtn').addEventListener('click', () => openHowto(false));
$('howGo').addEventListener('click', () => { $('howto').hidden = true; store.set('hw.tut', true); if (howtoThenPlay) startGame(false); });
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });


// ==================== плеер: свои песни со словами-караоке ====================
const plAudio = new Audio();
let plSong = null, plSrcNode = null, plUrl = '', plLine = -2, kick = 0, bassAvg = 0, seeking = false, sync = null;
const plList = () => songs.filter((s) => s.blob); // встроенный демо-трек живёт только в игре
const plOpen = () => !$('player').hidden;
const PATH = { play: 'M8 5v14l11-7z', pause: 'M6 5h4v14H6zM14 5h4v14h-4z' };

// звук плеера идёт через общий тракт игры: та же громкость и анализатор баса для обложки
function plPlay() {
  ensureAudio();
  if (!plSrcNode) { plSrcNode = actx.createMediaElementSource(plAudio); plSrcNode.connect(musicGain); }
  if (actx.state === 'suspended') actx.resume();
  plAudio.play().catch(() => {});
}
function plUpText() {
  const list = plList(), nx = plSong && list[(list.indexOf(plSong) + 1) % list.length];
  $('plUp').textContent = '';
  if (!nx || nx === plSong) return;
  const b = document.createElement('b'); b.textContent = nx.name;
  $('plUp').append('Дальше: ', b);
}
async function plLoad(song, autoplay) {
  plSong = song;
  if (plUrl) URL.revokeObjectURL(plUrl);
  plUrl = URL.createObjectURL(song.blob);
  plAudio.src = plUrl;
  $('plTitle').textContent = song.name;
  $('plArtist').textContent = song.artist || 'Твой трек';
  plUpText();
  renderLines();
  if (selId !== song.id) select(song.id); // фон, цвета и меню — под эту песню
  if (autoplay) plPlay();
  await songImage(song);
  if (plSong !== song) return;
  $('plImg').src = song.imgUrl;
  if (window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: song.name, artist: song.artist || '', artwork: [{ src: song.imgUrl }] });
}
function plToggle() {
  if (!plSong) { const s = plList()[0]; if (s) plLoad(s, true); return; }
  if (plAudio.paused) plPlay(); else plAudio.pause();
}
function plStep(d) {
  const list = plList();
  if (sync || !list.length) return;
  if (d < 0 && plAudio.currentTime > 3) { plAudio.currentTime = 0; return; } // как в любом плеере: сначала в начало песни
  plLoad(list[((plSong ? list.indexOf(plSong) : -1) + d + list.length) % list.length], true);
}
function plVolume(d) {
  settings.music = Math.round(Math.max(0, Math.min(1, settings.music + d)) * 20) / 20;
  applyVolumes(); saveSettings();
}
plAudio.addEventListener('play', () => { $('plPlay').querySelector('path').setAttribute('d', PATH.pause); $('plPlay').ariaLabel = 'Пауза'; });
plAudio.addEventListener('pause', () => { $('plPlay').querySelector('path').setAttribute('d', PATH.play); $('plPlay').ariaLabel = 'Играть'; });
plAudio.addEventListener('loadedmetadata', () => { $('plDur').textContent = fmtDur(plAudio.duration * 1000); });
plAudio.addEventListener('ended', () => {
  if (!sync) return plStep(1);
  // песня кончилась посреди разметки: сохраняем то, что успели
  if (sync.i) { sync.lines.length = sync.i; syncDone(true); } else syncDone(false);
});
if ('mediaSession' in navigator) {
  for (const [a, f] of [['play', plPlay], ['pause', () => plAudio.pause()], ['previoustrack', () => plStep(-1)], ['nexttrack', () => plStep(1)]]) {
    try { navigator.mediaSession.setActionHandler(a, f); } catch { /* старый браузер */ }
  }
}

const SYNC_HINT = 'Вставь текст песни и разметь его: песня играет, а ты жмёшь пробел, когда начинается каждая строка. Минута работы.';
function renderLines() {
  const box = $('plLines');
  box.textContent = '';
  const lines = sync ? sync.lines.map((text) => ({ text })) : (plSong && plSong.lyrics) || [];
  $('plLyr').classList.toggle('syncing', !!sync);
  $('plEmpty').hidden = lines.length > 0;
  $('plEmpty').querySelector('h3').textContent = plSong ? 'У песни пока нет слов' : 'Песен пока нет';
  $('plEmptyText').textContent = plSong ? SYNC_HINT : 'Нажми «Добавить песни» или перетащи mp3 в окно. Можно сразу несколько.';
  $('plEmpty').querySelector('.actions').hidden = !plSong;
  $('plFind').hidden = !window.cbApp;
  lines.forEach((l) => {
    const el = document.createElement('div');
    el.className = 'ln' + (l.text ? '' : ' gap');
    el.textContent = l.text || '• • •';
    if (!sync) el.addEventListener('click', () => { plAudio.currentTime = Math.max(0, l.t / 1000); if (plAudio.paused) plPlay(); });
    box.appendChild(el);
  });
  box.style.transform = '';
  plLine = -2;
}

let lastCur = '';
function plTick() {
  if (!plOpen()) return;
  const t = plAudio.currentTime * 1000;
  if (!seeking && plAudio.duration) {
    const v = plAudio.currentTime / plAudio.duration;
    $('plSeek').value = Math.round(v * 1000);
    $('plSeek').style.setProperty('--pos', (v * 100).toFixed(2) + '%');
    const c = fmtDur(t);
    if (c !== lastCur) $('plCur').textContent = lastCur = c;
  }
  // обложка подпрыгивает на ударах баса: сравниваем с недавним средним, а не с порогом
  if (analyser && !plAudio.paused) {
    analyser.getByteFrequencyData(freq);
    const b = (freq[0] + freq[1] + freq[2]) / 765;
    bassAvg += (b - bassAvg) * 0.04;
    kick = Math.max(Math.min(1, (b - bassAvg) * 5), kick * 0.86);
  } else kick *= 0.86;
  $('player').style.setProperty('--kick', kick.toFixed(3));

  const L = plSong && plSong.lyrics, els = $('plLines').children;
  let i;
  if (sync) i = sync.i;
  else {
    if (!L || !L.length) return;
    i = -1;
    while (i + 1 < L.length && L[i + 1].t <= t) i++;
  }
  if (i !== plLine && els.length) {
    plLine = i;
    for (let k = 0; k < els.length; k++) {
      els[k].classList.toggle('past', k < i);
      els[k].classList.toggle(sync ? 'next' : 'on', k === i);
    }
    const el = els[Math.max(0, Math.min(els.length - 1, i))];
    $('plLines').style.transform = `translateY(${-(el.offsetTop + el.offsetHeight / 2)}px)`;
  }
  if (!sync && i >= 0) {
    // строка заливается слева направо за время, пока её поют
    const end = i + 1 < L.length ? L[i + 1].t : L[i].t + 4000;
    const p = Math.min(1, (t - L[i].t) / Math.max(400, Math.min(end - L[i].t, 7000) * 0.85));
    els[i].style.setProperty('--p', p.toFixed(3));
  }
}

// разметка слов: песня с начала, пробел на каждой новой строке
function syncOpen(text) {
  $('syncText').value = text != null ? text : plSong.lyrics && plSong.lyrics.length ? plSong.lyrics.map((l) => l.text).filter(Boolean).join('\n') : plSong.plain || '';
  $('syncDlg').hidden = false;
  $('syncText').focus();
}
function syncTap() {
  sync.stamps[sync.i] = Math.max(0, plAudio.currentTime * 1000 - 120); // люди жмут чуть позже, чем начинают петь
  sync.i++;
  if (sync.i >= sync.lines.length) syncDone(true);
}
function syncUndo() {
  if (!sync.i) return;
  sync.i--;
  plAudio.currentTime = Math.max(0, sync.stamps[sync.i] / 1000 - 3);
}
function syncDone(save) {
  if (save) {
    plSong.lyrics = sync.lines.map((text, k) => ({ t: sync.stamps[k], text }));
    saveSong(plSong);
    if (selId === plSong.id) renderHero(false);
  }
  sync = null;
  $('syncBar').hidden = true;
  renderLines();
  if (save) { plAudio.currentTime = 0; plPlay(); }
}
$('syncGo').addEventListener('click', () => {
  const lines = $('syncText').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) { $('syncText').focus(); return; }
  $('syncDlg').hidden = true;
  sync = { lines, i: 0, stamps: [] };
  $('syncBar').hidden = false;
  renderLines();
  plAudio.currentTime = 0;
  plPlay();
});
$('syncCancel').addEventListener('click', () => { $('syncDlg').hidden = true; });
$('syncTap').addEventListener('click', () => sync && syncTap());
$('syncUndo').addEventListener('click', () => sync && syncUndo());
$('syncStop').addEventListener('click', () => sync && syncDone(false));

function openPlayer() {
  $('menu').hidden = true;
  $('player').hidden = false;
  const list = plList(), s = list.find((x) => x.id === selId) || (list.includes(plSong) ? plSong : list[0]);
  if (s && s !== plSong) plLoad(s, true);
  else { if (!s) plSong = null; renderLines(); plUpText(); }
}
function closePlayer() {
  if (sync) syncDone(false);
  $('player').hidden = true;
  $('menu').hidden = false;
}
function plKey(e) {
  const tag = e.target.tagName;
  if (!$('syncDlg').hidden || tag === 'TEXTAREA') { if (e.code === 'Escape') $('syncDlg').hidden = true; return; }
  if (sync) {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); if (!e.repeat) syncTap(); }
    else if (e.code === 'Backspace') { e.preventDefault(); syncUndo(); }
    else if (e.code === 'Escape') syncDone(false);
    return;
  }
  if (e.code === 'Space' && tag === 'BUTTON') return; // кнопка с фокуса клавиатуры нажмётся сама
  const act = { ArrowRight: () => plStep(1), ArrowLeft: () => plStep(-1), Space: plToggle, ArrowUp: () => plVolume(0.05), ArrowDown: () => plVolume(-0.05), Escape: closePlayer }[e.code];
  if (act) { e.preventDefault(); if (!e.repeat || e.code.startsWith('ArrowU') || e.code.startsWith('ArrowD')) act(); }
}
$('plBtn').addEventListener('click', openPlayer);
$('plBack').addEventListener('click', closePlayer);
$('plAdd').addEventListener('click', () => $('file').click());
$('plPlay').addEventListener('click', plToggle);
$('plPrev').addEventListener('click', () => plStep(-1));
$('plNext').addEventListener('click', () => plStep(1));
$('plSync').addEventListener('click', () => syncOpen());
$('plLrc').addEventListener('click', () => { if (plSong) syncOpen(); });
$('plFile').addEventListener('click', () => $('lrcFile').click());
$('plFind').addEventListener('click', async () => {
  showLoading('Ищу слова', `«${plSong.name}» на lrclib.net…`, 0.5);
  if (await findLyrics(plSong)) { renderLines(); return; }
  if (plSong.plain) { syncOpen(plSong.plain); return; } // нашёлся текст без таймингов: осталось разметить
  showLoading('Слова не нашлись', 'Вставь текст сам и разметь пробелом — это минута.', 0);
  setTimeout(() => { $('loading').hidden = true; }, 2600);
});
// мышью нажатая кнопка не держит фокус, чтобы пробел оставался паузой
$('player').addEventListener('mouseup', (e) => { const b = e.target.closest('button,input'); if (b) b.blur(); });
$('plSeek').addEventListener('input', () => {
  seeking = true;
  const v = $('plSeek').value / 1000;
  $('plSeek').style.setProperty('--pos', v * 100 + '%');
  if (plAudio.duration) $('plCur').textContent = fmtDur(v * plAudio.duration * 1000);
});
$('plSeek').addEventListener('change', () => { if (plAudio.duration) plAudio.currentTime = $('plSeek').value / 1000 * plAudio.duration; seeking = false; });

// ==================== отрисовка ====================
const DISPLAY = (px) => `${px}px "Dela Gothic One", "Arial Black", sans-serif`;
const UI = (w, px) => `${w} ${px}px Onest, "Segoe UI", sans-serif`;
const ease = (x) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`; }
function shade(hex, k) { const n = parseInt(hex.slice(1), 16), f = (v) => Math.round(v * k); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; }

// фон игры: размытая обложка песни, готовится один раз
let bgC = null, bgFor = '';
function prepBackground(song) {
  const key = song.id + '|' + W + 'x' + H + '|' + (song.imgUrl || '');
  if (bgFor === key) return;
  bgFor = key;
  bgC = null;
  if (!song.img) return;
  bgC = document.createElement('canvas');
  bgC.width = Math.round(W * DPR); bgC.height = Math.round(H * DPR);
  const x = bgC.getContext('2d'), img = song.img;
  const k = Math.max(bgC.width / img.width, bgC.height / img.height) * 1.1;
  x.filter = `blur(${Math.round(18 * DPR)}px) saturate(1.3)`;
  x.drawImage(img, (bgC.width - img.width * k) / 2, (bgC.height - img.height * k) / 2, img.width * k, img.height * k);
  x.filter = 'none';
}

// ноты рисуются один раз в спрайт для каждого цвета и размера
const spriteCache = new Map();
function noteSprite(ci, R) {
  const key = COLORS[ci % 4] + '|' + Math.round(R * DPR);
  let c = spriteCache.get(key);
  if (c) return c;
  const pad = R * 0.45, size = Math.ceil((R + pad) * 2 * DPR);
  c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d'), m = size / 2, r = R * DPR, col = COLORS[ci % 4];
  x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = r * 0.35; x.shadowOffsetY = r * 0.08;
  x.fillStyle = col;
  x.beginPath(); x.arc(m, m, r * 0.94, 0, Math.PI * 2); x.fill();
  x.shadowColor = 'transparent';
  // объём: светлее сверху, темнее снизу
  const gr = x.createLinearGradient(0, m - r, 0, m + r);
  gr.addColorStop(0, 'rgba(255,255,255,0.32)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.22)');
  x.fillStyle = gr;
  x.beginPath(); x.arc(m, m, r * 0.94, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#FFFFFF'; x.lineWidth = r * 0.12;
  x.beginPath(); x.arc(m, m, r * 0.88, 0, Math.PI * 2); x.stroke();
  spriteCache.set(key, c);
  if (spriteCache.size > 80) spriteCache.delete(spriteCache.keys().next().value);
  return c;
}
function drawNote(x, y, R, ci, alpha, num, scale) {
  if (alpha <= 0) return;
  const sp = noteSprite(ci, R), s = scale || 1, w = sp.width / DPR * s;
  g.save();
  g.globalAlpha = Math.min(1, alpha);
  g.drawImage(sp, x - w / 2, y - w / 2, w, w);
  if (num !== undefined) {
    g.fillStyle = '#FFFFFF';
    g.font = DISPLAY(Math.round(R * 0.74 * s));
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = GLOW(6);
    g.fillText(num, x, y + R * 0.06);
  }
  g.restore();
}
function drawApproach(x, y, R, ci, alpha, p) {
  g.save();
  g.globalAlpha = Math.min(1, alpha);
  g.strokeStyle = COLORS[ci % 4];
  g.lineWidth = Math.max(2.5, R * 0.085);
  g.beginPath(); g.arc(x, y, R * 0.92 * (1 + 2.4 * (1 - p)), 0, Math.PI * 2); g.stroke();
  g.restore();
}
// режим «Скрытые»: нота исчезает задолго до удара
function hdAlpha(o, t, ar) { return Math.max(0, Math.min(1, (o.t - ar * 0.3 - t) / (ar * 0.3))); }

function drawBackground(t, beatPulse) {
  g.fillStyle = '#09090D';
  g.fillRect(0, 0, W, H);
  if (bgC) { g.drawImage(bgC, 0, 0, W, H); }
  g.fillStyle = `rgba(9,9,13,${0.35 + settings.dim * 0.6})`;
  g.fillRect(0, 0, W, H);
  let bass = 0;
  if (analyser && state === 'play') { analyser.getByteFrequencyData(freq); bass = (freq[1] + freq[2] + freq[3] + freq[4]) / 1020; }
  const k = 1 - settings.dim * 0.8;
  // свет из центра качается от баса и бита (готовая картинка: дешевле, чем градиент каждый кадр)
  const glow = glowSprite(), gs = Math.max(W, H) * 1.25;
  g.globalAlpha = Math.min(1, (0.1 + bass * 0.22 + beatPulse * 0.06) * k);
  g.drawImage(glow, W / 2 - gs / 2, H / 2 - gs / 2, gs, gs);
  g.globalAlpha = 1;
  if (analyser && state === 'play' && fx.level === 0) {
    const n = 48, bw = W / n;
    g.fillStyle = hexA(COLORS[1], 0.22 * k);
    for (let i = 0; i < n; i++) {
      const v = freq[Math.floor(i * freq.length / n * 0.8)] / 255, h = v * H * 0.16;
      g.fillRect(i * bw + 2, H - h, bw - 4, h);
    }
  }
}
let glowC = null, glowFor = '';
function glowSprite() {
  if (glowC && glowFor === COLORS[0]) return glowC;
  glowFor = COLORS[0];
  glowC = document.createElement('canvas'); glowC.width = glowC.height = 256;
  const x = glowC.getContext('2d'), gr = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, hexA(COLORS[0], 1)); gr.addColorStop(1, hexA(COLORS[0], 0));
  x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
  return glowC;
}

function drawGame(t) {
  const G = game, f = field(), s = f.s, R = G.diff.r * s, ar = G.diff.ar;
  const P = G.song.an.period;
  const beatPulse = Math.exp(-(((t - G.song.an.phase) % P + P) % P) / 140);
  drawBackground(t, beatPulse);
  const X = (x) => f.ox + x * s, Y = (y) => f.oy + y * s;

  let lastIdx = G.first;
  while (lastIdx < G.objs.length && G.objs[lastIdx].t - ar <= t) lastIdx++;
  for (let i = lastIdx - 1; i >= G.first; i--) {
    const o = G.objs[i];
    let fadeIn = Math.min(1, (t - (o.t - ar)) / (ar * 0.4));
    if (o.type === 'p') { drawSpinner(o, t, f, fadeIn); continue; }
    if (o.type === 's') { drawSlider(o, t, f, R, fadeIn); continue; }
    if (o.judged) {
      const k = (t - o.hitT) / 260;
      if (k >= 1 || (G.hidden && o.res > 0)) continue;
      if (o.res > 0) drawNote(X(o.x), Y(o.y), R, o.color, 1 - k, undefined, 1 + ease(k) * 0.4);
      else drawNote(X(o.x), Y(o.y) + k * R * 0.5, R, o.color, (1 - k) * 0.45, o.combo);
      continue;
    }
    if (G.hidden) fadeIn = Math.min(fadeIn, hdAlpha(o, t, ar));
    const shake = o.shakeT !== undefined && t - o.shakeT < 160 ? Math.sin((t - o.shakeT) / 12) * R * 0.12 : 0;
    drawNote(X(o.x) + shake, Y(o.y), R, o.color, fadeIn, o.combo);
    if (t < o.t && !G.hidden) drawApproach(X(o.x) + shake, Y(o.y), R, o.color, fadeIn, Math.max(0, (t - (o.t - ar)) / ar));
  }

  G.popups = G.popups.filter((p) => t - p.t < 650);
  for (const p of G.popups) {
    const k = (t - p.t) / 650;
    g.save();
    g.globalAlpha = 1 - k * k;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (p.txt) {
      g.font = UI(800, 16);
      g.fillStyle = p.col;
      g.fillText(p.txt, X(p.x), Y(p.y) - R * 1.25 - k * 18);
    } else {
      g.font = DISPLAY(Math.round(R * (p.res ? 0.55 : 0.8)));
      g.fillStyle = p.res === 100 ? '#7CF0B4' : p.res === 50 ? '#FFC857' : '#FF5468';
      g.fillText(p.res ? String(p.res) : '×', X(p.x), Y(p.y) - R * 0.9 - k * R * 0.5);
    }
    g.restore();
  }
  drawCursor();
}

function drawSlider(o, t, f, R, fadeIn) {
  const s = f.s, X = (x) => f.ox + x * s, Y = (y) => f.oy + y * s, col = COLORS[o.color % 4], G = game;
  const out = o.judged ? Math.max(0, 1 - (t - o.hitT) / 220) : 1;
  if (out <= 0) return;
  let a = fadeIn * out;
  if (G.hidden && t > o.t - G.diff.ar * 0.4) a *= Math.max(0, 1 - (t - (o.t - G.diff.ar * 0.4)) / Math.max(1, o.end - o.t + G.diff.ar * 0.4));
  g.save();
  g.globalAlpha = a;
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  o.pts.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y))));
  g.strokeStyle = '#FFFFFF'; g.lineWidth = R * 1.86; g.stroke();
  g.strokeStyle = shade(col, 0.32); g.lineWidth = R * 1.62; g.stroke();
  g.strokeStyle = hexA(col, 0.35); g.lineWidth = R * 1.1; g.stroke();
  g.restore();
  const end = o.pts[o.pts.length - 1];
  if (!o.judged) drawNote(X(end.x), Y(end.y), R * 0.98, o.color, a * 0.85);

  if (!o.headDone) {
    let ha = fadeIn;
    if (G.hidden) ha = Math.min(ha, hdAlpha(o, t, G.diff.ar));
    drawNote(X(o.x), Y(o.y), R, o.color, ha, o.combo);
    if (t < o.t && !G.hidden) drawApproach(X(o.x), Y(o.y), R, o.color, fadeIn, Math.max(0, (t - (o.t - G.diff.ar)) / G.diff.ar));
  } else if (o.hitT !== undefined && t - o.hitT < 240 && o.headHit) {
    const k = (t - o.hitT) / 240;
    drawNote(X(o.x), Y(o.y), R, o.color, 1 - k, undefined, 1 + ease(k) * 0.4);
  }
  if (t >= o.t && !o.judged) {
    const b = sliderPos(o, t);
    g.save();
    g.fillStyle = '#FFFFFF';
    g.shadowColor = col; g.shadowBlur = GLOW(16);
    g.beginPath(); g.arc(X(b.x), Y(b.y), R * 0.62, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = col; g.lineWidth = R * 0.14;
    g.beginPath(); g.arc(X(b.x), Y(b.y), R * 0.62, 0, Math.PI * 2); g.stroke();
    if (o.tracking) {
      g.strokeStyle = hexA('#FFFFFF', 0.85); g.lineWidth = 3;
      g.beginPath(); g.arc(X(b.x), Y(b.y), R * 2.05, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
  }
}

function drawSpinner(o, t, f, fadeIn) {
  const cx = f.ox + PF_W / 2 * f.s, cy = f.oy + PF_H / 2 * f.s;
  const out = o.judged ? Math.max(0, 1 - (t - o.hitT) / 300) : 1;
  if (out <= 0) return;
  const need = (o.end - o.t) / 1000 * game.diff.spin * Math.PI * 2;
  const prog = Math.min(1, (o.acc || 0) / need);
  const Rr = Math.min(W, H) * 0.3;
  g.save();
  g.globalAlpha = fadeIn * out;
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 14;
  g.beginPath(); g.arc(cx, cy, Rr, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = COLORS[0]; g.shadowColor = COLORS[0]; g.shadowBlur = GLOW(18);
  g.beginPath(); g.arc(cx, cy, Rr, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); g.stroke();
  g.shadowBlur = 0;
  // три метки вращаются вместе с курсором
  g.translate(cx, cy);
  g.rotate(o.acc || 0);
  for (let i = 0; i < 3; i++) {
    g.rotate(Math.PI * 2 / 3);
    g.fillStyle = COLORS[(i + 1) % 4];
    g.beginPath(); g.arc(0, -Rr * 0.72, 12, 0, Math.PI * 2); g.fill();
  }
  g.restore();
  g.save();
  g.globalAlpha = fadeIn * out;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#FFFFFF';
  g.font = DISPLAY(Math.round(Rr * 0.16));
  g.fillText(prog >= 1 ? 'Бонус!' : 'Крути', cx, cy - 8);
  g.font = UI(700, 15);
  g.fillStyle = 'rgba(246,245,250,0.62)';
  g.fillText(`${Math.round((o.spinV || 0) / (Math.PI * 2) * 60)} об/мин`, cx, cy + Rr * 0.14);
  if (t < o.t) { g.globalAlpha = fadeIn; g.fillStyle = '#FFFFFF'; g.font = UI(700, 16); g.fillText('Зажми кнопку и веди мышь по кругу', cx, cy - Rr - 34); }
  g.restore();
}

// интерфейс поверх игры
function drawOverlay(t) {
  const G = game, f = field();
  drawLyrics(t);
  drawHUD(t, f);
  drawKeys();
  if (G.failed) {
    const k = Math.min(1, (performance.now() - G.failT) / 1400);
    g.fillStyle = `rgba(9,9,13,${k * 0.75})`;
    g.fillRect(0, 0, W, H);
    g.save();
    g.globalAlpha = k;
    g.font = DISPLAY(72);
    g.textAlign = 'center';
    g.fillStyle = '#FF5468';
    g.fillText('Провал', W / 2, H / 2);
    g.restore();
  }
}

// слова песни внизу экрана: строка заливается цветом по мере пения, как караоке
function drawLyrics(t) {
  const L = game.song.lyrics;
  if (!L || !L.length) return;
  let i = game.lyric;
  while (i + 1 < L.length && L[i + 1].t <= t) i++;
  while (i > 0 && L[i].t > t) i--;
  game.lyric = i;
  const cur = L[i];
  if (!cur || cur.t > t || !cur.text) return;
  const next = L[i + 1], end = next ? next.t : cur.t + 4000;
  const k = Math.max(0, Math.min(1, (t - cur.t) / Math.max(400, (end - cur.t) * 0.85)));
  const appear = Math.min(1, (t - cur.t) / 180);
  const y = H - 74;
  g.save();
  g.font = DISPLAY(Math.min(30, Math.max(20, W / 48)));
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const w = g.measureText(cur.text).width, x0 = W / 2 - w / 2;
  g.globalAlpha = appear;
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillText(cur.text, W / 2, y + (1 - appear) * 10);
  g.beginPath(); g.rect(x0 - 4, y - 30, (w + 8) * k, 60); g.clip();
  g.fillStyle = '#FFFFFF';
  g.shadowColor = COLORS[0]; g.shadowBlur = GLOW(16);
  g.fillText(cur.text, W / 2, y + (1 - appear) * 10);
  g.restore();
  if (next && next.text && next.t - t < 3000) {
    g.save();
    g.font = UI(600, 15);
    g.textAlign = 'center';
    g.fillStyle = 'rgba(246,245,250,0.45)';
    g.fillText(next.text, W / 2, y + 30);
    g.restore();
  }
}

function drawHUD(t, f) {
  const G = game;
  const p = Math.max(0, Math.min(1, t / G.song.an.duration));
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.fillRect(0, 0, W, 3);
  g.fillStyle = COLORS[0];
  g.fillRect(0, 0, W * p, 3);

  // жизнь
  const hw = Math.min(300, W * 0.28), low = G.hp < 0.25;
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.beginPath(); g.roundRect(24, 24, hw, 8, 4); g.fill();
  g.fillStyle = low ? '#FF5468' : '#FFFFFF';
  if (low) g.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() / 90);
  g.beginPath(); g.roundRect(24, 24, Math.max(8, hw * G.hp), 8, 4); g.fill();
  g.globalAlpha = 1;
  if (G.auto) { g.font = UI(800, 13); g.fillStyle = COLORS[0]; g.textAlign = 'left'; g.fillText('АВТОИГРА — СМОТРИ И ЗАПОМИНАЙ', 24, 56); }
  else if (G.modsText) { g.font = UI(700, 13); g.fillStyle = 'rgba(246,245,250,0.6)'; g.textAlign = 'left'; g.fillText(G.modsText, 24, 56); }

  G.shownScore += (G.score - G.shownScore) * 0.25;
  g.textAlign = 'right'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#FFFFFF';
  g.font = DISPLAY(38);
  g.fillText(Math.round(G.shownScore).toLocaleString('ru-RU'), W - 26, 60);
  const acc = G.judged ? G.accSum / (300 * G.judged) * 100 : 100;
  g.font = UI(700, 17);
  g.fillStyle = 'rgba(246,245,250,0.7)';
  g.fillText(acc.toFixed(2) + '%', W - 26, 86);

  if (G.combo > 0) {
    const k = Math.min(1, (t - G.comboPop) / 160);
    const sc = 1 + (1 - ease(k)) * 0.16;
    g.save();
    g.translate(26, H - 26);
    g.scale(sc, sc);
    g.textAlign = 'left';
    g.font = DISPLAY(54);
    g.fillStyle = '#FFFFFF';
    const txt = String(G.combo);
    g.fillText(txt, 0, 0);
    const tw = g.measureText(txt).width;
    g.fillStyle = COLORS[0];
    g.font = DISPLAY(30);
    g.fillText('x', tw + 6, 0);
    g.restore();
  }

  // шкала точности: зоны 300 / 100 / 50 и последние нажатия
  const w = G.win, bw = Math.min(240, W * 0.28), sx = bw / 2 / w.w50, cx = W / 2, cy = H - 22;
  const zone = (ms, col) => { g.fillStyle = col; g.beginPath(); g.roundRect(cx - ms * sx, cy - 2.5, ms * sx * 2, 5, 3); g.fill(); };
  zone(w.w50, 'rgba(255,200,87,0.55)'); zone(w.w100, 'rgba(124,240,180,0.6)'); zone(w.w300, 'rgba(120,200,255,0.9)');
  g.fillStyle = '#FFFFFF';
  g.fillRect(cx - 1, cy - 9, 2, 18);
  for (let i = G.errors.length - 1; i >= 0 && t - G.errors[i].t < 5000; i--) {
    const e = G.errors[i];
    g.globalAlpha = 1 - (t - e.t) / 5000;
    g.fillRect(cx + e.d * sx - 1.5, cy - 7, 3, 14);
  }
  g.globalAlpha = 1;

  const first = G.objs[0];
  if (first.t - t > 3000 && !paused) {
    g.textAlign = 'center';
    g.font = UI(700, 15);
    g.fillStyle = 'rgba(246,245,250,' + (0.55 + 0.35 * Math.sin(performance.now() / 300)) + ')';
    g.fillText('Пробел — пропустить вступление', W / 2, 110);
  }
}

function drawKeys() {
  const now = performance.now(), x = W - 68, y0 = H / 2 - 54;
  keysUI.forEach((k, i) => {
    const y = y0 + i * 62, flash = Math.max(0, 1 - (now - k.t) / 200);
    g.save();
    g.translate(x + 24, y + 24);
    const sc = k.down ? 0.92 : 1 + flash * 0.06;
    g.scale(sc, sc);
    g.fillStyle = k.down ? COLORS[0] : 'rgba(255,255,255,0.08)';
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1;
    g.beginPath(); g.roundRect(-24, -24, 48, 48, 14); g.fill(); g.stroke();
    g.fillStyle = '#FFFFFF';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = DISPLAY(17);
    g.fillText(k.label, 0, -5);
    g.font = UI(700, 11);
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText(String(k.n), 0, 13);
    g.restore();
  });
}

// хвост курсора по всем движениям мыши: гладкий, без «лесенки»
function drawCursor() {
  const now = performance.now();
  if (game && game.auto) trail.push({ x: mouse.x, y: mouse.y, t: now });
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i], k = (now - r.t) / 320;
    if (k >= 1) { ripples.splice(i, 1); continue; }
    g.strokeStyle = hexA('#FFFFFF', (1 - k) * 0.7);
    g.lineWidth = 2.5 * (1 - k) + 1;
    g.beginPath(); g.arc(r.x, r.y, 12 * settings.cursor + ease(k) * 34, 0, Math.PI * 2); g.stroke();
  }
  if (inputTouch && !(game && game.auto)) return;
  const life = 30 + 150 * settings.trail;
  while (trail.length && now - trail[0].t > life) trail.shift();
  const cs = 13 * settings.cursor * (held > 0 ? 1.15 : 1);
  if (settings.trail > 0 && trail.length > 1) {
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i], k = 1 - (now - b.t) / life;
      if (k <= 0) continue;
      g.strokeStyle = hexA(COLORS[0], k * 0.6);
      g.lineWidth = cs * 1.1 * k + 1;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    g.restore();
  }
  g.save();
  g.shadowColor = COLORS[0]; g.shadowBlur = GLOW(16);
  g.fillStyle = '#FFFFFF';
  g.beginPath(); g.arc(mouse.x, mouse.y, cs * 0.45, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = COLORS[0]; g.lineWidth = 3;
  g.beginPath(); g.arc(mouse.x, mouse.y, cs, 0, Math.PI * 2); g.stroke();
  g.restore();
}

// автоигра: курсор плавно летит к нотам и жмёт точно в такт
function autoPilot(t) {
  const G = game, f = field();
  const S = (x, y) => { mouse.x = f.ox + x * f.s; mouse.y = f.oy + y * f.s; };
  const P2S = () => ({ x: (mouse.x - f.ox) / f.s, y: (mouse.y - f.oy) / f.s });
  if (G.apRelease && t >= G.apRelease) { G.apRelease = 0; held = 0; keysUI.forEach((k) => { k.down = false; }); }
  let o = null;
  for (let i = G.first; i < G.objs.length; i++) { const x = G.objs[i]; if (!x.judged) { o = x; break; } }
  if (!o) return;
  const press2 = () => { G.apKey = 1 - (G.apKey || 0); keyState(G.apKey, true); held = 1; };
  if (o.type === 'p') {
    if (t >= o.t - 40) { const a = t / 32; S(PF_W / 2 + Math.cos(a) * 60, PF_H / 2 + Math.sin(a) * 60); if (!held) press2(); G.apFrom = { ...P2S(), t }; }
    else glide(o.x, o.y);
    return;
  }
  if (o.type === 's' && o.headDone) { const b = sliderPos(o, t); S(b.x, b.y); G.apFrom = { ...b, t }; if (t >= o.end - 8) { G.apRelease = t + 30; } return; }
  glide(o.x, o.y);
  if (t >= o.t - 2 && !o.apDone) {
    o.apDone = true;
    S(o.x, o.y);
    press2();
    press();
    G.apFrom = { x: o.x, y: o.y, t };
    if (o.type === 'c') G.apRelease = t + 60;
  }
  function glide(x, y) {
    const from = G.apFrom || { x: PF_W / 2, y: PF_H / 2, t: t };
    if (!G.apFrom) G.apFrom = from;
    const k = Math.max(0, Math.min(1, (t - from.t) / Math.max(1, o.t - from.t)));
    const e = easeInOut(k);
    S(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
  }
}

let lastFrame = performance.now(), lastT = null;
function frame(now) {
  const dt = Math.min(50, now - lastFrame);
  lastFrame = now;
  if (state === 'play' && game && actx) {
    const t = songTime();
    if (game.auto && !paused) autoPilot(t);
    qualityTick(dt);
    $('tSkip').hidden = !(inputTouch && !paused && game.objs[0].t - t > 3000);
    if (!paused && !game.failed) update(t, lastT === null ? 0 : Math.max(0, Math.min(50, t - lastT)));
    lastT = t;
    drawGame(t);
    drawOverlay(t);
  } else {
    lastT = null;
    if (state === 'menu') { g.clearRect(0, 0, W, H); plTick(); }
    else drawBackground(now, 0);
  }
  void dt;
  requestAnimationFrame(frame);
}

// ---------- старт ----------
resize();
if (matchMedia('(pointer: coarse)').matches || innerWidth < 760) $('mobileNote').hidden = false;
requestAnimationFrame(frame);
loadLibrary().catch(() => { renderSongs(); });
