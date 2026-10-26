import { PitchRenderer } from "./pitch.js";
import { Studio } from "./studio.js";
import { Stadium, Stingers } from "./fx.js";
import { AskDesk } from "./ask.js";
import { avatarURL } from "./avatar.js";
import { crestImg, crestURL } from "./crests.js";
import { onLang, t } from "./i18n.js";
import { SquadTracker } from "./squads.js";
import { roleCode } from "./formations.js";
import { Commentator, sayFormation, sayScore } from "./commentary.js";
import { playerRatings } from "./ratings.js";
import { EventStack, Heat, LayersUI, PlayerCard, setupMotion, winProbability } from "./hud.js";

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
  const [evText, moments, summary, insights, portraits] = await Promise.all([
    get(`match_${SEED}.jsonl`, "text"),
    get(`match_${SEED}_moments.json`),
    get(`match_${SEED}_summary.json`),
    // the AI crew's output is optional: without it the replay still works
    fetch(`${DATA}/match_${SEED}_insights.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    // AI-generated photo portraits (people who do not exist), if they have been made
    fetch("portraits/manifest.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  return { events: evText.trim().split("\n").map((l) => JSON.parse(l)), moments, summary, insights, portraits };
}

// --------------------------------------------------------------- live stats
class LiveStats {
  constructor() { this.reset(); }
  reset() {
    const blank = () => ({ poss: 0, shots: 0, sot: 0, xg: 0, passes: 0, comp: 0, pressures: 0, won: 0, reds: 0,
      f3: 0, oppPassesZone: 0, defZone: 0, big: 0, xgSeries: [[0, 0]] });
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
      case "pass": {
        s.passes++; if (ev.outcome === "complete") s.comp++;
        const home = ev.team === "home", x0 = ev.start?.[0] ?? 52.5, x1 = ev.end?.[0] ?? 52.5;
        if (home ? x1 > 70 : x1 < 35) s.f3++; // field tilt: passes into the final third
        // PPDA: the opponent's passes in its own 60% of the pitch...
        if (home ? x0 < 63 : x0 > 42) this.t[home ? "away" : "home"].oppPassesZone++;
        break;
      }
      case "shot":
        s.shots++; s.xg += ev.xg; if (ev.outcome === "goal" || ev.outcome === "saved") s.sot++;
        if (ev.xg >= 0.3) s.big++;
        s.xgSeries.push([ev.t, s.xg]);
        break;
      case "pressure": s.pressures++; break;
      case "tackle": case "interception": case "foul": {
        if (ev.type !== "foul") s.won++;
        // ...per defensive action there
        const bx = ev.ball?.[0] ?? 52.5;
        if (ev.team === "home" ? bx > 42 : bx < 63) s.defZone++;
        break;
      }
      case "card": if (ev.card === "red") s.reds++; break;
    }
  }
  rows() {
    const h = this.t.home, a = this.t.away;
    const total = h.poss + a.poss || 1;
    const pct = (x) => Math.round((100 * x) / total);
    const acc = (s) => (s.passes ? Math.round((100 * s.comp) / s.passes) : 0);
    return [
      [t("stat.possession"), `${pct(h.poss)}%`, `${pct(a.poss)}%`, h.poss, a.poss],
      [t("stat.xg"), h.xg.toFixed(2), a.xg.toFixed(2), h.xg, a.xg],
      [t("stat.sot"), `${h.sot}/${h.shots}`, `${a.sot}/${a.shots}`, h.shots, a.shots],
      [t("stat.passAcc"), `${acc(h)}%`, `${acc(a)}%`, acc(h), acc(a)],
      [t("stat.pressures"), h.pressures, a.pressures, h.pressures, a.pressures],
      [t("stat.wins"), h.won, a.won, h.won, a.won],
      [t("stat.tilt"), `${this.tilt("home")}%`, `${this.tilt("away")}%`, this.tilt("home"), this.tilt("away")],
      [t("stat.ppda"), this.ppda("home"), this.ppda("away"), 1 / (this.ppda("home") || 99), 1 / (this.ppda("away") || 99)],
    ];
  }
  tilt(side) {
    const f = this.t.home.f3 + this.t.away.f3;
    return f ? Math.round((100 * this.t[side].f3) / f) : 50;
  }
  ppda(side) {
    const s = this.t[side];
    return s.defZone ? Number((s.oppPassesZone / s.defZone).toFixed(1)) : 0;
  }
}

// -------------------------------------------------------------------- app
class Replay {
  constructor({ events, moments, summary, insights, portraits }) {
    this.portraits = new Set(portraits?.pids || []);
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
    this.pitch.setRoster(this.roster, this.colors, { home: home.name, away: away.name });
    this.heat = new Heat();
    this.squads = new SquadTracker(this.start);
    this.stats = new LiveStats();
    this.fx = new Stingers();
    this.stadium = new Stadium();
    this.fx.onShow = () => this.stadium.whoosh();
    this.pitch.rain = /rain/i.test(this.start.weather || "");
    this.studio = new Studio(this, insights);
    this.comm = new Commentator(this.studio.prefs);
    this.ask = new AskDesk(this);
    this.evStack = new EventStack(this);
    this.pcard = new PlayerCard(this);
    this.layersUI = new LayersUI(this);
    setupMotion();
    this.setupUI(home, away);
    this.pulseCanvas = $("pulse");
    new ResizeObserver(() => this.drawPulse()).observe(this.pulseCanvas);
    this.seek(0);
    requestAnimationFrame((t) => this.loop(t));
  }

  setupUI(home, away) {
    $("matchTitle").innerHTML = `${crestImg(home.name, this.colors.home, "crest-sm")}<span>${esc(home.name)} v ${esc(away.name)}</span>${crestImg(away.name, this.colors.away, "crest-sm")}`;
    $("matchMeta").textContent = [this.start.venue, this.start.weather].filter(Boolean).join(", ");
    $("stHome").innerHTML = `${crestImg(home.name, this.colors.home, "st-crest")}${esc(home.short)}`;
    $("stAway").innerHTML = `${esc(away.short)}${crestImg(away.name, this.colors.away, "st-crest")}`;
    this.view = "3d";
    this.relabel();
    onLang(() => this.relabel());

    $("playBtn").addEventListener("click", () => { this.studio.hideOverlays(); this.toggle(); });
    document.querySelectorAll(".speeds button").forEach((b) =>
      b.addEventListener("click", () => {
        this.speed = Number(b.dataset.speed);
        document.querySelectorAll(".speeds button").forEach((x) => x.classList.toggle("on", x === b));
      }));
    document.querySelectorAll(".view-toggle button").forEach((b) =>
      b.addEventListener("click", () => {
        this.pitch.setView(b.dataset.view);
        this.view = b.dataset.view;
        const bug = $("camBug");
        $("camName").textContent = t(`cam.${this.view}`);
        bug.classList.remove("swap"); void bug.offsetWidth; bug.classList.add("swap");
        document.querySelectorAll(".view-toggle button").forEach((x) => {
          x.classList.toggle("on", x === b);
          x.setAttribute("aria-pressed", String(x === b));
        });
      }));
    document.addEventListener("tabchange", () => this.renderSquads());
    document.querySelectorAll("[data-emo]").forEach((b) => b.addEventListener("click", () => {
      this.emojiBurst([b.dataset.emo], 5);
      b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
    }));
    $("lineupsBtn").addEventListener("click", () => { this.studio.hideOverlays(); this.showLineups(); });
    $("namesToggle").addEventListener("change", (e) => { this.pitch.showNames = e.target.checked; });
    $("soundToggle").addEventListener("change", (e) => {
      if (e.target.checked) { if (!this.stadium.start()) e.target.checked = false; } else this.stadium.stop();
    });
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

  /** Labels that depend on the interface language. */
  relabel() {
    const { home, away } = this.start;
    $("lgHome").textContent = t("deck.onTop", { team: home.name.split(" ")[0] });
    $("lgAway").textContent = t("deck.onTop", { team: away.name.split(" ")[0] });
    $("camName").textContent = t(`cam.${this.view || "3d"}`);
    $("feedLabel").textContent = !this.live ? t("feed.synthetic") : this.seed === SEED ? t("feed.live") : t("feed.liveMatch", { seed: this.seed });
    for (const li of document.querySelectorAll("#momentList li")) {
      const m = this.studio.momentById.get(li.dataset.moment);
      if (m) li.querySelector(".m-title").textContent = this.momentTitle(m);
    }
    this.renderStats(true);
  }

  /** A moment's title in the viewer's language (names stay as they are). */
  momentTitle(m) {
    if (this.studio.prefs.lang === "en") return m.title;
    const who = (m.players || []).map((pid) => this.roster[pid]?.short).filter(Boolean)[0];
    return who ? `${this.studio.typeLabel(m.type)} · ${who}` : `${this.studio.typeLabel(m.type)} · ${this.start[m.team]?.name ?? ""}`;
  }

  // ---------------------------------------------------------------- live
  /** Switch from the recorded file to the server's live feed (Server-Sent Events). */
  goLive(seed = null, { prep = false } = {}) {
    if (this.live && seed === null) return;
    this.preparing = prep;
    this.feed?.close();
    if (seed !== null) this.seed = String(seed);
    this.live = true;
    this.liveEnded = false;
    this.events = [this.events[0]];
    this.moments.length = 0;
    this.summary.pulse = [];
    this.studio.reset();
    this.studio.stopHighlights();
    this.studio.selectTab("tabStats");
    $("recap").hidden = true;
    $("askThread").innerHTML = "";
    this.endT = 0;
    this.T = 0;
    this.idx = 0;
    $("momentList").innerHTML = "";
    this.momentsShown = 0;
    this.seek(0);
    $("feedLabel").textContent = this.seed === SEED ? t("feed.live") : t("feed.liveMatch", { seed: this.seed });
    $("feedLabel").closest(".feed-pill").classList.add("is-live");
    $("hlBtn").hidden = true;
    if (prep) $("feedLabel").textContent = t("feed.prep");
    // "AI highlights": the crew watches the whole match at high speed first
    const es = new EventSource(`/api/live?seed=${this.seed}&speed=${prep ? 900 : this.speed}${prep ? "&prep=1" : ""}`);
    this.feed = es;
    es.addEventListener("hello", (e) => {
      const h = JSON.parse(e.data);
      if (this.studio.insights) this.studio.insights.engine = h.engine;
      else this.studio.insights = { engine: h.engine, cards: [] };
      const model = h.engine?.model;
      $("crewEngine").textContent = h.mode !== "live AI" ? "Recorded crew"
        : model && model !== "offline" ? `${model} on Foundry, live` : "Offline crew, live";
    });
    es.addEventListener("event", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "match_start") { this.events[0] = ev; return; }
      this.events.push(ev);
      this.endT = ev.t;
      if (prep) this.renderPrep(ev);
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
    es.addEventListener("end", () => {
      this.liveEnded = true;
      es.close();
      if (prep) this.finishPrep();
    });
    es.onerror = () => { if (this.liveEnded) es.close(); };
    if (!prep) this.toggle(true);
  }

  /** The crew has watched the whole match: play its highlights. */
  finishPrep() {
    this.preparing = false;
    this.live = false;
    $("chooser").hidden = true;
    $("feedLabel").textContent = t("feed.liveMatch", { seed: this.seed });
    $("feedLabel").closest(".feed-pill").classList.remove("is-live");
    $("hlBtn").hidden = false;
    this.secondHalfT = (this.events.find((e) => e.type === "kickoff" && e.period === 2) || {}).t;
    this.seek(0);
    this.studio.startHighlights();
  }

  // ------------------------------------------------------------- new match
  /** New match: simulate a fresh seed, then let the viewer choose live or AI highlights. */
  async openChooser() {
    this.studio.hideOverlays();
    this.pcard?.close();
    const box = $("chooser"), card = $("chooserCard");
    box.hidden = false;
    card.innerHTML = `<div class="nm-loading"><span class="nm-spin" aria-hidden="true"></span></div>`;
    let info;
    try {
      const r = await fetch("/api/new-match");
      info = await r.json();
    } catch {
      box.hidden = true;
      return;
    }
    const { home, away } = this.start;
    card.innerHTML = `
      <button type="button" class="nm-x" aria-label="${esc(t("nm.cancel"))}">×</button>
      <p class="nm-kicker">CHALK · #${esc(info.seed)}</p>
      <div class="nm-fixture">
        <span class="nm-club">${crestImg(home.name, this.colors.home, "nm-crest")}<b>${esc(home.name)}</b></span>
        <span class="nm-v">v</span>
        <span class="nm-club">${crestImg(away.name, this.colors.away, "nm-crest")}<b>${esc(away.name)}</b></span>
      </div>
      <h2 class="nm-title" id="nmTitle">${esc(t("nm.title"))}</h2>
      <p class="nm-sub">${esc(t("nm.sub", { seed: info.seed }))}</p>
      <div class="nm-options">
        <button type="button" class="nm-opt" data-nm="live"><span class="nm-ic"><span class="live-dot"></span></span><b>${esc(t("nm.live"))}</b><small>${esc(t("nm.liveSub"))}</small></button>
        <button type="button" class="nm-opt" data-nm="hl"><span class="nm-ic">★</span><b>${esc(t("nm.hl"))}</b><small>${esc(t("nm.hlSub"))}</small></button>
      </div>`;
    const close = () => { box.hidden = true; };
    card.querySelector(".nm-x").addEventListener("click", close);
    card.querySelectorAll("[data-nm]").forEach((b) => b.addEventListener("click", () => {
      this.studio.soundOn?.();
      if (b.dataset.nm === "live") {
        close();
        this.goLive(info.seed); // the line-ups play at kick-off
      } else {
        this.goLive(info.seed, { prep: true });
        this.renderPrep(null);
      }
    }));
  }

  renderPrep(ev) {
    const card = $("chooserCard");
    if (!card.querySelector(".nm-prep")) {
      card.innerHTML = `<div class="nm-prep">
        <span class="nm-spin" aria-hidden="true"></span>
        <h2 class="nm-title">${esc(t("nm.prep", { seed: this.seed }))}</h2>
        <div class="nm-bar"><span id="nmBar"></span></div>
        <p class="nm-sub" id="nmProg"></p>
        <p class="nm-latest" id="nmLatest"></p>
      </div>`;
    }
    const now = performance.now();
    if (ev && this.lastPrepPaint && now - this.lastPrepPaint < 120) return;
    this.lastPrepPaint = now;
    const tNow = ev?.t ?? 0;
    $("nmBar").style.width = `${Math.min(100, (tNow / (95 * 60)) * 100).toFixed(1)}%`;
    $("nmProg").textContent = t("nm.prepSub", { clock: ev?.clock ?? "0'", n: this.studio.cards.length });
    const last = this.moments[this.moments.length - 1];
    if (last) $("nmLatest").textContent = `${last.clock} ${this.momentTitle(last)}`;
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
    if (force !== false && !this.playing && this.T >= this.endT && !this.live) this.seek(0); // replay from the start
    this.playing = force ?? !this.playing;
    $("playBtn").setAttribute("aria-pressed", String(this.playing));
    $("playBtn").setAttribute("aria-label", this.playing ? "Pause" : "Play");
  }

  // ---------------------------------------------------------- time control
  seek(T) {
    this.T = Math.max(0, Math.min(T, this.endT));
    this.stats.reset();
    this.heat.reset();
    this.squads.reset();
    this.ratings = null;
    this.evStack?.clear();
    this.layersUI && (this.layersUI.dirty = true);
    this.idx = 0;
    this.pitch.clearMarks();
    this.fx?.hide();
    this.studio.resync(this.T);
    this.advanceTo(this.T, true);
    $("momentList").innerHTML = "";
    this.momentsShown = 0;
    this.revealMoments(true);
    this.drawPulse();
    this.renderStats(true);
  }

  advanceTo(T, silent = false) {
    while (this.idx + 1 < this.events.length && this.events[this.idx + 1].t <= T) {
      this.idx++;
      const ev = this.events[this.idx];
      this.stats.apply(ev);
      this.squads.apply(ev);
      this.heat.add(ev, this.teamOf);
      if (!silent) this.onEvent(ev);
    }
    this.updateScoreboard();
  }

  teamOf = (pid) => this.roster[pid]?.team;

  isFan() { return this.studio?.prefs.persona === "casual"; }

  callVars(ev = this.events[this.idx]) {
    const lang = this.studio.prefs.lang, { home, away } = this.start;
    const sc = ev?.score || { home: 0, away: 0 };
    return { home: home.name, away: away.name, hs: sayScore(sc.home, sc.away, lang).split(/-| à | مقابل /)[0],
      as: sayScore(sc.home, sc.away, lang).split(/-| à | مقابل /)[1], score: sayScore(sc.home, sc.away, lang),
      venue: (this.start.venue || "").replace(/\s*\(fictional\)/, "") };
  }

  /** Live commentary on the moments that matter, in the viewer's language. */
  comment(ev) {
    const c = this.comm;
    if (!c.on || this.preparing) return;
    const v = this.callVars(ev), lang = this.studio.prefs.lang;
    const who = (pid) => this.roster[pid]?.name ?? "";
    const team = (side) => this.start[side]?.name ?? "";
    switch (ev.type) {
      case "kickoff":
        if (ev.period === 2) c.call("kickoff2", v, { priority: 2 });
        break;
      case "goal": {
        const side = ev.team, other = side === "home" ? "away" : "home";
        const after = ev.score[side], opp = ev.score[other], before = after - 1;
        const effect = before === 0 && opp === 0 ? "opener" : after === opp ? "equaliser"
          : before === opp ? "ahead" : before > opp ? "extends" : "pullsback";
        const minute = parseInt(ev.clock, 10);
        const text = [c.line("goal", { player: who(ev.player) }), c.line(effect, { ...v, team: team(side) }),
          minute >= 89 ? c.line("late") : ""].filter(Boolean).join(" ");
        c.speak(text, { priority: 3, excited: true });
        break;
      }
      case "shot": {
        if (ev.outcome === "goal") break;
        const key = ev.outcome === "saved" ? (ev.xg >= 0.12 ? "save" : null)
          : ev.outcome === "blocked" ? (ev.xg >= 0.2 ? "blocked" : null) : ev.xg >= 0.18 ? "miss" : null;
        if (key) c.call(key, v, { priority: 1, excited: ev.xg >= 0.3 });
        break;
      }
      case "card":
        c.call(ev.card === "red" ? "red" : "yellow", { player: who(ev.player), team: team(ev.team) }, { priority: ev.card === "red" ? 2 : 1, excited: ev.card === "red" });
        break;
      case "substitution":
        c.call("sub", { team: team(ev.team), on: who(ev.player), off: who(ev.player_off) }, { priority: 1 });
        break;
      case "formation_change":
        c.call("shape", { team: team(ev.team), formation: sayFormation(ev.to, lang) }, { priority: 1 });
        break;
      case "period_end": {
        const h = ev.score.home, a = ev.score.away;
        if (ev.period === 1) c.call("half", v, { priority: 2 });
        else c.call(h === a ? "fullDraw" : "full", { ...v, winner: team(h > a ? "home" : "away") }, { priority: 3, excited: true });
        break;
      }
    }
  }

  /** Full time: ratings for everyone who played, computed by code; the player of the match first. */
  showRatings() {
    const r = playerRatings({ events: this.events, idx: this.idx, start: this.start, squads: this.squads });
    if (!r.potm) return;
    this.ratings = r;
    const lang = this.studio.prefs.lang;
    const sayRating = (x) => { // "nine point four", the way a presenter reads it
      const [a, b] = x.toFixed(1).split(".");
      if (b === "0") return a;
      return `${a} ${lang === "en" ? "point" : lang === "fr" ? "virgule" : "فاصلة"} ${b}`;
    };
    this.fx.ratings({
      ...r, start: this.start, colors: this.colors, photo: (pid) => this.photo(pid),
      crest: (side) => crestURL(this.start[side].name, this.colors[side]),
      speak: this.comm.on ? (text) => this.comm.speak(text, { priority: 3, queue: true }) : null, // after the final-whistle call
      labels: { title: t("rt.title"), potm: t("rt.potm"), sayIntro: this.comm.line("ratings"),
                sayPotm: this.comm.line("potm", { player: r.potm.name, rating: sayRating(r.potm.rating) }) },
    });
    this.renderSquads(true);
  }

  managerPhoto(side) {
    const m = this.start[side].manager;
    if (!m) return "";
    if (this.portraits.has(`mgr-${side}`)) return `portraits/mgr-${side}.webp`;
    return avatarURL({ pid: `mgr-${side}`, name: m.name, color: this.colors[side], coach: true });
  }

  /** Floating emoji over the pitch (fan reactions, goal celebrations). */
  emojiBurst(set, n = 1, from = null) {
    const layer = $("emojiLayer");
    if (!layer || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (let i = 0; i < n; i++) {
      const e = document.createElement("span");
      e.className = "emo";
      e.textContent = set[i % set.length];
      e.style.left = `${from ? from + (Math.random() - 0.5) * 12 : 8 + Math.random() * 84}%`;
      e.style.setProperty("--dx", `${(Math.random() - 0.5) * 120}px`);
      e.style.setProperty("--s", (0.8 + Math.random() * 0.9).toFixed(2));
      e.style.animationDelay = `${Math.random() * (n > 1 ? 0.8 : 0)}s`;
      layer.appendChild(e);
      setTimeout(() => e.remove(), 3200);
    }
  }

  /** The shape predictor's card on the pitch: pending, then confirmed or not. */
  renderShapeWatch() {
    const el = $("shapeWatch");
    const p = this.squads.current(this.T);
    if (!p || this.isFan()) { el.hidden = true; this.swKey = null; return; }
    const key = `${p.team}|${p.t}|${p.status}|${this.studio.prefs.lang}`;
    el.hidden = false;
    if (key === this.swKey) return;
    this.swKey = key;
    const team = this.start[p.team];
    const pos = t(`role.${p.inPos}`), outPos = t(`role.${p.outPos}`);
    const why = p.reason === "like" ? t("shape.like", { from: p.from })
      : p.reason === "fits" ? t("shape.fits", { pos, from: p.from }) : t("shape.change", { pos, outPos, from: p.from, to: p.to });
    const status = {
      pending: t("shape.waiting"), confirmed: t("shape.confirmed", { clock: p.resolvedClock, to: p.actual }),
      different: t("shape.different", { actual: p.actual }), held: t("shape.held", { to: p.to }),
      unconfirmed: t("shape.unconfirmed", { actual: this.squads.formation[p.team] }),
    }[p.status];
    const ok = p.status === "confirmed" || p.status === "held";
    const lines = p.to.split("-").map(Number);
    const dots = [1, ...lines].map((n) => `<span class="sw-row">${"<i></i>".repeat(n)}</span>`).reverse().join("");
    el.style.setProperty("--team", this.colors[p.team]);
    el.className = `shape-watch ${p.status}`;
    el.innerHTML = `
      <p class="sw-k">${esc(t("shape.title"))} · ${crestImg(team.name, this.colors[p.team], "sw-crest")}${esc(team.short)} · ${esc(p.clock)}</p>
      <div class="sw-main"><div class="sw-pitch" aria-hidden="true">${dots}</div>
        <div><p class="sw-forms"><span>${esc(p.from)}</span><b>→</b><strong>${esc(p.to)}</strong>${p.men < 11 ? `<small>${esc(t("shape.men", { n: p.men }))}</small>` : ""}</p>
        <p class="sw-why">${esc(why)}</p></div></div>
      <p class="sw-status"><span class="sw-ic">${p.status === "pending" ? "" : ok ? "✓" : "✕"}</span>${esc(status)}</p>`;
  }

  /** The Squads tab: both XIs with their current roles, benches, managers, substitutions used. */
  renderSquads(force = false) {
    if ($("paneSquads").hidden && !force) return;
    const sq = this.squads;
    const side = (key) => {
      const team = this.start[key], col = this.colors[key];
      const used = sq.subs[key].length, max = team.max_subs || 5;
      const badges = (pid) => {
        const c = sq.cards[pid], g = sq.goals[pid];
        return `${g ? `<span class="sq-b goal">⚽${g.length > 1 ? `×${g.length}` : ""}</span>` : ""}${
          c?.yellow ? `<span class="sq-b yc"></span>` : ""}${c?.red ? `<span class="sq-b rc"></span>` : ""}${
          sq.on[pid] ? `<span class="sq-b in">▲ ${esc(sq.on[pid])}</span>` : ""}${
          sq.off[pid] ? `<span class="sq-b out">▼ ${esc(sq.off[pid])}</span>` : ""}`;
      };
      const row = (pid, role) => {
        const p = this.roster[pid];
        const gone = sq.sentOff.has(pid);
        const rt = this.ratings?.list.find((x) => x.pid === pid);
        return `<li class="sq-row${gone ? " gone" : ""}" data-pid="${pid}"><img src="${this.photo(pid)}" alt=""><span class="sq-num">${p.number}</span>
          <span class="sq-name">${esc(p.name)}</span><span class="sq-role">${esc(roleCode(role))}</span><span class="sq-badges">${badges(pid)}${
          rt ? `<span class="sq-rt ${rt.rating >= 8 ? "elite" : rt.rating >= 7 ? "good" : rt.rating >= 6 ? "ok" : "poor"}">${rt.rating.toFixed(1)}</span>` : ""}</span></li>`;
      };
      const xi = sq.slots[key].map((pid) => row(pid, sq.roleOf(pid))).join("");
      const benchIds = [...team.bench.map((p) => p.pid), ...team.players.map((p) => p.pid)].filter((pid) => !sq.slots[key].includes(pid));
      const bench = benchIds.map((pid) => {
        const p = this.roster[pid];
        return `<li class="sq-bench${sq.off[pid] ? " off" : ""}" data-pid="${pid}"><img src="${this.photo(pid)}" alt="">
          <b>${p.number}</b><span>${esc(p.short)}</span><small>${esc(roleCode(p.position))}</small>${badges(pid)}</li>`;
      }).join("");
      const m = team.manager;
      return `<section class="sq-team" style="--team:${col}">
        <header class="sq-head">${crestImg(team.name, col, "sq-crest")}<div><b>${esc(team.name)}</b>
          <span>${esc(t("sq.formation"))} <em>${esc(sq.formation[key])}</em></span></div></header>
        ${m ? `<div class="sq-mgr"><img src="${this.managerPhoto(key)}" alt=""><div><small>${esc(t("sq.manager"))}</small><b>${esc(m.name)}</b><span>${esc(m.style)}</span></div></div>` : ""}
        <div class="sq-subs"><span>${esc(t("sq.subs", { n: used, max }))}</span><span class="sq-pips">${
          Array.from({ length: max }, (_, i) => `<i class="${i < used ? "used" : ""}"></i>`).join("")}</span></div>
        <h3 class="sq-h">${esc(t("sq.xi"))}</h3><ol class="sq-xi">${xi}</ol>
        <h3 class="sq-h">${esc(t("sq.bench"))}</h3><ul class="sq-benchlist">${bench}</ul>
      </section>`;
    };
    $("squadsBody").innerHTML = side("home") + side("away");
    $("squadsBody").querySelectorAll("[data-pid]").forEach((li) => li.addEventListener("click", () => this.pcard.open(li.dataset.pid)));
  }

  /** Analyst rail and xG race (analyst mode); the fan zone (fan mode). */
  renderModePanels() {
    const s = this.stats, H = this.start.home.short, A = this.start.away.short;
    const h = s.t.home, a = s.t.away;
    if (!this.isFan()) {
      $("anRail").innerHTML = `
        <span><b>xG</b> ${h.xg.toFixed(2)}<i>–</i>${a.xg.toFixed(2)}</span>
        <span><b>${esc(t("stat.tilt"))}</b> ${s.tilt("home")}%<i>–</i>${s.tilt("away")}%</span>
        <span><b>PPDA</b> ${s.ppda("home") || "–"}<i>–</i>${s.ppda("away") || "–"}</span>
        <span><b>${esc(t("stat.sot"))}</b> ${h.sot}/${h.shots}<i>–</i>${a.sot}/${a.shots}</span>`;
      this.drawXgRace();
    } else {
      const pulse = this.summary.pulse.filter((p) => p.t <= this.T).at(-1);
      const dom = pulse ? pulse.dominance : 0, chaos = pulse ? pulse.chaos : 1;
      $("fzTug").style.setProperty("--k", ((dom + 1) / 2).toFixed(3));
      $("fzTugLabel").textContent = Math.abs(dom) < 0.15 ? t("fan.even") : t("fan.onTop", { team: this.start[dom > 0 ? "home" : "away"].name });
      const level = Math.max(0.1, Math.min(1, (chaos - 0.6) / 0.9));
      $("fzNoise").style.setProperty("--lv", level.toFixed(2));
      $("fzBigH").textContent = h.big;
      $("fzBigA").textContent = a.big;
      $("fzShotsH").textContent = h.shots;
      $("fzShotsA").textContent = a.shots;
    }
  }

  drawXgRace() {
    const cv = $("xgRace");
    if (!cv || !cv.clientWidth) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext("2d");
    c.clearRect(0, 0, w, h);
    const span = Math.max(this.span(), 1), pad = 6 * dpr;
    const maxXg = Math.max(1, this.stats.t.home.xg, this.stats.t.away.xg) * 1.15;
    const X = (tt) => pad + (tt / span) * (w - 2 * pad), Y = (v) => h - pad - (v / maxXg) * (h - 2 * pad);
    c.strokeStyle = "rgba(255,255,255,0.1)";
    c.lineWidth = 1 * dpr;
    for (let v = 0.5; v < maxXg; v += 0.5) { c.beginPath(); c.moveTo(pad, Y(v)); c.lineTo(w - pad, Y(v)); c.stroke(); }
    for (const side of ["home", "away"]) {
      const ser = [...this.stats.t[side].xgSeries, [this.T, this.stats.t[side].xg]];
      c.beginPath();
      ser.forEach(([tt, v], i) => {
        if (!i) { c.moveTo(X(tt), Y(v)); return; }
        c.lineTo(X(tt), Y(ser[i - 1][1])); // a step: xG only moves when a shot is taken
        c.lineTo(X(tt), Y(v));
      });
      c.strokeStyle = this.colors[side];
      c.lineWidth = 2.2 * dpr;
      c.shadowColor = this.colors[side];
      c.shadowBlur = 6 * dpr;
      c.stroke();
      c.shadowBlur = 0;
    }
    for (const m of this.moments) {
      if (m.t > this.T || m.type !== "goal") continue;
      const v = this.stats.t[m.team].xgSeries.filter(([tt]) => tt <= m.t + 0.5).at(-1)?.[1] ?? 0;
      c.beginPath(); c.arc(X(m.t), Y(v), 4 * dpr, 0, Math.PI * 2);
      c.fillStyle = "#fff"; c.fill();
      c.lineWidth = 2 * dpr; c.strokeStyle = this.colors[m.team]; c.stroke();
    }
  }

  /** The player's illustrated portrait (generated, never a photo of a real person). */
  photo(pid) {
    const p = this.roster[pid];
    if (p && this.portraits.has(pid)) return `portraits/${pid}.webp`;
    return p ? avatarURL({ pid, name: p.name, number: p.number, color: this.colors[p.team], keeper: p.position === "GK" }) : "";
  }

  onEvent(ev) {
    const p = this.pitch;
    this.evStack.push(ev);
    this.comment(ev);
    const name = (pid) => this.roster[pid]?.short ?? "";
    switch (ev.type) {
      case "pass": {
        const hard = ev.outcome === "complete" && ev.difficulty >= 70;
        p.addMark({ kind: "line", from: ev.start, to: ev.end, dashed: true, width: hard ? 2.6 : 1.5,
                    color: hard ? SIGNAL : "#ffffff", ttl: hard ? 2600 : 1000, seed: ev.id });
        if (hard && !this.isFan()) p.addMark({ kind: "label", at: ev.end, text: t("pitch.passDiff", { n: ev.difficulty }), tone: "signal", ttl: 2600 });
        break;
      }
      case "shot":
        this.lastShot = ev;
        if (ev.outcome !== "goal" && (ev.xg >= 0.2 || ev.outcome === "saved")) this.stadium.ooh();
        p.addMark({ kind: "line", from: ev.start, to: ev.end, width: 2.8, color: SIGNAL, ttl: 3200, arrow: true, seed: ev.id });
        // sits under the shooter so it never collides with the name tag above
        p.addMark({ kind: "label", at: ev.start, text: this.isFan() ? `\u{1F4A5} ${ev.speed_kmh} km/h` : `${ev.speed_kmh} km/h   xG ${ev.xg.toFixed(2)}`, tone: "signal", ttl: 3200, lift: -34 });
        break;
      case "sprint": {
        const pos = ev.frame[ev.player];
        if (ev.speed_kmh >= 30 && pos) p.addMark({ kind: "label", at: pos, text: `${this.isFan() ? "\u26A1 " : ""}${name(ev.player)} ${ev.speed_kmh} km/h`, ttl: 2200 });
        break;
      }
      case "goal": {
        const shot = this.lastShot || {};
        const pl = this.roster[ev.player] || {};
        this.fx.goal({
          team: ev.team, teamName: this.start[ev.team].name, color: this.colors[ev.team],
          scorer: pl.name, number: pl.number, clock: ev.clock, xg: (ev.xg ?? shot.xg ?? 0).toFixed(2),
          speed: shot.speed_kmh ?? "", distance: shot.distance_m ?? "", photo: this.photo(ev.player),
          scoreText: `${this.start.home.name} ${ev.score.home} – ${ev.score.away} ${this.start.away.name}`,
        });
        this.stadium.net();
        this.stadium.roar();
        if (this.isFan()) this.emojiBurst(["\u26BD", "\u{1F389}", "\u{1F525}", "\u{1F64C}"], 26);
        this.pitch.celebrate(this.colors[ev.team], "GOAL");
        this.queueVarCheck(ev, pl);
        break;
      }
      case "card":
        if (ev.card === "red") {
          const pl = this.roster[ev.player] || {};
          this.fx.redCard({ player: pl.name, number: pl.number, teamName: this.start[ev.team].name,
            color: this.colors[ev.team], clock: ev.clock, left: 11 - this.stats.t[ev.team].reds, photo: this.photo(ev.player) });
        }
        this.stadium.whistle(1);
        break;
      case "substitution": {
        const pin = this.roster[ev.player] || {}, pout = this.roster[ev.player_off] || {};
        const side = (pid, p) => ({ ...p, photo: this.photo(pid), name: p.name });
        this.fx.substitution({ teamName: this.start[ev.team].name, color: this.colors[ev.team], clock: ev.clock,
          crest: crestURL(this.start[ev.team].name, this.colors[ev.team]),
          n: this.squads.subs[ev.team].length, max: this.start[ev.team].max_subs || 5,
          manager: this.start[ev.team].manager?.name, off: side(ev.player_off, pout), on: side(ev.player, pin) });
        break;
      }
      case "formation_change":
        this.fx.tactics({ teamName: this.start[ev.team].name, color: this.colors[ev.team], from: ev.from, to: ev.to, clock: ev.clock,
          pred: this.squads.preds.find((x) => x.team === ev.team && x.resolvedT === ev.t) });
        break;
      case "kickoff":
        this.stadium.whistle(1);
        if (ev.period === 1 && ev.t < 5 && !this.studio.hl) {
          this.showLineups();
          this.fx.next = () => this.comm.call("kickoff1", this.callVars(ev), { priority: 2 });
        }
        break;
      case "tackle":
      case "interception":
        if (ev.ball) p.addMark({ kind: "ripple", at: ev.ball, color: this.colors[ev.team], ttl: 700 });
        break;
      case "period_end":
        this.fx.period({ label: t(ev.period === 1 ? "st.half" : "st.full"),
          scoreText: `${this.start.home.name} ${ev.score.home} – ${ev.score.away} ${this.start.away.name}` });
        this.stadium.whistle(ev.period === 1 ? 2 : 3, true);
        if (ev.period === 2) this.fx.next = () => this.showRatings();
        break;
    }
  }

  showLineups() {
    // where everyone stands at kick-off (the match-start record has no positions)
    const ko = this.events.find((e) => e.type === "kickoff" && e.period === 1);
    this.fx.lineups({
      start: this.start, frame: ko?.frame, colors: this.colors, photo: (pid) => this.photo(pid),
      crest: (side) => crestURL(this.start[side].name, this.colors[side]),
      // the stadium announcer: the graphic waits for each name to be read
      speak: this.comm.on ? (text, fresh) => this.comm.speak(text, { priority: 2, queue: !fresh }) : null,
      onStep: () => this.stadium.tick(),
      managerPhoto: (side) => this.managerPhoto(side),
    });
  }

  /** After the goal stinger: VAR checks the final pass on the frozen picture, lines and all. */
  queueVarCheck(ev, scorer) {
    const m = this.moments.find((x) => x.type === "goal" && Math.abs(x.t - ev.t) < 3);
    const geo = m?.geometry || {};
    const off = geo.offside;
    this.fx.next = () => {
      if (geo.frame) this.fx.frozen = { frame: geo.frame, ball: geo.ball };
      this.pitch.showVarLine(off || null);
      this.fx.onEnd = () => { if (!this.studio.onAir) this.pitch.showVarLine(null); };
      this.stadium.whistle(1);
      this.comm.call("varCheck", {}, { priority: 2, queue: true });
      setTimeout(() => this.comm.call("varOk", {}, { priority: 2, queue: true }), 2800);
      this.fx.varCheck({ clock: ev.clock, scorer: scorer.short || scorer.name, offside: off,
                         defender: off ? this.roster[off.defender]?.short : "" });
    };
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
    const scoreText = `${ev.score.home} – ${ev.score.away}`;
    const sb = $("sbScore");
    if (sb.textContent !== scoreText) {
      sb.textContent = scoreText;
      if (this.playing) { sb.classList.remove("flip"); void sb.offsetWidth; sb.classList.add("flip"); }
    }
    // only touch the scorebug when it changes, so a new red card animates in once
    const hHtml = `${crestImg(this.start.home.name, this.colors.home, "sb-crest")}${esc(this.start.home.short)}${reds("home")}`;
    const aHtml = `${reds("away")}${esc(this.start.away.short)}${crestImg(this.start.away.name, this.colors.away, "sb-crest")}`;
    if (this.sbCache !== hHtml + aHtml) {
      this.sbCache = hHtml + aHtml;
      $("sbHome").innerHTML = hHtml;
      $("sbAway").innerHTML = aHtml;
    }
    $("sbClock").textContent = ev.type === "period_end" ? (ev.period === 1 ? "HT" : "FT") : ev.clock;
    this.renderStats();
  }

  renderStats(force = false) {
    const now = performance.now();
    if (!force && this.lastStats && now - this.lastStats < 300) return;
    this.lastStats = now;
    this.studio?.renderPlayer(this.stats);
    const list = $("statList");
    const rows = this.stats.rows();
    if (list.children.length !== rows.length) {
      list.innerHTML = rows.map(() => `<li class="stat-row"><span class="v h"></span><span class="label"></span><span class="v a"></span>
        <span class="bar h2h" aria-hidden="true"><span class="half l"><span class="bh"></span></span><span class="half r"><span class="ba"></span></span></span></li>`).join("");
    }
    rows.forEach(([label, h, a, hv, av], i) => {
      const li = list.children[i];
      const sum = hv + av;
      const hs = sum ? hv / sum : 0.5;
      const [vh, lab, va] = li.children;
      if (vh.textContent !== String(h)) { vh.textContent = h; vh.classList.remove("tick"); void vh.offsetWidth; vh.classList.add("tick"); }
      if (va.textContent !== String(a)) { va.textContent = a; va.classList.remove("tick"); void va.offsetWidth; va.classList.add("tick"); }
      lab.textContent = label;
      vh.classList.toggle("trail", hv < av);
      va.classList.toggle("trail", av < hv);
      // head-to-head bars grow out from the centre; the leader fills its half
      const top = Math.max(hv, av) || 1;
      li.querySelector(".bh").style.width = `${((hv / top) * 100).toFixed(1)}%`;
      li.querySelector(".ba").style.width = `${((av / top) * 100).toFixed(1)}%`;
      li.classList.toggle("lead-h", hv > av);
      li.classList.toggle("lead-a", av > hv);
    });
    this.renderWinProb();
    this.renderModePanels();
    this.renderSquads();
  }

  renderWinProb() {
    const ev = this.events[this.idx];
    const ts = this.stats.t;
    const ended = ev.type === "period_end" && ev.period === 2 || ev.type === "match_end";
    const wp = ended
      ? { home: ev.score.home > ev.score.away ? 100 : 0, away: ev.score.away > ev.score.home ? 100 : 0, draw: ev.score.home === ev.score.away ? 100 : 0 }
      : winProbability({ T: ev.t, score: ev.score, xg: { home: ts.home.xg, away: ts.away.xg }, men: { home: 11 - ts.home.reds, away: 11 - ts.away.reds } });
    $("wpH").style.flexGrow = Math.max(wp.home, 0.5);
    $("wpD").style.flexGrow = Math.max(wp.draw, 0.5);
    $("wpA").style.flexGrow = Math.max(wp.away, 0.5);
    $("wpHn").textContent = `${this.start.home.short} ${wp.home}%`;
    $("wpDn").textContent = t("wp.draw", { n: wp.draw });
    $("wpAn").textContent = `${wp.away}% ${this.start.away.short}`;
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
        <span class="m-title">${esc(this.momentTitle(m))}</span></button>`;
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
        const fill = c.createLinearGradient(0, side === "home" ? top : bottom, 0, mid);
        fill.addColorStop(0, this.colors[side]);
        fill.addColorStop(1, `${this.colors[side]}55`);
        c.fillStyle = fill;
        c.fill(path);
        c.restore();
      }
      // the edge of the curve in the broadcast gradient, glowing
      const edge = new Path2D();
      pts.forEach((p, i) => (i ? edge.lineTo(X(p.t), mid - p.dominance * amp) : edge.moveTo(X(p.t), mid - p.dominance * amp)));
      const g = c.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, "#00e0ff"); g.addColorStop(0.5, "#8b6bff"); g.addColorStop(1, "#ff2d8f");
      c.save();
      c.strokeStyle = g;
      c.lineWidth = 2 * dpr;
      c.lineJoin = "round";
      c.shadowColor = "rgba(139,107,255,0.8)";
      c.shadowBlur = 6 * dpr;
      c.stroke(edge);
      c.restore();
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
    this.layersUI.tick(now);
    this.squads.expire(this.T);
    if (Math.floor(now / 200) !== this.lastSwTick) { this.lastSwTick = Math.floor(now / 200); this.renderShapeWatch(); }
    if (Math.floor(now / 250) !== this.lastCrowdTick) {
      this.lastCrowdTick = Math.floor(now / 250);
      const pts = this.summary.pulse;
      let chaos = 1;
      for (let i = pts.length - 1; i >= 0; i--) if (pts[i].t <= this.T) { chaos = pts[i].chaos; break; }
      this.stadium.follow(chaos, this.playing, !!this.studio.onAir);
    }
    if (this.playing && !this.studio.onAir?.paused && !this.fx.active(now)) {
      const before = this.idx;
      this.T = Math.min(this.endT, this.T + dt * this.speed);
      this.advanceTo(this.T);
      if (this.idx !== before) this.revealMoments();
      this.studio.check(this.T);
      const tick = Math.floor(now / 200);
      if (tick !== this.lastPulseTick) { this.lastPulseTick = tick; this.drawPulse(); }
      // the recap waits for the full-time graphics (final whistle, then the ratings)
      if (this.T >= this.endT && (!this.live || this.liveEnded) && !this.fx.active(now) && !this.fx.next) {
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
    const frozen = this.studio.frozenFrame() || this.fx.frozen;
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
    // long passes and shots leave the grass: a parabola, higher for longer balls
    let ballZ = 0;
    if ((a.type === "pass" || a.type === "shot") && a.start && a.end) {
      const d = Math.hypot(a.end[0] - a.start[0], a.end[1] - a.start[1]);
      const peak = a.type === "shot" ? (d > 18 ? 2.2 : 0.6) : d > 24 ? Math.min(9, d * 0.18) : 0;
      ballZ = 4 * peak * ease * (1 - ease);
    }
    // the ring follows the ball: on a pass it moves to the receiver
    const carrier = a.type === "pass" ? (a.outcome === "complete" ? a.to : null)
      : ON_BALL.has(a.type) || WINS_BALL.has(a.type) ? a.player : null;
    this.pitch.draw(frame, ball, carrier, now, ballZ);
  }
}

load()
  .then((data) => {
    window.chalk = new Replay(data);
    if (!params.has("nowelcome")) window.chalk.studio.showWelcome();
    fetch("/api/health").then((r) => (r.ok ? r.json() : null)).then((h) => {
      if (!h?.ok) return;
      const app = window.chalk;
      $("startLive").hidden = false;
      $("startNew").hidden = false;
      $("newMatchBtn").hidden = false;
      app.ask.setAvailable(true, (h.features || []).includes("ask"));
      const fresh = () => { app.studio.soundOn(); app.openChooser(); };
      $("newMatchBtn").addEventListener("click", fresh);
      $("startNew").addEventListener("click", fresh);
      if (params.has("live")) { app.studio.hideOverlays(); app.goLive(); }
    }).catch(() => { /* static hosting: replay only */ });
  })
  .catch((err) => {
    $("matchTitle").textContent = err.message;
    console.error(err);
  });
