// Mirror of songlevel/sim.py judge() constants and rules (tests/crosscheck.mjs keeps them equal).
export const GREAT = 0.050, GOOD = 0.120, HOLD_SLACK = 0.10;
export const D = { great: 0.02, good: 0.01, miss: -0.08, ghost: -0.03, brk: -0.06 };
export const PASS_HITS = 0.70; // sim.py PASS_HITS
export const TIER = { easy: [0.150, -0.05], normal: [0.120, -0.08], hard: [0.095, -0.10] }; // sim.py TIER
export const LETHAL = { easy: false, normal: false, hard: true }; // sim.py LETHAL: health ends a song only on hard

// Live referee: feed presses/releases in song time; call tick(t) every frame to expire misses.
export class Referee {
  constructor(notes, tier = 'normal') {
    [this.good, this.dMiss] = TIER[tier]; this.lethal = LETHAL[tier];
    this.notes = notes.map(([t, lane, hold], i) => ({ t, lane, hold, i, hit: false, done: false, held: false }));
    this.byLane = [[], [], [], []];
    for (const n of this.notes) this.byLane[n.lane].push(n);
    this.hp = 1; this.alive = true;
    this.cnt = { great: 0, good: 0, miss: 0, ghost: 0, brk: 0 };
    this.active = [null, null, null, null]; // hold note being held per lane
    this.last = null;
  }
  _apply(kind) {
    this.cnt[kind]++; this.last = kind;
    if (!this.alive) return;
    this.hp = Math.min(1, this.hp + (kind === 'miss' ? this.dMiss : D[kind]));
    if (this.hp <= 0) { this.hp = 0; this.alive = !this.lethal; }
  }
  press(t, lane) {
    const n = this.byLane[lane].find(n => !n.done && Math.abs(n.t - t) <= this.good);
    if (!n) return this._apply('ghost');
    n.done = n.hit = true;
    this._apply(Math.abs(n.t - t) <= GREAT ? 'great' : 'good');
    if (n.hold > 0) { n.held = true; this.active[lane] = n; }
  }
  release(t, lane) {
    const n = this.active[lane];
    if (!n) return;
    this.active[lane] = null; n.held = false;
    if (t < n.t + n.hold - HOLD_SLACK) this._apply('brk');
  }
  tick(t) {
    for (const n of this.notes) if (!n.done && t > n.t + this.good) { n.done = true; this._apply('miss'); }
    for (let l = 0; l < 4; l++) { const n = this.active[l]; if (n && t >= n.t + n.hold) { this.active[l] = null; n.held = false; } }
  }
  passed() { return this.alive && this.cnt.ghost <= this.notes.length && this.cnt.great + this.cnt.good >= PASS_HITS * this.notes.length; }
  acc() { return (this.cnt.great + 0.5 * this.cnt.good) / Math.max(1, this.notes.length); }
}
