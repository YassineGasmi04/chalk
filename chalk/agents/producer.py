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


def context_at(state: MatchState, det: MomentDetector, moment: Any) -> dict[str, Any]:
    """The match context an agent sees for a moment, captured when the moment happens."""
    teams = {}
    for side in ("home", "away"):
        s = state.team_summary(side)
        teams[side] = {k: s[k] for k in ("name", "goals", "possession_pct", "shots", "xg",
                                         "players_on_pitch", "formation")}
    earlier = [p for p in det.moments if p is not moment]
    return {
        "clock": moment.clock,
        "score": f"{state.score['home']}-{state.score['away']}",
        "teams": teams,
        "previous_moments": [f"{p.clock} {p.title}" for p in earlier[-3:]],
        "pulse": vars(state.pulse[-1]) if state.pulse else None,
    }


def replay_with_context(events: list[dict[str, Any]]) -> tuple[MatchState, list[dict[str, Any]], dict[str, dict]]:
    """Re-run the Interpret + Spot stages, capturing the match context at each moment."""
    state = MatchState()
    det = MomentDetector(state)
    contexts: dict[str, dict[str, Any]] = {}
    for ev in events:
        state.apply(ev)
        for m in det.process(ev):
            contexts[m.id] = context_at(state, det, m)
    return state, [m.to_dict() for m in det.moments], contexts


class LiveProducer:
    """Decides what goes on air during a live match, without seeing the future."""

    def __init__(self, min_gap_s: float = MIN_GAP_S):
        self.min_gap_s = min_gap_s
        self.last_optional_t: float | None = None

    def wants(self, m: dict[str, Any]) -> bool:
        if m["type"] in MUST_AIR:
            return True
        if m["importance"] < 0.5:
            return False
        if self.last_optional_t is not None and m["t"] - self.last_optional_t < self.min_gap_s:
            return False
        self.last_optional_t = m["t"]
        return True


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


def player_of_the_match(state: MatchState) -> str | None:
    """Code picks the player of the match, so the AI can't invent one."""
    best, best_score = None, -1.0
    for pid in state.names:
        P = state.player[pid]
        if not P["touches"]:
            continue
        score = (P["goals"] * 4 + P["assists"] * 3 + P["key_passes"] + P["shots_on_target"] * 0.5
                 + (P["tackles"] + P["interceptions"]) * 0.25 + P["progressive_passes"] * 0.1)
        if score > best_score:
            best, best_score = pid, score
    return best


def build_recap_card(events: list[dict[str, Any]], state: MatchState,
                     moments: list[dict[str, Any]]) -> Card:
    """The full-time recap as one more card: a 'full_time' moment with its own fact sheet."""
    start, end = events[0], events[-1]
    names = {"home": start["home"]["name"], "away": start["away"]["name"]}
    h, a = state.score["home"], state.score["away"]
    winner = "draw" if h == a else names["home" if h > a else "away"]
    loser = None if h == a else names["away" if h > a else "home"]
    facts: dict[str, Any] = {
        "clock": "FT", "score": f"{h}-{a}",
        "final_score_text": f"{names['home']} {h}-{a} {names['away']}",
        "winner": winner, "loser": loser,
        "home_team": names["home"], "away_team": names["away"],
    }
    for side in ("home", "away"):
        t = state.team_summary(side)
        for k in ("possession_pct", "shots", "shots_on_target", "xg", "pass_accuracy_pct", "pressures",
                  "red_cards", "big_chances"):
            facts[f"{side}_{k}"] = t[k]
        facts[f"{side}_players_on_pitch"] = state.men[side]  # "down to 10 men" is a fact, not arithmetic
    facts["xg_text"] = f"{names['home']} {facts['home_xg']}, {names['away']} {facts['away_xg']}"
    goals = [m for m in moments if m["type"] == "goal"]
    facts["goals_timeline"] = "; ".join(
        f"{m['clock']} {m['facts']['scorer']} for {names[m['team']]} ({m['facts']['goal_effect']}, "
        f"{m['facts']['score_before']} to {m['facts']['score']})" for m in goals)
    reds = [m for m in moments if m["type"] == "red_card"]
    facts["red_cards_timeline"] = "; ".join(f"{m['clock']} {m['facts']['player']} ({names[m['team']]})"
                                            for m in reds) or "none"
    shifts = [m for m in moments if m["type"] == "tactical_shift"]
    facts["tactical_changes"] = "; ".join(f"{m['clock']} {names[m['team']]} {m['facts']['from_formation']} "
                                          f"to {m['facts']['to_formation']}" for m in shifts) or "none"
    # turning point: the decisive goal if there is one, else the biggest swing moment
    decisive = [m for m in goals if m["facts"]["goal_effect"] == "goes ahead"]
    tp = decisive[-1] if decisive and h != a else (reds[0] if reds else (goals[-1] if goals else None))
    if tp:
        facts["turning_point_clock"] = tp["clock"]
        facts["turning_point_text"] = f"{tp['clock']}, {tp['title']}"
    facts["turning_points"] = "; ".join(f"{m['clock']} {m['title']}" for m in moments
                                        if m["type"] in ("goal", "red_card", "tactical_shift"))
    pid = player_of_the_match(state)
    if pid:
        ps = state.player_summary(pid)
        facts.update({"potm_id": pid, "potm_name": ps["name"], "potm_team": names[ps["team"]],
                      "potm_goals": ps["goals"], "potm_assists": ps["assists"], "potm_shots": ps["shots"],
                      "potm_xg": ps["xg"], "potm_touches": ps["touches"],
                      "potm_pass_accuracy_pct": ps["pass_accuracy_pct"],
                      "potm_top_speed_kmh": ps["top_speed_kmh"]})
    roster: dict[str, dict[str, Any]] = {}
    for side in ("home", "away"):
        for p in start[side]["players"] + start[side]["bench"]:
            roster[p["pid"]] = {"name": p["name"], "team": side, "position": p["position"], "number": p["number"]}
    involved = {pid} if pid else set()
    for m in goals + reds:
        involved.update(m.get("players", []))
    moment = {"id": "recap", "type": "full_time", "t": end["t"], "minute": end["minute"], "clock": "FT",
              "team": None, "title": "Full-time recap", "importance": 1.0,
              "players": [pid] if pid else [], "facts": facts, "evidence": [], "geometry": {"frame": {}}}
    return Card(moment=moment, players={k: roster[k] for k in sorted(involved) if k in roster},
                context={"score": facts["score"]}, team_names=names)
