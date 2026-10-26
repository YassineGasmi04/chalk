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


def test_second_live_run_regressions(match):
    """Second gpt-4.1-mini run: raw key names leaked into stories, and a signed
    dominance number was misread as the wrong team."""
    card = cards_for(match, types={"tactical_shift"}, n=1)[0]
    f = card.facts
    assert f["pulse_team_on_top"] in (card.team_names["home"], card.team_names["away"], "neither team")
    assert "pulse_dominance" not in f  # no signed number left to misread
    allowed = rulebook.allowed_numbers(f, card.extra_numbers())
    leak = rulebook.check_language("Ashvale lead (home_possession_pct 50.3 vs pulse_chaos 1.35).")
    assert any("internal data names" in i for i in leak)
    assert rulebook.check_language("Ashvale have 4-2-3-1 shape and a box-to-box run.") == []
    # 48.9% written as a share is the same fact
    assert rulebook.check_numbers("a 0.489 share", rulebook.allowed_numbers({"p": 48.9})) == []
    # citing the moment's own title is fine
    assert rulebook.resolve_key("title", f)


def test_third_live_run_regressions(match):
    """Full 18-moment run: momentum facts were signed numbers, the judge miscounted
    11 v 10, and drawing labels showed player ids and an unknown 'press' style."""
    events, moments, contexts = match
    swings = [m for m in moments if m["type"] == "momentum_swing"]
    assert swings and all("dominance_now" not in m["facts"] for m in swings)
    assert all(isinstance(m["facts"]["team_on_top_now"], str) for m in swings)
    red = cards_for(match, types={"red_card"}, n=1)[0]
    assert red.facts["player_advantage"].endswith("have 1 more player")
    assert red.facts["leading_team"] in ("level", red.team_names["home"], red.team_names["away"])
    goal = cards_for(match, types={"goal"}, n=1)[0]
    seg = goal.moment["geometry"]["buildup"][-1]
    raw = [{"type": "arrow", "from": seg["from"], "to": seg["to"], "style": "press", "label": "h9 to h6"}]
    fixed = rulebook.repair_labels(raw, goal.players)
    assert fixed[0]["style"] == "run" and "h9" not in fixed[0]["label"]
    kept, issues = rulebook.filter_drawings(fixed, goal.moment["geometry"], rulebook.allowed_numbers(goal.facts))
    assert kept and not issues


def test_one_broken_deployment_does_not_silence_the_others(match):
    """Round 3 live run: a missing VAR deployment tripped a global circuit breaker
    and every agent went offline. The breaker is per model now."""
    crew = Crew(OFFLINE)
    crew.settings = Settings("foundry", "https://example.invalid/openai/v1/", "x", "gpt-4.1-mini", 2, "gpt-4.1")
    crew.retry_base_s = 0
    crew.agents["var"] = Agent(_DownClient(), "x", name="VAR")
    for role in ("analyst", "telestrator", "personalizer"):
        crew.agents[role] = crew.offline_agents[role]
    for card in cards_for(match, types={"goal"}, n=4):
        out = run(crew, card)
        assert out.var["final"] == "rulebook-only"
    assert crew.circuit_open == {"gpt-4.1"}
    assert "gpt-4.1" in crew.errors and "gpt-4.1-mini" not in crew.errors


def test_fourth_live_run_score_logic(match):
    """Round 4 live run: three score-logic slips got past the judge. The rulebook
    owns that arithmetic now."""
    goals = {c.facts["clock"]: c for c in cards_for(match, types={"goal"})}
    assert [g.facts["goal_effect"] for g in goals.values()] == \
        ["opening goal", "extends the lead", "pulls one back", "equaliser", "goes ahead"]
    eq, winner = goals["71'"], goals["89'"]
    assert rulebook.check_score_logic("Holmberg scores, maintaining the 2-2 deadlock", eq.facts)
    assert rulebook.check_score_logic("Mensah-Cole extends Ashvale's lead to 3-2", winner.facts)
    assert rulebook.check_score_logic("Mensah-Cole puts Ashvale ahead at 3-2", winner.facts) == []
    red = cards_for(match, types={"red_card"}, n=1)[0]
    assert red.facts["leading_team"] == "level"
    assert rulebook.check_score_logic("Kestrel Bay down to 10 men, yet still leading", red.facts)
    assert rulebook.check_score_logic("Kestrel Bay down to 10 men at 2-2", red.facts) == []


def test_recap_agent_runs_through_the_same_crew(match):
    from chalk.agents.producer import build_recap_card
    from chalk.stats.moments import analyse
    events, moments, _ = match
    state, _ = analyse(events)
    card = build_recap_card(events, state, moments)
    f = card.facts
    assert f["final_score_text"] == "Ashvale Rovers 3-2 Kestrel Bay FC" and f["winner"] == "Ashvale Rovers"
    assert f["potm_id"] == "h9" and f["potm_goals"] == 3  # the hat-trick, picked by code
    assert f["goals_timeline"].count("'") == 5
    out = run(Crew(OFFLINE), card)
    assert out.var["final"] == "verified" and out.drawings == []
    assert [t["agent"] for t in out.trace] == ["Recap", "VAR", "Personalizer"]
    assert rulebook.check_variants(out.variants, rulebook.allowed_numbers(out.facts, out.extra_numbers()),
                                   PERSONAS, LANGUAGES, out.facts) == {}
