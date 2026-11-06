// Daily Setlist client: one original AI song per day (plus the rest of the setlist) as a verified 4-lane rhythm level.
// Plain JS + Web Audio, no deps. Data: levels/index.json {songs:[{id,title,genre,audio,level}], days:{YYYY-MM-DD:id}} +
// levels/<id>.json {song,levels}. Hosted (window.__channel): saves only through the Bridge, per-song events go to Bridge analytics.
import { Referee } from './judge.js';

const $ = id => document.getElementById(id);
const cv = $('c'), g = cv.getContext('2d');
const LANE_KEYS = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 }, KEY_NAMES = 'DFJK';
const LANE_COL = ['#ff6b8b', '#ffd166', '#06d6a0', '#7fe3ff'];
const STAGE = { 'indie-folk': 32, 'synth-pop': 285, country: 40, jazz: 225, punk: 345, 'pop-rock': 15, rnb: 265, soul: 300 };
const LEAD = 1.6;            // seconds a note is visible before the hit line
const VERSION = '1.1.0';
const TUTORIAL_NOTES = 8;

const ch = () => window.__channel;
const hosted = () => !!window.__channel;
const bridgeOk = () => !!(window.bridge && ch() && ch().bridgeReady);

// ---- save: one key, read once at startup, written only on meaningful change. Hosted = Bridge storage only (rule 3.2.1).
const SAVE_KEY = 'sl_save';
const save = { offset: 0, muted: false, tut: false, best: {}, streak: 0, lastClear: '' };
async function loadSave() {
  try {
    let raw = null;
    if (hosted()) { if (bridgeOk()) raw = (await window.bridge.storage.get([SAVE_KEY]))?.[0]; }
    else raw = localStorage.getItem(SAVE_KEY);
    if (raw) Object.assign(save, typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch {}
}
function persist() {
  const raw = JSON.stringify(save);
  try {
    if (hosted()) { if (bridgeOk()) window.bridge.storage.set([SAVE_KEY], [raw]); }
    else localStorage.setItem(SAVE_KEY, raw);
  } catch {}
}

// portal bridge (same contract as imaker's 032b bridge) and the play log = the preference signal
const bus = window.__ilazy = window.__ilazy || { events: [] };
bus.events = bus.events || []; bus.version = bus.version || 'songlevel-2'; bus.state = () => S.mode;
const emit = (type, data = {}) => { const e = { type, t: performance.now(), ...data }; bus.events.push(e);
  try { bus.onEvent && bus.onEvent(e); } catch {} };
const track = (name, data) => { try { if (bridgeOk()) window.bridge.analytics.send(name, data); } catch {} };
const playLog = [];
window.__songlevel = { log: playLog, save, songTimeAt: t => songTimeAt(t), get S() { return S; } };
// one event per outcome with song_id in the data: Playgama's per-field distribution of an event IS the per-song table
function log(ev, data = {}) {
  playLog.push({ ev, song: S.song?.id, tier: S.tier, at: Date.now(), ...data });
  emit('songlevel:' + ev, data);
  const base = { song_id: S.song?.id || '', tier: S.tier };
  if (['start', 'clear', 'fail', 'skip', 'replay', 'like', 'leave', 'tutorial_done'].includes(ev))
    track('song_' + ev, data.acc === undefined ? base : { ...base, acc_pct: Math.round(100 * data.acc), progress_pct: Math.round(100 * data.progress) });
}

const S = { mode: 'boot', tier: 'normal', idx: null, k: 0, today: 0, song: null, level: null, buf: null, bufs: {}, ctx: null, master: null, src: null,
            t0: 0, ref: null, flash: [0, 0, 0, 0], down: new Map(), combo: 0, maxCombo: 0, miss: 0, brk: 0, sparks: [], words: [], tut: false, wasPaused: false };

function today() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
function todayIndex(idx) {
  const d = today(), id = idx.days?.[d];
  const k = idx.songs.findIndex(s => s.id === id);
  return k >= 0 ? k : Math.floor(Date.parse(d) / 864e5) % idx.songs.length;
}

async function pick(k) {
  const n = S.idx.songs.length;
  S.k = (k + n) % n;
  const meta = S.idx.songs[S.k];
  S.song = meta; S.buf = null;
  S.level = await (await fetch(meta.level)).json();
  S.audioBytes = fetch(meta.audio).then(r => r.arrayBuffer());   // decoded on Play (needs an AudioContext)
  $('tag').textContent = S.k === S.today ? "Today's song" : `Setlist ${S.k + 1} of ${n}`;
  $('song').textContent = meta.title;
  $('meta').textContent = meta.genre.replace('-', ' ');
  drawTitle();
}
const stars = acc => acc === undefined ? 0 : acc >= 0.85 ? 3 : acc >= 0.6 ? 2 : 1;
function drawTitle() {
  const b = save.best[S.song?.id] || {};
  document.querySelectorAll('.tier').forEach(x => {
    const t = x.dataset.t; x.classList.toggle('on', t === S.tier); x.classList.toggle('alt', t !== S.tier);
    x.querySelector('b').textContent = b[t] === undefined ? '' : '★'.repeat(stars(b[t]));
    x.setAttribute('aria-pressed', t === S.tier);
  });
  const cleared = S.idx ? S.idx.songs.filter(s => save.best[s.id]).length : 0;
  $('stats').textContent = `${cleared} of ${S.idx?.songs.length || 0} songs cleared` + (save.streak ? ` · ${save.streak} day streak` : '');
  $('calv').textContent = save.offset ? `timing offset ${(save.offset * 1000).toFixed(0)} ms` : '';
}

function ensureCtx() {
  if (!S.ctx) {
    S.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    S.master = S.ctx.createGain(); S.master.connect(S.ctx.destination); applyMute();
    for (const name of ['tap', 'ui']) fetch(`sfx/${name}.mp3`).then(r => r.arrayBuffer()).then(a => S.ctx.decodeAudioData(a)).then(b => {
      // mp3 encoder padding: find the true onset so a click sounds exactly when scheduled (calibration depends on it)
      const d = b.getChannelData(0); let pk = 0, i = 0;
      for (const v of d) pk = Math.max(pk, Math.abs(v));
      while (i < d.length && Math.abs(d[i]) < 0.1 * pk) i++;
      S.bufs[name] = { b, lead: i / b.sampleRate };
    }).catch(() => {});
  }
  if (S.ctx.state !== 'running') S.ctx.resume();
  return S.ctx;
}
function sfx(name, gain = 0.35, when = 0) {
  const x = S.bufs[name]; if (!x || !S.ctx) return;
  const s = S.ctx.createBufferSource(), v = S.ctx.createGain();
  s.buffer = x.b; v.gain.value = gain; s.connect(v).connect(S.master); s.start(when, x.lead);
}
const platformMuted = () => !!(ch() && ch().audioOff);
function applyMute() {
  const m = save.muted || platformMuted();
  if (S.master) S.master.gain.value = m ? 0 : 1;
  $('mutep').setAttribute('d', save.muted
    ? 'M4 9v6h4l5 5V4L8 9zm11.4 0L14 10.4l1.6 1.6-1.6 1.6 1.4 1.4 1.6-1.6 1.6 1.6 1.4-1.4-1.6-1.6 1.6-1.6L18.6 9 17 10.6z'
    : 'M4 9v6h4l5 5V4L8 9zm12 3a4 4 0 0 0-2-3.5v7A4 4 0 0 0 16 12z');
  $('mute').setAttribute('aria-pressed', save.muted); $('mute').setAttribute('aria-label', save.muted ? 'Unmute' : 'Mute');
}

// audio-clock position (seconds since the song started) of a performance.now() timestamp; output latency included
function songTimeAt(perfMs) {
  const c = S.ctx, off = save.offset;
  if (c.state !== 'running') return c.currentTime - S.t0 - off;   // suspended by a pause: the clock stands still
  if (c.getOutputTimestamp) {
    const ts = c.getOutputTimestamp();
    if (ts.performanceTime > 0) return ts.contextTime + (perfMs - ts.performanceTime) / 1000 - S.t0 - off;
  }
  return c.currentTime + (perfMs - performance.now()) / 1000 - (c.outputLatency || c.baseLatency || 0) - S.t0 - off;
}

async function start() {
  if (S.starting) return;
  S.starting = true; $('play').disabled = true; $('play').textContent = 'Loading';
  try {
    const c = ensureCtx();
    if (!S.buf) S.buf = await c.decodeAudioData((await S.audioBytes).slice(0));
    S.ref = new Referee(S.level.levels[S.tier], S.tier);
    S.src = c.createBufferSource(); S.src.buffer = S.buf; S.src.connect(S.master);
    S.t0 = c.currentTime + LEAD + 0.2;
    S.src.start(S.t0);
    S.src.onended = () => S.mode === 'play' && finish(false);
    Object.assign(S, { mode: 'play', combo: 0, maxCombo: 0, miss: 0, brk: 0, sparks: [], words: [], tut: !save.tut, tutDone: false });
    perf.reset();
    ['title', 'end', 'paused'].forEach(p => $(p).classList.add('hidden')); $('pause').classList.remove('hidden');
    emit('gameplayStart'); log('start');
  } finally { S.starting = false; $('play').disabled = false; $('play').textContent = 'Play'; }
}

function pausePlay() {
  if (S.mode !== 'play') return;
  S.mode = 'paused'; try { S.ctx.suspend(); } catch {}
  $('paused').classList.remove('hidden'); $('pause').classList.add('hidden');
}
function resumePlay() {
  if (S.mode !== 'paused' || hostPaused()) return;
  S.mode = 'play'; S.ctx.resume(); perf.reset();
  $('paused').classList.add('hidden'); $('pause').classList.remove('hidden');
}

function finish(quit) {
  if (S.mode !== 'play' && S.mode !== 'paused') return;
  const r = S.ref, t = songTimeAt(performance.now()), dur = S.buf.duration;
  S.mode = 'end';
  try { S.src.onended = null; S.src.stop(); } catch {}
  if (S.ctx.state !== 'running') S.ctx.resume();
  perf.flush();
  const res = { clear: r.passed() && !quit, acc: +r.acc().toFixed(4), hp: +r.hp.toFixed(3), cnt: r.cnt,
                progress: +Math.min(1, Math.max(0, t / dur)).toFixed(3), quit };
  emit('gameplayStop'); emit('levelEnd', { won: res.clear, level: S.k + 1, score: Math.round(100 * res.acc) });
  log(quit ? 'skip' : (res.clear ? 'clear' : 'fail'), res);
  if (S.tutDone) save.tut = true;      // only a player who actually hit the first notes has seen the tutorial
  if (res.clear) {
    const b = save.best[S.song.id] = save.best[S.song.id] || {};
    b[S.tier] = Math.max(b[S.tier] || 0, res.acc);
    const d = today();
    if (save.lastClear !== d) {
      save.streak = Date.parse(d) - Date.parse(save.lastClear || 0) === 864e5 ? save.streak + 1 : 1;
      save.lastClear = d;
    }
  }
  persist();
  $('endh').textContent = res.clear ? 'Cleared!' : (quit ? 'Stopped' : (!r.alive ? 'Out of health' : (r.cnt.ghost > r.notes.length ? 'Too many stray taps' : 'Not enough hits')));
  $('pct').textContent = `${(100 * res.acc).toFixed(1)}%`;
  $('stars').textContent = res.clear ? '★'.repeat(stars(res.acc)) : '';
  $('ends').textContent = `great ${r.cnt.great} · good ${r.cnt.good} · miss ${r.cnt.miss} · best combo ${S.maxCombo}`;
  $('like').classList.remove('on'); $('like').lastElementChild.textContent = 'Like this song';
  $('end').classList.remove('hidden'); $('pause').classList.add('hidden');
  try { bus.host && bus.host.interstitial && bus.host.interstitial(); } catch {}   // natural pause; the platform paces ads
}

// ---- input ----
let view = { x: 0, lw: 1, hitY: 1, W: 1, H: 1 };
function laneOfX(x) { const d = devicePixelRatio > 2 ? 2 : devicePixelRatio; return Math.max(0, Math.min(3, Math.floor((x * d - view.x) / view.lw))); }
function word(l, text, col) { S.words.push({ l, text, col, t: performance.now() }); if (S.words.length > 8) S.words.shift(); }
function press(lane, perf_) {
  if (hostPaused()) return;
  if (S.mode === 'cal') { S.flash[lane] = performance.now(); return calTap(perf_); }
  if (S.mode !== 'play') return;
  const r = S.ref, c0 = r.cnt.great + r.cnt.good;
  S.flash[lane] = performance.now(); r.press(songTimeAt(perf_), lane);
  if (r.cnt.great + r.cnt.good > c0) {
    S.combo++; S.maxCombo = Math.max(S.maxCombo, S.combo);
    sfx('tap', 0.3); burst(lane, LANE_COL[lane]);
    word(lane, r.last === 'great' ? 'GREAT' : 'GOOD', r.last === 'great' ? '#ffd166' : '#f3f0ff');
  }
}
function release(lane, perf_) { if (S.mode === 'play') S.ref.release(songTimeAt(perf_), lane); }
cv.addEventListener('pointerdown', e => { const l = laneOfX(e.clientX); S.down.set(e.pointerId, l); press(l, e.timeStamp); e.preventDefault(); });
const up = e => { const l = S.down.get(e.pointerId); if (l !== undefined) { S.down.delete(e.pointerId); release(l, e.timeStamp); } };
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('keydown', e => { if (e.repeat) return; if (e.code in LANE_KEYS) press(LANE_KEYS[e.code], e.timeStamp);
  if (e.code === 'KeyP' || e.code === 'Space') { if (S.mode === 'play') pausePlay(); else if (S.mode === 'paused') resumePlay(); } });
addEventListener('keyup', e => { if (e.code in LANE_KEYS) release(LANE_KEYS[e.code], e.timeStamp); });
function burst(l, col) {
  const x = view.x + (l + 0.5) * view.lw;
  for (let k = 0; k < 8; k++) { const a = -Math.PI * Math.random(), v = (0.25 + Math.random() * 0.5) * view.lw * 2.2;
    S.sparks.push({ x, y: view.hitY, vx: Math.cos(a) * v, vy: Math.sin(a) * v, col, t: performance.now() }); }
  if (S.sparks.length > 48) S.sparks.splice(0, S.sparks.length - 48);
}

// ---- calibration: 12 clicks at 100 bpm; offset = median(tap - click) on the audio clock ----
let cal = null;
function calibrate() {
  const c = ensureCtx(); const keep = save.offset; save.offset = 0; S.t0 = 0;
  const t0 = c.currentTime + 1.2, clicks = [];
  for (let k = 0; k < 12; k++) { const t = t0 + k * 0.6; sfx('tap', k % 4 ? 0.6 : 1, t); clicks.push(t); }
  cal = { clicks, taps: [], keep }; S.mode = 'cal'; $('title').classList.add('hidden');
  setTimeout(endCal, (1.2 + 12 * 0.6 + 0.5) * 1000);
}
function calTap(perf_) { cal.taps.push(songTimeAt(perf_)); }
function endCal() {
  const d = cal.taps.map(t => { const c = cal.clicks.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a); return t - c; })
    .filter(x => Math.abs(x) < 0.3).sort((a, b) => a - b);
  S.mode = 'title'; $('title').classList.remove('hidden');
  if (d.length >= 6) { save.offset = d[d.length >> 1]; persist(); log('calibrate', { offset: save.offset, n: d.length }); }
  else save.offset = cal.keep;
  // device diagnostics (the phone-rung latency check reads these): tap jitter = MAD of the residuals, reported output latency
  const med = d.length ? d[d.length >> 1] : 0, mad = d.length ? d.map(x => Math.abs(x - med)).sort((a, b) => a - b)[d.length >> 1] : 0;
  window.__songlevel.cal = { offset: save.offset, n: d.length, jitter_mad: mad, outputLatency: S.ctx.outputLatency ?? null,
                             baseLatency: S.ctx.baseLatency ?? null, outputTimestamp: !!S.ctx.getOutputTimestamp };
  drawTitle();
  $('calv').textContent = `timing offset ${(save.offset * 1000).toFixed(0)} ms · jitter ${(mad * 1000).toFixed(0)} ms` +
    (d.length < 6 ? ' (not enough taps, try again)' : '');
}

// ---- performance_sample (Playgama telemetry guide): one aggregate every ~30 s of visible gameplay, never per frame ----
const perf = { dts: [], last: 0, t0: 0, active: 0,
  reset() { this.dts = []; this.last = 0; this.t0 = performance.now(); this.active = 0; },
  frame(now) { if (this.last) { const dt = now - this.last; if (dt < 2000) { this.dts.push(dt); this.active += dt; } } this.last = now;
    if (now - this.t0 >= 30000) this.flush(); },
  flush() { const d = this.dts.slice().sort((a, b) => a - b), n = d.length; if (n >= 30) {
      const q = p => d[Math.min(n - 1, Math.floor(p * n))], over = ms => d.filter(x => x > ms).length, fix = x => +x.toFixed(1);
      track('performance_sample', { target_fps: 60, window_ms: Math.round(performance.now() - this.t0), active_ms: Math.round(this.active), frame_count: n,
        fps_avg: fix(1000 * n / this.active), fps_p10: fix(1000 / q(0.9)), frame_time_p50_ms: fix(q(0.5)), frame_time_p95_ms: fix(q(0.95)), frame_time_p99_ms: fix(q(0.99)),
        frame_time_max_ms: fix(d[n - 1]), frames_over_50ms: over(50), frames_over_100ms: over(100), frames_over_250ms: over(250), frames_over_500ms: over(500),
        frames_over_1000ms: over(1000), game_version: VERSION }); }
    this.reset(); } };

// ---- render ----
// channel host pause (ads, platform pause): window.__channel.paused is non-empty and the host has suspended our
// AudioContext (so the song clock stands still); stop drawing until it clears, then offer Continue
const hostPaused = () => { const c = ch(); return !!(c && c.paused && Object.keys(c.paused).length); };
function waitResume() { if (hostPaused()) setTimeout(waitResume, 250); else { if (S.mode === 'play') pausePlay(); requestAnimationFrame(frame); } }
function rrect(c, x, y, w, h, r) { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); }
let sprites = null, spriteKey = '';
function makeSprites(lw, d) {
  const h = Math.round(22 * d), w = Math.round(lw - 10 * d), pad = Math.round(14 * d);
  sprites = LANE_COL.map(col => {
    const o = document.createElement('canvas'); o.width = w + 2 * pad; o.height = h + 2 * pad;
    const c = o.getContext('2d'); c.shadowColor = col; c.shadowBlur = 12 * d; c.fillStyle = col;
    rrect(c, pad, pad, w, h, 8 * d); c.fill(); c.shadowBlur = 0;
    const gr = c.createLinearGradient(0, pad, 0, pad + h); gr.addColorStop(0, 'rgba(255,255,255,.55)'); gr.addColorStop(0.55, 'rgba(255,255,255,0)');
    c.fillStyle = gr; rrect(c, pad, pad, w, h, 8 * d); c.fill();
    return { o, pad };
  });
}
function stage(W, H, now, d) {
  const hue = STAGE[S.song?.genre] ?? 265, bpm = S.level?.song?.bpm || 100;
  const clock = S.mode === 'play' || S.mode === 'paused' ? songTimeAt(now) : now / 1000;
  const phase = (clock * bpm / 60) % 1, pulse = Math.pow(1 - (phase < 0 ? phase + 1 : phase), 3);
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, `hsl(${hue} 55% ${10 + 5 * pulse}%)`); bg.addColorStop(0.7, '#0a0814');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 4; k++) {          // stage lights swing slowly and kick on the beat
    const a = Math.sin(clock * 0.33 + k * 1.7) * 0.5, x0 = W * (k + 0.5) / 4, len = H * 1.1, sp = 0.13;
    const gr = g.createLinearGradient(x0, 0, x0, len);
    gr.addColorStop(0, `hsla(${hue + k * 40} 90% 65% / ${0.13 + 0.14 * pulse})`); gr.addColorStop(1, 'hsla(0 0% 0% / 0)');
    g.fillStyle = gr; g.beginPath(); g.moveTo(x0, -10 * d);
    g.lineTo(x0 + Math.tan(a - sp) * len, len); g.lineTo(x0 + Math.tan(a + sp) * len, len); g.closePath(); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
}
function frame() {
  if (hostPaused()) { setTimeout(waitResume, 250); return; }
  const d = Math.min(2, devicePixelRatio || 1), cw = Math.round(cv.clientWidth * d), ch_ = Math.round(cv.clientHeight * d);
  if (cv.width !== cw || cv.height !== ch_) { cv.width = cw; cv.height = ch_; }
  const W = cw, H = ch_, now = performance.now();
  const fw = Math.min(W, Math.max(H * 0.72, 340 * d)), fx = (W - fw) / 2, lw = fw / 4, hitY = H * 0.84;
  view = { x: fx, lw, hitY, W, H };
  if (spriteKey !== lw + '/' + d) { makeSprites(lw, d); spriteKey = lw + '/' + d; }
  // a paused song stays paused even when the host resumes every context on return; platform mute runs silently (gain 0)
  if (S.ctx) {
    if (S.mode === 'paused' && S.ctx.state === 'running') S.ctx.suspend();
    if (S.mode === 'play' && S.ctx.state === 'suspended') S.ctx.resume();
    if (S.lastMuted !== platformMuted()) { S.lastMuted = platformMuted(); applyMute(); }
  }
  stage(W, H, now, d);
  g.fillStyle = 'rgba(8,6,18,.6)'; g.fillRect(fx, 0, fw, H);
  for (let l = 0; l < 4; l++) {
    const f = Math.max(0, 1 - (now - S.flash[l]) / 180);
    if (f > 0) { const gr = g.createLinearGradient(0, hitY, 0, hitY - H * 0.5); gr.addColorStop(0, LANE_COL[l] + '66'); gr.addColorStop(1, LANE_COL[l] + '00');
      g.globalAlpha = f; g.fillStyle = gr; g.fillRect(fx + l * lw, hitY - H * 0.5, lw, H * 0.5); g.globalAlpha = 1; }
    if (l) { g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(fx + l * lw - d / 2, 0, d, H); }
  }
  if (S.mode === 'play' || S.mode === 'paused') {
    const t = songTimeAt(now), r = S.ref;
    if (S.mode === 'play') {
      r.tick(t);
      if (r.cnt.miss > S.miss || r.cnt.brk > S.brk) { S.combo = 0; if (r.cnt.miss > S.miss) word(-1, 'MISS', '#ff6b8b'); S.miss = r.cnt.miss; S.brk = r.cnt.brk; }
      perf.frame(now);
      if (!r.alive) finish(false);
    }
    const px = hitY / LEAD;
    for (const n of r.notes) {
      if (n.done && !n.held) continue;
      const y = hitY - (n.t - t) * px;
      if (n.t - t > LEAD + 0.2) break;
      const sp = sprites[n.lane], cx = fx + n.lane * lw + 5 * d;
      if (n.hold > 0) { const top = y - n.hold * px, bot = n.held ? hitY : y;
        g.fillStyle = LANE_COL[n.lane] + (n.held ? 'cc' : '77'); rrect(g, fx + n.lane * lw + lw * 0.34, top, lw * 0.32, Math.max(0, bot - top), 6 * d); g.fill(); }
      g.drawImage(sp.o, cx - sp.pad, (n.held ? hitY : y) - 11 * d - sp.pad);
    }
  }
  // receptors + key labels
  for (let l = 0; l < 4; l++) {
    const f = Math.max(0, 1 - (now - S.flash[l]) / 180);
    g.strokeStyle = LANE_COL[l]; g.lineWidth = (2 + 2 * f) * d; g.globalAlpha = 0.75 + 0.25 * f;
    rrect(g, fx + l * lw + 5 * d, hitY - 11 * d, lw - 10 * d, 22 * d, 8 * d); g.stroke(); g.globalAlpha = 1;
    if (W >= 700 * d) { g.fillStyle = '#cfc8ea'; g.font = `600 ${13 * d}px system-ui`; g.textAlign = 'center'; g.fillText(KEY_NAMES[l], fx + (l + 0.5) * lw, hitY + 34 * d); }
  }
  // sparks + hit words
  for (const s of S.sparks) { const a = (now - s.t) / 1000; if (a > 0.4) continue;
    g.globalAlpha = 1 - a / 0.4; g.fillStyle = s.col; g.fillRect(s.x + s.vx * a - 2 * d, s.y + s.vy * a + 500 * d * a * a - 2 * d, 4 * d, 4 * d); }
  g.textAlign = 'center';
  for (const w of S.words) { const a = (now - w.t) / 450; if (a > 1) continue;
    g.globalAlpha = 1 - a; g.fillStyle = w.col; g.font = `800 ${(w.l < 0 ? 20 : 16) * d}px Display,system-ui`;
    g.fillText(w.text, w.l < 0 ? fx + fw / 2 : fx + (w.l + 0.5) * lw, hitY - (34 + 22 * a) * d); }
  g.globalAlpha = 1;
  if (S.mode === 'play' || S.mode === 'paused') {
    const r = S.ref, t = songTimeAt(now);
    g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(fx, 0, fw, 8 * d);
    g.fillStyle = r.hp > 0.3 ? '#06d6a0' : '#ff6b8b'; g.fillRect(fx, 0, fw * r.hp, 8 * d);
    g.fillStyle = '#7fe3ff'; g.fillRect(fx, 8 * d, fw * Math.max(0, Math.min(1, t / S.buf.duration)), 2 * d);
    if (S.combo >= 4) { g.fillStyle = '#f3f0ff'; g.font = `800 ${44 * d}px Display,system-ui`; g.fillText(S.combo, fx + fw / 2, H * 0.34);
      g.font = `600 ${12 * d}px system-ui`; g.fillStyle = '#cfc8ea'; g.fillText('COMBO', fx + fw / 2, H * 0.34 + 20 * d); }
    if (S.tut && S.mode === 'play') {       // first song: the next notes say what to do, right where the finger goes
      const next = r.notes.find(n => !n.done), hits = r.cnt.great + r.cnt.good;
      if (next && hits < TUTORIAL_NOTES && next.t - t < LEAD) {
        const p = 0.6 + 0.4 * Math.sin(now / 90);
        g.globalAlpha = p; g.fillStyle = LANE_COL[next.lane]; g.font = `800 ${18 * d}px Display,system-ui`;
        g.fillText(next.hold > 0 ? 'HOLD' : 'TAP', fx + (next.lane + 0.5) * lw, hitY + (W >= 700 * d ? 58 : 36) * d); g.globalAlpha = 1;
      } else if (hits >= TUTORIAL_NOTES && !S.tutDone) { S.tutDone = true; log('tutorial_done'); }
    }
  }
  if (S.mode === 'cal') {
    g.fillStyle = '#f3f0ff'; g.font = `800 ${24 * d}px Display,system-ui`; g.fillText('Tap with the clicks', W / 2, H * 0.4);
    g.font = `600 ${14 * d}px system-ui`; g.fillStyle = '#cfc8ea'; g.fillText('tap anywhere on the lanes', W / 2, H * 0.4 + 26 * d);
  }
  if (!bus.firstFrame) { bus.firstFrame = now; dispatchEvent(new Event('flutter-first-frame')); emit('ready'); }
  requestAnimationFrame(frame);
}

document.querySelectorAll('.tier').forEach(b => b.onclick = () => { S.tier = b.dataset.t; sfx('ui'); drawTitle(); });
const ui = (id, fn) => { $(id).onclick = () => { ensureCtx(); sfx('ui'); fn(); }; };
ui('play', () => start());
ui('again', () => { log('replay'); start(); });
ui('nextsong', async () => { $('nextsong').disabled = true; try { await pick(S.k + 1); await start(); } finally { $('nextsong').disabled = false; } });
ui('prev', () => pick(S.k - 1));
ui('next', () => pick(S.k + 1));
ui('back', () => { $('end').classList.add('hidden'); $('title').classList.remove('hidden'); S.mode = 'title'; drawTitle(); });
ui('like', () => { if ($('like').classList.contains('on')) return; log('like'); $('like').classList.add('on'); $('like').lastElementChild.textContent = 'Liked'; });
ui('cal', () => calibrate());
ui('pause', () => pausePlay());
ui('resume', () => resumePlay());
ui('stop', () => { $('paused').classList.add('hidden'); finish(true); });
ui('mute', () => { save.muted = !save.muted; applyMute(); persist(); });
addEventListener('pointerdown', () => { if (S.mode !== 'boot') ensureCtx(); }, true);   // browsers unlock audio only inside a gesture
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') pausePlay(); });
addEventListener('pagehide', () => { if (S.mode === 'play' || S.mode === 'paused') log('leave'); });

async function boot() {
  // Bridge required step 2: initialization finishes before the game loads anything (the host calls bridge.initialize)
  if (hosted()) for (let k = 0; k < 400 && !ch().bridgeReady && !ch().bridgeError; k++) await new Promise(r => setTimeout(r, 25));
  await loadSave();
  applyMute();
  S.idx = await (await fetch('levels/index.json')).json();
  S.today = todayIndex(S.idx);
  if (!save.tut) S.tier = 'easy';      // the first song is the easy chart
  await pick(S.today);
  S.mode = 'title'; $('title').classList.remove('hidden');
  requestAnimationFrame(frame);        // first frame only now: game_ready must mean playable
}
boot().catch(e => { console.error(e); $('title').classList.remove('hidden'); $('song').textContent = 'Could not load the setlist'; });
