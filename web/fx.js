// Broadcast effects: event stingers, chalk confetti and a procedural stadium.
// Everything here is generated in the browser: no images, no recorded audio.

import { lang, t } from "./i18n.js";
import { ANCHORS, FORMATIONS, roleCode } from "./formations.js";

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
    this.next = null; // a stinger queued to follow the current one (VAR check after a goal)
    this.frozen = null; // a frame the broadcast holds while VAR checks it
    this.onEnd = null;
  }

  /** True while a stinger holds the broadcast. */
  active(now = performance.now()) {
    return now < this.until;
  }

  show(html, cls, ms, wipe = true) {
    clearTimeout(this.timer);
    if (wipe) this.onShow?.();
    if (wipe && !reduceMotion) { // a gradient wipe sweeps across, revealing the graphic
      const w = $("wipe");
      if (w) { w.classList.remove("go"); void w.offsetWidth; w.classList.add("go"); }
    }
    this.el.className = `stinger ${cls}`;
    this.el.innerHTML = html;
    this.el.hidden = false;
    this.until = performance.now() + ms;
    this.timer = setTimeout(() => this.finish(), ms);
  }

  /** The stinger ran its course: clean up, then play the queued one, if any. */
  finish() {
    const next = this.next;
    this.next = null;
    this.hide(false);
    if (next) next();
  }

  /** Stop everything (a seek, a new feed). */
  hide(clearQueue = true) {
    clearTimeout(this.timer);
    (this.steps || []).forEach(clearTimeout);
    this.steps = [];
    if (clearQueue) this.next = null;
    this.el.hidden = true;
    this.until = 0;
    this.frozen = null;
    const end = this.onEnd;
    this.onEnd = null;
    if (end) end();
  }

  /** VAR check on a goal: freeze on the final pass, measure, decide. */
  varCheck({ clock, scorer, offside, defender }) {
    const ok = !offside || offside.onside;
    const margin = offside ? Math.abs(offside.margin_m).toFixed(1) : null;
    const steps = offside
      ? [t("var.possible", { name: scorer }), t("var.lineSet", { name: defender, m: margin }), t(ok ? "var.onside" : "var.offside", { m: margin })]
      : [t("var.buildup", { name: scorer }), t("var.noFoul"), t("var.noError")];
    const html = `
      <div class="var-scan" aria-hidden="true"></div>
      <div class="var-panel">
        <div class="var-tag"><span>VAR</span><i class="var-rec" aria-hidden="true"></i></div>
        <div class="var-steps">
          <p class="var-k">${esc(clock)} · ${esc(t("var.checking"))}</p>
          <ol>${steps.map((t, i) => `<li style="--d:${0.35 + i * 0.85}s" class="${i === 2 ? (ok ? "ok" : "no") : ""}">${esc(t)}</li>`).join("")}</ol>
          <span class="var-progress" aria-hidden="true"></span>
        </div>
        <div class="var-decision ${ok ? "ok" : "no"}" style="--d:2.75s"><b>${esc(t(ok ? "var.goal" : "var.noGoal"))}</b><small>${esc(t(ok ? "var.stands" : "var.overturned"))}</small></div>
      </div>`;
    this.show(html, "is-var", reduceMotion ? 2600 : 4400);
  }

  /** VAR review of the AI: what the fact-checker caught, and what finally aired. */
  varReview({ clock, issue, final }) {
    const ok = final === "verified";
    const html = `
      <div class="var-panel var-ai">
        <div class="var-tag ai"><span>VAR</span><small>${esc(t("var.aiReview"))}</small></div>
        <div class="var-steps">
          <p class="var-k">${esc(clock)} · ${esc(t("var.factCheck"))}</p>
          <ol>
            <li style="--d:0.3s" class="no">${esc(t("var.caught", { issue }))}</li>
            <li style="--d:1.15s">${esc(t(ok ? "var.rewrote" : "var.replaced"))}</li>
          </ol>
          <span class="var-progress" aria-hidden="true"></span>
        </div>
        <div class="var-decision ${ok ? "ok" : "warn"}" style="--d:1.9s"><b>${esc(t(ok ? "var.verified" : "var.safe"))}</b><small>${esc(t(ok ? "var.everyNumber" : "var.rulebook"))}</small></div>
      </div>`;
    this.show(html, "is-var is-var-ai", reduceMotion ? 2200 : 3400, false);
  }

  goal({ team, teamName, color, scorer, number, clock, xg, speed, distance, scoreText, photo }) {
    const html = `
      <div class="st-bands" aria-hidden="true">
        <span style="background:${color}"></span><span></span><span style="background:${color}"></span>
      </div>
      <div class="st-goal">
        <p class="st-word" aria-label="${esc(t("st.goal"))}">${lang() === "ar" ? `<span style="--i:0">${esc(t("st.goal"))}</span>`
          : t("st.goal").split("").map((c, i) => `<span style="--i:${i}">${esc(c)}</span>`).join("")}</p>
        <p class="st-who">${photo ? `<img class="st-photo" src="${photo}" alt="">` : ""}<span class="st-num" style="background:${color}">${esc(number)}</span>${esc(scorer)}<span class="st-clock">${esc(clock)}</span></p>
        <p class="st-stats">
          <span>xG <b>${esc(xg)}</b></span><span><b>${esc(speed)}</b> km/h</span><span><b>${esc(distance)}</b> m</span>
        </p>
        <p class="st-score">${esc(scoreText)}</p>
      </div>`;
    this.show(html, `is-goal team-${team}`, reduceMotion ? 2200 : 3300);
    if (!reduceMotion) this.confetti.burst(color);
  }

  redCard({ player, number, teamName, color, clock, left, photo }) {
    const html = `
      <div class="st-red">
        <div class="st-card" aria-hidden="true">${photo ? `<img src="${photo}" alt="">` : ""}</div>
        <div class="st-red-text">
          <p class="st-kicker">${esc(clock)} ${esc(t("st.sentOff"))}</p>
          <p class="st-who"><span class="st-num" style="background:${color}">${esc(number)}</span>${esc(player)}</p>
          <p class="st-sub">${esc(t("st.downTo", { team: teamName, n: left }))}</p>
          <p class="st-ban">${esc(t("st.ban"))}</p>
        </div>
      </div>`;
    this.show(html, "is-red", 2700);
  }

  /** The fourth official's board: who goes off, who comes on, how many changes are left. */
  substitution({ teamName, color, crest, clock, n, max, manager, off, on }) {
    const pips = Array.from({ length: max }, (_, i) => `<i class="${i < n ? "used" : ""}${i === n - 1 ? " now" : ""}"></i>`).join("");
    const side = (p, kind) => `
      <div class="sb2-side ${kind}">
        <img class="sb2-photo" src="${p.photo}" alt="">
        <div class="sb2-led"><span class="arrow" aria-hidden="true">${kind === "out" ? "\u25BC" : "\u25B2"}</span><span class="digits">${esc(String(p.number).padStart(2, "0"))}</span></div>
        <p class="sb2-name">${esc(p.name)}</p>
        <p class="sb2-role">${esc(t(kind === "out" ? "sub.off" : "sub.on"))} · ${esc(roleCode(p.position))}</p>
      </div>`;
    const html = `
      <div class="sb2" style="--team:${color}">
        <div class="sb2-head">${crest ? `<img src="${crest}" alt="">` : ""}<b>${esc(teamName)}</b><span>${esc(clock)}</span></div>
        <div class="sb2-body">${side(off, "out")}<span class="sb2-swap" aria-hidden="true">\u21C4</span>${side(on, "in")}</div>
        <div class="sb2-foot"><span>${esc(t("sub.title", { n, max }))}</span><span class="sb2-pips" aria-hidden="true">${pips}</span></div>
        ${manager ? `<p class="sb2-mgr">${esc(t("sub.by", { name: manager }))}</p>` : ""}
      </div>`;
    this.show(html, "is-sub", reduceMotion ? 2600 : 3600);
  }

  tactics({ teamName, color, from, to, clock, pred }) {
    const html = `
      <div class="st-tactic">
        <p class="st-kicker">${esc(clock)} ${esc(t("st.shape"))}</p>
        <p class="st-team" style="color:${color}">${esc(teamName)}</p>
        <p class="st-forms"><span>${esc(from)}</span><span class="to" aria-label="to">→</span><span class="new">${esc(to)}</span></p>
        ${pred ? `<p class="st-pred ${pred.status === "confirmed" ? "ok" : "no"}">${esc(pred.status === "confirmed" ? t("st.predicted", { clock: pred.clock }) : t("st.unpredicted"))}</p>` : ""}
      </div>`;
    this.show(html, "is-tactic", 2500);
  }

  /**
   * Line-ups, announced like a broadcast: for each team the keeper, then the defence,
   * midfield and attack, one player at a time, each with a spotlight card and portrait
   * while their spot lights up on the formation. Skippable.
   */
  lineups({ start, frame, colors, photo, crest, speak, onStep, managerPhoto }) {
    // Each player at their real formation position (deep midfielder below the other two,
    // full-backs pushed on, wingers high and wide), attacking upwards, right side on the right.
    // Announced like a stadium: keeper, defence right to left, midfield from the deepest, attack.
    const LINE = { GK: 0, RB: 1, CB: 1, LB: 1, RWB: 1, LWB: 1, DM: 2, CM: 3, RM: 3, LM: 3, CAM: 4, RAM: 4, LAM: 4, RW: 5, ST: 5, LW: 5 };
    const plan = (key) => {
      const team = start[key];
      const roles = FORMATIONS[team.formation] || [];
      const anchors = ANCHORS[team.formation] || [];
      return team.players.map((p, i) => {
        const slotRole = roles[i] || p.position;
        const [ax, ay] = anchors[i] || [30, 34];
        return { p, slotRole, code: roleCode(slotRole), role: t(`role.${slotRole}`), line: LINE[slotRole] ?? 3, ay,
          top: 91 - ((ax - 5) / 53) * 79, left: Math.max(9, Math.min(91, (ay / 68) * 100)) };
      }).sort((a, b) => a.line - b.line || b.ay - a.ay);
    };
    const teamHtml = (key, players) => {
      const team = start[key];
      const slots = players.map((s, i) => `<span class="lx-slot" data-i="${i}" style="top:${s.top.toFixed(1)}%;left:${s.left.toFixed(1)}%">
          <img src="${photo(s.p.pid)}" alt=""><b>${esc(s.p.number)}</b><i>${esc(s.p.short)}</i><u>${esc(s.code)}</u></span>`).join("");
      return `<div class="lx" style="--team:${colors[key]}">
        <div class="lx-bg" aria-hidden="true"><span></span><span></span><span></span></div>
        <button type="button" class="lx-skip">${esc(t("lu.skip"))} ›</button>
        <div class="lx-left">
          <div class="lx-head"><span class="lx-kicker">${esc(t("lu.xi"))}<span class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span></span><span class="lx-club">${crest ? `<img class="lx-crest" src="${crest(key)}" alt="">` : ""}${esc(team.name)}</span><span class="lx-form">${esc(team.formation)}</span></div>
          <div class="lx-pitch"><span class="lx-box" aria-hidden="true"></span>${slots}</div>
          <p class="lx-bench">${esc(t("lu.subs"))} · ${team.bench.map((b) => `${esc(b.number)} ${esc(b.short)}`).join(" · ")}</p>
        </div>
        <div class="lx-right"><div class="lx-stage" aria-live="polite"></div></div>
        <div class="lx-progress" aria-hidden="true"><span></span></div>
      </div>`;
    };
    const spot = (s) => {
      const [first, ...rest] = s.p.name.split(" ");
      return `<div class="lx-spot">
        <span class="lx-num" aria-hidden="true">${esc(s.p.number)}</span>
        <img class="lx-photo${photo(s.p.pid).startsWith("portraits/") ? " real" : ""}" src="${photo(s.p.pid)}" alt="">
        <div class="lx-plate"><small><em>${esc(s.code)}</em> ${esc(s.role)} · ${esc(s.p.number)}</small><span>${esc(first)}</span><b>${esc(rest.join(" ") || first)}</b></div>
      </div>`;
    };
    const teams = ["home", "away"].map((key) => ({ key, players: plan(key) }));
    // The sequence waits for the announcer: with the voice on, each player stays on screen
    // until their name has been read; without it, a steady broadcast pace.
    const token = (this.lxToken = {});
    const alive = () => this.lxToken === token && !this.el.hidden;
    this.steps = [];
    const sleep = (sec) => new Promise((r) => this.steps.push(setTimeout(r, sec * 1000)));
    const announce = (text, fresh = false) => (speak ? speak(text, fresh) : Promise.resolve());
    const hold = async (text, minSec, fresh = false) => {
      if (speak) { await Promise.all([announce(text, fresh), sleep(minSec)]); await sleep(0.3); } else await sleep(minSec);
    };
    const STEP = reduceMotion ? 0.3 : 1.1, HEAD = 1.4, MGR = 2.4;
    this.show(teamHtml("home", teams[0].players), "is-lineups", 15 * 60 * 1000); // held until the sequence ends
    const spokenForm = (f) => String(f).split("-").join(" ");
    (async () => {
      for (const [ti, { key, players }] of teams.entries()) {
        if (ti) {
          const w = $("wipe");
          if (w && !reduceMotion) { w.classList.remove("go"); void w.offsetWidth; w.classList.add("go"); }
          this.onShow?.();
          await sleep(0.3);
          if (!alive()) return;
          this.el.innerHTML = teamHtml(key, players);
          this.bindSkip();
        }
        await hold(t("say.team", { team: start[key].name, formation: spokenForm(start[key].formation) }), HEAD, ti === 0);
        for (const [i, s] of players.entries()) {
          if (!alive()) return;
          const stage = this.el.querySelector(".lx-stage");
          const slot = this.el.querySelector(`.lx-slot[data-i="${i}"]`);
          if (!stage || !slot) return;
          slot.classList.add("on");
          onStep?.();
          stage.querySelector(".lx-spot:not(.out)")?.classList.add("out");
          stage.insertAdjacentHTML("beforeend", spot(s));
          while (stage.children.length > 2) stage.firstElementChild.remove();
          const bar = this.el.querySelector(".lx-progress span");
          if (bar) bar.style.width = `${((i + 1) / 12) * 100}%`;
          await hold(t("say.role", { role: s.role, name: s.p.name }), STEP);
        }
        if (!alive()) return;
        const stage = this.el.querySelector(".lx-stage");
        const m = start[key].manager;
        this.el.querySelector(".lx-bench")?.classList.add("on");
        if (stage && m) { // the manager, then the bench
          stage.querySelector(".lx-spot:not(.out)")?.classList.add("out");
          const [first, ...rest] = m.name.split(" ");
          stage.insertAdjacentHTML("beforeend", `<div class="lx-spot lx-mgr">
            <img class="lx-photo" src="${managerPhoto ? managerPhoto(key) : ""}" alt="">
            <div class="lx-plate"><small><em>MGR</em> ${esc(t("lu.manager"))}</small><span>${esc(first)}</span><b>${esc(rest.join(" "))}</b><span class="lx-style">${esc(m.style)}</span></div>
          </div>`);
          while (stage.children.length > 2) stage.firstElementChild.remove();
          const bar = this.el.querySelector(".lx-progress span");
          if (bar) bar.style.width = "100%";
          onStep?.();
          await hold(t("say.manager", { name: m.name }), MGR);
        }
      }
      if (alive()) this.finish();
    })();
    this.bindSkip();
  }

  /** Full time: every player's rating, the player of the match first. */
  ratings({ list, potm, start, colors, photo, crest, speak, labels }) {
    const tone = (r) => (r >= 8 ? "elite" : r >= 7 ? "good" : r >= 6 ? "ok" : "poor");
    const team = (side) => {
      const rows = list.filter((x) => x.side === side).sort((a, b) => b.rating - a.rating);
      return `<div class="rt-team" style="--team:${colors[side]}">
        <p class="rt-head">${crest ? `<img src="${crest(side)}" alt="">` : ""}<b>${esc(start[side].name)}</b></p>
        <ol>${rows.map((x, i) => `<li class="${x.pid === potm.pid ? "potm" : ""}" style="--d:${(0.6 + i * 0.09).toFixed(2)}s">
          <img src="${photo(x.pid)}" alt=""><span class="rt-num">${x.number}</span>
          <span class="rt-name">${esc(x.name)}${x.sub ? " <i>\u25B2</i>" : ""}${x.red ? ' <i class="rc"></i>' : ""}</span>
          <span class="rt-pos">${esc(roleCode(x.position))}</span><span class="rt-r ${tone(x.rating)}">${x.rating.toFixed(1)}</span></li>`).join("")}</ol>
      </div>`;
    };
    const stats = [potm.goals ? `\u26BD ${potm.goals}` : "", potm.assists ? `\u{1F170}\uFE0F ${potm.assists}` : "",
      potm.sot ? `\u{1F3AF} ${potm.sot}` : "", `xG ${potm.xg.toFixed(2)}`, potm.passes ? `${potm.comp}/${potm.passes}` : "",
      potm.saves ? `\u{1F9E4} ${potm.saves}` : ""].filter(Boolean).join(" · ");
    const html = `<div class="rt">
      <button type="button" class="lx-skip">${esc(t("lu.skip"))} ›</button>
      <p class="rt-title">${esc(labels.title)}</p>
      <div class="rt-grid">
        <div class="rt-potm" style="--team:${colors[potm.side]}">
          <p class="rt-k">${esc(labels.potm)}</p>
          <img class="rt-photo" src="${photo(potm.pid)}" alt="">
          <p class="rt-pname">${esc(potm.name)}</p>
          <p class="rt-big">${potm.rating.toFixed(1)}</p>
          <p class="rt-stats">${stats}</p>
        </div>
        ${team("home")}${team("away")}
      </div>
    </div>`;
    const token = (this.lxToken = {});
    this.steps = [];
    this.show(html, "is-ratings", 15 * 60 * 1000);
    this.bindSkip();
    const alive = () => this.lxToken === token && !this.el.hidden;
    (async () => {
      const wait = (sec) => new Promise((r) => this.steps.push(setTimeout(r, sec * 1000)));
      if (speak) {
        await Promise.all([speak(labels.sayIntro, true), wait(2)]);
        await Promise.all([speak(labels.sayPotm), wait(4)]);
        await wait(5);
      } else await wait(11);
      if (alive()) this.finish();
    })();
  }

  bindSkip() {
    this.el.querySelector(".lx-skip")?.addEventListener("click", () => {
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      this.finish();
    });
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

  /** The ball hitting the net: a soft thud and the ripple of the mesh. */
  net() {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.3);
    for (let i = 0; i < 3; i++) { // the mesh rustles a few times as it settles
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2600 - i * 500;
      const ng = ctx.createGain();
      const t0 = t + 0.02 + i * 0.11;
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.35 / (i + 1), t0 + 0.015);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      src.connect(hp).connect(ng).connect(this.master);
      src.start(t0, Math.random()); src.stop(t0 + 0.25);
    }
  }

  /** A broadcast swoosh for graphic transitions. */
  whoosh() {
    if (!this.on || !this.ctx) return;
    this.swell({ peak: 0.16, attack: 0.18, decay: 0.45, freq: 500, q: 1.4, sweepTo: 4200 });
  }

  /** A soft tick (line-up announcements). */
  tick() {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(1320, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.14);
  }

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
