// Ask the studio: the viewer asks a question (typed or spoken) in English, French or
// Arabic. The Studio agent answers through the CHALK MCP server, pinned to the minute
// the viewer is watching (no spoilers), and VAR checks every number before it is shown.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const L = {
  en: {
    title: "Ask the studio", placeholder: "Ask about this match…", send: "Ask", listening: "Listening…",
    intro: "Ask anything about the match so far. The studio answers from the match data through its MCP tools, and VAR checks every number. It only sees up to the minute you are watching.",
    thinking: "The studio is checking the data…", ok: "VAR checked", safe: "Rulebook answer", at: "at",
    offline: "Ask needs the CHALK server. Run it with uvicorn chalk.server:app and open it from there.",
    error: "The studio couldn't answer that just now. Try again.", overturned: "VAR overturned the first answer",
    chips: ["What's the score?", "How is {player} doing?", "Who has more of the ball?", "Who's on top?", "Who is the fastest?", "Any red cards?"],
  },
  fr: {
    title: "Demandez au studio", placeholder: "Une question sur ce match…", send: "Envoyer", listening: "J'écoute…",
    intro: "Posez une question sur le match jusqu'ici. Le studio répond à partir des données du match via ses outils MCP, et la VAR vérifie chaque chiffre. Il ne voit que jusqu'à la minute que vous regardez.",
    thinking: "Le studio vérifie les données…", ok: "Vérifié VAR", safe: "Réponse du règlement", at: "à la",
    offline: "Cette fonction demande le serveur CHALK (uvicorn chalk.server:app).",
    error: "Le studio n'a pas pu répondre. Réessayez.", overturned: "La VAR a annulé la première réponse",
    chips: ["Quel est le score ?", "Comment joue {player} ?", "Qui a la possession ?", "Qui domine ?", "Qui est le plus rapide ?", "Des cartons rouges ?"],
  },
  ar: {
    title: "اسأل الاستوديو", placeholder: "اسأل عن هذه المباراة…", send: "اسأل", listening: "أستمع…",
    intro: "اسأل أي شيء عن المباراة حتى الآن. يجيب الاستوديو من بيانات المباراة عبر أدوات MCP، ويتحقق الفار من كل رقم. لا يرى إلا حتى الدقيقة التي تشاهدها.",
    thinking: "الاستوديو يراجع البيانات…", ok: "تحقق الفار", safe: "إجابة القواعد", at: "في",
    offline: "هذه الميزة تحتاج خادم CHALK.",
    error: "تعذّر على الاستوديو الإجابة الآن. حاول مجددًا.", overturned: "ألغى الفار الإجابة الأولى",
    chips: ["ما النتيجة؟", "كيف يلعب {player}؟", "من يستحوذ على الكرة؟", "من يسيطر؟", "من الأسرع؟", "هل هناك بطاقات حمراء؟"],
  },
};
const STAT_NAMES = {
  top_speed_kmh: "top speed", pass_accuracy_pct: "pass accuracy", xg: "xG", key_passes: "key passes",
  progressive_passes: "progressive passes", red_card: "red cards", goal: "goals",
};
const pretty = (v) => STAT_NAMES[v] || String(v).replace(/_/g, " ");
const TOOL_NAMES = {
  match_status: "match status", team_stats: "team stats", player_stats: "player stats", top_players: "leaderboard",
  key_moments: "key moments", moment_details: "moment details", match_flow: "match flow",
};

export class AskDesk {
  constructor(replay) {
    this.r = replay;
    this.busy = false;
    this.available = false;
    this.session = null;
    this.thread = $("askThread");
    $("askForm").addEventListener("submit", (e) => { e.preventDefault(); this.ask($("askInput").value); });
    this.setupMic();
    this.render();
  }

  get lang() { return this.r.studio.prefs.lang; }
  get t() { return L[this.lang] || L.en; }

  setAvailable(on) {
    this.available = on;
    this.render();
  }

  /** Re-label the pane for the viewer's language. */
  render() {
    const t = this.t, rtl = this.lang === "ar";
    $("askTitle").textContent = t.title;
    $("tabAskLabel").textContent = { en: "Ask", fr: "Question", ar: "اسأل" }[this.lang] || "Ask";
    $("askInput").placeholder = t.placeholder;
    $("askInput").dir = rtl ? "rtl" : "ltr";
    $("askSend").textContent = t.send;
    $("askIntro").textContent = this.available ? t.intro : t.offline;
    $("askIntro").dir = rtl ? "rtl" : "ltr";
    $("askForm").hidden = !this.available;
    const pid = this.r.studio.prefs.player;
    const player = (pid && this.r.roster[pid]?.name) || this.topScorerName()
      || (this.r.start.home.players.find((x) => x.number === 9) || this.r.start.home.players.at(-1)).name;
    const chips = $("askChips");
    chips.hidden = !this.available;
    chips.dir = rtl ? "rtl" : "ltr";
    chips.innerHTML = t.chips.map((c) => `<button type="button" class="ask-chip">${esc(c.replace("{player}", player.split(" ").at(-1)))}</button>`).join("");
    chips.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => this.ask(b.textContent)));
  }

  topScorerName() {
    let best = null, goals = 0;
    for (const [pid, p] of Object.entries(this.r.stats.p)) if (p.goals > goals) { best = pid; goals = p.goals; }
    return best ? this.r.roster[best]?.name : null;
  }

  // ----------------------------------------------------------------- mic
  setupMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $("askMic");
    if (!SR) { btn.hidden = true; return; }
    btn.addEventListener("click", () => {
      if (this.rec) { this.rec.stop(); return; }
      const rec = new SR();
      rec.lang = { en: "en-GB", fr: "fr-FR", ar: "ar-SA" }[this.lang] || "en-GB";
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      this.rec = rec;
      btn.classList.add("on");
      btn.setAttribute("aria-pressed", "true");
      $("askInput").placeholder = this.t.listening;
      let finalText = "";
      rec.onresult = (e) => {
        const res = [...e.results].map((r) => r[0].transcript).join(" ");
        $("askInput").value = res;
        if (e.results[e.results.length - 1].isFinal) finalText = res;
      };
      rec.onend = () => {
        this.rec = null;
        btn.classList.remove("on");
        btn.setAttribute("aria-pressed", "false");
        $("askInput").placeholder = this.t.placeholder;
        if (finalText.trim()) this.ask(finalText);
      };
      rec.onerror = () => rec.stop();
      try { rec.start(); } catch { rec.onend(); }
    });
  }

  // ----------------------------------------------------------------- ask
  async ask(question) {
    question = String(question || "").trim();
    if (!question || this.busy || !this.available) return;
    this.busy = true;
    $("askInput").value = "";
    $("askSend").disabled = true;
    const { lang, persona } = this.r.studio.prefs;
    const rtl = lang === "ar";
    this.thread.insertAdjacentHTML("beforeend",
      `<li class="ask-q" dir="${rtl ? "rtl" : "ltr"}"><p>${esc(question)}</p><span class="ask-at">${esc(this.r.events[this.r.idx]?.clock || "0'")}</span></li>`);
    const pending = document.createElement("li");
    pending.className = "ask-a pending";
    pending.innerHTML = `<p class="ask-thinking"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>${esc(this.t.thinking)}</p>`;
    this.thread.appendChild(pending);
    this.scroll();
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, t: this.r.T, seed: Number(this.r.seed), lang, persona }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const out = await r.json();
      this.session = out.session;
      this.fill(pending, out);
      this.r.studio.renderTrust();
      if (out.focus) this.point(out.focus);
      this.r.studio.speak(out.answer, out.lang);
    } catch (err) {
      console.error(err);
      pending.className = "ask-a error";
      pending.innerHTML = `<p>${esc(this.t.error)}</p>`;
    } finally {
      this.busy = false;
      $("askSend").disabled = false;
      this.scroll();
    }
  }

  fill(li, out) {
    const t = L[out.lang] || L.en, rtl = out.lang === "ar";
    const ok = out.var?.final === "verified";
    const retried = ok && (out.var?.attempts || 1) > 1;
    const tools = (out.tools || []).map((c) => {
      const a = c.args || {};
      const arg = ["player", "team", "stat", "kind", "moment"].map((k) => a[k]).filter((v) => v !== undefined && v !== null && v !== "").map(pretty).join(", ");
      return `<span class="tool-chip"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v3a3.5 3.5 0 0 1-7 0zM8 12v2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>${esc(TOOL_NAMES[c.tool] || c.tool)}${arg ? ` <b>${esc(arg)}</b>` : ""}</span>`;
    }).join("");
    const src = out.source === "model" ? out.engine : out.source === "recorded" ? `${out.engine}, replay` : "rules";
    li.className = "ask-a fresh";
    li.innerHTML = `
      <p class="ask-text" dir="${rtl ? "rtl" : "ltr"}" lang="${esc(out.lang)}">${esc(out.answer)}</p>
      <div class="ask-meta">
        <span class="var-badge ${ok ? "" : "safe"}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${esc(ok ? t.ok : t.safe)}</span></span>
        ${tools}
      </div>
      <p class="ask-foot">${retried ? `${esc(t.overturned)} · ` : ""}${esc(t.at)} ${esc(out.clock)} · ${esc(src)}${out.ms ? ` · ${(out.ms / 1000).toFixed(1)}s` : ""} · MCP</p>`;
  }

  /** The studio points at the player it is talking about. */
  point(pid) {
    const pitch = this.r.pitch;
    clearTimeout(this.pointTimer);
    pitch.focus = pid;
    this.pointTimer = setTimeout(() => { pitch.focus = this.r.studio.prefs.player || null; }, 7000);
  }

  scroll() {
    const pane = $("paneAsk");
    pane.scrollTop = pane.scrollHeight;
    this.thread.lastElementChild?.scrollIntoView({ block: "nearest" });
  }
}
