"""Ask the studio: a viewer's question, answered from the match data and fact-checked.

    viewer question --> Studio agent (Microsoft Agent Framework)
                           |  calls tools on the CHALK MCP server (chalk/mcp_server.py),
                           |  pinned to the minute the viewer is watching (no spoilers)
                           v
                        VAR rulebook: every number must come from a tool result
                           |  overturned? one retry with the VAR notes
                           v
                        answer on air (or a rule-based answer from the same tools)

Offline (no model configured) the same tools are queried by a small intent router, so the
feature works in every demo and every test without a key.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import sys
import time
import unicodedata
from typing import Any

from agent_framework import Agent, MCPStdioTool
from mcp import Client

from ..matchdata import MatchView
from ..mcp_server import build_server
from . import prompts
from .config import ROOT, Settings, load_settings
from .crew import CONSTANT_NUMBERS, CallCache, make_online_client
from .rulebook import PLAYER_ID_RE, allowed_numbers, check_language, check_numbers

log = logging.getLogger("chalk.qa")

MAX_QUESTION_CHARS = 240
MAX_ANSWER_WORDS = 80
MAX_ATTEMPTS = 2
TIMEOUT_S = 40.0
LANGS = ("en", "fr", "ar")
PERSONAS = ("analyst", "casual")


# ------------------------------------------------------------------ helpers
def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", (s or "").lower()) if not unicodedata.combining(c))


def _jsonish(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return v
    if isinstance(v, list):  # MCP results can come back as a list of content items
        return [_jsonish(getattr(x, "text", None) or x) for x in v]
    return getattr(v, "text", None) and _jsonish(v.text) or v


def extract_tool_trace(messages: list[Any]) -> tuple[list[dict[str, Any]], list[Any]]:
    """The tool calls an agent made and the results it received, from its response messages."""
    calls, results = [], []
    for m in messages:
        for c in getattr(m, "contents", []) or []:
            if c.type == "function_call":
                args = c.arguments
                if isinstance(args, str):
                    try:
                        args = json.loads(args or "{}")
                    except ValueError:
                        args = {"raw": args}
                calls.append({"tool": c.name, "args": args or {}})
            elif c.type == "function_result":
                results.append(_jsonish(c.result))
    return calls, results


def check_answer(text: str, results: list[Any], question: str, clock: str, lang: str,
                 tools_used: int) -> list[str]:
    """The VAR rulebook for answers: every number must come from a tool result."""
    issues: list[str] = []
    if not (text or "").strip():
        return ["empty answer"]
    allowed = allowed_numbers({}, extra=[*results, question, clock, *CONSTANT_NUMBERS])
    nums = check_numbers(text, allowed)
    issues += [i.replace("on the fact sheet", "in any tool result") for i in nums]
    for i in check_language(text):
        if lang == "en" or "internal data" in i:
            issues.append(i)
    if PLAYER_ID_RE.search(text):
        issues.append("a player id is in the text; use the player's name")
    if len(text.split()) > MAX_ANSWER_WORDS:
        issues.append(f"too long ({len(text.split())} words); keep it under 60")
    if not tools_used and re.search(r"\d", text):
        issues.append("answered with numbers without calling a tool")
    return issues


# ------------------------------------------------------------ the Studio
class StudioQA:
    def __init__(self, settings: Settings | None = None, client: Any = None, cache_path: Any = None):
        self.settings = settings or load_settings()
        self.client = client if client is not None else (
            make_online_client(self.settings) if self.settings.online else None)
        self.cache = CallCache(cache_path or ROOT / "data" / "cache" / "qa_calls.json")
        self.stats = {"questions": 0, "verified": 0, "overturned": 0, "fallbacks": 0, "recorded": 0}
        self.transport = os.environ.get("CHALK_QA_MCP", "memory")

    @property
    def engine(self) -> str:
        return self.settings.model if self.client is not None else "rules"

    async def ask(self, question: str, t: float | None = None, seed: int = 4,
                  lang: str = "en", persona: str = "analyst") -> dict[str, Any]:
        q = " ".join(str(question or "").split())[:MAX_QUESTION_CHARS]
        lang = lang if lang in LANGS else "en"
        persona = persona if persona in PERSONAS else "analyst"
        view = MatchView(seed, t)
        clock = view.state.clock if view.state.last_event else "0'"
        self.stats["questions"] += 1
        base = {"question": q, "lang": lang, "persona": persona, "clock": clock, "seed": seed}
        if not q:
            return {**base, **offline_answer(view, "", lang, persona), "var": {"final": "verified", "issues": [], "attempts": 0}}

        if self.client is None:
            out = offline_answer(view, q, lang, persona)
            self.stats["verified"] += 1
            return {**base, **out, "var": {"final": "verified", "issues": [], "attempts": 1, "by": "rulebook"}}

        key = CallCache.key(self.settings.model, prompts.QA, str(seed), str(int(view.cutoff // 60)),
                            _fold(q), lang, persona, f"{view.end_t:.1f}")  # a new match version never reuses old answers
        hit = self.cache.get(key)
        if hit is not None:
            self.stats["recorded"] += 1
            return {**base, **hit, "source": "recorded", "ms": 0}

        t0 = time.perf_counter()
        try:
            out = await asyncio.wait_for(self._online(view, q, lang, persona, clock), TIMEOUT_S)
        except Exception as err:  # network, rate limit, MCP start-up, timeout
            log.warning("studio Q&A model path failed: %s", err)
            out = {"error": str(err)[:200]}
        out["ms"] = round((time.perf_counter() - t0) * 1000)
        if out.get("var", {}).get("final") != "verified":
            self.stats["fallbacks"] += 1
            rule = offline_answer(view, q, lang, persona)
            var = out.get("var") or {"issues": [f"model unavailable: {out.get('error', '?')}"], "attempts": 0}
            var["final"] = "fallback"
            return {**base, **rule, "var": var, "ms": out["ms"], "model_tools": out.get("tools", [])}
        self.stats["verified"] += 1
        self.cache.put(key, {k: v for k, v in out.items() if k != "ms"})
        self.cache.save()
        return {**base, **out}

    def _mcp_tool(self, view: MatchView) -> MCPStdioTool:
        """The CHALK MCP server, pinned to the viewer's minute.

        Default: the server runs in-process and the agent talks MCP to it over memory streams
        (fast, works everywhere). CHALK_QA_MCP=stdio launches it as a subprocess instead,
        exactly as an external MCP client would."""
        if self.transport == "stdio":
            args = ["-m", "chalk.mcp_server", "--seed", str(view.seed), "--cutoff", str(round(view.cutoff, 1))]
            return MCPStdioTool(name="chalk_match", command=sys.executable, args=args, load_prompts=False,
                                env={**os.environ, "PYTHONPATH": str(ROOT)}, description="CHALK match data")
        return _InProcessMCP(view.seed, view.cutoff)

    async def _online(self, view: MatchView, q: str, lang: str, persona: str, clock: str) -> dict[str, Any]:
        all_issues: list[str] = []
        async with contextlib.AsyncExitStack() as stack:
            mcp = await stack.enter_async_context(self._mcp_tool(view))
            agent = Agent(self.client, prompts.QA, name="Studio",
                          description="Answers viewers' questions from the match data tools.", tools=[mcp])
            notes = ""
            for attempt in range(1, MAX_ATTEMPTS + 1):
                prompt = (f"LANGUAGE: {lang}\nPERSONA: {persona}\nMATCH CLOCK: {clock}\n"
                          f"VIEWER QUESTION: {q}{notes}")
                resp = await agent.run(prompt, options={"temperature": 0.2})
                calls, results = extract_tool_trace(resp.messages)
                text = (resp.text or "").strip()
                issues = check_answer(text, results, q, clock, lang, len(calls))
                if not issues:
                    return {"answer": text, "tools": calls, "source": "model",
                            "focus": _focus(view, calls),
                            "var": {"final": "verified", "issues": all_issues, "attempts": attempt,
                                    "by": "rulebook"}}
                self.stats["overturned"] += 1
                all_issues += issues
                notes = ("\n\nVAR OVERTURNED your previous answer:\n- " + "\n- ".join(issues) +
                         f"\nPrevious answer: {text}\nCall the tools again and answer using only their numbers.")
        return {"tools": calls, "var": {"issues": all_issues, "attempts": MAX_ATTEMPTS}}


class _InProcessMCP:
    """An MCP connection to an in-process CHALK server, wrapped as an Agent Framework tool."""

    def __init__(self, seed: int, cutoff: float):
        self.server = build_server(seed, cutoff)
        self.stack = contextlib.AsyncExitStack()

    async def __aenter__(self) -> MCPStdioTool:
        client = await self.stack.enter_async_context(Client(self.server))
        return await self.stack.enter_async_context(
            MCPStdioTool(name="chalk_match", mcp_client=client, load_prompts=False, description="CHALK match data"))

    async def __aexit__(self, *exc: Any) -> None:
        await self.stack.aclose()


def _focus(view: MatchView, calls: list[dict[str, Any]]) -> str | None:
    """The player to ring on the pitch, if the answer is about one."""
    for c in calls:
        if c["tool"] == "player_stats" and c["args"].get("player"):
            return view.find_player(str(c["args"]["player"]))
    return None


# ------------------------------------------------- offline: intent router
INTENTS: list[tuple[str, tuple[str, ...]]] = [
    ("red_card", ("red card", "sent off", "carton rouge", "expuls", "بطاقة حمراء", "طرد")),
    ("goals", ("goals", "who scored", "scorer", "buts", "buteur", "marque", "أهداف", "هدف", "سجل")),
    ("fastest", ("fastest", "quickest", "speed", "plus rapide", "vitesse", "أسرع", "سرعة")),
    ("best", ("best", "star", "man of the match", "standout", "meilleur", "homme du match", "أفضل", "نجم")),
    ("possession", ("possession", "ball", "ballon", "استحواذ", "الكرة")),
    ("shots", ("shots", "xg", "chances", "tirs", "occasions", "تسديد", "فرص")),
    ("flow", ("on top", "momentum", "dominat", "control", "domine", "dynamique", "يسيطر", "سيطرة", "أفضلية")),
    ("passing", ("pass", "passe", "تمرير", "تمريرات")),
    ("defending", ("press", "tackle", "defen", "pressing", "tacle", "défen", "ضغط", "دفاع")),
    ("score", ("score", "winning", "leading", "result", "qui gagne", "النتيجة", "يفوز")),
]
OFF_TOPIC = ("league table", "transfer", "injur", "season", "classement", "transfert", "bless", "saison",
             "الترتيب", "انتقال", "إصابة", "الموسم")

T = {
    "en": {
        "score": "It's {score} at {clock}.",
        "score_more": " {top} {top_verb} over the last five minutes.",
        "on_top": "have had the upper hand", "nobody": "Neither side has had the upper hand",
        "possession": "{a} have {ap}% of the ball, {b} {bp}%.",
        "shots": "{a}: {as_} shots, xG {ax}. {b}: {bs} shots, xG {bx}.",
        "passing": "{a} complete {aa}% of their passes, {b} {ba}%.",
        "defending": "{a} have made {ap} pressures, {b} {bp}.",
        "goals": "Goals so far: {list}.", "no_goals": "No goals yet at {clock}.",
        "red": "Red cards: {list}.", "no_red": "No red cards so far.",
        "fastest": "{name} ({team}) is the quickest so far, at {v} km/h.",
        "best": "{name} ({team}) stands out: {g} goals from {s} shots, xG {x}.",
        "player": "{name} ({team}): {g} goals, {s} shots, xG {x}, {p} passes at {pa}% accuracy.",
        "player_casual": "{name} has {g} goals so far and has been on the ball {t} times.",
        "flow": "Who was on top: {list}.",
        "off": "I can only see this match. ",
        "help": "Ask me about the score, a player, possession, shots, goals or who is on top.",
        "neither": "neither team",
    },
    "fr": {
        "score": "{score} à la {clock}.",
        "score_more": " {top} {top_verb} sur les cinq dernières minutes.",
        "on_top": "ont pris l'ascendant", "nobody": "Aucune équipe n'a pris l'ascendant",
        "possession": "{a} ont {ap}% de possession, {b} {bp}%.",
        "shots": "{a} : {as_} tirs, xG {ax}. {b} : {bs} tirs, xG {bx}.",
        "passing": "{a} réussissent {aa}% de leurs passes, {b} {ba}%.",
        "defending": "{a} ont exercé {ap} pressions, {b} {bp}.",
        "goals": "Les buts : {list}.", "no_goals": "Pas encore de but à la {clock}.",
        "red": "Cartons rouges : {list}.", "no_red": "Aucun carton rouge pour l'instant.",
        "fastest": "{name} ({team}) est le plus rapide pour l'instant, à {v} km/h.",
        "best": "{name} ({team}) se distingue : {g} buts sur {s} tirs, xG {x}.",
        "player": "{name} ({team}) : {g} buts, {s} tirs, xG {x}, {p} passes à {pa}% de réussite.",
        "player_casual": "{name} a marqué {g} buts et a touché le ballon {t} fois.",
        "flow": "Qui a dominé : {list}.",
        "off": "Je ne vois que ce match. ",
        "help": "Demandez-moi le score, un joueur, la possession, les tirs, les buts ou qui domine.",
        "neither": "aucune équipe",
    },
    "ar": {
        "score": "النتيجة {score} في الدقيقة {clock}.",
        "score_more": " {top} {top_verb} في آخر خمس دقائق.",
        "on_top": "كانت له الأفضلية", "nobody": "لم يفرض أي فريق أفضليته",
        "possession": "استحواذ {a} {ap}% مقابل {bp}% لـ{b}.",
        "shots": "{a}: {as_} تسديدات، xG {ax}. {b}: {bs} تسديدات، xG {bx}.",
        "passing": "دقة تمرير {a} {aa}% مقابل {ba}% لـ{b}.",
        "defending": "قام {a} بـ{ap} محاولة ضغط مقابل {bp} لـ{b}.",
        "goals": "الأهداف حتى الآن: {list}.", "no_goals": "لا أهداف حتى الدقيقة {clock}.",
        "red": "البطاقات الحمراء: {list}.", "no_red": "لا بطاقات حمراء حتى الآن.",
        "fastest": "{name} ({team}) هو الأسرع حتى الآن بسرعة {v} كم/س.",
        "best": "{name} ({team}) يتألق: {g} أهداف من {s} تسديدات، xG {x}.",
        "player": "{name} ({team}): {g} أهداف، {s} تسديدات، xG {x}، {p} تمريرة بدقة {pa}%.",
        "player_casual": "سجل {name} {g} أهداف ولمس الكرة {t} مرة.",
        "flow": "من سيطر: {list}.",
        "off": "أنا أرى هذه المباراة فقط. ",
        "help": "اسألني عن النتيجة، أو لاعب، أو الاستحواذ، أو التسديدات، أو الأهداف، أو من يسيطر.",
        "neither": "لا أحد",
    },
}


def _intent(q: str) -> str | None:
    f = _fold(q)
    for name, words in INTENTS:
        if any(_fold(w) in f for w in words):
            return name
    return None


def offline_answer(view: MatchView, q: str, lang: str = "en", persona: str = "analyst") -> dict[str, Any]:
    """A rule-based answer built only from the match data tools (same tools as the MCP server)."""
    L = T.get(lang, T["en"])
    tools: list[dict[str, Any]] = []

    def use(name: str, **args: Any) -> dict[str, Any]:
        tools.append({"tool": name, "args": args})
        return getattr(view, name)(**args)

    clock = view.state.clock if view.state.last_event else "0'"
    prefix = L["off"] if any(_fold(w) in _fold(q) for w in OFF_TOPIC) else ""
    intent = _intent(q)
    focus = None
    pid = view.find_player(q) if q and intent not in ("score", "possession", "shots", "flow") else None
    if pid and len(_fold(q)) > 2 and intent not in ("fastest", "best", "goals", "red_card"):
        ps = use("player_stats", player=view.state.names[pid])
        focus = pid
        key = "player_casual" if persona == "casual" else "player"
        text = L[key].format(name=ps["name"], team=ps["team"], g=ps["goals"], s=ps["shots"], x=ps["xg"],
                             p=ps["passes"], pa=ps["pass_accuracy_pct"], t=ps["touches"])
        return {"answer": _singular(prefix + text), "tools": tools, "source": "rules", "focus": focus}

    a_name, b_name = view.names["home"], view.names["away"]
    if intent in ("possession", "shots", "passing", "defending"):
        st = use("team_stats")["teams"]
        A, B = st[a_name], st[b_name]
        if intent == "possession":
            text = L["possession"].format(a=a_name, b=b_name, ap=A["possession_pct"], bp=B["possession_pct"])
        elif intent == "shots":
            text = L["shots"].format(a=a_name, b=b_name, as_=A["shots"], bs=B["shots"], ax=A["xg"], bx=B["xg"])
        elif intent == "passing":
            text = L["passing"].format(a=a_name, b=b_name, aa=A["pass_accuracy_pct"], ba=B["pass_accuracy_pct"])
        else:
            text = L["defending"].format(a=a_name, b=b_name, ap=A["pressures"], bp=B["pressures"])
    elif intent in ("goals", "red_card"):
        kind = "goal" if intent == "goals" else "red_card"
        ms = use("key_moments", kind=kind, limit=10)["moments"]
        items = ", ".join(f"{m['clock']} {m['title'].split(' scores')[0].split(' sent off')[0]}" for m in ms)
        text = (L["goals"] if kind == "goal" else L["red"]).format(list=items) if ms else \
            (L["no_goals"] if kind == "goal" else L["no_red"]).format(clock=clock)
    elif intent == "fastest":
        top = use("top_players", stat="top_speed_kmh", limit=1)["leaders"]
        text = L["fastest"].format(name=top[0]["player"], team=top[0]["team"], v=top[0]["top_speed_kmh"]) \
            if top else L["help"]
    elif intent == "best":
        top = use("top_players", stat="goals", limit=1)["leaders"] or use("top_players", stat="xg", limit=1)["leaders"]
        if top:
            ps = use("player_stats", player=top[0]["player"])
            focus = view.find_player(top[0]["player"])
            text = L["best"].format(name=ps["name"], team=ps["team"], g=ps["goals"], s=ps["shots"], x=ps["xg"])
        else:
            text = L["help"]
    elif intent == "flow":
        flow = use("match_flow", last_minutes=30)["flow"][-3:]
        sep = "، " if lang == "ar" else ", "
        items = sep.join(f"{c['minutes'].replace(chr(39), '') if lang == 'ar' else c['minutes']} "
                         f"{c['on_top'] if c['on_top'] != 'neither team' else L['neither']}" for c in flow)
        text = L["flow"].format(list=items) if flow else L["help"]
    else:
        st = use("match_status")
        top = st["team_on_top_last_5_minutes"]
        text = L["score"].format(score=st["score"], clock=st["clock"])
        if persona == "analyst" or intent == "score":
            text += (L["score_more"].format(top=top, top_verb=L["on_top"]) if top != "neither team"
                     else " " + L["nobody"] + ("." if lang != "ar" else "."))
        if intent is None and not prefix:
            text += " " + L["help"]
    return {"answer": _singular(prefix + text), "tools": tools, "source": "rules", "focus": focus}


SINGULAR_RE = re.compile(r"(?<![\d.,])1 (goal|shot|pressure|but|tir|pression)s\b")


def _singular(text: str) -> str:
    return SINGULAR_RE.sub(lambda m: f"1 {m.group(1)}", text)
