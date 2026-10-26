// Pitch renderer with two cameras that share one canvas:
//   "3d"  broadcast gantry view (true perspective projection)
//   "2d"  flat tactical view
// Switching blends the two projections, so the camera move is animated.
// World coordinates are metres on a 105 x 68 pitch.

const L = 105, W = 68, M = 4;
const SIGNAL = "#ffbf3c";
const LINE = "rgba(255,255,255,0.82)";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Broadcast camera: 40 m behind the near touchline, 105 m up, aimed at the centre spot
const CAM_H = 105, CAM_BACK = 40;
const THETA = Math.atan2(CAM_H, CAM_BACK + W / 2);
const SIN = Math.sin(THETA), COS = Math.cos(THETA);

function raw3d(x, y) {
  const vx = x - L / 2, vy = -CAM_H, vz = y - (W + CAM_BACK);
  const cx = vx;
  const cy = vy * COS - vz * SIN;
  const cz = -vy * SIN - vz * COS;
  return [cx / cz, -cy / cz];
}
const raw2d = (x, y) => [x, y];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export class PitchRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.bg = document.createElement("canvas");
    this.bgKey = null;
    this.marks = [];
    this.showNames = true;
    this.teamColor = { home: "#e4572e", away: "#2e86ab" };
    this.players = {};
    this.blend = 1; // 1 = broadcast, 0 = tactical
    this.target = 1;
    this.tele = null; // the AI Telestrator's drawings for the moment on air
    this.focus = null; // player followed in player-cam mode
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setRoster(players, colors) {
    this.players = players;
    this.teamColor = colors;
  }

  setView(view) {
    this.target = view === "3d" ? 1 : 0;
    if (reduceMotion) this.blend = this.target;
  }

  // ------------------------------------------------------------ projection
  fit(raw, w, h, padX, padTop, padBottom) {
    const corners = [[-M, -M], [L + M, -M], [-M, W + M], [L + M, W + M]].map(([x, y]) => raw(x, y));
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const s = Math.min((w - 2 * padX) / (x1 - x0), (h - padTop - padBottom) / (y1 - y0));
    const ox = (w - (x1 - x0) * s) / 2 - x0 * s;
    const oy = padTop + (h - padTop - padBottom - (y1 - y0) * s) / 2 - y0 * s;
    return { raw, s, ox, oy, aspect: (x1 - x0) / (y1 - y0) };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    if (!w) return;
    // canvas aspect follows the broadcast camera; the tactical view is letterboxed into it
    const probe = this.fit(raw3d, 1000, 1000, 0, 0, 0);
    const h = Math.round(w / probe.aspect + 60 * dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.height = `${h / dpr}px`;
    this.dpr = dpr;
    this.cam3 = this.fit(raw3d, w, h, 16 * dpr, 50 * dpr, 12 * dpr);
    this.cam2 = this.fit(raw2d, w, h, 16 * dpr, 62 * dpr, 16 * dpr);
    this.bg.width = w;
    this.bg.height = h;
    this.bgKey = null;
  }

  px(x, y) {
    const a = this.cam3, b = this.cam2;
    const [ax, ay] = a.raw(x, y), [bx, by] = b.raw(x, y);
    const p3 = [a.ox + ax * a.s, a.oy + ay * a.s];
    const p2 = [b.ox + bx * b.s, b.oy + by * b.s];
    const k = this.blend;
    return [p2[0] + (p3[0] - p2[0]) * k, p2[1] + (p3[1] - p2[1]) * k];
  }

  // pixel radii of a ground circle of radius r metres at (x, y)
  groundRadii(x, y, r) {
    const [cx, cy] = this.px(x, y);
    const [ex] = this.px(x + r, y);
    const [, ny] = this.px(x, y + r);
    const [, fy] = this.px(x, y - r);
    return [Math.abs(ex - cx), Math.abs(ny - fy) / 2, cx, cy];
  }

  // ----------------------------------------------------------------- board
  drawBoard() {
    const key = this.blend.toFixed(3);
    if (key === this.bgKey) return;
    this.bgKey = key;
    const c = this.bg.getContext("2d");
    c.clearRect(0, 0, this.bg.width, this.bg.height);
    const quad = (x0, y0, x1, y1) => {
      const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => this.px(x, y));
      c.beginPath();
      pts.forEach(([X, Y], i) => (i ? c.lineTo(X, Y) : c.moveTo(X, Y)));
      c.closePath();
    };
    // grass with mowing stripes, darker towards the far side
    const [, yFar] = this.px(L / 2, -M), [, yNear] = this.px(L / 2, W + M);
    const g = c.createLinearGradient(0, yFar, 0, yNear);
    g.addColorStop(0, "#1a5644");
    g.addColorStop(1, "#22684f");
    quad(-M, -M, L + M, W + M);
    c.fillStyle = g;
    c.fill();
    for (let i = 0; i < 14; i += 2) {
      quad(i * L / 14, 0, (i + 1) * L / 14, W);
      c.fillStyle = "rgba(255,255,255,0.035)";
      c.fill();
    }
    // floodlight bloom
    const [cxp, cyp] = this.px(L / 2, W / 2);
    const bloom = c.createRadialGradient(cxp, cyp, 0, cxp, cyp, this.bg.width * 0.55);
    bloom.addColorStop(0, "rgba(255,255,240,0.10)");
    bloom.addColorStop(1, "rgba(255,255,240,0)");
    quad(-M, -M, L + M, W + M);
    c.fillStyle = bloom;
    c.fill();

    const line = (pts) => this.stroke(c, pts, LINE, 1.6);
    line([[0, 0], [L, 0], [L, W], [0, W], [0, 0]]);
    line([[L / 2, 0], [L / 2, W]]);
    this.stroke(c, this.arcPts(L / 2, W / 2, 9.15, 0, Math.PI * 2), LINE, 1.6);
    this.spot(c, L / 2, W / 2);
    for (const side of [0, 1]) {
      const x = side ? L : 0, d = side ? -1 : 1;
      line([[x, W / 2 - 20.16], [x + d * 16.5, W / 2 - 20.16], [x + d * 16.5, W / 2 + 20.16], [x, W / 2 + 20.16]]);
      line([[x, W / 2 - 9.16], [x + d * 5.5, W / 2 - 9.16], [x + d * 5.5, W / 2 + 9.16], [x, W / 2 + 9.16]]);
      this.stroke(c, [[x, W / 2 - 3.66], [x - d * 1.6, W / 2 - 3.66], [x - d * 1.6, W / 2 + 3.66], [x, W / 2 + 3.66]],
                  "rgba(255,255,255,0.95)", 2.2);
      this.spot(c, x + d * 11, W / 2);
      const a = Math.acos(5.5 / 9.15);
      const pts = side ? this.arcPts(x - 11, W / 2, 9.15, Math.PI - a, Math.PI + a)
                       : this.arcPts(x + 11, W / 2, 9.15, -a, a);
      this.stroke(c, pts, LINE, 1.6);
    }
  }

  arcPts(x, y, r, a0, a1, n = 56) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
    return pts;
  }

  stroke(c, pts, color, width) {
    c.save();
    c.strokeStyle = color;
    c.lineWidth = width * this.dpr;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.beginPath();
    pts.forEach(([x, y], i) => {
      const [X, Y] = this.px(x, y);
      i ? c.lineTo(X, Y) : c.moveTo(X, Y);
    });
    c.stroke();
    c.restore();
  }

  spot(c, x, y) {
    const [rx, ry, X, Y] = this.groundRadii(x, y, 0.3);
    c.fillStyle = LINE;
    c.beginPath();
    c.ellipse(X, Y, Math.max(rx, 1.5), Math.max(ry, 1), 0, 0, Math.PI * 2);
    c.fill();
  }

  // Hand-drawn telestration stroke: a few slightly offset passes, like a marker
  chalk(c, pts, color, width, alpha, seed) {
    const r = rng(seed);
    c.save();
    c.strokeStyle = color;
    c.lineCap = "round";
    c.lineJoin = "round";
    for (let pass = 0; pass < 3; pass++) {
      c.globalAlpha = alpha * (pass ? 0.4 : 1);
      c.lineWidth = width * this.dpr * (pass ? 0.65 : 1);
      c.beginPath();
      pts.forEach(([x, y], i) => {
        const [X, Y] = this.px(x, y);
        const j = pass ? (r() - 0.5) * 1.4 * this.dpr : 0;
        i ? c.lineTo(X + j, Y + j) : c.moveTo(X + j, Y + j);
      });
      c.stroke();
    }
    c.restore();
  }

  // ------------------------------------------------------- transient marks
  addMark(mark) {
    this.marks.push({ born: performance.now(), ttl: 1400, ...mark });
    if (this.marks.length > 40) this.marks.shift();
  }

  clearMarks() { this.marks = []; }

  drawMarks(now) {
    const c = this.ctx;
    this.marks = this.marks.filter((m) => now - m.born < m.ttl);
    for (const m of this.marks) {
      const age = (now - m.born) / m.ttl;
      const fade = age < 0.75 ? 1 : 1 - (age - 0.75) / 0.25;
      const grow = reduceMotion ? 1 : Math.min(1, (now - m.born) / 280);
      const color = m.color || "#ffffff";
      if (m.kind === "line") {
        const [x0, y0] = m.from;
        const to = [x0 + (m.to[0] - x0) * grow, y0 + (m.to[1] - y0) * grow];
        c.save();
        if (m.dashed) c.setLineDash([7 * this.dpr, 6 * this.dpr]);
        this.chalk(c, [m.from, to], color, m.width || 2, 0.9 * fade, m.seed || 3);
        c.restore();
        if (m.arrow && grow >= 1) this.arrowHead(c, m.from, m.to, color, fade);
      } else if (m.kind === "label") {
        this.label(c, m.at, m.text, fade, m.tone, m.lift ?? 16);
      }
    }
  }

  arrowHead(c, from, to, color, alpha) {
    const [X0, Y0] = this.px(...from), [X1, Y1] = this.px(...to);
    const ang = Math.atan2(Y1 - Y0, X1 - X0);
    const len = 10 * this.dpr;
    c.save();
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(X1, Y1);
    c.lineTo(X1 - Math.cos(ang - 0.42) * len, Y1 - Math.sin(ang - 0.42) * len);
    c.lineTo(X1 - Math.cos(ang + 0.42) * len, Y1 - Math.sin(ang + 0.42) * len);
    c.closePath();
    c.fill();
    c.restore();
  }

  // pill label anchored above a pitch point
  label(c, at, text, alpha = 1, tone = "dark", lift = 16) {
    const [X, Y] = this.px(at[0], at[1]);
    const dpr = this.dpr;
    c.save();
    c.globalAlpha = alpha;
    c.font = `700 ${Math.round(12 * dpr)}px Archivo, system-ui, sans-serif`;
    const w = c.measureText(text).width + 14 * dpr;
    const h = 20 * dpr;
    const x = X - w / 2;
    let y = Y - lift * dpr - h;
    // nudge up past any label already drawn here
    const hits = (yy) => (this.placed || []).some((b) => x < b.x + b.w + 2 && x + w > b.x - 2 && yy < b.y + b.h + 2 && yy + h > b.y - 2);
    for (let i = 0; i < 6 && hits(y); i++) y -= h + 3 * dpr;
    (this.placed ||= []).push({ x, y, w, h });
    c.fillStyle = tone === "signal" ? SIGNAL : tone === "focus" ? "#ffffff" : "rgba(10, 22, 30, 0.86)";
    c.beginPath();
    c.roundRect(x, y, w, h, h / 2);
    c.fill();
    c.fillStyle = tone === "signal" ? "#1b1405" : tone === "focus" ? "#2a0a3d" : "#ffffff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, X, y + h / 2 + 0.5 * dpr);
    c.restore();
  }

  // ------------------------------------------------------------------ frame
  draw(frame, ball, carrier, now) {
    if (this.blend !== this.target) {
      const step = 0.06;
      this.blend = Math.abs(this.target - this.blend) < step ? this.target
        : this.blend + Math.sign(this.target - this.blend) * step;
    }
    this.drawBoard();
    const c = this.ctx;
    this.placed = []; // label boxes drawn this frame, to avoid overlaps
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.drawImage(this.bg, 0, 0);

    const tele = this.tele;
    if (tele) this.drawTelestration(c, frame, now, "under");

    if (this.focus && frame[this.focus]) {
      const [x, y] = frame[this.focus];
      const [rx, ry, X, Y] = this.groundRadii(x, y, 3.2);
      c.save();
      c.strokeStyle = "rgba(255,255,255,0.9)";
      c.setLineDash([4 * this.dpr, 4 * this.dpr]);
      c.lineWidth = 2 * this.dpr;
      c.beginPath();
      c.ellipse(X, Y, rx, ry, 0, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }

    // carrier ring sits on the grass, under everything
    if (!tele && carrier && frame[carrier]) {
      const [x, y] = frame[carrier];
      const [rx, ry, X, Y] = this.groundRadii(x, y, 2.4);
      c.save();
      c.strokeStyle = SIGNAL;
      c.lineWidth = 2.4 * this.dpr;
      c.beginPath();
      c.ellipse(X, Y, rx, ry, 0, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }
    if (!tele) this.drawMarks(now);

    // players, far to near so nearer chips overlap farther ones
    const lift = this.blend;
    const entries = Object.entries(frame).filter(([pid]) => this.players[pid])
      .sort((a, b) => a[1][1] - b[1][1]);
    for (const [pid, [x, y]] of entries) {
      const p = this.players[pid];
      const [rx, ry, X, Y] = this.groundRadii(x, y, 1.25);
      c.fillStyle = "rgba(0,0,0,0.28)";
      c.beginPath();
      c.ellipse(X, Y, rx, ry, 0, 0, Math.PI * 2);
      c.fill();
      // chips stay readable on large screens without crowding on phones
      const r = Math.max(rx * 1.1, Math.min(8.5, this.canvas.clientWidth / 62) * this.dpr);
      const cy = Y - r * 0.95 * lift;
      c.beginPath();
      c.arc(X, cy, r, 0, Math.PI * 2);
      c.fillStyle = this.teamColor[p.team];
      c.fill();
      c.lineWidth = (p.position === "GK" ? 2.2 : 1.2) * this.dpr;
      c.strokeStyle = p.position === "GK" ? "#ffffff" : "rgba(255,255,255,0.55)";
      c.stroke();
      c.fillStyle = "#ffffff";
      c.font = `800 ${Math.round(r * 1.02)}px Archivo, system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(p.number), X, cy + r * 0.05);
    }

    if (ball) {
      const [rx, ry, X, Y] = this.groundRadii(ball[0], ball[1], 0.55);
      const r = Math.max(rx, 3.5 * this.dpr);
      c.fillStyle = "rgba(0,0,0,0.35)";
      c.beginPath();
      c.ellipse(X + r * 0.3, Y + r * 0.3, r, Math.max(ry, r * 0.6), 0, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.arc(X, Y - r * 0.4 * lift, r, 0, Math.PI * 2);
      c.fillStyle = "#ffffff";
      c.fill();
      c.lineWidth = 1 * this.dpr;
      c.strokeStyle = "rgba(0,0,0,0.35)";
      c.stroke();
    }

    if (tele) this.drawTelestration(c, frame, now, "over");
    const tagged = new Set();
    for (const pid of [this.focus, tele ? null : carrier]) {
      if (!pid || tagged.has(pid) || !frame[pid] || !this.players[pid]) continue;
      if (pid !== this.focus && !this.showNames) continue;
      tagged.add(pid);
      const [x, y] = frame[pid];
      this.label(c, [x, y], this.players[pid].short, 1, pid === this.focus ? "focus" : "dark", this.chipLift(x, y));
    }
  }

  chipLift(x, y) {
    const [rx] = this.groundRadii(x, y, 1.25);
    const r = Math.max(rx * 1.1, Math.min(8.5, this.canvas.clientWidth / 62) * this.dpr);
    return (r * 2 * this.blend) / this.dpr + 8;
  }

  // --------------------------------------------------------- telestration
  // Drawings from the AI Telestrator, revealed one stroke at a time.
  showTelestration(drawings) {
    this.tele = drawings && drawings.length ? { drawings, born: performance.now() } : null;
  }

  clearTelestration() {
    this.tele = null;
  }

  teleProgress(i, now) {
    const STAGGER = 750, GROW = 520;
    if (reduceMotion) return 1;
    return Math.max(0, Math.min(1, (now - this.tele.born - 250 - i * STAGGER) / GROW));
  }

  drawTelestration(c, frame, now, layer) {
    const ink = SIGNAL;
    this.tele.drawings.forEach((d, i) => {
      const k = this.teleProgress(i, now);
      if (k <= 0) return;
      if (layer === "under") {
        if (d.type === "zone") this.teleZone(c, d.points, k);
        if (d.type === "circle" && frame[d.player]) this.teleRing(c, frame[d.player], k);
        return;
      }
      if (d.type === "arrow") {
        const to = [d.from[0] + (d.to[0] - d.from[0]) * k, d.from[1] + (d.to[1] - d.from[1]) * k];
        c.save();
        const dash = { pass: [9, 6], run: [2, 7], carry: [5, 4] }[d.style];
        if (dash) c.setLineDash(dash.map((v) => v * this.dpr));
        this.chalk(c, [d.from, to], d.style === "shot" ? "#ffffff" : ink, d.style === "shot" ? 3.4 : 3, 0.95, 7 + i);
        c.restore();
        if (k >= 1) this.arrowHead(c, d.from, d.to, d.style === "shot" ? "#ffffff" : ink, 1);
        if (k >= 1 && d.label) this.label(c, d.to, d.label, 1, "signal", 14);
      } else if (d.type === "link") {
        const [a, b] = (d.players || []).map((p) => frame[p]);
        if (!a || !b) return;
        const to = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
        c.save();
        c.setLineDash([3 * this.dpr, 5 * this.dpr]);
        this.chalk(c, [a, to], "#ffffff", 2.4, 0.95, 21 + i);
        c.restore();
        if (k >= 1 && d.label) this.label(c, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d.label, 1, "signal", 6);
      } else if (d.type === "circle" && frame[d.player] && k >= 1 && d.label) {
        const [x, y] = frame[d.player];
        this.label(c, [x, y], d.label, 1, "signal", this.chipLift(x, y) + 2);
      } else if (d.type === "zone" && k >= 1 && d.label) {
        const pts = d.points;
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        this.label(c, [cx, cy], d.label, 1, "signal", -10);
      }
    });
  }

  teleRing(c, [x, y], k) {
    const [rx, ry, X, Y] = this.groundRadii(x, y, 2.6);
    c.save();
    c.strokeStyle = SIGNAL;
    c.lineCap = "round";
    // a pundit's circle: drawn once round and a little past the start
    for (const [w, a, off] of [[3.2, 1, 0], [1.6, 0.45, 0.06]]) {
      c.globalAlpha = a;
      c.lineWidth = w * this.dpr;
      c.beginPath();
      c.ellipse(X, Y, rx * (1 + off), ry * (1 + off), 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2.15 * k);
      c.stroke();
    }
    c.restore();
  }

  teleZone(c, points, k) {
    if (!points || points.length < 3) return;
    c.save();
    c.beginPath();
    points.forEach(([x, y], i) => {
      const [X, Y] = this.px(x, y);
      i ? c.lineTo(X, Y) : c.moveTo(X, Y);
    });
    c.closePath();
    c.fillStyle = `rgba(255, 191, 60, ${0.2 * k})`;
    c.fill();
    c.setLineDash([6 * this.dpr, 5 * this.dpr]);
    c.strokeStyle = `rgba(255, 191, 60, ${0.9 * k})`;
    c.lineWidth = 2 * this.dpr;
    c.stroke();
    c.restore();
  }
}
