// Broadcast effects: event stingers, chalk confetti and a procedural stadium.
// Everything here is generated in the browser: no images, no recorded audio.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// --------------------------------------------------------------- stingers
export class Stingers {
  constructor() {
    this.el = $("stinger");
    this.until = 0;
    this.confetti = new Confetti($("fxCanvas"));
    this.timer = null;
  }

  /** True while a stinger holds the broadcast. */
  active(now = performance.now()) {
    return now < this.until;
  }

  show(html, cls, ms) {
    clearTimeout(this.timer);
    this.el.className = `stinger ${cls}`;
    this.el.innerHTML = html;
    this.el.hidden = false;
    this.until = performance.now() + ms;
    this.timer = setTimeout(() => this.hide(), ms);
  }

  hide() {
    this.el.hidden = true;
    this.until = 0;
  }

  goal({ team, teamName, color, scorer, number, clock, xg, speed, distance, scoreText }) {
    const html = `
      <div class="st-bands" aria-hidden="true">
        <span style="background:${color}"></span><span></span><span style="background:${color}"></span>
      </div>
      <div class="st-goal">
        <p class="st-word" aria-label="Goal">${"GOAL".split("").map((c, i) => `<span style="--i:${i}">${c}</span>`).join("")}</p>
        <p class="st-who"><span class="st-num" style="background:${color}">${esc(number)}</span>${esc(scorer)}<span class="st-clock">${esc(clock)}</span></p>
        <p class="st-stats">
          <span>xG <b>${esc(xg)}</b></span><span><b>${esc(speed)}</b> km/h</span><span><b>${esc(distance)}</b> m</span>
        </p>
        <p class="st-score">${esc(scoreText)}</p>
      </div>`;
    this.show(html, `is-goal team-${team}`, reduceMotion ? 2200 : 3300);
    if (!reduceMotion) this.confetti.burst(color);
  }

  redCard({ player, number, teamName, color, clock, left }) {
    const html = `
      <div class="st-red">
        <div class="st-card" aria-hidden="true"></div>
        <div class="st-red-text">
          <p class="st-kicker">${esc(clock)} Sent off</p>
          <p class="st-who"><span class="st-num" style="background:${color}">${esc(number)}</span>${esc(player)}</p>
          <p class="st-sub">${esc(teamName)} down to ${esc(left)}</p>
        </div>
      </div>`;
    this.show(html, "is-red", 2700);
  }

  substitution({ teamName, color, inNum, inName, outNum, outName, clock }) {
    const html = `
      <div class="st-board">
        <p class="st-board-head" style="background:${color}">${esc(teamName)}<span>${esc(clock)}</span></p>
        <div class="st-board-body">
          <div class="st-led out"><span class="arrow" aria-hidden="true">▼</span><span class="digits">${esc(String(outNum).padStart(2, "0"))}</span><span class="name">${esc(outName)}</span></div>
          <div class="st-led in"><span class="arrow" aria-hidden="true">▲</span><span class="digits">${esc(String(inNum).padStart(2, "0"))}</span><span class="name">${esc(inName)}</span></div>
        </div>
      </div>`;
    this.show(html, "is-sub", 2600);
  }

  tactics({ teamName, color, from, to, clock }) {
    const html = `
      <div class="st-tactic">
        <p class="st-kicker">${esc(clock)} Change of shape</p>
        <p class="st-team" style="color:${color}">${esc(teamName)}</p>
        <p class="st-forms"><span>${esc(from)}</span><span class="to" aria-label="to">→</span><span class="new">${esc(to)}</span></p>
      </div>`;
    this.show(html, "is-tactic", 2500);
  }

  period({ label, scoreText }) {
    const html = `<div class="st-period"><p class="st-word-sm">${esc(label)}</p><p class="st-score">${esc(scoreText)}</p></div>`;
    this.show(html, "is-period", 2400);
  }
}

// ----------------------------------------------------------------- confetti
class Confetti {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.bits = [];
    this.running = false;
  }

  burst(teamColor) {
    const r = this.c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.c.width = r.width * dpr;
    this.c.height = r.height * dpr;
    this.dpr = dpr;
    const colors = ["#ffbf3c", "#ffffff", teamColor, "#ffbf3c"];
    for (let i = 0; i < 160; i++) {
      this.bits.push({
        x: this.c.width * (0.15 + Math.random() * 0.7),
        y: -20 * dpr - Math.random() * this.c.height * 0.4,
        vx: (Math.random() - 0.5) * 3 * dpr,
        vy: (2 + Math.random() * 4) * dpr,
        w: (4 + Math.random() * 6) * dpr,
        h: (2 + Math.random() * 3) * dpr,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        color: colors[i % colors.length],
      });
    }
    if (!this.running) {
      this.running = true;
      requestAnimationFrame(() => this.step());
    }
  }

  step() {
    const { ctx, c } = this;
    ctx.clearRect(0, 0, c.width, c.height);
    this.bits = this.bits.filter((b) => b.y < c.height + 20);
    for (const b of this.bits) {
      b.x += b.vx;
      b.y += b.vy;
      b.vy += 0.04 * this.dpr;
      b.rot += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (this.bits.length) requestAnimationFrame(() => this.step());
    else { this.running = false; ctx.clearRect(0, 0, c.width, c.height); }
  }
}

// ------------------------------------------------------------------ stadium
/** A crowd synthesised from filtered noise, plus a referee's whistle. */
export class Stadium {
  constructor() {
    this.on = false;
    this.ctx = null;
  }

  start() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      const ctx = this.ctx;
      const len = ctx.sampleRate * 3;
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < len; i++) { // pink-ish noise: a warmer crowd than white noise
          const w = Math.random() * 2 - 1;
          b0 = 0.99765 * b0 + w * 0.099046;
          b1 = 0.963 * b1 + w * 0.2965164;
          b2 = 0.57 * b2 + w * 1.0526913;
          d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
        }
      }
      this.noise = buf;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(ctx.destination);
      // the bed: a murmur that breathes slowly
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 650;
      bp.Q.value = 0.6;
      this.bed = ctx.createGain();
      this.bed.gain.value = 0;
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.17;
      lfoGain.gain.value = 0.012;
      lfo.connect(lfoGain).connect(this.bed.gain);
      src.connect(bp).connect(this.bed).connect(this.master);
      src.start();
      lfo.start();
    }
    this.ctx.resume?.();
    this.on = true;
    this.setLevel(0.05);
    return true;
  }

  stop() {
    this.on = false;
    if (this.ctx) this.bed.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
  }

  setLevel(v) {
    if (!this.on || !this.ctx) return;
    this.bed.gain.setTargetAtTime(v, this.ctx.currentTime, 0.8);
  }

  /** The crowd follows the match: louder when it gets chaotic, quiet when paused. */
  follow(chaos, playing, ducked) {
    if (!this.on) return;
    let v = playing ? 0.045 + Math.max(0, Math.min(1, (chaos || 1) - 0.7)) * 0.05 : 0.012;
    if (ducked) v *= 0.45;
    this.setLevel(v);
  }

  swell({ peak, attack, decay, freq, q = 0.5, sweepTo = null }) {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(freq, t);
    if (sweepTo) bp.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + 0.6);
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random() * 2);
    src.stop(t + attack + decay + 0.1);
  }

  roar() { this.swell({ peak: 0.55, attack: 0.25, decay: 4.2, freq: 700, q: 0.4, sweepTo: 1300 }); }

  ooh() { this.swell({ peak: 0.22, attack: 0.5, decay: 1.6, freq: 420, q: 0.9, sweepTo: 300 }); }

  whistle(count = 1, long = false) {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx;
    let t = ctx.currentTime + 0.05;
    for (let i = 0; i < count; i++) {
      const dur = long && i === count - 1 ? 1.1 : 0.42;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.03);
      g.gain.setValueAtTime(0.09, t + dur - 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const trem = ctx.createOscillator();
      const tremGain = ctx.createGain();
      trem.frequency.value = 32; // the pea rattling inside the whistle
      tremGain.gain.value = 0.04;
      trem.connect(tremGain).connect(g.gain);
      for (const f of [2950, 3180]) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        o.connect(g);
        o.start(t);
        o.stop(t + dur);
      }
      g.connect(this.master);
      trem.start(t);
      trem.stop(t + dur);
      t += dur + 0.22;
    }
  }
}
