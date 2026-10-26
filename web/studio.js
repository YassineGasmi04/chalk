// The studio: puts the AI crew's insights on air and shapes them for each viewer.
//
// When playback reaches an insight's on-air time, the broadcast freezes on the
// moment, the Telestrator's drawings appear stroke by stroke, and a lower-third
// shows the caption for the viewer's mode (Analyst / Fan) and language
// (EN / FR / AR). "Why?" opens the crew's working: claims, facts, VAR, timings.

import { makeShareCard, shareOrDownload } from "./share.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (id) => document.getElementById(id);

const TYPE_LABELS = {
  en: { goal: "Goal", big_chance: "Big chance", red_card: "Red card", press_surge: "Press surge",
        momentum_swing: "Momentum", chaos_spike: "Chaos", tactical_shift: "Tactics",
        substitution: "Substitution", hardest_pass: "Pass of the match", speed_burst: "Top speed",
        rocket_shot: "Rocket", milestone: "Milestone" },
  fr: { goal: "But", big_chance: "Grosse occasion", red_card: "Carton rouge", press_surge: "Pressing",
        momentum_swing: "Dynamique", chaos_spike: "Chaos", tactical_shift: "Tactique",
        substitution: "Changement", hardest_pass: "Passe du match", speed_burst: "Vitesse",
        rocket_shot: "Frappe", milestone: "Cap" },
  ar: { goal: "هدف", big_chance: "فرصة كبيرة", red_card: "بطاقة حمراء", press_surge: "ضغط عالٍ",
        momentum_swing: "تحوّل", chaos_spike: "فوضى", tactical_shift: "تكتيك",
        substitution: "تبديل", hardest_pass: "تمريرة المباراة", speed_burst: "سرعة",
        rocket_shot: "قذيفة", milestone: "إنجاز" },
};
const TYPE_LABEL = TYPE_LABELS.en;
const UI = {
  en: { yourClub: "Your club", yourPlayer: "Your player", ok: "VAR checked", safe: "Rulebook version", rules: "Rules checked", why: "Why?", resume: "Resume", share: "Share" },
  fr: { yourClub: "Votre club", yourPlayer: "Votre joueur", ok: "Vérifié VAR", safe: "Version sûre", rules: "Règles vérifiées", why: "Pourquoi ?", resume: "Reprendre", share: "Partager" },
  ar: { yourClub: "فريقك", yourPlayer: "لاعبك", ok: "تحقق الفار", safe: "نسخة آمنة", rules: "قواعد", why: "لماذا؟", resume: "استئناف", share: "مشاركة" },
};
const STORE_KEY = "chalk.viewer";

function loadPrefs() {
  const base = { persona: "analyst", lang: "en", club: "", player: "", pause: true, voice: false };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") };
  } catch {
    return base;
  }
}

function savePrefs(p) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* private mode: fine */ }
}

export class Studio {
  constructor(replay, insights) {
    this.r = replay;
    this.insights = insights;
    this.cards = (insights?.cards || []).slice().sort((a, b) => a.on_air_t - b.on_air_t);
    this.byMoment = new Map(this.cards.map((c) => [c.moment_id, c]));
    this.momentById = new Map(replay.moments.map((m) => [m.id, m]));
    this.prefs = loadPrefs();
    this.aired = new Set(); // moment ids already on air (supports cards arriving live)
    this.onAir = null; // {card, frame, ball, start, hold, paused}
    this.lastCard = null;
    this.setupViewer();
    this.setupTabs();
    const eng = insights?.engine;
    $("crewEngine").textContent = eng ? (eng.provider === "offline" ? "Offline crew" : `${eng.model} on Foundry`) : "";
    this.renderTrust();
  }

  // ------------------------------------------------------------- viewer
  setupViewer() {
    const start = this.r.start;
    const clubPick = $("clubPick");
    for (const side of ["home", "away"]) {
      clubPick.insertAdjacentHTML("beforeend", `<option value="${side}">${esc(start[side].name)}</option>`);
    }
    const playerPick = $("playerPick");
    for (const side of ["home", "away"]) {
      const group = document.createElement("optgroup");
      group.label = start[side].name;
      for (const p of [...start[side].players, ...start[side].bench]) {
        group.insertAdjacentHTML("beforeend", `<option value="${p.pid}">${p.number} ${esc(p.name)}</option>`);
      }
      playerPick.appendChild(group);
    }
    const bindSeg = (attr, key) => document.querySelectorAll(`[data-${attr}]`).forEach((b) => {
      b.addEventListener("click", () => { this.prefs[key] = b.dataset[attr]; this.applyPrefs(); });
    });
    bindSeg("persona", "persona");
    bindSeg("lang", "lang");
    clubPick.addEventListener("change", () => { this.prefs.club = clubPick.value; this.applyPrefs(); });
    playerPick.addEventListener("change", () => { this.prefs.player = playerPick.value; this.applyPrefs(); });
    $("pauseToggle").addEventListener("change", (e) => { this.prefs.pause = e.target.checked; this.applyPrefs(); });
    $("voiceToggle").addEventListener("change", (e) => {
      this.prefs.voice = e.target.checked;
      if (!this.prefs.voice) this.silence();
      this.applyPrefs();
    });
    if (!("speechSynthesis" in window)) $("voiceToggle").closest("label").hidden = true;
    $("hlBtn").addEventListener("click", () => (this.hl ? this.stopHighlights() : this.startHighlights()));
    $("startMatch").addEventListener("click", () => { this.hideOverlays(); this.r.seek(0); this.r.toggle(true); });
    $("startHighlights").addEventListener("click", () => this.startHighlights());
    $("startLive").addEventListener("click", () => { this.hideOverlays(); this.r.goLive(); });
    $("insWhy").addEventListener("click", () => { this.selectTab("tabCrew"); });
    $("insNext").addEventListener("click", () => this.end());
    $("insShare").addEventListener("click", () => this.share());
    this.applyPrefs(true);
  }

  applyPrefs(initial = false) {
    const p = this.prefs;
    for (const [attr, key] of [["persona", "persona"], ["lang", "lang"]]) {
      document.querySelectorAll(`[data-${attr}]`).forEach((b) => {
        const on = b.dataset[attr] === p[key];
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
    }
    $("clubPick").value = p.club;
    $("playerPick").value = p.player;
    $("pauseToggle").checked = p.pause;
    $("voiceToggle").checked = p.voice;
    this.r.pitch.focus = p.player || null;
    savePrefs(p);
    this.r.ask?.render();
    if (!initial) {
      if (this.onAir) this.renderCard(this.onAir.card);
      if (!$("recap").hidden) this.showRecap();
      this.r.renderStats(true);
      this.r.refreshMomentMarks();
    }
  }

  isMine(team, players = []) {
    return (this.prefs.club && team === this.prefs.club) || (this.prefs.player && players.includes(this.prefs.player));
  }

  // --------------------------------------------------------------- tabs
  setupTabs() {
    const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
    tabs.forEach((t) => t.addEventListener("click", () => this.selectTab(t.id)));
    tabs.forEach((t, i) => t.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      this.selectTab(n.id);
      n.focus();
    }));
  }

  selectTab(id) {
    document.querySelectorAll('.tabs [role="tab"]').forEach((t) => {
      const on = t.id === id;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    });
    document.dispatchEvent(new CustomEvent("tabchange"));
  }

  // ---------------------------------------------------------- scheduling
  /** Called after a seek: cards before T have already aired. */
  resync(T) {
    this.end(false);
    this.aired = new Set(this.cards.filter((c) => c.on_air_t <= T).map((c) => c.moment_id));
  }

  /** A card that arrived over the live feed. */
  addCard(card) {
    if (this.byMoment.has(card.moment_id)) return;
    this.cards.push(card);
    this.cards.sort((a, b) => a.on_air_t - b.on_air_t);
    this.byMoment.set(card.moment_id, card);
    this.renderTrust();
  }

  reset() {
    this.end(false);
    this.cards = [];
    this.byMoment = new Map();
    this.momentById = new Map();
    this.aired = new Set();
    if (this.insights) { this.insights.recap = null; this.insights.stats = null; }
    this.renderTrust();
  }

  /** Called as time advances; returns true if playback must freeze. */
  check(T) {
    if (this.onAir) return false;
    const card = this.cards.find((c) => !this.aired.has(c.moment_id) && c.on_air_t <= T);
    if (!card) return false;
    this.aired.add(card.moment_id);
    this.air(card);
    return this.onAir?.paused ?? false;
  }

  air(card) {
    const m = this.momentById.get(card.moment_id);
    const paused = this.prefs.pause || !!this.hl;
    const hold = Math.min(12000, 4200 + 900 * card.drawings.length);
    this.onAir = { card, frame: m?.geometry?.frame, ball: m?.geometry?.ball, start: performance.now(), hold, paused };
    if (this.speak(this.spokenText(card))) this.onAir.spoken = false;
    if (paused) {
      this.r.pitch.showTelestration(card.drawings);
      if (card.type === "goal") this.r.pitch.showVarLine(m?.geometry?.offside);
    }
    this.lastCard = card;
    this.renderCard(card);
    this.renderCrew(card);
    $("ticker").classList.remove("show");
    $("insight").hidden = false;
  }

  end(resume = true) {
    if (!this.onAir) return;
    this.onAir = null;
    this.silence();
    this.r.pitch.clearTelestration();
    this.r.pitch.showVarLine(null);
    $("insight").hidden = true;
    if (!resume) return;
    this.r.lastFrame = performance.now();
    if (this.hl) {
      this.hl.i++;
      if (this.hl.i < this.cards.length) this.queueHighlight();
      else { this.stopHighlights(); this.r.toggle(false); this.showRecap(); }
    }
  }

  /** Per frame: progress bar and the end of the hold. */
  tick(now) {
    const a = this.onAir;
    if (!a) return;
    const k = Math.min(1, (now - a.start) / a.hold);
    $("insBar").style.width = `${(k * 100).toFixed(1)}%`;
    const voiceDone = a.spoken !== false || now - a.start > a.hold + 15000;
    if (k >= 1 && voiceDone) this.end();
  }

  frozenFrame() {
    const a = this.onAir;
    return a && a.paused && a.frame ? { frame: a.frame, ball: a.ball } : null;
  }

  // -------------------------------------------------------------- render
  renderCard(card) {
    const { persona, lang } = this.prefs;
    const ui = UI[lang] || UI.en;
    const v = card.variants?.[persona]?.[lang] || card.variants?.analyst?.en || {};
    const m = this.momentById.get(card.moment_id);
    const involved = [...(card.focus_players || []), ...(m?.players || [])];
    const tag = this.prefs.player && involved.includes(this.prefs.player) ? ui.yourPlayer
      : this.prefs.club && card.team === this.prefs.club ? ui.yourClub
      : (TYPE_LABELS[lang] || TYPE_LABEL)[card.type] || "Insight";
    $("insTag").textContent = `${card.clock}  ${tag}`;
    $("insTag").lang = lang;
    const text = $("insText");
    const rtl = lang === "ar";
    text.classList.toggle("rtl", rtl);
    text.dir = rtl ? "rtl" : "ltr";
    text.lang = lang;
    if (lang === "en") {
      $("insHead").textContent = card.headline || "";
      $("insCaption").textContent = v.caption || "";
      $("insCaption").hidden = false;
    } else {
      $("insHead").textContent = v.caption || card.headline || "";
      $("insCaption").hidden = true;
    }
    const final = card.var?.final;
    const badge = $("insVar");
    badge.classList.toggle("warn", final !== "verified");
    badge.querySelector("span").textContent = final === "verified" ? ui.ok : final === "fallback" ? ui.safe : ui.rules;
    badge.title = final === "verified"
      ? "Every number was checked against the match data and the reasoning by the VAR agent"
      : "VAR could not verify the AI's version, so a version built only from the fact sheet aired";
    $("insWhy").textContent = ui.why;
    $("insShare").textContent = ui.share;
    $("insNext").textContent = ui.resume;
    $("insNext").hidden = !this.onAir?.paused;
  }

  renderCrew(card) {
    const facts = card.facts || {};
    const lookup = (k) => {
      if (k in facts) return [k, facts[k]];
      const hit = Object.keys(facts).find((f) => f.endsWith(`_${k}`) || f.startsWith(`${k}_`));
      return hit ? [hit, facts[hit]] : [k, "?"];
    };
    const pretty = (k) => k.replace(/_/g, " ");
    const claims = (card.claims || []).map((c) => `<li>${esc(c.text)}<div class="chips">${
      (c.fact_keys || []).map((k) => { const [key, val] = lookup(k); return `<span class="chip">${esc(pretty(key))} <b>${esc(val)}</b></span>`; }).join("")
    }</div></li>`).join("");
    const hist = (card.var?.history || []).map((h) => {
      const ok = h.verdict === "stands";
      const who = h.by === "judge" ? "VAR judge" : h.by === "rulebook" ? "VAR rulebook" : h.by;
      const issues = (h.issues || []).slice(0, 2).map((i) => `<div class="why">${esc(i)}</div>`).join("");
      return `<li><span class="mark ${ok ? "ok" : "no"}">${ok ? "✓" : "✕"}</span><div>Attempt ${h.attempt}: ${ok ? "stands" : "overturned"} (${esc(who)})${issues}</div></li>`;
    }).join("");
    const final = card.var?.final;
    const finalLine = final === "verified" ? "Aired the AI's version after VAR checked it."
      : final === "fallback" ? "VAR overturned it twice, so a version built only from the fact sheet aired."
      : "Aired after the rulebook checks (the VAR judge was unavailable).";
    const maxMs = Math.max(1, ...(card.trace || []).map((t) => t.ms || 0));
    const trace = (card.trace || []).map((t) => `<li><span>${esc(t.agent)}</span><span class="bar"><span style="width:${((t.ms || 0) / maxMs * 100).toFixed(0)}%"></span></span><span class="ms">${
      t.source === "recorded" ? "replay" : t.source === "error" ? "error" : `${((t.ms || 0) / 1000).toFixed(1)}s`}</span></li>`).join("");
    const rejected = (card.var?.drawing_issues || []).length;
    const eng = this.insights?.engine || {};
    $("crewBody").innerHTML = `
      <p class="crew-moment">${esc(card.clock)} ${esc(TYPE_LABEL[card.type] || card.type)}</p>
      <p class="crew-head">${esc(card.headline)}</p>
      <p class="crew-story">${esc(card.story)}</p>
      <h3 class="crew-section">Analyst: claims and the facts behind them</h3>
      <ul class="claims">${claims}</ul>
      <h3 class="crew-section">VAR</h3>
      <ul class="verdicts">${hist}<li><span class="mark ok">▸</span><div>${finalLine}</div></li></ul>
      <h3 class="crew-section">Telestrator</h3>
      <p class="crew-story">Drew ${card.drawings.length} shape${card.drawings.length === 1 ? "" : "s"} on the pitch${
        rejected ? `; VAR rejected ${rejected} that weren't anchored to real positions or facts` : ""}.</p>
      <h3 class="crew-section">Agent timings</h3>
      <ul class="trace">${trace}</ul>
      <p class="crew-foot">${esc(eng.model || "")}${eng.provider === "foundry" ? " on Microsoft Foundry" : ""}, orchestrated with Microsoft Agent Framework.
        <a href="${this.r.dataPath}/match_${this.r.seed}_overlay.json" target="_blank" rel="noopener">Broadcast overlay feed (JSON)</a></p>`;
  }

  // --------------------------------------------------------- trust report
  /** How much checking stands behind what aired: the whole pipeline, in numbers. */
  renderTrust() {
    const cards = this.cards;
    const qa = this.r.ask?.session;
    if (!cards.length && !qa?.questions) { $("trustBody").innerHTML = ""; return; }
    const sum = (f) => cards.reduce((n, c) => n + f(c), 0);
    const claims = sum((c) => (c.claims || []).length);
    const facts = sum((c) => (c.claims || []).reduce((n, cl) => n + (cl.fact_keys || []).length, 0));
    const overturns = sum((c) => (c.var?.history || []).filter((h) => h.verdict !== "stands").length);
    const verified = cards.filter((c) => c.var?.final === "verified").length;
    const fallbacks = cards.filter((c) => c.var?.final === "fallback").length;
    const rejected = sum((c) => (c.var?.drawing_issues || []).length);
    const drawn = sum((c) => (c.drawings || []).length);
    const traces = cards.flatMap((c) => c.trace || []);
    const calls = this.insights?.stats?.calls ?? traces.filter((t) => t.source === "model").length;
    const byAgent = {};
    for (const t of traces) if (t.source === "model" && t.ms) (byAgent[t.agent] ||= []).push(t.ms);
    const pct = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
    const lat = Object.entries(byAgent).map(([a, xs]) => [a, pct(xs, 0.5), pct(xs, 0.95)]);
    const maxMs = Math.max(1, ...lat.map((l) => l[2]));
    const tile = (v, label, hot = false) => `<div class="${hot ? "hot" : ""}"><dt>${label}</dt><dd>${v}</dd></div>`;
    const qaTiles = qa?.questions ? tile(qa.questions, "viewer questions answered") +
      tile(qa.overturned, "Q&amp;A answers VAR sent back", qa.overturned > 0) : "";
    $("trustBody").innerHTML = `
      <div class="trust-head"><h3 class="trust-title">Trust report</h3>${cards.length ? `<p class="trust-score">${verified}/${cards.length} insights aired as the AI wrote them, after VAR</p>` : ""}</div>
      <dl class="trust-grid">
        ${tile(claims, "claims checked")}${tile(facts, "facts cited")}${tile(overturns, "times VAR overturned the AI", overturns > 0)}
        ${tile(fallbacks, "rulebook versions aired", fallbacks > 0)}${tile(`${drawn - rejected}/${drawn}`, "drawings kept on the pitch")}${tile(calls, "model calls")}
        ${qaTiles}
      </dl>
      ${lat.length ? `<ul class="trust-lat">${lat.map(([a, p50, p95]) => `<li><span>${esc(a)}</span><span class="ms">median ${(p50 / 1000).toFixed(1)}s · p95 ${(p95 / 1000).toFixed(1)}s</span><span class="bar"><span class="p95" style="width:${(p95 / maxMs * 100).toFixed(0)}%"></span><span class="p50" style="width:${(p50 / maxMs * 100).toFixed(0)}%"></span></span></li>`).join("")}</ul>` : ""}
      <p class="trust-note">Every number on air comes from code. Agents write the words and drawings; VAR rejects anything it cannot find in the match data.</p>`;
  }

  // --------------------------------------------------------------- share
  async share() {
    const card = this.onAir?.card || this.lastCard;
    if (!card) return;
    const btn = $("insShare");
    const was = btn.textContent;
    btn.disabled = true;
    try {
      const blob = await makeShareCard({
        card, moment: this.momentById.get(card.moment_id), prefs: this.prefs, roster: this.r.roster,
        colors: this.r.colors, start: this.r.start, ui: UI[this.prefs.lang] || UI.en,
        typeLabel: (TYPE_LABELS[this.prefs.lang] || TYPE_LABEL)[card.type] || "Insight",
      });
      await shareOrDownload(blob, `chalk-${card.clock.replace(/[^0-9+]/g, "")}-${card.type}.png`);
    } finally {
      btn.disabled = false;
      btn.textContent = was;
    }
  }

  // --------------------------------------------------------------- voice
  spokenText(card) {
    const { persona, lang } = this.prefs;
    const v = card.variants?.[persona]?.[lang] || {};
    return lang === "en" ? `${card.headline}. ${v.caption || ""}` : (v.caption || "");
  }

  speak(text, lang = this.prefs.lang) {
    if (!this.prefs.voice || !text || !("speechSynthesis" in window)) return false;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const tag = { en: "en-GB", fr: "fr-FR", ar: "ar-SA" }[lang] || "en-GB";
      u.lang = tag;
      const voices = speechSynthesis.getVoices();
      const voice = voices.find((v) => v.lang === tag) || voices.find((v) => v.lang?.toLowerCase().startsWith(lang));
      if (voice) u.voice = voice;
      u.rate = lang === "ar" ? 0.95 : 1.05;
      u.onend = u.onerror = () => { if (this.onAir) this.onAir.spoken = true; };
      speechSynthesis.speak(u);
      return true;
    } catch {
      return false;
    }
  }

  silence() {
    try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch { /* nothing to stop */ }
  }

  // ---------------------------------------------------------- highlights
  startHighlights() {
    if (!this.cards.length || this.r.live) return;
    this.hideOverlays();
    this.hl = { i: 0 };
    this.r.setSpeed(4);
    this.updateHlButton();
    this.queueHighlight();
  }

  queueHighlight() {
    const c = this.cards[this.hl.i];
    this.r.seek(Math.max(0, c.on_air_t - 7));
    this.r.toggle(true);
  }

  stopHighlights() {
    if (!this.hl) return;
    this.hl = null;
    this.updateHlButton();
  }

  updateHlButton() {
    const b = $("hlBtn");
    b.setAttribute("aria-pressed", String(!!this.hl));
    b.querySelector("span").textContent = this.hl ? "Exit highlights" : "AI highlights";
  }

  // ------------------------------------------------------- welcome, recap
  showWelcome() {
    if (this.cards.length) $("welcome").hidden = false;
  }

  hideOverlays() {
    $("welcome").hidden = true;
    $("recap").hidden = true;
  }

  showRecap() {
    const rc = this.insights?.recap;
    if (!rc) return;
    const { persona, lang } = this.prefs;
    const ui = UI[lang] || UI.en;
    const f = rc.facts || {};
    const v = rc.variants?.[persona]?.[lang] || rc.variants?.analyst?.en || {};
    const rtl = lang === "ar" ? ' dir="rtl" lang="ar"' : "";
    const start = this.r.start;
    const [hg, ag] = String(f.score || "0-0").split("-");
    const goals = this.r.moments.filter((m) => m.type === "goal").map((m) =>
      `<li><span class="clk">${esc(m.clock)}</span><span class="dot" style="background:${this.r.colors[m.team]}"></span><span>${esc(m.facts.scorer)} <span class="why">(${esc(m.facts.goal_effect)})</span></span></li>`).join("");
    const chips = [["Goals", f.potm_goals], ["Shots", f.potm_shots], ["xG", f.potm_xg], ["Touches", f.potm_touches],
      ["Top speed", f.potm_top_speed_kmh ? `${f.potm_top_speed_kmh} km/h` : null]]
      .filter(([, x]) => x !== undefined && x !== null)
      .map(([k, x]) => `<span class="chip">${k} <b>${esc(x)}</b></span>`).join("");
    const potm = this.r.roster[rc.player_of_the_match] || {};
    const final = rc.var?.final;
    const head = lang === "en" ? rc.headline : (v.caption || rc.headline);
    const body = lang === "en" ? (persona === "analyst" ? rc.story : v.caption) : "";
    const tp = rc.turning_point;
    $("recapCard").innerHTML = `
      <p class="rc-kicker"><span>Full-time recap</span>
        <span class="var-badge${final === "verified" ? "" : " warn"}"><span>${final === "verified" ? ui.ok : ui.safe}</span></span></p>
      <div class="rc-score"><span class="rc-team">${esc(start.home.name)}</span><span class="rc-goals">${esc(hg)} – ${esc(ag)}</span><span class="rc-team">${esc(start.away.name)}</span></div>
      <h2 class="rc-head${lang === "ar" ? " rtl" : ""}"${rtl}>${esc(head)}</h2>
      ${body ? `<p class="rc-text">${esc(body)}</p>` : ""}
      <div class="rc-grid">
        <div class="rc-box"><h3>Goals</h3><ol class="rc-goals-list">${goals}</ol></div>
        <div class="rc-box"><h3>Player of the match</h3>
          <p class="potm-name">${esc(potm.number ?? "")} ${esc(f.potm_name || "")}</p>
          <div class="potm-stats">${chips}</div></div>
        <div class="rc-box rc-shotmap"><h3>Every shot, sized by xG</h3>${this.shotMap()}
          <p class="rc-legend"><span><span class="dot" style="display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:${this.r.colors.home}"></span> ${esc(start.home.name)}</span>
          <span><span class="dot" style="display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:${this.r.colors.away}"></span> ${esc(start.away.name)}</span>
          <span>Filled with a white ring: goal</span></p></div>
      </div>
      <div class="rc-actions">
        ${tp ? `<button type="button" class="btn-primary" data-rc="tp">Replay the turning point ${esc(tp)}</button>` : ""}
        <button type="button" class="btn-ghost" data-rc="why">${ui.why}</button>
        <button type="button" class="btn-ghost" data-rc="hl">AI highlights</button>
        <button type="button" class="btn-ghost" data-rc="close">Close</button>
      </div>`;
    $("recap").hidden = false;
    this.renderCrew(rc);
    if (this.prefs.voice) this.speak(lang === "en" ? `${rc.headline}. ${v.caption || ""}` : v.caption);
    $("recapCard").querySelectorAll("[data-rc]").forEach((b) => b.addEventListener("click", () => {
      const act = b.dataset.rc;
      if (act === "close") this.hideOverlays();
      if (act === "why") this.selectTab("tabCrew");
      if (act === "hl") this.startHighlights();
      if (act === "tp") {
        const card = this.cards.find((c) => c.clock === tp);
        this.hideOverlays();
        this.r.seek(Math.max(0, (card ? card.on_air_t : 0) - 8));
        this.r.toggle(true);
      }
    }));
  }

  shotMap() {
    const shots = this.r.events.filter((e) => e.type === "shot");
    const lines = `<rect x="0" y="0" width="105" height="68" rx="1.5" fill="#174d3c"/>
      <g fill="none" stroke="rgba(255,255,255,.55)" stroke-width=".35">
        <rect x="0" y="0" width="105" height="68"/><line x1="52.5" y1="0" x2="52.5" y2="68"/>
        <circle cx="52.5" cy="34" r="9.15"/>
        <rect x="0" y="13.84" width="16.5" height="40.32"/><rect x="88.5" y="13.84" width="16.5" height="40.32"/>
        <rect x="0" y="24.84" width="5.5" height="18.32"/><rect x="99.5" y="24.84" width="5.5" height="18.32"/></g>`;
    const dots = shots.map((e) => {
      const goal = e.outcome === "goal";
      const r = (1 + Math.sqrt(e.xg) * 5).toFixed(2);
      const c = this.r.colors[e.team];
      return `<circle cx="${e.start[0]}" cy="${e.start[1]}" r="${r}" fill="${c}" fill-opacity="${goal ? 1 : 0.45}"
        stroke="${goal ? "#fff" : c}" stroke-width="${goal ? 0.7 : 0.35}"><title>${esc(e.clock)} xG ${e.xg}${goal ? ", goal" : ""}</title></circle>`;
    }).join("");
    return `<svg viewBox="-1 -1 107 70" role="img" aria-label="Shot map: ${shots.length} shots">${lines}${dots}</svg>`;
  }

  // --------------------------------------------------------- player card
  renderPlayer(stats) {
    const pid = this.prefs.player;
    const card = $("playerCard");
    if (!pid || !this.r.roster[pid]) { card.hidden = true; return; }
    const p = this.r.roster[pid];
    const s = stats.p[pid] || {};
    card.hidden = false;
    $("pcName").textContent = `${p.number} ${p.name}`;
    $("pcMeta").textContent = `${p.position}, ${this.r.start[p.team].short}`;
    const acc = s.passes ? `${Math.round((100 * s.comp) / s.passes)}%` : "–";
    const cells = [
      ["Touches", s.touches || 0], ["Passes", s.passes || 0], ["Accuracy", acc],
      ["Shots", s.shots || 0], ["Goals", s.goals || 0], ["xG", (s.xg || 0).toFixed(2)],
      ["Ball wins", s.won || 0], ["Sprints", s.sprints || 0], ["Top speed", s.top ? `${s.top} km/h` : "–"],
    ];
    $("pcGrid").innerHTML = cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  }
}
