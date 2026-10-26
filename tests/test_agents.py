"""Tests for the studio crew: rulebook, workflow, VAR retry loop and fallbacks.

All offline: no network, no model, no key.
"""

from __future__ import annotations

import asyncio
import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_framework import Agent, BaseChatClient  # noqa: E402

from chalk.agents import offline, rulebook  # noqa: E402
from chalk.agents.config import Settings  # noqa: E402
from chalk.agents.crew import LANGUAGES, PERSONAS, Crew  # noqa: E402
from chalk.agents.producer import build_cards, replay_with_context, select_moments  # noqa: E402
from chalk.sim.engine import MatchSimulator  # noqa: E402

OFFLINE = Settings("offline", None, None, "offline", 4)


@pytest.fixture(scope="module")
def match():
    events = MatchSimulator(seed=4).run()
    _, moments, contexts = replay_with_context(events)
    return events, moments, contexts


def cards_for(match, types=None, n=None):
    events, moments, contexts = match
    chosen = select_moments(moments, 18)
    if types:
        chosen = [m for m in chosen if m["type"] in types]
    return build_cards(events, chosen[:n] if n else chosen, contexts)


def run(crew, card):
    return asyncio.run(crew.run_moment(card))


# ------------------------------------------------------------------ rulebook
def test_rulebook_rejects_invented_numbers():
    facts = {"xg": 0.461, "shot_speed_kmh": 109.9, "score": "3-2"}
    allowed = rulebook.allowed_numbers(facts)
    assert rulebook.check_numbers("0.46 xG at 110 km/h, 3-2", allowed) == []
    assert rulebook.check_numbers("a 0.9 xG chance", allowed)


def test_rulebook_rejects_unsupported_context():
    assert rulebook.check_language("his best season record ever")
    assert rulebook.check_language("a brilliant finish") == []


def test_drawings_must_be_anchored(match):
    card = cards_for(match, types={"goal"}, n=1)[0]
    geo = card.moment["geometry"]
    allowed = rulebook.allowed_numbers(card.facts)
    shot = geo["shot"]
    good = {"type": "arrow", "from": shot["from"], "to": shot["to"], "style": "shot"}
    floating = {"type": "arrow", "from": [52.0, 2.0], "to": [53.0, 3.0], "style": "run"}
    ghost = {"type": "circle", "player": "h99"}
    kept, issues = rulebook.filter_drawings([good, floating, ghost], geo, allowed)
    assert kept == [good]
    assert len(issues) == 2


# ---------------------------------------------------------------- the crew
def test_offline_crew_airs_verified_cards(match):
    crew = Crew(OFFLINE)
    cards = cards_for(match)
    out = [run(crew, c) for c in cards]
    assert len(out) == len(cards) >= 10
    for c in out:
        assert c.var["final"] == "verified"
        assert [t["agent"] for t in c.trace] == ["Analyst", "Telestrator", "VAR", "Personalizer"]
        assert c.drawings, f"no drawings for {c.moment['title']}"
        allowed = rulebook.allowed_numbers(c.facts, c.extra_numbers())
        assert rulebook.check_analysis(c.analysis, c.facts, c.players, c.extra_numbers()) == []
        assert rulebook.check_variants(c.variants, allowed, PERSONAS, LANGUAGES) == {}


def test_var_overturns_and_analyst_fixes_it(match, monkeypatch):
    """First answer invents a number; VAR sends it back; the second answer airs."""
    calls = {"n": 0}
    real = offline.HANDLERS["analyst"]

    def flaky(payload):
        calls["n"] += 1
        out = copy.deepcopy(real(payload))
        if "var_notes" not in payload:
            out["story"] += " He has now scored 99 goals."
        return out

    monkeypatch.setitem(offline.HANDLERS, "analyst", flaky)
    card = cards_for(match, types={"goal"}, n=1)[0]
    out = run(Crew(OFFLINE), card)
    hist = out.var["history"]
    assert [h["verdict"] for h in hist] == ["overturned", "stands"]
    assert any("99" in i for i in hist[0]["issues"])
    assert out.var["final"] == "verified" and out.attempts == 2
    assert "99" not in out.analysis["story"]


def test_var_falls_back_when_analyst_keeps_failing(match, monkeypatch):
    real = offline.HANDLERS["analyst"]

    def stubborn(payload):
        out = copy.deepcopy(real(payload))
        out["story"] += " A club record 77 goals."
        return out

    monkeypatch.setitem(offline.HANDLERS, "analyst", stubborn)
    card = cards_for(match, types={"red_card"}, n=1)[0]
    out = run(Crew(OFFLINE), card)
    assert out.var["final"] == "fallback"
    assert "77" not in out.analysis["story"]
    assert any("overturned twice" in f for f in out.fallbacks)


class _DownClient(BaseChatClient):
    """A model endpoint that is down."""

    def _inner_get_response(self, *, messages, stream, options, **kwargs):
        async def fail():
            raise ConnectionError("endpoint unreachable")
        return fail()


def test_model_outage_falls_back_to_rule_based_pundit(match):
    crew = Crew(OFFLINE)
    crew.settings = Settings("foundry", "https://example.invalid/openai/v1/", "x", "gpt", 2)
    crew.retry_base_s = 0
    crew.agents["analyst"] = Agent(_DownClient(), "x", name="Analyst")
    for role in ("telestrator", "var", "personalizer"):
        crew.agents[role] = crew.offline_agents[role]
    card = cards_for(match, types={"goal"}, n=1)[0]
    out = run(crew, card)
    assert out.var["final"] == "verified"
    assert any("model unavailable" in f for f in out.fallbacks)
    assert crew.stats["model_errors"] >= 1


# ------------------------------------- regression: first live Foundry run
def test_context_citations_from_live_run_are_accepted(match):
    """In the first gpt-4.1-mini run, good claims citing match context were wrongly
    overturned. They must pass now; invented numbers must still be caught."""
    card = cards_for(match, types={"red_card"}, n=1)[0]
    f = card.facts
    assert "home_possession_pct" in f and "pulse_chaos" in f and f["team_name"]
    good = {
        "headline": "Down to ten",
        "story": f"{f['team_name']} are down to {f['players_left']} with {f['minutes_remaining']} minutes left, "
                 f"after {f['team_possession_last5_pct']}% of the ball in the last 5 minutes.",
        "claims": [
            {"text": "They kept the ball well before the card.", "fact_keys": ["possession_pct"]},
            {"text": "The game had been chaotic.", "fact_keys": ["chaos", "pulse"]},
            {"text": f"{f['team_name']} lose a player.", "fact_keys": ["team", "players_left"]},
            {"text": "Shots so far.", "fact_keys": ["shots", "teams.home.xg"]},
        ],
        "focus_players": card.moment["players"][:1],
    }
    assert rulebook.check_analysis(good, f, card.players, card.extra_numbers()) == []
    bad = copy.deepcopy(good)
    bad["story"] += " Their 9th red card of the season."
    bad["claims"][0]["fact_keys"] = ["pct"]
    issues = rulebook.check_analysis(bad, f, card.players, card.extra_numbers())
    assert any("number 9" in i for i in issues)
    assert any("unsupported context" in i for i in issues)
    assert any("unknown facts" in i for i in issues)


def test_step_numbers_allowed_in_drawing_labels(match):
    card = cards_for(match, types={"goal"}, n=1)[0]
    geo = card.moment["geometry"]
    seg = geo["buildup"][-1]
    d = {"type": "arrow", "from": seg["from"], "to": seg["to"], "style": "pass", "label": "Pass 2"}
    kept, issues = rulebook.filter_drawings([d], geo, rulebook.allowed_numbers(card.facts))
    assert kept == [d] and issues == []
