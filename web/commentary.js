// Match commentary: short play-by-play lines in the style of a TV commentator, written
// natively in English, French and Arabic (not translated from each other), with several
// variations per moment so it never repeats itself. Spoken with the most natural voice
// the browser has (Edge's "Online (Natural)" voices sound the most human), with more
// energy on goals. The AI's studio analysis uses a second voice: the pundit.

const BANK = {
  en: {
    kickoff1: ["And we're underway here at {venue}!", "The referee blows, and we're off!", "Here we go! {home} get us started."],
    kickoff2: ["We're back underway for the second half!", "Second half, and off we go again!"],
    goal: ["Goal! {player}! What a finish!", "It's in! {player} finds the net!", "Goal! {player} does it! Get in!", "And it's there! {player}!"],
    opener: ["{team} lead!", "{team} have the breakthrough!"],
    extends: ["{team} extend their lead!", "That's {score} now, {team} in control!"],
    pullsback: ["{team} pull one back! Game on!", "That's a lifeline for {team}!"],
    equaliser: ["And we're level! {score}!", "{team} are back in it! All square!"],
    ahead: ["{team} are in front!", "{team} turn it around! {score}!"],
    late: ["In stoppage time! Unbelievable scenes!", "So late in the game! What drama!"],
    save: ["What a save!", "Brilliant stop from the keeper!", "Denied! Superb hands!", "Kept out! Great reactions!"],
    miss: ["Oh, so close!", "Just wide! He'll feel he should have scored.", "Off target! A big chance goes begging.", "Over the bar! That was the moment."],
    blocked: ["Blocked! Bodies on the line!", "Charged down!"],
    red: ["Red card! {player} is off!", "He's been sent off! {team} are down to ten!"],
    yellow: ["Yellow card for {player}.", "{player} goes into the book."],
    sub: ["A change for {team}: {on} comes on for {off}.", "{team} make a switch. {off} makes way for {on}."],
    shape: ["{team} change shape, they're going {formation}.", "Tactical tweak from {team}, now a {formation}."],
    half: ["That's half-time. {home} {hs}, {away} {as}.", "The referee blows for the break. {score}."],
    full: ["And there's the final whistle! {home} {hs}, {away} {as}!", "It's all over! {winner} take it, {score}!"],
    fullDraw: ["And there's the final whistle! It finishes {score}.", "All over, and honours even, {score}."],
    varCheck: ["VAR is having a look at this one…", "Just a check from VAR…"],
    varOk: ["And the goal stands!", "It stands! Onside!"],
    ratings: ["Let's run through the player ratings."],
    potm: ["Player of the match: {player}, rated {rating}."],
    lineups: ["Here are the teams."],
  },
  fr: {
    kickoff1: ["Et c'est parti ici à {venue} !", "L'arbitre siffle, c'est parti !", "Coup d'envoi ! {home} engage."],
    kickoff2: ["C'est reparti pour la seconde période !", "La deuxième mi-temps est lancée !"],
    goal: ["BUT ! {player} ! Quelle finition !", "C'est au fond ! {player} trouve le chemin des filets !", "BUT ! {player} ! Il est là !", "Et ça rentre ! {player} !"],
    opener: ["{team} ouvre le score !", "{team} fait sauter le verrou !"],
    extends: ["{team} creuse l'écart !", "{score}, {team} maîtrise son sujet !"],
    pullsback: ["{team} réduit l'écart ! Le match est relancé !", "{team} revient dans la partie !"],
    equaliser: ["Égalisation ! {score} !", "{team} recolle au score ! Tout est à refaire !"],
    ahead: ["{team} passe devant !", "{team} renverse la situation ! {score} !"],
    late: ["Dans le temps additionnel ! Incroyable !", "Si tard dans le match ! Quel scénario !"],
    save: ["Quel arrêt !", "Superbe parade du gardien !", "Le gardien s'interpose ! Magnifique !", "Repoussé ! Quels réflexes !"],
    miss: ["Oh, c'était tout près !", "Juste à côté ! Il pouvait mieux faire.", "Non cadré ! Une grosse occasion qui s'envole.", "Au-dessus ! C'était le moment."],
    blocked: ["Contré ! Les défenseurs se jettent !", "Le tir est contré !"],
    red: ["Carton rouge ! {player} doit sortir !", "Expulsion ! {team} réduit à dix !"],
    yellow: ["Carton jaune pour {player}.", "{player} est averti."],
    sub: ["Changement pour {team} : {on} remplace {off}.", "{team} effectue un changement. {off} laisse sa place à {on}."],
    shape: ["{team} change de système, on passe en {formation}.", "Ajustement tactique de {team}, désormais en {formation}."],
    half: ["C'est la mi-temps. {home} {hs}, {away} {as}.", "L'arbitre renvoie tout le monde aux vestiaires. {score}."],
    full: ["Et c'est le coup de sifflet final ! {home} {hs}, {away} {as} !", "C'est terminé ! {winner} l'emporte, {score} !"],
    fullDraw: ["C'est le coup de sifflet final ! Score final, {score}.", "C'est terminé, match nul, {score}."],
    varCheck: ["La VAR vérifie l'action…", "Petite vérification de la VAR…"],
    varOk: ["Et le but est validé !", "But accordé ! Pas de hors-jeu !"],
    ratings: ["Place aux notes des joueurs."],
    potm: ["L'homme du match : {player}, noté {rating}."],
    lineups: ["Voici les compositions."],
  },
  ar: {
    kickoff1: ["وانطلقت المباراة هنا في {venue}!", "صافرة البداية، وانطلقنا!", "ضربة البداية! {home} يبدأ اللعب."],
    kickoff2: ["انطلق الشوط الثاني!", "عدنا من جديد مع الشوط الثاني!"],
    goal: ["هدف! هدف! {player}! يا لها من لمسة!", "في الشباك! {player} يسجل!", "هدددف! {player}! ما أروعه!", "الكرة في المرمى! {player}!"],
    opener: ["{team} يفتتح التسجيل!", "{team} يكسر التعادل!"],
    extends: ["{team} يعزز تقدمه!", "{score} الآن، و{team} يسيطر!"],
    pullsback: ["{team} يقلص الفارق! المباراة تشتعل!", "{team} يعود إلى الأجواء!"],
    equaliser: ["التعادل! {score}!", "{team} يدرك التعادل! عادت المباراة من جديد!"],
    ahead: ["{team} يتقدم!", "{team} يقلب النتيجة! {score}!"],
    late: ["في الوقت بدل الضائع! لا يُصدق!", "في اللحظات الأخيرة! يا لها من دراما!"],
    save: ["يا له من تصدٍّ!", "الحارس يتألق!", "أنقذها الحارس ببراعة!", "تصدٍّ رائع! ردة فعل مذهلة!"],
    miss: ["يا سلام! كانت قريبة جدًا!", "بجوار القائم! فرصة لا تُهدر!", "خارج المرمى! ضاعت فرصة كبيرة.", "فوق العارضة! كانت هذه هي الفرصة."],
    blocked: ["مصدودة! الدفاع يرمي بنفسه!", "الدفاع يصد التسديدة!"],
    red: ["بطاقة حمراء! {player} خارج الملعب!", "طرد! {team} يكمل بعشرة لاعبين!"],
    yellow: ["بطاقة صفراء لـ{player}.", "إنذار لـ{player}."],
    sub: ["تبديل في {team}: {on} يدخل بدلًا من {off}.", "{team} يجري تبديلًا، يخرج {off} ويدخل {on}."],
    shape: ["{team} يغير خطته إلى {formation}.", "تعديل تكتيكي من {team}، الآن بخطة {formation}."],
    half: ["نهاية الشوط الأول. {home} {hs}، {away} {as}.", "الحكم يعلن نهاية الشوط الأول. {score}."],
    full: ["وصافرة النهاية! {home} {hs}، {away} {as}!", "انتهت المباراة! {winner} يفوز، {score}!"],
    fullDraw: ["صافرة النهاية! تنتهي المباراة {score}.", "انتهت المباراة بالتعادل، {score}."],
    varCheck: ["تقنية الفيديو تراجع اللقطة…", "مراجعة سريعة من الفار…"],
    varOk: ["والهدف صحيح!", "الهدف محتسب! لا تسلل!"],
    ratings: ["لنلقِ نظرة على تقييمات اللاعبين."],
    potm: ["رجل المباراة: {player}، بتقييم {rating}."],
    lineups: ["إليكم التشكيلات."],
  },
};

const NUM = {
  en: ["nil", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
  fr: ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf"],
  ar: ["صفر", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"],
};

/** A score the way a commentator says it: "three-two", "trois à deux", "ثلاثة مقابل اثنين". */
export function sayScore(h, a, lang) {
  const n = NUM[lang] || NUM.en;
  const w = (x) => n[x] ?? String(x);
  if (lang === "fr") return `${w(h)} à ${w(a)}`;
  if (lang === "ar") return `${w(h)} مقابل ${w(a)}`;
  return `${w(h)}-${w(a)}`;
}

/** A formation spoken: "four-four-two". */
export function sayFormation(f, lang) {
  const n = NUM[lang] || NUM.en;
  return String(f).split("-").map((d) => (lang === "en" && d === "0" ? "zero" : n[Number(d)] ?? d)).join(lang === "ar" ? " " : "-");
}

const TAG = { en: ["en-GB", "en-US", "en"], fr: ["fr-FR", "fr-CA", "fr"], ar: ["ar-SA", "ar-EG", "ar"] };

// Child voices exist in some browsers (Edge's "Ana", "Maisie", "Eloise"): never use them.
const CHILD = /\b(ana|maisie|eloise|junior|kid|kids|child)\b/i;
// Adult male voices commentators usually sound like, across Edge, Windows, Chrome and Apple.
const MALE = /\b(ryan|thomas|guy|christopher|eric|roger|steffan|andrew|brian|davis|tony|jason|william|oliver|alfie|elliot|ethan|noah|george|david|mark|daniel|arthur|henri|remy|alain|claude|jerome|yves|paul|hamed|shakir|taim|naayf|maged|majed|male)\b/i;
const FEMALE = /\b(sonia|libby|aria|jenny|michelle|emma|ava|denise|vivienne|brigitte|hortense|julie|zariyah|salma|laila|hazel|zira|female)\b/i;

/** Adult, human-sounding voices for a language, best first: neural "Natural"/"Online" voices lead. */
export function rankVoices(lang, role = "commentator") {
  if (!("speechSynthesis" in window)) return [];
  const tags = TAG[lang] || TAG.en;
  const score = (v) => {
    if (CHILD.test(v.name)) return -1;
    const i = tags.findIndex((tg) => v.lang?.toLowerCase().startsWith(tg.toLowerCase()));
    if (i < 0) return -1;
    let s = 10 - i;
    if (/natural|online|neural/i.test(v.name)) s += 40;
    if (/premium|enhanced|wavenet|siri/i.test(v.name)) s += 25;
    if (/google/i.test(v.name)) s += 12;
    if (/compact|espeak/i.test(v.name)) s -= 20;
    if (role === "commentator" && MALE.test(v.name)) s += 15; // a classic commentary-box voice
    if (role === "pundit" && FEMALE.test(v.name)) s += 8; // a contrasting studio voice
    return s;
  };
  return speechSynthesis.getVoices().map((v) => [score(v), v]).filter(([s]) => s >= 0)
    .sort((a, b) => b[0] - a[0]).map(([, v]) => v);
}

export class Commentator {
  constructor(prefs) {
    this.prefs = prefs; // live reference to the viewer's preferences
    this.last = {};
    if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => { this.voices = null; };
  }

  get on() { return this.prefs.voice && "speechSynthesis" in window; }

  voice(role, lang) {
    const commentator = rankVoices(lang, "commentator")[0];
    if (role !== "pundit") return commentator;
    // the studio pundit: a different adult voice, so it sounds like two people
    return rankVoices(lang, "pundit").find((v) => v !== commentator) || commentator;
  }

  line(key, vars = {}, lang = this.prefs.lang) {
    const bank = (BANK[lang] || BANK.en)[key] || BANK.en[key] || [];
    if (!bank.length) return "";
    // never the same line twice in a row
    let i = Math.floor(Math.random() * bank.length);
    if (bank.length > 1 && i === this.last[key]) i = (i + 1) % bank.length;
    this.last[key] = i;
    return bank[i].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  }

  /**
   * Speak text. Resolves when the voice has finished (or after a safe timeout), so a
   * sequence such as the line-ups can wait for each name. priority: 0 chatter, 1 normal,
   * 2 important (interrupts lower ones), 3 goals and the final whistle.
   */
  speak(text, { role = "commentator", priority = 1, excited = false, queue = false, lang = this.prefs.lang } = {}) {
    if (!this.on || !text) return Promise.resolve(false);
    const busy = speechSynthesis.speaking;
    if (busy && !queue && priority < (this.speakingPriority ?? 0)) return Promise.resolve(false);
    if (busy && !queue && priority <= 1 && this.speakingPriority >= 1) return Promise.resolve(false);
    if (!queue) speechSynthesis.cancel();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = (TAG[lang] || TAG.en)[0];
      const v = this.voice(role, lang);
      if (v) u.voice = v;
      u.rate = excited ? 1.1 : role === "pundit" ? 0.98 : 1.02;
      u.pitch = excited ? 1.05 : role === "pundit" ? 0.95 : 0.97; // energy from pace, not a raised pitch
      u.volume = 1;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.speakingPriority = 0;
        setTimeout(() => { if (!speechSynthesis.speaking) document.body.classList.remove("speaking"); }, 120);
        resolve(true);
      };
      u.onstart = () => { document.body.classList.add("speaking"); this.speakingPriority = priority; };
      u.onend = finish;
      u.onerror = finish;
      const timer = setTimeout(finish, 2500 + text.length * 95); // never wait forever on a stuck voice
      speechSynthesis.speak(u);
    });
  }

  /** Say a line from the bank. */
  call(key, vars, opts = {}) {
    return this.speak(this.line(key, vars, opts.lang), opts);
  }

  stop() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    document.body.classList.remove("speaking");
    this.speakingPriority = 0;
  }
}
