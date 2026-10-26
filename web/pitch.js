// Pitch renderer: a floodlit stadium on one canvas, with three cameras.
//   "3d"      broadcast gantry view (true perspective projection, with height)
//   "follow"  the gantry camera zoomed in, panning with the ball like a TV match camera
//   "2d"      flat tactical view
// Switching blends the projections, so every camera move is animated.
// World coordinates are metres on a 105 x 68 pitch; z is height above the grass.
//
// Analytics layers (all computed in the browser from the positions in the feed):
//   space    who controls each patch of grass (nearest player, Voronoi style)
//   shape    each team's outfield block (convex hull), its width, depth and line height
//   heat     where a team or a player has been so far
//   network  the passing network over the last 15 minutes
//   trails   where every player has just run

const L = 105, W = 68, M = 4;
const SIGNAL = "#ffbf3c";
const LINE = "rgba(255,255,255,0.86)";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Broadcast camera: 40 m behind the near touchline, 105 m up, aimed at the centre spot
const CAM_H = 105, CAM_BACK = 40;
const THETA = Math.atan2(CAM_H, CAM_BACK + W / 2);
const SIN = Math.sin(THETA), COS = Math.cos(THETA);

function raw3d(x, y, z = 0) {
  const vx = x - L / 2, vy = z - CAM_H, vz = y - (W + CAM_BACK);
  const cy = vy * COS - vz * SIN;
  const cz = -vy * SIN - vz * COS;
  return [vx / cz, -cy / cz];
}
const raw2d = (x, y) => [x, y];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Mix a colour towards white (amt > 0) or black (amt < 0). */
function tone(hex, amt) {
  const [r, g, b] = hexRgb(hex);
  const t = amt > 0 ? 255 : 0, k = Math.abs(amt);
  return `rgb(${Math.round(r + (t - r) * k)},${Math.round(g + (t - g) * k)},${Math.round(b + (t - b) * k)})`;
}
const rgba = (hex, a) => { const [r, g, b] = hexRgb(hex); return `rgba(${r},${g},${b},${a})`; };

function hull(points) { // monotone chain convex hull
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export class PitchRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.bg = document.createElement("canvas");
    this.bgKey = null;
    this.heatCanvas = document.createElement("canvas");
    this.heatKey = null;
    this.marks = [];
    this.showNames = true;
    this.teamColor = { home: "#e4572e", away: "#2e86ab" };
    this.players = {};
    this.blend = 1; // 1 = broadcast, 0 = tactical
    this.target = 1;
    this.follow = false;
    this.cam = { z: 1, x: null, y: null };
    this.tele = null; // the AI Telestrator's drawings for the moment on air
    this.focus = null; // player followed in player-cam mode
    this.hover = null; // player under the mouse
    this.varLine = null; // VAR offside lines for a goal on air
    this.rain = false;
    this.layers = { space: false, shape: false, heat: false, network: false, trails: false };
    this.heat = null; // {grid, nx, ny, color, version}
    this.network = null; // {nodes, links, color}
    this.readouts = {}; // numbers the layers computed this frame (space share, line heights...)
    this.trails = {};
    this.ballTrail = [];
    this.party = null; // goal celebration: LED boards and camera flashes
    this.hits = [];
    this.boardText = "CHALK  ◆  THE AI PUNDIT THAT DRAWS ON THE PITCH  ◆  ";
    this.drops = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), v: 0.6 + Math.random() * 0.6 }));
    this.grain = this.makeGrain();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setRoster(players, colors, names = {}) {
    this.players = players;
    this.teamColor = colors;
    if (names.home) {
      this.boardText = `CHALK  ◆  ${names.home.toUpperCase()}  ◆  THE AI PUNDIT THAT DRAWS ON THE PITCH  ◆  ${names.away.toUpperCase()}  ◆  SYNTHETIC MATCH  ◆  `;
    }
    this.bgKey = null;
  }

  setView(view) {
    this.target = view === "2d" ? 0 : 1;
    this.follow = view === "follow";
    if (reduceMotion) this.blend = this.target;
  }

  /** Goal: the LED boards go to the scoring team's colour and the stands light up with camera flashes. */
  celebrate(color, text = "GOAL") {
    this.party = { color, text, born: performance.now() };
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
    const top = Math.min(130, Math.max(64, this.canvas.clientWidth * 0.105));
    const h = Math.round(w / probe.aspect + (top + 14) * dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.height = `${h / dpr}px`;
    this.dpr = dpr;
    this.cam3 = this.fit(raw3d, w, h, 18 * dpr, top * dpr, 14 * dpr);
    this.cam2 = this.fit(raw2d, w, h, 16 * dpr, 62 * dpr, 16 * dpr);
    this.bg.width = w;
    this.bg.height = h;
    this.heatCanvas.width = w;
    this.heatCanvas.height = h;
    this.bgKey = null;
    this.heatKey = null;
    this.cam = { z: 1, x: w / 2, y: h / 2 };
  }

  px(x, y, z = 0) {
    const a = this.cam3, b = this.cam2;
    const [ax, ay] = a.raw(x, y, z), [bx, by] = b.raw(x, y);
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

  poly(c, pts) {
    c.beginPath();
    pts.forEach((p, i) => {
      const [X, Y] = this.px(p[0], p[1], p[2] || 0);
      i ? c.lineTo(X, Y) : c.moveTo(X, Y);
    });
    c.closePath();
  }

  // ----------------------------------------------------------------- stadium
  makeGrain() {
    const g = document.createElement("canvas");
    g.width = g.height = 160;
    const c = g.getContext("2d");
    const r = rng(7);
    for (let i = 0; i < 5200; i++) {
      const light = r() > 0.5;
      c.fillStyle = light ? `rgba(190,255,200,${0.05 + r() * 0.07})` : `rgba(0,20,10,${0.08 + r() * 0.1})`;
      c.fillRect(r() * 160, r() * 160, 1 + r() * 1.5, 1 + r() * 2.5);
    }
    return g;
  }

  drawStands(c) {
    const r = rng(42);
    const home = this.teamColor.home, away = this.teamColor.away;
    const dark = "#0d0716";
    // far stand and the two ends rise away from the pitch
    const stands = [
      { kind: "far", seat: (u, d) => [u, -6.5 - d, d * 0.62], u0: -26, u1: L + 26, mix: [home, away, home, "#d9d4e6"] },
      { kind: "left", seat: (u, d) => [-7 - d, u, d * 0.62], u0: -14, u1: W + 14, mix: [home, home, "#d9d4e6"] },
      { kind: "right", seat: (u, d) => [L + 7 + d, u, d * 0.62], u0: -14, u1: W + 14, mix: [away, away, "#d9d4e6"] },
    ];
    for (const s of stands) {
      // the concrete bowl
      const corners = [s.seat(s.u0, 0), s.seat(s.u1, 0), s.seat(s.u1, 60), s.seat(s.u0, 60)];
      this.poly(c, corners);
      const [, ya] = this.px(...s.seat((s.u0 + s.u1) / 2, 0));
      const [, yb] = this.px(...s.seat((s.u0 + s.u1) / 2, 40));
      const g = c.createLinearGradient(0, ya, 0, yb);
      g.addColorStop(0, "#1c1328");
      g.addColorStop(1, dark);
      c.fillStyle = g;
      c.fill();
      // the crowd, row by row
      const size = Math.max(1.4, 2.1 * this.dpr * (this.blend * 0.6 + 0.4));
      for (let d = 0.6; d < 40; d += 0.85) {
        const fade = Math.max(0.15, 1 - d / 44);
        for (let u = s.u0; u < s.u1; u += 0.62 + r() * 0.2) {
          if (r() < 0.07) continue; // empty seats
          const [X, Y] = this.px(...s.seat(u, d));
          if (X < -4 || Y < -4 || X > this.bg.width + 4 || Y > this.bg.height + 4) continue;
          const col = s.mix[Math.floor(r() * s.mix.length)];
          c.globalAlpha = Math.min(1, fade * (0.6 + r() * 0.5));
          c.fillStyle = r() < 0.2 ? "#f1ecff" : r() < 0.12 ? "#2a1d3a" : col;
          c.fillRect(X - size / 2, Y - size, size, size * 1.25);
        }
      }
      c.globalAlpha = 1;
      // aisles
      c.strokeStyle = "rgba(255,255,255,0.05)";
      c.lineWidth = 1 * this.dpr;
      for (let u = s.u0 + 12; u < s.u1; u += 18) {
        c.beginPath();
        const [X0, Y0] = this.px(...s.seat(u, 0)), [X1, Y1] = this.px(...s.seat(u, 40));
        c.moveTo(X0, Y0); c.lineTo(X1, Y1); c.stroke();
      }
    }
    // a soft haze over the upper tiers so the pitch pops
    const yTop = this.px(L / 2, -6)[1];
    const haze = c.createLinearGradient(0, 0, 0, yTop);
    haze.addColorStop(0, "rgba(13,7,22,0.85)");
    haze.addColorStop(0.45, "rgba(13,7,22,0.25)");
    haze.addColorStop(1, "rgba(13,7,22,0)");
    c.fillStyle = haze;
    c.fillRect(0, 0, this.bg.width, this.bg.height);
    // the roof edge and its floodlight gantry
    if (this.blend > 0.5) {
      const w = this.bg.width, dpr = this.dpr, ry = Math.max(8 * dpr, yTop * 0.16);
      c.fillStyle = "#07040c";
      c.beginPath();
      c.moveTo(0, 0); c.lineTo(w, 0); c.lineTo(w, ry * 1.1); c.quadraticCurveTo(w / 2, ry * 0.55, 0, ry * 1.1); c.closePath();
      c.fill();
      c.globalCompositeOperation = "lighter";
      for (let i = 0; i < 26; i++) {
        const u = (i + 0.5) / 26;
        const x = u * w, y = ry * (1.1 - 0.55 * 4 * u * (1 - u) * 0.5) - 1.5 * dpr;
        const big = i % 5 === 2;
        const rr = (big ? 26 : 11) * dpr;
        const g = c.createRadialGradient(x, y, 0, x, y, rr);
        g.addColorStop(0, "rgba(255,255,245,0.95)");
        g.addColorStop(0.18, "rgba(255,250,220,0.45)");
        g.addColorStop(1, "rgba(255,250,220,0)");
        c.fillStyle = g;
        c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      }
      c.globalCompositeOperation = "source-over";
    }
  }

  drawGoal(c, side) {
    const x = side ? L : 0, d = side ? 1 : -1, y0 = W / 2 - 3.66, y1 = W / 2 + 3.66, H = 2.44, D = 2.1;
    const net = "rgba(255,255,255,0.32)";
    c.save();
    c.lineWidth = 0.8 * this.dpr;
    c.strokeStyle = net;
    const seg = (a, b) => { const [X0, Y0] = this.px(...a), [X1, Y1] = this.px(...b); c.beginPath(); c.moveTo(X0, Y0); c.lineTo(X1, Y1); c.stroke(); };
    // net: back, sides and roof
    for (let i = 0; i <= 10; i++) {
      const y = y0 + (y1 - y0) * (i / 10);
      seg([x + d * D, y, 0], [x + d * D, y, H * 0.85]);
      seg([x, y, H], [x + d * D, y, H * 0.85]);
    }
    for (let j = 0; j <= 5; j++) {
      const z = H * 0.85 * (j / 5);
      seg([x + d * D, y0, z], [x + d * D, y1, z]);
    }
    for (const y of [y0, y1]) {
      for (let k = 0; k <= 4; k++) seg([x + d * D * (k / 4), y, 0], [x + d * D * (k / 4), y, H - (H * 0.15) * (k / 4)]);
      seg([x, y, H * 0.5], [x + d * D, y, H * 0.45]);
    }
    // frame
    c.strokeStyle = "#ffffff";
    c.lineWidth = 2.6 * this.dpr;
    c.lineCap = "round";
    c.shadowColor = "rgba(255,255,255,0.6)";
    c.shadowBlur = 4 * this.dpr;
    c.beginPath();
    const pts = [[x, y0, 0], [x, y0, H], [x, y1, H], [x, y1, 0]].map((p) => this.px(...p));
    pts.forEach(([X, Y], i) => (i ? c.lineTo(X, Y) : c.moveTo(X, Y)));
    c.stroke();
    c.restore();
  }

  drawBoard() {
    const key = `${this.blend.toFixed(3)}|${this.teamColor.home}|${this.teamColor.away}`;
    if (key === this.bgKey) return;
    this.bgKey = key;
    const c = this.bg.getContext("2d");
    const w = this.bg.width, h = this.bg.height;
    c.clearRect(0, 0, w, h);
    // night sky and the stadium bowl
    const sky = c.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#120a1d");
    sky.addColorStop(1, "#0a1712");
    c.fillStyle = sky;
    c.fillRect(0, 0, w, h);
    this.drawStands(c);

    // run-off: the grass around the pitch, slightly darker
    this.poly(c, [[-M - 3, -M - 1.5], [L + M + 3, -M - 1.5], [L + M + 3, W + M + 3], [-M - 3, W + M + 3]]);
    c.fillStyle = "#123f31";
    c.fill();

    // the pitch: two-tone mowing stripes along x, and a lighter cross-cut along y
    const [, yFar] = this.px(L / 2, -M), [, yNear] = this.px(L / 2, W + M);
    const g = c.createLinearGradient(0, yFar, 0, yNear);
    g.addColorStop(0, "#1b5e45");
    g.addColorStop(1, "#257553");
    this.poly(c, [[-M, -M], [L + M, -M], [L + M, W + M], [-M, W + M]]);
    c.fillStyle = g;
    c.fill();
    const bands = 18;
    for (let i = 0; i < bands; i++) {
      const x0 = -M + (L + 2 * M) * (i / bands), x1 = -M + (L + 2 * M) * ((i + 1) / bands);
      this.poly(c, [[x0, -M], [x1, -M], [x1, W + M], [x0, W + M]]);
      c.fillStyle = i % 2 ? "rgba(255,255,255,0.045)" : "rgba(0,0,0,0.05)";
      c.fill();
    }
    for (let j = 0; j < 8; j++) {
      const y0 = -M + (W + 2 * M) * (j / 8), y1 = -M + (W + 2 * M) * ((j + 1) / 8);
      if (j % 2) continue;
      this.poly(c, [[-M, y0], [L + M, y0], [L + M, y1], [-M, y1]]);
      c.fillStyle = "rgba(255,255,255,0.022)";
      c.fill();
    }
    // grass grain
    c.save();
    this.poly(c, [[-M - 3, -M - 1.5], [L + M + 3, -M - 1.5], [L + M + 3, W + M + 3], [-M - 3, W + M + 3]]);
    c.clip();
    c.globalAlpha = 0.7;
    c.fillStyle = c.createPattern(this.grain, "repeat");
    c.fillRect(0, 0, w, h);
    c.globalAlpha = 1;
    // wear in the goalmouths and the centre circle
    for (const [x, y, r] of [[5, W / 2, 7], [L - 5, W / 2, 7], [L / 2, W / 2, 6]]) {
      const [X, Y] = this.px(x, y);
      const [rx] = this.groundRadii(x, y, r);
      const wg = c.createRadialGradient(X, Y, 0, X, Y, rx);
      wg.addColorStop(0, "rgba(150,140,90,0.16)");
      wg.addColorStop(1, "rgba(150,140,90,0)");
      c.fillStyle = wg;
      c.fillRect(X - rx, Y - rx, rx * 2, rx * 2);
    }
    // four floodlight pools from the corners
    c.globalCompositeOperation = "lighter";
    for (const [x, y] of [[-8, -10], [L + 8, -10], [-8, W + 10], [L + 8, W + 10]]) {
      const [X, Y] = this.px(x, y);
      const fl = c.createRadialGradient(X, Y, 0, X, Y, w * 0.55);
      fl.addColorStop(0, "rgba(255,255,235,0.10)");
      fl.addColorStop(0.5, "rgba(255,255,235,0.035)");
      fl.addColorStop(1, "rgba(255,255,235,0)");
      c.fillStyle = fl;
      c.fillRect(0, 0, w, h);
    }
    c.globalCompositeOperation = "source-over";
    c.restore();

    // markings, slightly glowing like fresh paint under floodlights
    c.save();
    c.shadowColor = "rgba(255,255,255,0.35)";
    c.shadowBlur = 3 * this.dpr;
    const line = (pts) => this.stroke(c, pts, LINE, 1.7);
    line([[0, 0], [L, 0], [L, W], [0, W], [0, 0]]);
    line([[L / 2, 0], [L / 2, W]]);
    this.stroke(c, this.arcPts(L / 2, W / 2, 9.15, 0, Math.PI * 2), LINE, 1.7);
    this.spot(c, L / 2, W / 2);
    for (const side of [0, 1]) {
      const x = side ? L : 0, d = side ? -1 : 1;
      line([[x, W / 2 - 20.16], [x + d * 16.5, W / 2 - 20.16], [x + d * 16.5, W / 2 + 20.16], [x, W / 2 + 20.16]]);
      line([[x, W / 2 - 9.16], [x + d * 5.5, W / 2 - 9.16], [x + d * 5.5, W / 2 + 9.16], [x, W / 2 + 9.16]]);
      this.spot(c, x + d * 11, W / 2);
      const a = Math.acos(5.5 / 9.15);
      const pts = side ? this.arcPts(x - 11, W / 2, 9.15, Math.PI - a, Math.PI + a)
                       : this.arcPts(x + 11, W / 2, 9.15, -a, a);
      this.stroke(c, pts, LINE, 1.7);
    }
    for (const [x, y, a0] of [[0, 0, 0], [L, 0, Math.PI / 2], [L, W, Math.PI], [0, W, -Math.PI / 2]]) {
      this.stroke(c, this.arcPts(x, y, 1, a0, a0 + Math.PI / 2, 10), LINE, 1.5);
    }
    c.restore();

    // goals and corner flags
    this.drawGoal(c, 0);
    this.drawGoal(c, 1);
    for (const [x, y] of [[0, 0], [L, 0], [0, W], [L, W]]) {
      const [X0, Y0] = this.px(x, y), [X1, Y1] = this.px(x, y, 1.6);
      c.strokeStyle = "#f4f1ff";
      c.lineWidth = 1.4 * this.dpr;
      c.beginPath(); c.moveTo(X0, Y0); c.lineTo(X1, Y1); c.stroke();
      const [X2, Y2] = this.px(x + (x ? -0.9 : 0.9), y, 1.35);
      c.fillStyle = SIGNAL;
      c.beginPath(); c.moveTo(X1, Y1); c.lineTo(X2, Y2); c.lineTo(X1, Y1 + (Y0 - Y1) * 0.35); c.closePath(); c.fill();
    }

    // vignette
    const v = c.createRadialGradient(w / 2, h * 0.55, h * 0.35, w / 2, h * 0.55, w * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.38)");
    c.fillStyle = v;
    c.fillRect(0, 0, w, h);
  }

  /** LED advertising boards round the pitch: scrolling text, and the scorer's colours after a goal. */
  drawLed(c, now) {
    const party = this.party && now - this.party.born < 5200 ? this.party : null;
    const t = now / 1000;
    const H = 1.15, yb = -3.4;
    const segs = 6;
    for (let i = 0; i < segs; i++) {
      const x0 = -1 + ((L + 2) / segs) * i + 0.15, x1 = -1 + ((L + 2) / segs) * (i + 1) - 0.15;
      const q = [[x0, yb, 0], [x1, yb, 0], [x1, yb, H], [x0, yb, H]].map((p) => this.px(...p));
      const top = Math.min(q[2][1], q[3][1]), bot = Math.max(q[0][1], q[1][1]);
      const left = Math.min(q[0][0], q[3][0]), right = Math.max(q[1][0], q[2][0]);
      const bh = bot - top;
      if (bh < 2) continue;
      c.save();
      c.beginPath();
      q.forEach(([X, Y], k) => (k ? c.lineTo(X, Y) : c.moveTo(X, Y)));
      c.closePath();
      const flash = party && Math.floor((now - party.born) / 260) % 2 === 0;
      c.fillStyle = party ? (flash ? party.color : "#0b0812") : "#0b0812";
      c.fill();
      c.clip();
      c.font = `800 ${Math.max(6, bh * 0.78)}px Archivo, system-ui, sans-serif`;
      c.textBaseline = "middle";
      c.fillStyle = party ? (flash ? "#ffffff" : party.color) : i % 2 ? SIGNAL : "#ffffff";
      const text = party ? `${party.text}  ◆  `.repeat(6) : this.boardText;
      const tw = c.measureText(text).width;
      const off = ((t * 42 * this.dpr + i * 97 * this.dpr) % tw);
      for (let x = left - off; x < right; x += tw) c.fillText(text, x, (top + bot) / 2 + 0.5);
      // LED pixel grid
      c.fillStyle = "rgba(0,0,0,0.25)";
      for (let y = top; y < bot; y += 2 * this.dpr) c.fillRect(left, y, right - left, 0.7 * this.dpr);
      c.restore();
    }
    // the ends: glowing panels
    for (const x of [-3.4, L + 3.4]) {
      for (let j = 0; j < 5; j++) {
        const y0 = 4 + j * 12.4, y1 = y0 + 11.6;
        const q = [[x, y0, 0], [x, y1, 0], [x, y1, H], [x, y0, H]];
        this.poly(c, q);
        const hue = party ? party.color : (j + Math.floor(t * 0.5)) % 2 ? SIGNAL : "#7d3cff";
        c.fillStyle = party ? rgba(party.color, 0.55 + 0.4 * Math.sin(t * 12)) : rgba(hue, 0.5);
        c.fill();
      }
    }
  }

  /** Camera flashes in the stands after a goal. */
  drawFlashes(c, now) {
    if (!this.party || reduceMotion) return;
    const age = now - this.party.born;
    if (age > 3200) return;
    const n = Math.round(14 * (1 - age / 3200));
    for (let i = 0; i < n; i++) {
      const d = 0.5 + Math.random() * 14, u = Math.random();
      const side = Math.random();
      const p = side < 0.6 ? [u * (L + 40) - 20, -6.5 - d, d * 0.62]
        : side < 0.8 ? [-7 - d, u * W, d * 0.62] : [L + 7 + d, u * W, d * 0.62];
      const [X, Y] = this.px(...p);
      const r = (2 + Math.random() * 3) * this.dpr;
      const g = c.createRadialGradient(X, Y, 0, X, Y, r * 3);
      g.addColorStop(0, "rgba(255,255,255,0.95)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g;
      c.fillRect(X - r * 3, Y - r * 3, r * 6, r * 6);
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

  clearMarks() {
    this.marks = [];
    this.trails = {};
    this.ballTrail = [];
  }

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
      } else if (m.kind === "ripple") { // a ring that spreads on the grass (tackles, interceptions)
        const [rx, ry, X, Y] = this.groundRadii(m.at[0], m.at[1], 1 + age * 4);
        c.save();
        c.globalAlpha = 0.7 * (1 - age);
        c.strokeStyle = color;
        c.lineWidth = 2 * this.dpr;
        c.beginPath();
        c.ellipse(X, Y, rx, ry, 0, 0, Math.PI * 2);
        c.stroke();
        c.restore();
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
  label(c, at, text, alpha = 1, tone_ = "dark", lift = 16) {
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
    const fill = tone_ === "signal" ? SIGNAL : tone_ === "focus" ? "#ffffff" : tone_ === "var" ? "#5ad1ff"
      : tone_ in this.teamColor ? this.teamColor[tone_] : "rgba(10, 8, 22, 0.86)";
    c.shadowColor = "rgba(0,0,0,0.35)";
    c.shadowBlur = 6 * dpr;
    c.shadowOffsetY = 2 * dpr;
    c.fillStyle = fill;
    c.beginPath();
    c.roundRect(x, y, w, h, h / 2);
    c.fill();
    c.shadowColor = "transparent";
    c.fillStyle = tone_ === "signal" ? "#1b1405" : tone_ === "focus" || tone_ === "var" ? "#2a0a3d" : "#ffffff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, X, y + h / 2 + 0.5 * dpr);
    c.restore();
  }

  // ------------------------------------------------------------------ layers
  drawSpace(c, frame) {
    // exact Voronoi cells: each player's cell is the pitch clipped by the bisector with every other player
    const pts = Object.entries(frame).filter(([pid]) => this.players[pid]).map(([pid, p]) => [p[0], p[1], this.players[pid].team]);
    if (pts.length < 4) return;
    const clip = (poly, a, b) => {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, nx = b[0] - a[0], ny = b[1] - a[1];
      const side = (p) => (p[0] - mx) * nx + (p[1] - my) * ny; // <= 0: closer to a
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const sp = side(p), sq = side(q);
        if (sp <= 0) out.push(p);
        if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
          const t = sp / (sp - sq);
          out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
      }
      return out;
    };
    const area = (poly) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    let homeArea = 0;
    const cells = pts.map((a, i) => {
      let poly = [[0, 0], [L, 0], [L, W], [0, W]];
      for (let j = 0; j < pts.length && poly.length; j++) if (j !== i) poly = clip(poly, a, pts[j]);
      if (a[2] === "home") homeArea += area(poly);
      return [poly, a[2]];
    });
    c.save();
    for (const [poly, team] of cells) {
      if (poly.length < 3) continue;
      this.poly(c, poly);
      c.fillStyle = rgba(this.teamColor[team], 0.22);
      c.fill();
      c.strokeStyle = "rgba(255,255,255,0.28)";
      c.lineWidth = 1 * this.dpr;
      c.stroke();
    }
    c.restore();
    const home = Math.round((100 * homeArea) / (L * W));
    this.readouts.space = { home, away: 100 - home };
  }

  drawShape(c, frame) {
    this.readouts.shape = {};
    for (const team of ["home", "away"]) {
      const out = Object.entries(frame).filter(([pid]) => this.players[pid]?.team === team && this.players[pid].position !== "GK")
        .map(([, p]) => p);
      if (out.length < 3) continue;
      const hl = hull(out);
      const col = this.teamColor[team];
      c.save();
      this.poly(c, hl);
      c.fillStyle = rgba(col, 0.14);
      c.fill();
      c.setLineDash([6 * this.dpr, 5 * this.dpr]);
      c.strokeStyle = rgba(col, 0.95);
      c.lineWidth = 2 * this.dpr;
      c.stroke();
      c.restore();
      // the back line: the four deepest outfield players
      const dir = team === "home" ? 1 : -1;
      const deep = out.slice().sort((a, b) => (a[0] - b[0]) * dir).slice(0, 4);
      const lx = deep.reduce((s, p) => s + p[0], 0) / deep.length;
      c.save();
      c.strokeStyle = col;
      c.lineWidth = 2.2 * this.dpr;
      c.shadowColor = col;
      c.shadowBlur = 6 * this.dpr;
      const [X0, Y0] = this.px(lx, 0), [X1, Y1] = this.px(lx, W);
      c.beginPath(); c.moveTo(X0, Y0); c.lineTo(X1, Y1); c.stroke();
      c.restore();
      const xs = out.map((p) => p[0]), ys = out.map((p) => p[1]);
      const width = Math.round(Math.max(...ys) - Math.min(...ys)), depth = Math.round(Math.max(...xs) - Math.min(...xs));
      const height = Math.round(team === "home" ? lx : L - lx);
      this.readouts.shape[team] = { width, depth, line: height };
      this.label(c, [lx, -1.5], `Line ${height} m`, 0.95, team, 4);
      const cx = xs.reduce((s, v) => s + v, 0) / xs.length;
      this.label(c, [cx, Math.min(...ys)], `${width} × ${depth} m`, 0.95, team, 10);
    }
  }

  drawHeat(c) {
    const h = this.heat;
    if (!h) return;
    const key = `${h.version}|${this.blend.toFixed(3)}|${this.bg.width}`;
    if (key !== this.heatKey) {
      this.heatKey = key;
      const hc = this.heatCanvas.getContext("2d");
      hc.clearRect(0, 0, this.heatCanvas.width, this.heatCanvas.height);
      const { grid, nx, ny } = h;
      let max = 0;
      for (const v of grid) max = Math.max(max, v);
      if (max > 0) {
        const up = 2, NX = nx * up, NY = ny * up, cw = L / NX, ch = W / NY;
        const val = (x, y) => { // bilinear sample of the coarse grid
          const gx = Math.min(nx - 1.001, Math.max(0, x / (L / nx) - 0.5)), gy = Math.min(ny - 1.001, Math.max(0, y / (W / ny) - 0.5));
          const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
          const a = grid[j * nx + i], b = grid[j * nx + Math.min(nx - 1, i + 1)];
          const d = grid[Math.min(ny - 1, j + 1) * nx + i], e = grid[Math.min(ny - 1, j + 1) * nx + Math.min(nx - 1, i + 1)];
          return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
        };
        const [r0, g0, b0] = hexRgb(h.color);
        for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
          const v = val((i + 0.5) * cw, (j + 0.5) * ch) / max;
          if (v < 0.06) continue;
          // team colour, warming to amber then white in the hottest spots
          const k2 = Math.max(0, (v - 0.55) / 0.45);
          const r = Math.round(r0 + (255 - r0) * k2), g = Math.round(g0 + (215 - g0) * k2), b = Math.round(b0 + (120 - b0) * k2);
          hc.fillStyle = `rgba(${r},${g},${b},${Math.min(0.72, v * 0.85)})`;
          const a = this.px(i * cw, j * ch), bb = this.px((i + 1) * cw, j * ch), d = this.px((i + 1) * cw, (j + 1) * ch), e = this.px(i * cw, (j + 1) * ch);
          hc.beginPath(); hc.moveTo(a[0], a[1]); hc.lineTo(bb[0], bb[1]); hc.lineTo(d[0] + 0.6, d[1] + 0.6); hc.lineTo(e[0], e[1]); hc.closePath(); hc.fill();
        }
      }
    }
    c.save();
    c.filter = "blur(3px)";
    c.drawImage(this.heatCanvas, 0, 0);
    c.restore();
  }

  drawNetwork(c) {
    const n = this.network;
    if (!n || !n.nodes.length) return;
    const pos = Object.fromEntries(n.nodes.map((d) => [d.pid, d]));
    const maxL = Math.max(1, ...n.links.map((l) => l.n));
    c.save();
    c.lineCap = "round";
    for (const l of n.links) {
      const a = pos[l.a], b = pos[l.b];
      if (!a || !b) continue;
      const [X0, Y0] = this.px(a.x, a.y), [X1, Y1] = this.px(b.x, b.y);
      c.strokeStyle = rgba("#ffffff", 0.25 + 0.6 * (l.n / maxL));
      c.lineWidth = (1 + 6 * (l.n / maxL)) * this.dpr;
      c.beginPath(); c.moveTo(X0, Y0); c.lineTo(X1, Y1); c.stroke();
    }
    const maxN = Math.max(1, ...n.nodes.map((d) => d.n));
    for (const d of n.nodes) {
      const [X, Y] = this.px(d.x, d.y);
      const r = (7 + 9 * (d.n / maxN)) * this.dpr;
      c.beginPath(); c.arc(X, Y, r, 0, Math.PI * 2);
      c.fillStyle = n.color; c.fill();
      c.lineWidth = 2 * this.dpr; c.strokeStyle = "#ffffff"; c.stroke();
      c.fillStyle = "#ffffff";
      c.font = `800 ${Math.round(r * 0.95)}px Archivo, system-ui, sans-serif`;
      c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText(String(this.players[d.pid]?.number ?? ""), X, Y + 0.5);
    }
    c.restore();
  }

  recordTrails(frame, ball, now) {
    if (!this.lastTrail || now - this.lastTrail > 80) {
      this.lastTrail = now;
      for (const [pid, p] of Object.entries(frame)) {
        const tr = (this.trails[pid] ||= []);
        const last = tr.at(-1);
        if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) > 9) tr.length = 0; // a seek, not a run
        tr.push([p[0], p[1], now]);
        while (tr.length && now - tr[0][2] > 1800) tr.shift();
      }
    }
    if (ball) {
      const bt = this.ballTrail, last = bt.at(-1);
      if (last && Math.hypot(last[0] - ball[0], last[1] - ball[1]) > 30) bt.length = 0;
      if (!last || Math.hypot(last[0] - ball[0], last[1] - ball[1]) > 0.25) bt.push([ball[0], ball[1], ball[2] || 0, now]);
      while (bt.length && now - bt[0][3] > 520) bt.shift();
    }
  }

  drawTrails(c, now) {
    c.save();
    c.lineCap = "round";
    for (const [pid, tr] of Object.entries(this.trails)) {
      const p = this.players[pid];
      if (!p || tr.length < 2) continue;
      for (let i = 1; i < tr.length; i++) {
        const a = 1 - (now - tr[i][2]) / 1800;
        const [X0, Y0] = this.px(tr[i - 1][0], tr[i - 1][1]), [X1, Y1] = this.px(tr[i][0], tr[i][1]);
        c.strokeStyle = rgba(this.teamColor[p.team], Math.max(0, a) * 0.85);
        c.lineWidth = (1 + 3 * a) * this.dpr;
        c.beginPath(); c.moveTo(X0, Y0); c.lineTo(X1, Y1); c.stroke();
      }
    }
    c.restore();
  }

  // ------------------------------------------------------------------ camera
  updateCamera(ball) {
    const w = this.canvas.width, h = this.canvas.height;
    const following = this.follow && this.blend > 0.5 && !this.tele && ball;
    const zt = following ? 1.75 : 1;
    let tx = w / 2, ty = h / 2;
    if (following) [tx, ty] = this.px(ball[0], ball[1]);
    const cam = this.cam;
    const k = reduceMotion ? 1 : 0.07;
    cam.z += (zt - cam.z) * k;
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    // keep the view inside the canvas
    const hw = w / (2 * cam.z), hh = h / (2 * cam.z);
    cam.x = Math.max(hw, Math.min(w - hw, cam.x));
    cam.y = Math.max(hh, Math.min(h - hh, cam.y));
    return [cam.z, 0, 0, cam.z, w / 2 - cam.x * cam.z, h / 2 - cam.y * cam.z];
  }

  /** The player under a mouse position (client coordinates), or null. */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = ((clientX - rect.left) / rect.width) * this.canvas.width;
    const sy = ((clientY - rect.top) / rect.height) * this.canvas.height;
    const [z, , , , ox, oy] = this.view || [1, 0, 0, 1, 0, 0];
    const x = (sx - ox) / z, y = (sy - oy) / z;
    let best = null, bd = Infinity;
    for (const hit of this.hits) {
      const d = Math.hypot(hit.X - x, hit.Y - y);
      if (d < hit.r * 1.6 && d < bd) { best = hit.pid; bd = d; }
    }
    return best;
  }

  /** Where a player is drawn, in client coordinates (to anchor DOM cards). */
  clientPos(pid) {
    const hit = this.hits.find((h) => h.pid === pid);
    if (!hit) return null;
    const rect = this.canvas.getBoundingClientRect();
    const [z, , , , ox, oy] = this.view || [1, 0, 0, 1, 0, 0];
    return [((hit.X * z + ox) / this.canvas.width) * rect.width, ((hit.Y * z + oy) / this.canvas.height) * rect.height];
  }

  // ------------------------------------------------------------------ frame
  draw(frame, ball, carrier, now, ballZ = 0) {
    if (this.blend !== this.target) {
      const step = 0.06;
      this.blend = Math.abs(this.target - this.blend) < step ? this.target
        : this.blend + Math.sign(this.target - this.blend) * step;
    }
    this.drawBoard();
    const c = this.ctx;
    this.placed = []; // label boxes drawn this frame, to avoid overlaps
    this.readouts = {};
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.view = this.updateCamera(ball);
    c.setTransform(...this.view);
    c.drawImage(this.bg, 0, 0);
    this.drawLed(c, now);
    this.drawFlashes(c, now);
    this.recordTrails(frame, ball ? [ball[0], ball[1], ballZ] : null, now);

    const lay = this.layers;
    if (lay.heat) this.drawHeat(c);
    if (lay.space) this.drawSpace(c, frame);
    if (lay.shape) this.drawShape(c, frame);
    if (lay.trails) this.drawTrails(c, now);

    const tele = this.tele;
    if (tele) this.drawTelestration(c, frame, now, "under");

    for (const [pid, color, dash] of [[this.focus, "rgba(255,255,255,0.9)", true], [this.hover, SIGNAL, false]]) {
      if (!pid || !frame[pid]) continue;
      const [x, y] = frame[pid];
      const [rx, ry, X, Y] = this.groundRadii(x, y, 3.2);
      c.save();
      c.strokeStyle = color;
      if (dash) c.setLineDash([4 * this.dpr, 4 * this.dpr]);
      c.lineWidth = 2 * this.dpr;
      c.beginPath();
      c.ellipse(X, Y, rx, ry, 0, 0, Math.PI * 2);
      c.stroke();
      if (!dash) { c.globalAlpha = 0.18; c.fillStyle = color; c.fill(); }
      c.restore();
    }

    // carrier ring sits on the grass, under everything
    if (!tele && carrier && frame[carrier]) {
      const [x, y] = frame[carrier];
      const [rx, ry, X, Y] = this.groundRadii(x, y, 2.4);
      const pulse = reduceMotion ? 0 : (Math.sin(now / 160) + 1) / 2;
      c.save();
      c.strokeStyle = SIGNAL;
      c.lineWidth = 2.4 * this.dpr;
      c.shadowColor = SIGNAL;
      c.shadowBlur = (4 + 6 * pulse) * this.dpr;
      c.beginPath();
      c.ellipse(X, Y, rx, ry, 0, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }
    if (!tele) this.drawMarks(now);
    if (lay.network) this.drawNetwork(c);

    // players, far to near so nearer chips overlap farther ones
    const lift = this.blend;
    const entries = Object.entries(frame).filter(([pid]) => this.players[pid])
      .sort((a, b) => a[1][1] - b[1][1]);
    // floodlight shadows: four soft shadows per player, one from each corner tower
    c.save();
    c.fillStyle = "rgba(0,0,0,0.13)";
    for (const [, [x, y]] of entries) {
      for (const [dx, dy] of [[0.9, 0.7], [-0.9, 0.7], [0.9, -0.7], [-0.9, -0.7]]) {
        const [rx, ry, X, Y] = this.groundRadii(x + dx, y + dy, 1.05);
        c.beginPath(); c.ellipse(X, Y, rx, ry, 0, 0, Math.PI * 2); c.fill();
      }
    }
    c.restore();
    this.hits = [];
    const netDim = lay.network ? 0.35 : 1;
    for (const [pid, [x, y]] of entries) {
      const p = this.players[pid];
      const col = this.teamColor[p.team];
      const [rx, ry, X, Y] = this.groundRadii(x, y, 1.25);
      c.save();
      c.globalAlpha = netDim;
      c.fillStyle = "rgba(0,0,0,0.4)";
      c.beginPath();
      c.ellipse(X, Y, rx * 0.8, ry * 0.8, 0, 0, Math.PI * 2);
      c.fill();
      // chips stay readable on large screens without crowding on phones
      const r = Math.max(rx * 1.1, Math.min(9, this.canvas.clientWidth / 60) * this.dpr);
      const cy = Y - r * 0.95 * lift;
      // the puck: a darker rim underneath, a lit face on top
      c.beginPath();
      c.arc(X, cy + r * 0.2 * lift, r, 0, Math.PI * 2);
      c.fillStyle = tone(col, -0.45);
      c.fill();
      const face = c.createRadialGradient(X - r * 0.35, cy - r * 0.45, r * 0.1, X, cy, r * 1.05);
      face.addColorStop(0, tone(col, 0.38));
      face.addColorStop(0.55, col);
      face.addColorStop(1, tone(col, -0.2));
      c.beginPath();
      c.arc(X, cy, r, 0, Math.PI * 2);
      c.fillStyle = face;
      c.fill();
      c.lineWidth = (p.position === "GK" ? 2.4 : 1.3) * this.dpr;
      c.strokeStyle = p.position === "GK" ? "#ffffff" : "rgba(255,255,255,0.7)";
      c.stroke();
      // gloss
      c.beginPath();
      c.ellipse(X - r * 0.15, cy - r * 0.5, r * 0.55, r * 0.28, -0.3, 0, Math.PI * 2);
      c.fillStyle = "rgba(255,255,255,0.18)";
      c.fill();
      c.fillStyle = "#ffffff";
      c.shadowColor = "rgba(0,0,0,0.45)";
      c.shadowBlur = 2 * this.dpr;
      c.font = `800 ${Math.round(r * 1.02)}px Archivo, system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(p.number), X, cy + r * 0.06);
      c.restore();
      this.hits.push({ pid, X, Y: cy, r });
    }

    if (ball) this.drawBall(c, ball, ballZ, lift, now);

    if (this.varLine) this.drawVarLine(c, now);
    if (tele) this.drawTelestration(c, frame, now, "over");
    const tagged = new Set();
    for (const pid of [this.hover, this.focus, tele ? null : carrier]) {
      if (!pid || tagged.has(pid) || !frame[pid] || !this.players[pid]) continue;
      if (pid !== this.focus && pid !== this.hover && !this.showNames) continue;
      tagged.add(pid);
      const [x, y] = frame[pid];
      this.label(c, [x, y], this.players[pid].short, 1, pid === this.focus || pid === this.hover ? "focus" : "dark", this.chipLift(x, y));
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    this.drawRain(c);
  }

  drawBall(c, ball, z, lift, now) {
    // trail
    const bt = this.ballTrail;
    if (bt.length > 1 && !reduceMotion) {
      c.save();
      c.lineCap = "round";
      for (let i = 1; i < bt.length; i++) {
        const a = 1 - (now - bt[i][3]) / 520;
        const [X0, Y0] = this.px(bt[i - 1][0], bt[i - 1][1], bt[i - 1][2] * lift);
        const [X1, Y1] = this.px(bt[i][0], bt[i][1], bt[i][2] * lift);
        c.strokeStyle = `rgba(255,255,255,${Math.max(0, a) * 0.55})`;
        c.lineWidth = (0.5 + 3 * a) * this.dpr;
        c.beginPath(); c.moveTo(X0, Y0); c.lineTo(X1, Y1); c.stroke();
      }
      c.restore();
    }
    const [rx, ry, X, Y] = this.groundRadii(ball[0], ball[1], 0.55);
    const r = Math.max(rx, 3.6 * this.dpr);
    const hz = Math.min(1, z / 8);
    // shadow on the grass shrinks and fades as the ball rises
    c.fillStyle = `rgba(0,0,0,${0.4 - 0.25 * hz})`;
    c.beginPath();
    c.ellipse(X + r * 0.3, Y + r * 0.3, r * (1 - 0.3 * hz), Math.max(ry, r * 0.6) * (1 - 0.3 * hz), 0, 0, Math.PI * 2);
    c.fill();
    const [BX, BY0] = this.px(ball[0], ball[1], z * lift);
    const BY = BY0 - r * 0.4 * lift;
    const br = r * (1 + 0.25 * hz * lift);
    const g = c.createRadialGradient(BX - br * 0.35, BY - br * 0.35, br * 0.1, BX, BY, br);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(1, "#b9c3cc");
    c.beginPath();
    c.arc(BX, BY, br, 0, Math.PI * 2);
    c.fillStyle = g;
    c.fill();
    c.lineWidth = 1 * this.dpr;
    c.strokeStyle = "rgba(0,0,0,0.4)";
    c.stroke();
    // a panel that turns as the ball rolls
    const spin = (ball[0] + ball[1]) * 0.9;
    c.fillStyle = "rgba(30,20,50,0.55)";
    c.beginPath();
    c.arc(BX + Math.cos(spin) * br * 0.35, BY + Math.sin(spin) * br * 0.35, br * 0.3, 0, Math.PI * 2);
    c.fill();
  }

  // ------------------------------------------------------------- weather
  drawRain(c) {
    if (!this.rain || reduceMotion) return;
    const w = this.canvas.width, h = this.canvas.height;
    c.save();
    c.strokeStyle = "rgba(220, 235, 255, 0.16)";
    c.lineWidth = 1.1 * this.dpr;
    c.beginPath();
    for (const d of this.drops) {
      d.y += 0.011 * d.v;
      d.x -= 0.0016 * d.v;
      if (d.y > 1.05) { d.y = -0.05; d.x = Math.random() * 1.1; }
      const x = d.x * w, y = d.y * h;
      c.moveTo(x, y);
      c.lineTo(x - 3 * this.dpr * d.v, y + 16 * this.dpr * d.v);
    }
    c.stroke();
    c.restore();
  }

  // ---------------------------------------------------------- VAR lines
  showVarLine(offside) {
    this.varLine = offside ? { o: offside, born: performance.now() } : null;
  }

  drawVarLine(c, now) {
    const { o, born } = this.varLine;
    const k = reduceMotion ? 1 : Math.max(0, Math.min(1, (now - born) / 650));
    const y1 = W * k;
    const lineAt = (x, color, width) => {
      c.save();
      c.strokeStyle = color;
      c.lineWidth = width * this.dpr;
      c.shadowColor = color;
      c.shadowBlur = 8 * this.dpr;
      c.beginPath();
      const [X0, Y0] = this.px(x, 0), [X1, Y1] = this.px(x, y1);
      c.moveTo(X0, Y0);
      c.lineTo(X1, Y1);
      c.stroke();
      c.restore();
    };
    // the gap between attacker and defender, tinted green when onside
    const quad = [[o.receiver_x, 0], [o.line_x, 0], [o.line_x, y1], [o.receiver_x, y1]].map(([x, y]) => this.px(x, y));
    c.save();
    c.beginPath();
    quad.forEach(([X, Y], i) => (i ? c.lineTo(X, Y) : c.moveTo(X, Y)));
    c.closePath();
    c.fillStyle = o.onside ? "rgba(70, 200, 130, 0.22)" : "rgba(255, 77, 94, 0.25)";
    c.fill();
    c.restore();
    lineAt(o.line_x, "#5ad1ff", 2.6);
    lineAt(o.receiver_x, o.onside ? "#7ee2a8" : "#ff4d5e", 2.6);
    if (k >= 1) {
      const label = `${o.onside ? "Onside" : "Offside"} by ${Math.abs(o.margin_m).toFixed(1)} m`;
      this.label(c, [(o.line_x + o.receiver_x) / 2, 0], `VAR  ${label}`, 1, "var", 8);
    }
  }

  chipLift(x, y) {
    const [rx] = this.groundRadii(x, y, 1.25);
    const r = Math.max(rx * 1.1, Math.min(9, this.canvas.clientWidth / 60) * this.dpr);
    return (r * 2.2 * this.blend) / this.dpr + 8;
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
