// The interactive layer around the pitch: analytics layers, a heatmap tracker, the
// passing network, a live win-probability model, the event card stack, clickable
// players with a player card, and small motion touches (tab ink, panel spotlight).
// Every number here is computed in the browser from the match feed.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const L = 105, W = 68;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ heatmaps
/** Time spent in each 3 x 3 m patch, per team and per player. */
export class Heat {
  constructor() {
    this.nx = 35;
    this.ny = 23;
    this.reset();
  }

  reset() {
    const n = this.nx * this.ny;
    this.team = { home: new Float32Array(n), away: new Float32Array(n) };
    this.player = {};
    this.lastT = 0;
  }

  add(ev, teamOf) {
    const dt = Math.max(0, Math.min(4, ev.t - this.lastT));
    this.lastT = ev.t;
    if (!ev.frame || !dt) return;
    for (const [pid, [x, y]] of Object.entries(ev.frame)) {
      const team = teamOf(pid);
      if (!team) continue;
      const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x / L) * this.nx)));
      const j = Math.min(this.ny - 1, Math.max(0, Math.floor((y / W) * this.ny)));
      const k = j * this.nx + i;
      this.team[team][k] += dt;
      (this.player[pid] ||= new Float32Array(this.nx * this.ny))[k] += dt;
    }
  }

  blurred(grid) {
    const { nx, ny } = this;
    let a = Float32Array.from(grid || new Float32Array(nx * ny));
    for (let pass = 0; pass < 2; pass++) {
      const b = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        let s = 0, w = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const k = (2 - Math.abs(di)) * (2 - Math.abs(dj));
          s += a[jj * nx + ii] * k; w += k;
        }
        b[j * nx + i] = s / w;
      }
      a = b;
    }
    return a;
  }
}

/** Passing network over the last 15 minutes: average positions and pass links. */
export function passNetwork(events, idx, team, teamOf) {
  const T = events[idx]?.t ?? 0;
  const sums = {}, pairs = {}, involve = {};
  for (let i = idx; i >= 0 && events[i].t >= T - 900; i--) {
    const ev = events[i];
    if (ev.frame) {
      for (const [pid, [x, y]] of Object.entries(ev.frame)) {
        if (teamOf(pid) !== team) continue;
        const s = (sums[pid] ||= [0, 0, 0]);
        s[0] += x; s[1] += y; s[2]++;
      }
    }
    if (ev.type === "pass" && ev.team === team && ev.outcome === "complete" && ev.to) {
      const key = [ev.player, ev.to].sort().join("|");
      pairs[key] = (pairs[key] || 0) + 1;
      involve[ev.player] = (involve[ev.player] || 0) + 1;
      involve[ev.to] = (involve[ev.to] || 0) + 1;
    }
  }
  const onPitch = Object.keys(events[idx]?.frame || {}).filter((pid) => teamOf(pid) === team);
  const nodes = onPitch.filter((pid) => sums[pid]).map((pid) => ({
    pid, x: sums[pid][0] / sums[pid][2], y: sums[pid][1] / sums[pid][2], n: involve[pid] || 0 }));
  const links = Object.entries(pairs).filter(([, n]) => n >= 2).map(([k, n]) => {
    const [a, b] = k.split("|");
    return { a, b, n };
  });
  return { nodes, links };
}

// ------------------------------------------------------------ win probability
function poisson(mu, kmax = 10) {
  const out = [];
  let p = Math.exp(-mu);
  for (let k = 0; k <= kmax; k++) { out.push(p); p *= mu / (k + 1); }
  return out;
}

/**
 * Live win probability: each team's remaining goals are Poisson, with a scoring rate that
 * blends a prior with the xG it has created so far, adjusted for red cards.
 */
export function winProbability({ T, score, xg, men }) {
  const played = T / 60, remaining = Math.max(0, 93 - played);
  const w = Math.min(0.5, played / 120); // the match so far counts, but one half is a small sample
  const rate = (side, prior) => {
    const observed = xg[side] / Math.max(10, played);
    let r = (1 - w) * prior + w * observed;
    const diff = men[side] - men[side === "home" ? "away" : "home"];
    r *= diff < 0 ? 0.78 ** -diff : 1.12 ** diff;
    return r;
  };
  const ph = poisson(rate("home", 1.45 / 90) * remaining), pa = poisson(rate("away", 1.2 / 90) * remaining);
  let home = 0, draw = 0, away = 0;
  for (let a = 0; a < ph.length; a++) for (let b = 0; b < pa.length; b++) {
    const p = ph[a] * pa[b], h = score.home + a, x = score.away + b;
    if (h > x) home += p; else if (h < x) away += p; else draw += p;
  }
  const s = home + draw + away;
  const H = Math.round((100 * home) / s), A = Math.round((100 * away) / s);
  return { home: H, away: A, draw: Math.max(0, 100 - H - A) };
}

// ------------------------------------------------------------- event stack
const EV_ICONS = {
  shot: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
  goal: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.6l2.6 1.9-1 3H6.4l-1-3z" fill="currentColor"/>',
  foul: '<path d="M8 2.2l6 10.8H2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.2v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  card: '<rect x="4.5" y="2.5" width="7" height="11" rx="1.2" fill="currentColor"/>',
  sub: '<path d="M3 5.5h9l-2.5-2.5M13 10.5H4l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  shape: '<circle cx="4" cy="4" r="1.6" fill="currentColor"/><circle cx="12" cy="4" r="1.6" fill="currentColor"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/><circle cx="4" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  speed: '<path d="M2 5h6M1 8h7M3 11h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M9 3.5l5 4.5-5 4.5z" fill="currentColor"/>',
};

export class EventStack {
  constructor(replay) {
    this.r = replay;
    this.el = $("evStack");
  }

  clear() { this.el.innerHTML = ""; }

  card(ev) {
    const r = this.r, name = (pid) => r.roster[pid]?.short ?? "";
    switch (ev.type) {
      case "shot": {
        if (ev.outcome === "goal") return null;
        const title = { saved: "Shot saved", blocked: "Shot blocked", off_target: "Shot off target" }[ev.outcome] || "Shot";
        return { icon: "shot", title, sub: `${name(ev.player)} · xG ${ev.xg.toFixed(2)} · ${ev.speed_kmh} km/h`, hot: ev.xg >= 0.25 };
      }
      case "goal":
        return { icon: "goal", title: "GOAL", sub: `${name(ev.player)} · ${ev.score.home}-${ev.score.away}`, hot: true };
      case "foul":
        return { icon: "foul", title: "Foul", sub: `${name(ev.player)} on ${name(ev.on)}` };
      case "card":
        return { icon: "card", title: ev.card === "red" ? "Red card" : "Yellow card", sub: name(ev.player), red: ev.card === "red", yellow: ev.card !== "red" };
      case "substitution":
        return { icon: "sub", title: "Substitution", sub: `${name(ev.player)} on · ${name(ev.player_off)} off` };
      case "formation_change":
        return { icon: "shape", title: "Change of shape", sub: `${ev.from} → ${ev.to}` };
      case "sprint":
        return ev.speed_kmh >= 33.5 ? { icon: "speed", title: "Top speed", sub: `${name(ev.player)} · ${ev.speed_kmh} km/h` } : null;
      default:
        return null;
    }
  }

  push(ev) {
    const c = this.card(ev);
    if (!c) return;
    const li = document.createElement("li");
    li.className = `ev-card${c.hot ? " hot" : ""}${c.red ? " red" : ""}${c.yellow ? " yellow" : ""}`;
    li.style.setProperty("--team", this.r.colors[ev.team] || "#ffffff");
    li.innerHTML = `<svg class="ev-ic" viewBox="0 0 16 16" aria-hidden="true">${EV_ICONS[c.icon]}</svg>
      <span class="ev-body"><b>${esc(c.title)}</b><small>${esc(c.sub)}</small></span><span class="ev-clock">${esc(ev.clock)}</span>`;
    this.el.prepend(li);
    while (this.el.children.length > 4) this.el.lastElementChild.remove();
    setTimeout(() => { li.classList.add("out"); setTimeout(() => li.remove(), 450); }, 6500);
  }
}

// ------------------------------------------------------------- player card
export class PlayerCard {
  constructor(replay) {
    this.r = replay;
    this.el = $("pcard");
    this.pid = null;
    const cv = replay.pitch.canvas;
    cv.addEventListener("pointermove", (e) => {
      const pid = replay.pitch.pick(e.clientX, e.clientY);
      replay.pitch.hover = pid;
      cv.style.cursor = pid ? "pointer" : "default";
    });
    cv.addEventListener("pointerleave", () => { replay.pitch.hover = null; });
    cv.addEventListener("click", (e) => {
      const pid = replay.pitch.pick(e.clientX, e.clientY);
      if (pid) this.open(pid); else this.close();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
  }

  open(pid) {
    const p = this.r.roster[pid];
    if (!p) return;
    this.pid = pid;
    const rect = this.r.pitch.canvas.getBoundingClientRect();
    const pos = this.r.pitch.clientPos(pid);
    const right = !pos || pos[0] < rect.width / 2;
    this.el.className = `pcard ${right ? "at-right" : "at-left"}`;
    this.el.style.setProperty("--team", this.r.colors[p.team]);
    this.el.hidden = false;
    this.render(true);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.render(false), 600);
  }

  close() {
    if (this.el.hidden) return;
    this.el.classList.add("closing");
    clearInterval(this.timer);
    setTimeout(() => { this.el.hidden = true; this.el.classList.remove("closing"); }, reduceMotion ? 0 : 220);
    this.pid = null;
  }

  render(full) {
    const pid = this.pid;
    if (!pid) return;
    const r = this.r, p = r.roster[pid];
    const s = r.stats.p[pid] || { touches: 0, passes: 0, comp: 0, shots: 0, goals: 0, xg: 0, won: 0, sprints: 0, top: 0 };
    const team = r.start[p.team];
    const acc = s.passes ? Math.round((100 * s.comp) / s.passes) : 0;
    const onPitch = !!r.events[r.idx]?.frame?.[pid];
    const stats = [
      ["Goals", s.goals], ["Shots", s.shots], ["xG", s.xg.toFixed(2)],
      ["Passes", `${s.comp}/${s.passes}`], ["Pass acc.", `${acc}%`], ["Touches", s.touches],
      ["Ball wins", s.won], ["Sprints", s.sprints], ["Top speed", s.top ? `${s.top.toFixed(1)}` : "–"],
    ];
    if (full) {
      const following = r.studio.prefs.player === pid;
      this.el.innerHTML = `
        <div class="pc-stack" aria-hidden="true"><span></span><span></span></div>
        <div class="pc-main">
          <span class="pc-water" aria-hidden="true">${p.number}</span>
          <button type="button" class="pc-close" aria-label="Close">×</button>
          <div class="pc-top">
            <span class="pc-num">${p.number}</span>
            <div><p class="pc-pos">${esc(p.position)} · ${esc(team.name)}</p><h3 class="pc-name">${esc(p.name)}</h3>
            <p class="pc-status" id="pcStatus"></p></div>
          </div>
          <div class="pc-body">
            <dl class="pc-stats" id="pcStats"></dl>
            <div class="pc-side">
              <div class="pc-heat-wrap"><canvas class="pc-heat" id="pcHeat" width="520" height="336"></canvas><span>Heatmap so far</span></div>
              <div class="pc-actions">
                <button type="button" class="pc-btn" id="pcFollow">${following ? "Following" : "Follow"}</button>
                <button type="button" class="pc-btn pc-ask" id="pcAsk">Ask the studio</button>
              </div>
            </div>
          </div>
        </div>`;
      this.el.querySelector(".pc-close").addEventListener("click", () => this.close());
      $("pcFollow").addEventListener("click", () => {
        r.studio.prefs.player = r.studio.prefs.player === pid ? "" : pid;
        r.studio.applyPrefs();
        $("pcFollow").textContent = r.studio.prefs.player === pid ? "Following" : "Follow";
      });
      $("pcAsk").addEventListener("click", () => {
        r.studio.selectTab("tabAsk");
        r.ask.ask(`How is ${p.name} doing?`);
      });
    }
    $("pcStatus").textContent = onPitch ? `On the pitch · ${s.touches} touches` : "Not on the pitch";
    $("pcStats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}${k === "Top speed" ? " km/h" : ""}</dt><dd>${v}</dd></div>`).join("");
    this.drawHeat($("pcHeat"), r.heat.blurred(r.heat.player[pid]), r.colors[p.team]);
  }

  drawHeat(cv, grid, color) {
    const c = cv.getContext("2d");
    const w = cv.width, h = cv.height, pad = 10;
    const sx = (w - 2 * pad) / L, sy = (h - 2 * pad) / W;
    c.clearRect(0, 0, w, h);
    c.fillStyle = "#1b5e45";
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 12; i += 2) { c.fillStyle = "rgba(255,255,255,0.04)"; c.fillRect(pad + (i * L / 12) * sx, pad, (L / 12) * sx, W * sy); }
    const { nx, ny } = this.r.heat;
    let max = 0;
    for (const v of grid) max = Math.max(max, v);
    if (max > 0) {
      c.save();
      c.filter = "blur(6px)";
      const n = parseInt(color.slice(1), 16), R = (n >> 16) & 255, G = (n >> 8) & 255, B = n & 255;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const v = grid[j * nx + i] / max;
        if (v < 0.05) continue;
        const k = Math.max(0, (v - 0.55) / 0.45);
        c.fillStyle = `rgba(${Math.round(R + (255 - R) * k)},${Math.round(G + (215 - G) * k)},${Math.round(B + (120 - B) * k)},${Math.min(0.9, v)})`;
        c.fillRect(pad + (i * L / nx) * sx - 2, pad + (j * W / ny) * sy - 2, (L / nx) * sx + 4, (W / ny) * sy + 4);
      }
      c.restore();
    }
    c.strokeStyle = "rgba(255,255,255,0.75)";
    c.lineWidth = 2;
    c.strokeRect(pad, pad, L * sx, W * sy);
    c.beginPath(); c.moveTo(pad + (L / 2) * sx, pad); c.lineTo(pad + (L / 2) * sx, pad + W * sy); c.stroke();
    c.beginPath(); c.arc(pad + (L / 2) * sx, pad + (W / 2) * sy, 9.15 * sx, 0, Math.PI * 2); c.stroke();
    for (const x of [0, L - 16.5]) c.strokeRect(pad + x * sx, pad + (W / 2 - 20.16) * sy, 16.5 * sx, 40.32 * sy);
    // attacking direction
    const home = this.r.roster[this.pid]?.team === "home";
    c.fillStyle = "rgba(255,255,255,0.7)";
    c.font = "700 20px Archivo, system-ui, sans-serif";
    c.textAlign = "center";
    c.fillText(home ? "attacking →" : "← attacking", w / 2, h - 18);
  }
}

// ------------------------------------------------------------------ layers
const LAYER_KEYS = ["space", "shape", "heat", "network", "trails"];

export class LayersUI {
  constructor(replay) {
    this.r = replay;
    this.team = "home";
    this.dirty = true;
    this.lastHeat = 0;
    this.lastNet = 0;
    this.lastRead = 0;
    this.version = 0;
    const btn = $("layersBtn"), card = $("layersCard");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      card.hidden = !card.hidden;
      btn.setAttribute("aria-expanded", String(!card.hidden));
    });
    document.addEventListener("click", (e) => {
      if (!card.hidden && !card.contains(e.target) && e.target !== btn) {
        card.hidden = true;
        btn.setAttribute("aria-expanded", "false");
      }
    });
    card.querySelectorAll("[data-layer]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.layer;
      this.r.pitch.layers[k] = !this.r.pitch.layers[k];
      this.dirty = true;
      this.sync();
    }));
    card.querySelectorAll("[data-lteam]").forEach((b) => b.addEventListener("click", () => {
      this.team = b.dataset.lteam;
      this.dirty = true;
      this.sync();
    }));
    $("lteamHome").textContent = replay.start.home.name;
    $("lteamAway").textContent = replay.start.away.name;
    this.sync();
  }

  sync() {
    const lay = this.r.pitch.layers;
    document.querySelectorAll("[data-layer]").forEach((b) => {
      b.classList.toggle("on", !!lay[b.dataset.layer]);
      b.setAttribute("aria-pressed", String(!!lay[b.dataset.layer]));
    });
    document.querySelectorAll("[data-lteam]").forEach((b) => b.classList.toggle("on", b.dataset.lteam === this.team));
    const n = LAYER_KEYS.filter((k) => lay[k]).length;
    $("layersCount").textContent = n ? String(n) : "";
    $("layersBtn").classList.toggle("active", n > 0);
  }

  /** Called every frame: refresh the heavier layers now and then, and the readouts. */
  tick(now) {
    const r = this.r, lay = r.pitch.layers;
    const teamOf = (pid) => r.roster[pid]?.team;
    const focus = r.studio.prefs.player;
    if (lay.heat && (this.dirty || now - this.lastHeat > 1200)) {
      this.lastHeat = now;
      const grid = focus ? r.heat.player[focus] : r.heat.team[this.team];
      const color = focus ? r.colors[r.roster[focus].team] : r.colors[this.team];
      r.pitch.heat = { grid: r.heat.blurred(grid), nx: r.heat.nx, ny: r.heat.ny, color, version: ++this.version };
    }
    if (lay.network && (this.dirty || now - this.lastNet > 1500)) {
      this.lastNet = now;
      r.pitch.network = { ...passNetwork(r.events, r.idx, this.team, teamOf), color: r.colors[this.team] };
    }
    this.dirty = false;
    if (now - this.lastRead > 350) {
      this.lastRead = now;
      this.readout();
    }
  }

  readout() {
    const r = this.r, ro = r.pitch.readouts, lay = r.pitch.layers;
    const H = r.start.home.short, A = r.start.away.short;
    const rows = [];
    if (lay.space && ro.space) {
      rows.push(`<div class="ro-row"><span>Space</span><span class="ro-bar"><i style="flex-grow:${ro.space.home};background:var(--home)"></i><i style="flex-grow:${ro.space.away};background:var(--away)"></i></span><b>${ro.space.home}% · ${ro.space.away}%</b></div>`);
    }
    if (lay.shape && ro.shape) {
      for (const [side, code] of [["home", H], ["away", A]]) {
        const s = ro.shape[side];
        if (s) rows.push(`<div class="ro-row"><span class="ro-team ${side}">${esc(code)}</span><span>line ${s.line} m</span><b>${s.width} × ${s.depth} m</b></div>`);
      }
    }
    if (lay.heat) {
      const focus = r.studio.prefs.player;
      rows.push(`<div class="ro-row"><span>Heatmap</span><b>${esc(focus ? r.roster[focus].name : r.start[this.team].name)}</b></div>`);
    }
    $("layerReadout").innerHTML = rows.join("") || `<p class="ro-hint">Turn on a layer. Click any player on the pitch for their card.</p>`;
  }
}

// ----------------------------------------------------------- motion touches
export function setupMotion() {
  // tab ink: a pill that slides to the selected tab
  const tabs = document.querySelector(".tabs");
  const ink = tabs?.querySelector(".tab-ink");
  const place = () => {
    const sel = tabs.querySelector('[aria-selected="true"]');
    if (!sel || !ink) return;
    ink.style.width = `${sel.offsetWidth}px`;
    ink.style.transform = `translateX(${sel.offsetLeft}px)`;
  };
  document.addEventListener("tabchange", place);
  new ResizeObserver(place).observe(tabs);
  requestAnimationFrame(place);
  // a soft light that follows the pointer over panels
  document.addEventListener("pointermove", (e) => {
    const el = e.target.closest?.(".panel, .deck, .viewer");
    if (!el) return;
    const b = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - b.left}px`);
    el.style.setProperty("--my", `${e.clientY - b.top}px`);
  }, { passive: true });
}
