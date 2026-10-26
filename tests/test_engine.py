"""Tests for the synthetic engine and the Interpret/Spot layers (no AI, no network)."""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chalk.sim.engine import MatchSimulator  # noqa: E402
from chalk.stats import metrics as M  # noqa: E402
from chalk.stats.moments import analyse  # noqa: E402

DEMO_SEED = 4


@pytest.fixture(scope="module")
def demo():
    events = MatchSimulator(seed=DEMO_SEED).run()
    state, det = analyse(events)
    return events, state, det


def test_same_seed_same_match():
    a = MatchSimulator(seed=DEMO_SEED).run()
    b = MatchSimulator(seed=DEMO_SEED).run()
    assert [e["type"] for e in a] == [e["type"] for e in b]
    assert a[-1]["final_score"] == b[-1]["final_score"]


def test_event_stream_is_well_formed(demo):
    events, _, _ = demo
    assert events[0]["type"] == "match_start" and events[0]["synthetic"] is True
    assert events[-1]["type"] == "match_end"
    ids = [e["id"] for e in events]
    assert ids == list(range(len(events)))
    ts = [e["t"] for e in events]
    assert ts == sorted(ts), "time must never go backwards"
    for e in events:
        x, y = e["ball"]
        assert 0 <= x <= 105 and 0 <= y <= 68
        assert len(e["frame"]) >= 20  # 22 players, minus red cards


@pytest.mark.parametrize("seed", [1, 4, 9, 13])
def test_realistic_ranges(seed):
    events = MatchSimulator(seed=seed).run()
    c = Counter(e["type"] for e in events)
    passes = [e for e in events if e["type"] == "pass"]
    acc = sum(e["outcome"] == "complete" for e in passes) / len(passes)
    xg = sum(e["xg"] for e in events if e["type"] == "shot")
    assert 1500 <= len(events) <= 3000
    assert 700 <= c["pass"] <= 1200
    assert 0.74 <= acc <= 0.9
    assert 10 <= c["shot"] <= 32
    assert 0.8 <= xg <= 5.0


def test_scripted_storyline_is_discovered_from_data(demo):
    """The Spotter never sees the script, but must still find its beats."""
    _, _, det = demo
    by_type: dict[str, list[int]] = {}
    for m in det.moments:
        by_type.setdefault(m.type, []).append(m.minute)
    # Ashvale's high press starts at 15'
    assert any(14 <= mi <= 22 and m.team == "home" for m in det.moments
               for mi in [m.minute] if m.type == "press_surge")
    # Kestrel's formation switch at 65'
    assert any(64 <= mi <= 68 for mi in by_type.get("tactical_shift", []))
    # Red card around 76'
    assert any(75 <= mi <= 82 for mi in by_type.get("red_card", []))
    # Every goal becomes a moment
    goals = sum(1 for m in det.moments if m.type == "goal")
    assert goals == sum(demo[1].score.values())


def test_moments_carry_facts_evidence_and_geometry(demo):
    _, _, det = demo
    for m in det.moments:
        assert m.facts and "clock" in m.facts
        assert "frame" in m.geometry
        if m.type == "goal":
            assert m.evidence, "goals must cite the events that prove them"
            assert m.geometry["shot"]["from"]


def test_stats_match_raw_events(demo):
    events, state, _ = demo
    for side in ("home", "away"):
        shots = [e for e in events if e["type"] == "shot" and e["team"] == side]
        assert state.team_summary(side)["shots"] == len(shots)
        assert state.team_summary(side)["xg"] == round(sum(s["xg"] for s in shots), 2)
        goals = sum(1 for e in events if e["type"] == "goal" and e["team"] == side)
        assert state.score[side] == goals


def test_metrics_behave():
    # closer, more central shots are better chances
    assert M.expected_goals((99, 34), 1) > M.expected_goals((85, 34), 1) > \
        M.expected_goals((80, 10), 1)
    # harder passes: longer, pressured, tightly marked, line-breaking
    easy = M.pass_difficulty((50, 34), (55, 34), 1, 12, 10, 0)
    hard = M.pass_difficulty((40, 34), (80, 30), 1, 1.0, 1.0, 3)
    assert 0 <= easy < 25 < 75 < hard <= 100


def test_touches_count_every_on_ball_action(demo):
    events, state, _ = demo
    on_ball = {"pass", "carry", "take_on", "shot", "kickoff", "throw_in", "goal_kick", "free_kick"}
    for pid in ("h9", "h8", "a10"):
        expected = sum(1 for e in events if e.get("player") == pid and e["type"] in on_ball)
        assert state.player_summary(pid)["touches"] == expected > 20


def test_goals_carry_a_var_offside_line(demo):
    _, _, det = demo
    goals = [m for m in det.moments if m.type == "goal"]
    for g in goals:
        o = g.geometry["offside"]
        assert o and o["onside"] and o["margin_m"] >= 0  # every goal in the demo stood
        assert (o["line_x"] - o["receiver_x"]) * o["attack_dir"] == pytest.approx(o["margin_m"], abs=0.01)
    assert min(g.geometry["offside"]["margin_m"] for g in goals) < 1.5  # one tight call


def test_portrait_prompts_describe_fictional_people_only():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("gp", Path(__file__).resolve().parents[1] / "scripts" / "generate_portraits.py")
    gp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gp)
    players = gp.roster()
    assert len(players) == 40  # 11 starters and 9 substitutes per club
    prompts = [gp.prompt_for(p, t) for p, t in players]
    assert all("does not exist" in x and "No logos" in x for x in prompts)
    assert prompts == [gp.prompt_for(p, t) for p, t in players]  # the same face every run
    assert not any(p["name"] in x for (p, _), x in zip(players, prompts))  # names never reach the model
