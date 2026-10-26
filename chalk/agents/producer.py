"""Producer: decides what goes on air and prepares each moment for the crew.

Plain code. It picks moments (every goal, red card and tactical shift, then
the most important of the rest, spaced out so the broadcast never floods),
and attaches what the agents need: the players involved, the match context
at that exact moment, and the team names.
"""

from __future__ import annotations

from typing import Any

from ..stats.moments import MomentDetector
from ..stats.state import MatchState
from .crew import MUST_AIR, Card

MIN_GAP_S = 120  # minimum seconds between two optional moments on air


def replay_with_context(events: list[dict[str, Any]]) -> tuple[MatchState, list[dict[str, Any]], dict[str, dict]]:
    """Re-run the Interpret + Spot stages, capturing the match context at each moment."""
    state = MatchState()
    det = MomentDetector(state)
    contexts: dict[str, dict[str, Any]] = {}
    for ev in events:
        state.apply(ev)
        for m in det.process(ev):
            teams = {}
            for side in ("home", "away"):
                s = state.team_summary(side)
                teams[side] = {k: s[k] for k in ("name", "goals", "possession_pct", "shots", "xg",
                                                 "players_on_pitch", "formation")}
            contexts[m.id] = {
                "clock": m.clock,
                "score": f"{state.score['home']}-{state.score['away']}",
                "teams": teams,
                "previous_moments": [f"{p.clock} {p.title}" for p in det.moments[:-1][-3:]],
                "pulse": vars(state.pulse[-1]) if state.pulse else None,
            }
    return state, [m.to_dict() for m in det.moments], contexts


def select_moments(moments: list[dict[str, Any]], max_cards: int = 18) -> list[dict[str, Any]]:
    must = [m for m in moments if m["type"] in MUST_AIR]
    optional = sorted((m for m in moments if m["type"] not in MUST_AIR and m["importance"] >= 0.45),
                      key=lambda m: -m["importance"])
    chosen = list(must)
    for m in optional:
        if len(chosen) >= max_cards:
            break
        if all(abs(m["t"] - c["t"]) >= MIN_GAP_S for c in chosen):
            chosen.append(m)
    return sorted(chosen, key=lambda m: m["t"])


def build_cards(events: list[dict[str, Any]], moments: list[dict[str, Any]],
                contexts: dict[str, dict[str, Any]]) -> list[Card]:
    start = events[0]
    roster: dict[str, dict[str, Any]] = {}
    for side in ("home", "away"):
        for p in start[side]["players"] + start[side]["bench"]:
            roster[p["pid"]] = {"name": p["name"], "team": side, "position": p["position"],
                                "number": p["number"]}
    team_names = {"home": start["home"]["name"], "away": start["away"]["name"]}
    cards = []
    for m in moments:
        on_pitch = set((m.get("geometry") or {}).get("frame", {}).keys()) | set(m.get("players", []))
        players = {pid: roster[pid] for pid in sorted(on_pitch) if pid in roster}
        cards.append(Card(moment=m, players=players, context=contexts.get(m["id"], {}),
                          team_names=team_names))
    return cards
