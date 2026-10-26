// The studio: puts the AI crew's insights on air and shapes them for each viewer.
//
// When playback reaches an insight's on-air time, the broadcast freezes on the
// moment, the Telestrator's drawings appear stroke by stroke, and a lower-third
// shows the caption for the viewer's mode (Analyst / Fan) and language
// (EN / FR / AR). "Why?" opens the crew's working: claims, facts, VAR, timings.

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
  en: { yourClub: "Your club", yourPlayer: "Your player", ok: "VAR checked", safe: "Rulebook version", rules: "Rules checked", why: "Why?", resume: "Resume" },
  fr: { yourClub: "Votre club", yourPlayer: "Votre joueur", ok: "Vérifié VAR", safe: "Version sûre", rules: "Règles vérifiées", why: "Pourquoi ?", resume: "Reprendre" },
  ar: { yourClub: "فريقك", yourPlayer: "لاعبك", ok: "تحقق الفار", safe: "نسخة آمنة", rules: "قواعد", why: "لماذا؟", resume: "استئناف" },
};
const STORE_KEY = "chalk.viewer";

function loadPrefs() {
  const base = { persona: "analyst", lang: "en", club: "", player: "", pause: true };
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
    this.next = 0; // index of the next card to air
    this.onAir = null; // {card, frame, ball, start, hold, paused}
    this.lastCard = null;
    this.setupViewer();
    this.setupTabs();
    const eng = insights?.engine;
    $("crewEngine").textContent = eng ? (eng.provider === "offline" ? "Offline crew" : `${eng.model} on Foundry`) : "";
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
    $("insWhy").addEventListener("click", () => { this.selectTab("tabCrew"); });
    $("insNext").addEventListener("click", () => this.end());
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
    this.r.pitch.focus = p.player || null;
    savePrefs(p);
    if (!initial) {
      if (this.onAir) this.renderCard(this.onAir.card);
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
  }

  // ---------------------------------------------------------- scheduling
  /** Called after a seek: cards before T have already aired. */
  resync(T) {
    this.end(false);
    this.next = this.cards.findIndex((c) => c.on_air_t > T);
    if (this.next < 0) this.next = this.cards.length;
  }

  /** Called as time advances; returns true if playback must freeze. */
  check(T) {
    if (this.onAir || this.next >= this.cards.length) return false;
    const card = this.cards[this.next];
    if (card.on_air_t > T) return false;
    this.next++;
    this.air(card);
    return this.onAir?.paused ?? false;
  }

  air(card) {
    const m = this.momentById.get(card.moment_id);
    const paused = this.prefs.pause;
    const hold = Math.min(12000, 4200 + 900 * card.drawings.length);
    this.onAir = { card, frame: m?.geometry?.frame, ball: m?.geometry?.ball, start: performance.now(), hold, paused };
    if (paused) this.r.pitch.showTelestration(card.drawings);
    this.lastCard = card;
    this.renderCard(card);
    this.renderCrew(card);
    $("ticker").classList.remove("show");
    $("insight").hidden = false;
  }

  end(resume = true) {
    if (!this.onAir) return;
    this.onAir = null;
    this.r.pitch.clearTelestration();
    $("insight").hidden = true;
    if (resume) this.r.lastFrame = performance.now();
  }

  /** Per frame: progress bar and the end of the hold. */
  tick(now) {
    const a = this.onAir;
    if (!a) return;
    const k = Math.min(1, (now - a.start) / a.hold);
    $("insBar").style.width = `${(k * 100).toFixed(1)}%`;
    if (k >= 1) this.end();
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
