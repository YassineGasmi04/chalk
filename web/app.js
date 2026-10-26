import { PitchRenderer } from "./pitch.js";
import { Studio } from "./studio.js";

const params = new URLSearchParams(location.search);
const SEED = params.get("seed") || "4";
const DATA = params.get("data") || "../data";
const SIGNAL = "#ffbf3c";
const ON_BALL = new Set(["pass", "carry", "take_on", "shot", "kickoff", "throw_in", "goal_kick", "free_kick"]);
const WINS_BALL = new Set(["interception", "tackle", "save", "block"]);
const ICONS = {
  goal: "ic-goal", red_card: "ic-card", big_chance: "ic-chance", rocket_shot: "ic-chance",
  press_surge: "ic-press", momentum_swing: "ic-swing", chaos_spike: "ic-swing",
  tactical_shift: "ic-shift", substitution: "ic-sub", speed_burst: "ic-speed",
  hardest_pass: "ic-star", milestone: "ic-star",
};

const $ = (id) => document.getElementById(id);
// lift club colours so they read on the purple stage and the green pitch
function brighten(hex, amount = 0.18) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * amount));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------ loading
async function load() {
  const get = async (path, kind) => {
    const r = await fetch(`${DATA}/${path}`);
    if (!r.ok) throw new Error(`Couldn't load ${path}. Run python scripts/generate_match.py, then reload.`);
    return kind === "text" ? r.text() : r.json();
  };
  const [evText, moments, summary, insights] = await Promise.all([
    get(`match_${SEED}.jsonl`, "text"),
    get(`match_${SEED}_moments.json`),
    get(`match_${SEED}_summary.json`),
    // the AI crew's output is optional: without it the replay still works
    fetch(`${DATA}/match_${SEED}_insights.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  return { events: evText.trim().split("\n").map((l) => JSON.parse(l)), moments, summary, insights };
}

// --------------------------------------------------------------- live stats
class LiveStats {
  constructor() { this.reset(); }
  reset() {
    const blank = () => ({ poss: 0, shots: 0, sot: 0, xg: 0, passes: 0, comp: 0, pressures: 0, won: 0, reds: 0 });
    this.t = { home: blank(), away: blank() };
    this.p = {}; // per player, for player-cam mode
    this.inPoss = null;
    this.lastT = 0;
  }
  apply(ev) {
    if (this.inPoss) this.t[this.inPoss].poss += Math.max(0, ev.t - this.lastT);
    this.lastT = ev.t;
    if ((ON_BALL.has(ev.type) || WINS_BALL.has(ev.type)) && ev.team) this.inPoss = ev.team;
    else if (ev.type === "goal" || ev.type === "period_end") this.inPoss = null;
    if (ev.player) {
      const P = (this.p[ev.player] ||= { touches: 0, passes: 0, comp: 0, shots: 0, goals: 0, xg: 0, won: 0, sprints: 0, top: 0 });
      if (ON_BALL.has(ev.type)) P.touches++;
      if (ev.type === "pass") { P.passes++; if (ev.outcome === "complete") P.comp++; }
      if (ev.type === "shot") { P.shots++; P.xg += ev.xg; }
      if (ev.type === "goal") P.goals++;
      if (ev.type === "tackle" || ev.type === "interception") P.won++;
      if (ev.type === "sprint") { P.sprints++; P.top = Math.max(P.top, ev.speed_kmh); }
    }
    const s = ev.team && this.t[ev.team];
    if (!s) return;
    switch (ev.type) {
      case "pass": s.passes++; if (ev.outcome === "complete") s.comp++; break;
      case "shot": s.shots++; s.xg += ev.xg; if (ev.outcome === "goal" || ev.outcome === "saved") s.sot++; break;
      case "pressure": s.pressures++; break;
      case "tackle": case "interception": s.won++; break;
      case "card": if (ev.card === "red") s.reds++; break;
    }
  }
  rows() {
    const h = this.t.home, a = this.t.away;
    const total = h.poss + a.poss || 1;
    const pct = (x) => Math.round((100 * x) / total);
    const acc = (s) => (s.passes ? Math.round((100 * s.comp) / s.passes) : 0);
    return [
      ["Possession", `${pct(h.poss)}%`, `${pct(a.poss)}%`, h.poss, a.poss],
      ["Expected goals", h.xg.toFixed(2), a.xg.toFixed(2), h.xg, a.xg],
      ["Shots on target", `${h.sot}/${h.shots}`, `${a.sot}/${a.shots}`, h.shots, a.shots],
      ["Pass accuracy", `${acc(h)}%`, `${acc(a)}%`, acc(h), acc(a)],
      ["Pressures", h.pressures, a.pressures, h.pressures, a.pressures],
      ["Ball wins", h.won, a.won, h.won, a.won],
    ];
  }
}

// -------------------------------------------------------------------- app
class Replay {
  constructor({ events, moments, summary, insights }) {
    this.seed = SEED;
    this.dataPath = DATA;
    this.events = events;
    this.moments = moments;
    this.summary = summary;
    this.start = events[0];
    this.endT = events[events.length - 1].t;
    this.T = 0;
    this.idx = 0; // index of the last event with t <= T
    this.speed = 10;
    this.playing = false;
    this.lastFrame = performance.now();
    this.momentsShown = 0;
    this.secondHalfT = (events.find((e) => e.type === "kickoff" && e.period === 2) || {}).t;

    const home = this.start.home, away = this.start.away;
    this.colors = { home: brighten(home.color, 0.12), away: brighten(away.color, 0.22) };
    document.documentElement.style.setProperty("--home", this.colors.home);
    document.documentElement.style.setProperty("--away", this.colors.away);
    this.roster = {};
    for (const side of ["home", "away"]) {
      for (const p of [...this.start[side].players, ...this.start[side].bench]) {
        this.roster[p.pid] = { number: p.number, team: side, short: p.short, position: p.position, name: p.name };
      }
    }

    this.pitch = new PitchRenderer($("pitch"));
    this.pitch.setRoster(this.roster, this.colors);
    this.stats = new LiveStats();
    this.studio = new Studio(this, insights);
    this.setupUI(home, away);
    this.pulseCanvas = $("pulse");
    new ResizeObserver(() => this.drawPulse()).observe(this.pulseCanvas);
    this.seek(0);
    requestAnimationFrame((t) => this.loop(t));
  }

  setupUI(home, away) {
    $("matchTitle").textContent = `${home.name} v ${away.name}`;
    $("matchMeta").textContent = [this.start.venue, this.start.weather].filter(Boolean).join(", ");
    for (const [id, text] of [["sbHome", home.short], ["sbAway", away.short], ["stHome", home.short], ["stAway", away.short]]) {
      $(id).textContent = text;
    }
    $("lgHome").textContent = `${home.name.split(" ")[0]} on top`;
    $("lgAway").textContent = `${away.name.split(" ")[0]} on top`;

    $("playBtn").addEventListener("click", () => { this.studio.hideOverlays(); this.toggle(); });
    document.querySelectorAll(".speeds button").forEach((b) =>
      b.addEventListener("click", () => {
        this.speed = Number(b.dataset.speed);
        document.querySelectorAll(".speeds button").forEach((x) => x.classList.toggle("on", x === b));
      }));
    document.querySelectorAll(".view-toggle button").forEach((b) =>
      b.addEventListener("click", () => {
        this.pitch.setView(b.dataset.view);
        document.querySelectorAll(".view-toggle button").forEach((x) => {
          x.classList.toggle("on", x === b);
          x.setAttribute("aria-pressed", String(x === b));
        });
      }));
    $("namesToggle").addEventListener("change", (e) => { this.pitch.showNames = e.target.checked; });
    $("scrub").addEventListener("input", (e) => {
      this.studio.stopHighlights();
      this.studio.hideOverlays();
      this.seek(Math.min(this.endT, (Number(e.target.value) / 1000) * this.span()));
    });
    // releasing the scrubber on an AI marker replays that insight
    $("scrub").addEventListener("change", (e) => {
      const t = (Number(e.target.value) / 1000) * this.span();
      const near = this.studio.cards.find((c) => c.on_air_t <= this.endT && Math.abs(c.on_air_t - t) < this.span() * 0.012);
      if (near) { this.seek(Math.max(0, near.on_air_t - 6)); this.toggle(true); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input, button")) return;
      if (e.key === " ") {
        e.preventDefault();
        if (this.studio.onAir?.paused) this.studio.end(); else this.toggle();
      }
      if (e.key === "ArrowRight") this.seek(Math.min(this.endT, this.T + 15));
      if (e.key === "ArrowLeft") this.seek(Math.max(0, this.T - 15));
    });
  }

  // ---------------------------------------------------------------- live
  /** Switch from the recorded file to the server's live feed (Server-Sent Events). */
  goLive() {
    if (this.live) return;
    this.live = true;
    this.liveEnded = false;
    this.events = [this.events[0]];
    this.moments.length = 0;
    this.summary.pulse = [];
    this.studio.reset();
    this.studio.stopHighlights();
    this.endT = 0;
    this.T = 0;
    this.idx = 0;
    $("momentList").innerHTML = "";
    this.momentsShown = 0;
    this.seek(0);
    $("feedLabel").textContent = "Live feed";
    $("feedLabel").closest(".feed-pill").classList.add("is-live");
    $("hlBtn").hidden = true;
    const es = new EventSource(`/api/live?seed=${this.seed}&speed=${this.speed}`);
    this.feed = es;
    es.addEventListener("hello", (e) => {
      const h = JSON.parse(e.data);
      if (this.studio.insights) this.studio.insights.engine = h.engine;
      $("crewEngine").textContent = h.mode === "live AI" ? `${h.engine.model} on Foundry, live` : "Recorded crew";
    });
    es.addEventListener("event", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "match_start") return;
      this.events.push(ev);
      this.endT = ev.t;
    });
    es.addEventListener("moment", (e) => {
      const m = JSON.parse(e.data);
      this.moments.push(m);
      this.studio.momentById.set(m.id, m);
    });
    es.addEventListener("pulse", (e) => { this.summary.pulse.push(JSON.parse(e.data)); });
    es.addEventListener("insight", (e) => { this.studio.addCard(JSON.parse(e.data)); });
    es.addEventListener("recap", (e) => {
      if (this.studio.insights) this.studio.insights.recap = JSON.parse(e.data);
      else this.studio.insights = { recap: JSON.parse(e.data), cards: [] };
    });
    es.addEventListener("end", () => { this.liveEnded = true; es.close(); });
    es.onerror = () => { if (this.liveEnded) es.close(); };
    this.toggle(true);
  }

  /** Length of the timeline: the full match, even while it is still being played live. */
  span() {
    return this.live ? Math.max(this.endT, 96 * 60) : this.endT;
  }

  setSpeed(n) {
    this.speed = n;
    document.querySelectorAll(".speeds button").forEach((x) => x.classList.toggle("on", Number(x.dataset.speed) === n));
  }

  toggle(force) {
    if (this.T >= this.endT && !this.live) this.seek(0);
    this.playing = force ?? !this.playing;
    $("playBtn").setAttribute("aria-pressed", String(this.playing));
    $("playBtn").setAttribute("aria-label", this.playing ? "Pause" : "Play");
  }

  // ---------------------------------------------------------- time control
  seek(T) {
    this.T = Math.max(0, Math.min(T, this.endT));
    this.stats.reset();
    this.idx = 0;
    this.pitch.clearMarks();
    this.studio.resync(this.T);
    this.advanceTo(this.T, true);
    $("momentList").innerHTML = "";
    this.momentsShown = 0;
    this.revealMoments(true);
    this.drawPulse();
  }

  advanceTo(T, silent = false) {
    while (this.idx + 1 < this.events.length && this.events[this.idx + 1].t <= T) {
      this.idx++;
      const ev = this.events[this.idx];
      this.stats.apply(ev);
      if (!silent) this.onEvent(ev);
    }
    this.updateScoreboard();
  }

  onEvent(ev) {
    const p = this.pitch;
    const name = (pid) => this.roster[pid]?.short ?? "";
    switch (ev.type) {
      case "pass": {
        const hard = ev.outcome === "complete" && ev.difficulty >= 70;
        p.addMark({ kind: "line", from: ev.start, to: ev.end, dashed: true, width: hard ? 2.6 : 1.5,
                    color: hard ? SIGNAL : "#ffffff", ttl: hard ? 2600 : 1000, seed: ev.id });
        if (hard) p.addMark({ kind: "label", at: ev.end, text: `Pass difficulty ${ev.difficulty}`, tone: "signal", ttl: 2600 });
        break;
      }
      case "shot":
        p.addMark({ kind: "line", from: ev.start, to: ev.end, width: 2.8, color: SIGNAL, ttl: 3200, arrow: true, seed: ev.id });
        // sits under the shooter so it never collides with the name tag above
        p.addMark({ kind: "label", at: ev.start, text: `${ev.speed_kmh} km/h   xG ${ev.xg.toFixed(2)}`, tone: "signal", ttl: 3200, lift: -34 });
        break;
      case "sprint": {
        const pos = ev.frame[ev.player];
        if (ev.speed_kmh >= 30 && pos) p.addMark({ kind: "label", at: pos, text: `${name(ev.player)} ${ev.speed_kmh} km/h`, ttl: 2200 });
        break;
      }
      case "goal":
        this.flash("Goal", `${this.roster[ev.player]?.name} ${ev.clock}`, 3800);
        break;
      case "card":
        if (ev.card === "red") this.flash("Red card", this.roster[ev.player]?.name, 3200);
        break;
      case "substitution":
        this.flash("Substitution", `${name(ev.player)} on for ${name(ev.player_off)}`, 2500);
        break;
      case "formation_change":
        this.flash("Tactics", `${this.start[ev.team].name} switch to ${ev.to}`, 2800);
        break;
      case "period_end":
        this.flash(ev.period === 1 ? "Half-time" : "Full-time",
                   `${this.start.home.short} ${ev.score.home} - ${ev.score.away} ${this.start.away.short}`, 3000);
        break;
    }
  }

  flash(label, body, ms) {
    if (this.studio?.onAir) return;
    const el = $("ticker");
    el.innerHTML = `<span class="accent">${esc(label)}</span><span class="body">${esc(body)}</span>`;
    el.classList.add("show");
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => el.classList.remove("show"), ms);
  }

  // -------------------------------------------------------------- display
  updateScoreboard() {
    const ev = this.events[this.idx];
    const reds = (side) => `<span class="sb-red" aria-label="red card"></span>`.repeat(this.stats.t[side].reds);
    $("sbScore").textContent = `${ev.score.home} – ${ev.score.away}`;
    $("sbHome").innerHTML = `${esc(this.start.home.short)}${reds("home")}`;
    $("sbAway").innerHTML = `${reds("away")}${esc(this.start.away.short)}`;
    $("sbClock").textContent = ev.type === "period_end" ? (ev.period === 1 ? "HT" : "FT") : ev.clock;
    this.renderStats();
  }

  renderStats(force = false) {
    const now = performance.now();
    if (!force && this.lastStats && now - this.lastStats < 300) return;
    this.lastStats = now;
    this.studio?.renderPlayer(this.stats);
    $("statList").innerHTML = this.stats.rows().map(([label, h, a, hv, av]) => {
      const sum = hv + av;
      const hs = sum ? hv / sum : 0.5;
      return `<li class="stat-row">
        <span class="v h ${hv < av ? "trail" : ""}">${h}</span>
        <span class="label">${label}</span>
        <span class="v a ${av < hv ? "trail" : ""}">${a}</span>
        <span class="bar" aria-hidden="true"><span class="bh" style="flex-grow:${hs.toFixed(3)}"></span><span class="ba" style="flex-grow:${(1 - hs).toFixed(3)}"></span></span>
      </li>`;
    }).join("");
  }

  revealMoments(silent = false) {
    const list = $("momentList");
    while (this.momentsShown < this.moments.length && this.moments[this.momentsShown].t <= this.T) {
      const m = this.moments[this.momentsShown++];
      const li = document.createElement("li");
      if (!silent) li.className = "fresh";
      const side = m.team || "neutral";
      const card = this.studio.byMoment.get(m.id);
      li.dataset.moment = m.id;
      li.innerHTML = `<button type="button" class="${m.importance >= 0.7 ? "big" : ""} ${m.type}${card ? " has-insight" : ""}">
        <span class="m-clock">${esc(m.clock)}</span>
        <svg class="m-icon ${side}" aria-hidden="true"><use href="#${ICONS[m.type] || "ic-star"}"/></svg>
        <span class="m-title">${esc(m.title)}</span></button>`;
      li.querySelector("button").addEventListener("click", () => {
        this.studio.stopHighlights();
        this.studio.hideOverlays();
        this.seek(Math.max(0, (card ? card.on_air_t : m.t) - 8));
        this.toggle(true);
      });
      list.prepend(li);
    }
    $("momentEmpty").hidden = this.momentsShown > 0;
    $("momentCount").textContent = this.momentsShown ? String(this.momentsShown) : "";
    this.refreshMomentMarks();
  }

  refreshMomentMarks() {
    for (const li of document.querySelectorAll("#momentList li")) {
      const m = this.studio.momentById.get(li.dataset.moment);
      if (m) li.querySelector("button").classList.toggle("mine", !!this.studio.isMine(m.team, m.players || []));
    }
  }

  drawPulse() {
    const cv = this.pulseCanvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext("2d");
    c.clearRect(0, 0, w, h);
    const span = this.span() || 1;
    const X = (t) => (t / span) * w;
    const top = 12 * dpr, bottom = h - 4 * dpr, mid = (top + bottom) / 2, amp = (bottom - top) / 2;

    // unplayed part of the match
    c.fillStyle = "rgba(255,255,255,0.06)";
    c.beginPath(); c.roundRect(0, top, w, bottom - top, 4 * dpr); c.fill();
    c.strokeStyle = "rgba(255,255,255,0.22)";
    c.lineWidth = 1 * dpr;
    c.beginPath(); c.moveTo(0, mid); c.lineTo(w, mid); c.stroke();
    if (this.secondHalfT) {
      c.strokeStyle = "rgba(255,255,255,0.4)";
      c.setLineDash([3 * dpr, 3 * dpr]);
      c.beginPath(); c.moveTo(X(this.secondHalfT), top); c.lineTo(X(this.secondHalfT), bottom); c.stroke();
      c.setLineDash([]);
    }

    const pts = this.summary.pulse.filter((p) => p.t <= this.T);
    if (pts.length > 1) {
      c.save();
      c.strokeStyle = "rgba(255,255,255,0.16)";
      c.lineWidth = 1 * dpr;
      for (let i = 0; i < pts.length - 1; i++) {
        if (pts[i].label !== "chaotic") continue;
        const x0 = X(pts[i].t), x1 = X(pts[i + 1].t);
        for (let x = x0; x < x1; x += 4 * dpr) { c.beginPath(); c.moveTo(x, bottom); c.lineTo(x + 5 * dpr, top); c.stroke(); }
      }
      c.restore();
      const path = new Path2D();
      path.moveTo(X(pts[0].t), mid);
      for (const p of pts) path.lineTo(X(p.t), mid - p.dominance * amp);
      path.lineTo(X(pts[pts.length - 1].t), mid);
      path.closePath();
      for (const [side, y0, y1] of [["home", 0, mid], ["away", mid, h]]) {
        c.save();
        c.beginPath(); c.rect(0, y0, w, y1 - y0); c.clip();
        c.globalAlpha = 0.9;
        c.fillStyle = this.colors[side];
        c.fill(path);
        c.restore();
      }
    }

    for (const m of this.moments) {
      if (m.t > this.T) break;
      const x = X(m.t);
      if (m.type === "goal") {
        c.fillStyle = this.colors[m.team];
        c.beginPath(); c.arc(x, top - 5 * dpr, 4 * dpr, 0, Math.PI * 2); c.fill();
      } else if (m.type === "red_card") {
        c.fillStyle = "#ff4d5e";
        c.fillRect(x - 2.5 * dpr, top - 9 * dpr, 5 * dpr, 7 * dpr);
      }
    }

    // AI insight markers (only for insights already aired: no spoilers)
    for (const card of this.studio?.cards || []) {
      if (card.on_air_t > this.T) break;
      const x = X(card.on_air_t), y = bottom - 7 * dpr, r = 4 * dpr;
      c.beginPath();
      c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath();
      c.fillStyle = "#ffbf3c";
      c.fill();
      c.lineWidth = 1.2 * dpr;
      c.strokeStyle = "rgba(31,10,46,0.9)";
      c.stroke();
    }

    const px = X(this.T);
    c.fillStyle = "#ffbf3c";
    c.fillRect(px - 1 * dpr, top - 2 * dpr, 2 * dpr, bottom - top + 4 * dpr);
    c.beginPath(); c.arc(px, bottom, 4 * dpr, 0, Math.PI * 2); c.fill();
    $("scrub").value = String(Math.round((this.T / span) * 1000));
    $("scrub").setAttribute("aria-valuetext", this.events[this.idx].clock);
  }

  // ------------------------------------------------------------------ loop
  loop(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.studio.tick(now);
    if (this.playing && !this.studio.onAir?.paused) {
      const before = this.idx;
      this.T = Math.min(this.endT, this.T + dt * this.speed);
      this.advanceTo(this.T);
      if (this.idx !== before) this.revealMoments();
      this.studio.check(this.T);
      const tick = Math.floor(now / 200);
      if (tick !== this.lastPulseTick) { this.lastPulseTick = tick; this.drawPulse(); }
      if (this.T >= this.endT && (!this.live || this.liveEnded)) {
        this.toggle(false);
        this.studio.stopHighlights();
        this.studio.showRecap();
      }
    }
    this.render(now);
    requestAnimationFrame((t) => this.loop(t));
  }

  render(now) {
    if (!this.events[this.idx]) return;
    const frozen = this.studio.frozenFrame();
    if (frozen) {
      this.pitch.draw(frozen.frame, frozen.ball, null, now);
      return;
    }
    const a = this.events[this.idx];
    const b = this.events[Math.min(this.idx + 1, this.events.length - 1)];
    const span = b.t - a.t;
    const k = span > 0 ? Math.min(1, Math.max(0, (this.T - a.t) / span)) : 0;
    const ease = k * k * (3 - 2 * k);
    const frame = {};
    for (const [pid, pa] of Object.entries(a.frame || {})) {
      const pb = b.frame?.[pid] || pa;
      frame[pid] = [pa[0] + (pb[0] - pa[0]) * ease, pa[1] + (pb[1] - pa[1]) * ease];
    }
    const ball = a.ball && b.ball
      ? [a.ball[0] + (b.ball[0] - a.ball[0]) * ease, a.ball[1] + (b.ball[1] - a.ball[1]) * ease]
      : a.ball;
    // the ring follows the ball: on a pass it moves to the receiver
    const carrier = a.type === "pass" ? (a.outcome === "complete" ? a.to : null)
      : ON_BALL.has(a.type) || WINS_BALL.has(a.type) ? a.player : null;
    this.pitch.draw(frame, ball, carrier, now);
  }
}

load()
  .then((data) => {
    window.chalk = new Replay(data);
    if (!params.has("nowelcome")) window.chalk.studio.showWelcome();
    fetch("/api/health").then((r) => (r.ok ? r.json() : null)).then((h) => {
      if (!h?.ok) return;
      $("startLive").hidden = false;
      if (params.has("live")) { window.chalk.studio.hideOverlays(); window.chalk.goLive(); }
    }).catch(() => { /* static hosting: replay only */ });
  })
  .catch((err) => {
    $("matchTitle").textContent = err.message;
    console.error(err);
  });
