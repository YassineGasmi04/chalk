"""CHALK's virtual studio crew, built on Microsoft Agent Framework.

    Producer (code) picks the moments worth airing, then each one runs through
    a Workflow:

        Analyst -> Telestrator -> VAR --stands-------> Personalizer -> on-air card
           ^                       |
           +------ overturned -----+   (one retry, then a rulebook-safe fallback)

Every agent is an agent_framework.Agent. Online they share one chat client
(Microsoft Foundry or any OpenAI-compatible endpoint); offline each one is
backed by a deterministic rule-based pundit with the same JSON contract.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent_framework import (Agent, BaseChatClient, ChatResponse, Executor, Message,
                             WorkflowBuilder, WorkflowContext, handler)

from . import offline, prompts, rulebook
from .config import ROOT, Settings

log = logging.getLogger("chalk.crew")
logging.getLogger("agent_framework").setLevel(logging.ERROR)

PERSONAS = ["analyst", "casual"]
LANGUAGES = ["en", "fr", "ar"]
MAX_ANALYST_ATTEMPTS = 2
MUST_AIR = {"goal", "red_card", "tactical_shift"}
CONSTANT_NUMBERS = [0, 5, 100]  # "out of 100", "the last 5 minutes" (the rolling window)

ROLES = {
    "analyst": ("Analyst", prompts.ANALYST,
                "Explains why a moment matters, citing the fact sheet for every claim."),
    "telestrator": ("Telestrator", prompts.TELESTRATOR,
                    "Turns the story into grounded drawings on the pitch."),
    "var": ("VAR", prompts.VAR,
            "Fact-checks the story; can overturn it and send it back to the Analyst."),
    "personalizer": ("Personalizer", prompts.PERSONALIZER,
                     "Rewrites the verified insight for analysts and casual fans in English, French and Arabic."),
}


# ------------------------------------------------------------ chat clients
class OfflineChatClient(BaseChatClient):
    """A chat client whose 'model' is a rule-based pundit (same JSON contract)."""

    def __init__(self, role: str, **kwargs: Any):
        super().__init__(**kwargs)
        self.role = role

    async def _respond(self, messages: list[Message]) -> ChatResponse:
        text = messages[-1].text or ""
        payload = json.loads(text.split("INPUT:", 1)[1]) if "INPUT:" in text else {}
        result = offline.HANDLERS[self.role](payload)
        return ChatResponse(messages=Message("assistant", [json.dumps(result, ensure_ascii=False)]))

    def _inner_get_response(self, *, messages, stream, options, **kwargs):  # type: ignore[override]
        return self._respond(list(messages))


def make_online_client(settings: Settings) -> Any:
    from agent_framework.openai import OpenAIChatCompletionClient
    return OpenAIChatCompletionClient(model=settings.model, api_key=settings.api_key,
                                      base_url=settings.base_url)


def parse_json(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError("model did not return a JSON object")
    return json.loads(text[start:end + 1])


# ------------------------------------------------------------------- cache
class CallCache:
    """Recorded agent outputs, so the demo replays identically and costs nothing."""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.dirty = False

    @staticmethod
    def key(*parts: str) -> str:
        return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:32]

    def get(self, k: str) -> Any:
        return self.data.get(k)

    def put(self, k: str, v: Any) -> None:
        self.data[k] = v
        self.dirty = True

    def save(self) -> None:
        if self.dirty:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=0), encoding="utf-8")
            self.dirty = False


# -------------------------------------------------------------------- card
@dataclass
class Card:
    """Shared state that travels through the workflow (the handoff object)."""
    moment: dict[str, Any]
    players: dict[str, Any]
    context: dict[str, Any]
    team_names: dict[str, str]
    analysis: dict[str, Any] | None = None
    drawings: list[dict[str, Any]] = field(default_factory=list)
    var: dict[str, Any] = field(default_factory=dict)
    attempts: int = 0
    route: str = ""
    variants: dict[str, Any] = field(default_factory=dict)
    fallbacks: list[str] = field(default_factory=list)
    trace: list[dict[str, Any]] = field(default_factory=list)
    _sheet: dict[str, Any] | None = field(default=None, repr=False)

    @property
    def facts(self) -> dict[str, Any]:
        """One fact sheet: the moment's own facts plus the match context at that moment.

        Keys are flat and explicit (home_possession_pct, away_xg, pulse_chaos...) so the
        Analyst can cite context and VAR can check it with the same rules.
        """
        if getattr(self, "_sheet", None) is None:
            sheet = dict(self.moment["facts"])
            team = self.moment.get("team")
            other = {"home": "away", "away": "home"}.get(team or "")
            if team:
                sheet["team_name"] = self.team_names.get(team)
                sheet["opponent_name"] = self.team_names.get(other or "")
            ctx = self.context or {}
            for side, stats in (ctx.get("teams") or {}).items():
                for k, v in stats.items():
                    sheet[f"{side}_{'team' if k == 'name' else k}"] = v
            for k, v in (ctx.get("pulse") or {}).items():
                if k in ("dominance", "chaos", "label"):
                    sheet[f"pulse_{k}"] = v
            sheet["window_minutes"] = 5
            self._sheet = sheet
        return self._sheet

    def extra_numbers(self) -> list[Any]:
        ctx = self.context or {}
        return CONSTANT_NUMBERS + [self.moment.get("clock", ""), ctx.get("score", "")] + \
            list(ctx.get("previous_moments") or [])

    def context_view(self) -> dict[str, Any]:
        """Context that isn't already on the fact sheet."""
        ctx = self.context or {}
        return {"previous_moments": ctx.get("previous_moments", [])}

    def moment_view(self) -> dict[str, Any]:
        m = self.moment
        team = m.get("team")
        other = {"home": "away", "away": "home"}.get(team or "", None)
        return {"id": m["id"], "type": m["type"], "clock": m["clock"], "title": m["title"],
                "team": team, "team_name": self.team_names.get(team or "", None),
                "opponent_name": self.team_names.get(other or "", None),
                "players": m.get("players", []), "facts": self.facts}


# ---------------------------------------------------------------- the crew
class Crew:
    def __init__(self, settings: Settings, cache_path: Path | None = None):
        self.settings = settings
        self.cache = CallCache(cache_path or ROOT / "data" / "cache" / "agent_calls.json")
        self.sem = asyncio.Semaphore(max(1, settings.max_concurrency))
        self.retry_base_s = 2.0  # back-off for rate limits and network errors
        self.consecutive_errors = 0
        self.circuit_open = False  # after repeated outages, stop waiting on the model
        self.stats = {"calls": 0, "cached": 0, "model_errors": 0, "fallbacks": 0,
                      "overturned": 0, "drawings_rejected": 0, "captions_repaired": 0}
        online = make_online_client(settings) if settings.online else None
        self.agents: dict[str, Agent] = {}
        self.offline_agents: dict[str, Agent] = {}
        for role, (name, instructions, desc) in ROLES.items():
            self.offline_agents[role] = Agent(OfflineChatClient(role), instructions, name=name, description=desc)
            self.agents[role] = Agent(online, instructions, name=name, description=desc) \
                if online is not None else self.offline_agents[role]

    # ------------------------------------------------------------- calls
    async def call(self, role: str, payload: dict[str, Any], card: Card,
                   force_offline: bool = False) -> dict[str, Any]:
        """Run one agent on one payload. Cached, retried, traced."""
        prompt = "INPUT:\n" + json.dumps(payload, ensure_ascii=False, sort_keys=True)
        use_offline = force_offline or not self.settings.online or self.circuit_open
        agent = self.offline_agents[role] if use_offline else self.agents[role]
        key = None
        if not use_offline:
            key = CallCache.key(self.settings.model, role, ROLES[role][1], prompt)
            hit = self.cache.get(key)
            if hit is not None:
                self.stats["cached"] += 1
                card.trace.append({"agent": ROLES[role][0], "source": "recorded", "ms": 0})
                return hit
        t0 = time.perf_counter()
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                async with self.sem:
                    opts: dict[str, Any] = {"temperature": 0.3}
                    if not use_offline:
                        opts["response_format"] = {"type": "json_object"}
                    resp = await agent.run(prompt, options=opts)
                result = parse_json(resp.text)
                ms = round((time.perf_counter() - t0) * 1000)
                self.stats["calls"] += 0 if use_offline else 1
                card.trace.append({"agent": ROLES[role][0], "source": "rules" if use_offline else "model", "ms": ms})
                if key:
                    self.cache.put(key, result)
                if not use_offline:
                    self.consecutive_errors = 0
                return result
            except Exception as err:  # network, rate limit, bad JSON
                last_err = err
                log.warning("%s attempt %d failed: %s", role, attempt + 1, err)
                await asyncio.sleep(self.retry_base_s * (attempt + 1) ** 2)
        self.stats["model_errors"] += 1
        self.consecutive_errors += 1
        if self.consecutive_errors >= 3 and not self.circuit_open:
            self.circuit_open = True
            log.error("model failed 3 times in a row (%s); switching to the offline crew for this run", last_err)
        card.trace.append({"agent": ROLES[role][0], "source": "error", "error": str(last_err)[:160]})
        if use_offline:
            raise RuntimeError(f"offline {role} failed: {last_err}")
        card.fallbacks.append(f"{role}: model unavailable, rule-based pundit used")
        return await self.call(role, payload, card, force_offline=True)

    # --------------------------------------------------------- workflow
    def build_workflow(self):
        crew = self

        class AnalystExec(Executor):
            @handler
            async def explain(self, card: Card, ctx: WorkflowContext[Card]) -> None:
                payload = {"moment": card.moment_view(), "players": card.players, "context": card.context_view()}
                if card.attempts and card.var.get("issues"):
                    payload["var_notes"] = card.var["issues"]
                card.analysis = await crew.call("analyst", payload, card)
                card.attempts += 1
                await ctx.send_message(card)

        class TelestratorExec(Executor):
            @handler
            async def draw(self, card: Card, ctx: WorkflowContext[Card]) -> None:
                payload = {"moment": card.moment_view(), "players": card.players,
                           "geometry": _geometry(card.moment["geometry"]), "analysis": card.analysis}
                raw = await crew.call("telestrator", payload, card)
                allowed = rulebook.allowed_numbers(card.facts, card.extra_numbers())
                kept, issues = rulebook.filter_drawings(raw.get("drawings"), card.moment["geometry"], allowed)
                crew.stats["drawings_rejected"] += len(issues)
                if not kept:
                    fb = offline.telestrator(payload)
                    kept, _ = rulebook.filter_drawings(fb["drawings"], card.moment["geometry"], allowed)
                    if issues:
                        card.fallbacks.append("telestrator: drawings not grounded, rule-based drawings used")
                card.drawings = kept
                card.var["drawing_issues"] = issues
                await ctx.send_message(card)

        class VarExec(Executor):
            @handler
            async def review(self, card: Card, ctx: WorkflowContext[Card]) -> None:
                rule_issues = rulebook.check_analysis(card.analysis or {}, card.facts, card.players,
                                                      card.extra_numbers())
                if rule_issues:
                    verdict, issues, by = "overturned", rule_issues, "rulebook"
                else:
                    judged = await crew.call("var", {"facts": card.facts, "players": card.players,
                                                     "analysis": card.analysis}, card)
                    verdict = "overturned" if judged.get("verdict") == "overturned" else "stands"
                    issues, by = judged.get("issues") or [], "judge"
                history = card.var.get("history", []) + [{"attempt": card.attempts, "verdict": verdict,
                                                          "by": by, "issues": issues}]
                card.var.update({"verdict": verdict, "issues": issues, "history": history})
                if verdict == "overturned":
                    crew.stats["overturned"] += 1
                    if card.attempts < MAX_ANALYST_ATTEMPTS:
                        card.route = "retry"
                        await ctx.send_message(card)
                        return
                    # Out of retries: air only what the rulebook can guarantee
                    payload = {"moment": card.moment_view(), "players": card.players, "context": card.context_view()}
                    card.analysis = offline.analyst(payload)
                    fb_draw = offline.telestrator({**payload, "geometry": _geometry(card.moment["geometry"]),
                                                   "analysis": card.analysis})
                    allowed = rulebook.allowed_numbers(card.facts, card.extra_numbers())
                    card.drawings, _ = rulebook.filter_drawings(fb_draw["drawings"], card.moment["geometry"], allowed)
                    card.fallbacks.append("analyst: overturned twice, rulebook-safe version aired")
                    crew.stats["fallbacks"] += 1
                    card.var["verdict"] = "stands"
                    card.var["final"] = "fallback"
                else:
                    card.var["final"] = "verified"
                card.route = "air"
                await ctx.send_message(card)

        class PersonalizerExec(Executor):
            @handler
            async def personalize(self, card: Card, ctx: WorkflowContext[Card, Card]) -> None:
                payload = {"moment": card.moment_view(), "analysis": {k: (card.analysis or {}).get(k)
                                                                      for k in ("headline", "story", "claims")},
                           "personas": PERSONAS, "languages": LANGUAGES}
                result = await crew.call("personalizer", payload, card)
                variants = result.get("variants") or {}
                allowed = rulebook.allowed_numbers(card.facts, card.extra_numbers())
                problems = rulebook.check_variants(variants, allowed, PERSONAS, LANGUAGES)
                if problems:
                    safe = offline.personalizer(payload)["variants"]
                    for (p, lang) in problems:
                        variants.setdefault(p, {})[lang] = safe[p][lang]
                    crew.stats["captions_repaired"] += len(problems)
                    card.var["caption_issues"] = {f"{p}/{lang}": v for (p, lang), v in problems.items()}
                card.variants = variants
                await ctx.yield_output(card)

        analyst = AnalystExec(id="analyst")
        tele = TelestratorExec(id="telestrator")
        var = VarExec(id="var")
        pers = PersonalizerExec(id="personalizer")
        return (WorkflowBuilder(start_executor=analyst, name="chalk-studio-crew",
                                description="Explain, draw, verify and personalize one moment")
                .add_edge(analyst, tele)
                .add_edge(tele, var)
                .add_edge(var, analyst, condition=lambda c: isinstance(c, Card) and c.route == "retry")
                .add_edge(var, pers, condition=lambda c: isinstance(c, Card) and c.route == "air")
                .build())

    async def run_moment(self, card: Card) -> Card:
        wf = self.build_workflow()
        result = await wf.run(card)
        outs = result.get_outputs()
        return outs[-1] if outs else card


# ----------------------------------------------------------------- helpers
def _geometry(geo: dict[str, Any]) -> dict[str, Any]:
    """Geometry for the Telestrator, rounded to keep prompts small."""
    def r(p: Any) -> Any:
        return [round(p[0], 1), round(p[1], 1)] if isinstance(p, (list, tuple)) and len(p) == 2 else p
    out: dict[str, Any] = {"players": {pid: r(pos) for pid, pos in (geo.get("frame") or {}).items()}}
    if geo.get("ball"):
        out["ball"] = r(geo["ball"])
    if geo.get("buildup"):
        out["buildup"] = [{"from": r(s["from"]), "to": r(s["to"]), "kind": s["kind"], "player": s.get("player")}
                          for s in geo["buildup"][-6:]]
    for k in ("shot", "pass"):
        if geo.get(k):
            out[k] = {"from": r(geo[k]["from"]), "to": r(geo[k]["to"])}
    if geo.get("runner"):
        out["runner"] = r(geo["runner"])
    if geo.get("press_zone"):
        out["press_zone"] = geo["press_zone"]
    return out
