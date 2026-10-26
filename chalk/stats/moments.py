"""Spotter: decide which moments are worth explaining.

Plain code, no AI. Each `Moment` carries:
  facts     every number an agent is allowed to say (the VAR agent checks
            generated text against exactly these values)
  evidence  ids of the events that prove it
  geometry  coordinates the Telestrator agent may draw with
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from . import metrics as M
from .state import DIR, MatchState

IMPORTANCE = {
    "goal": 1.0,
    "red_card": 0.95,
    "big_chance": 0.75,
    "tactical_shift": 0.8,
    "press_surge": 0.7,
    "momentum_swing": 0.65,
    "chaos_spike": 0.55,
    "substitution": 0.4,
    "hardest_pass": 0.5,
    "speed_burst": 0.45,
    "rocket_shot": 0.5,
    "milestone": 0.35,
}

COOLDOWN_S = {
    "press_surge": 12 * 60,
    "momentum_swing": 10 * 60,
    "chaos_spike": 10 * 60,
    "hardest_pass": 8 * 60,
    "speed_burst": 10 * 60,
    "rocket_shot": 8 * 60,
}


@dataclass
class Moment:
    id: str
    type: str
    t: float
    minute: int
    clock: str
    team: str | None
    title: str
    importance: float
    players: list[str] = field(default_factory=list)
    facts: dict[str, Any] = field(default_factory=dict)
    evidence: list[int] = field(default_factory=list)
    geometry: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class MomentDetector:
    def __init__(self, state: MatchState):
        self.s = state
        self.events: list[dict[str, Any]] = []
        self.moments: list[Moment] = []
        self._last_fired: dict[tuple[str, str | None], float] = {}
        self._last_pulse_len = 0
        self._last_label = "contested"

    # ------------------------------------------------------------- plumbing
    def _ok(self, kind: str, team: str | None) -> bool:
        cd = COOLDOWN_S.get(kind)
        if not cd:
            return True
        last = self._last_fired.get((kind, team))
        return last is None or self.s.t - last >= cd

    def _fire(self, kind: str, team: str | None, title: str, ev: dict[str, Any],
              players: list[str], facts: dict[str, Any], evidence: list[int],
              geometry: dict[str, Any], importance: float | None = None) -> Moment:
        self._last_fired[(kind, team)] = self.s.t
        self._last_fired[(kind, None)] = self.s.t
        m = Moment(
            id=f"m{len(self.moments) + 1:03d}",
            type=kind,
            t=ev["t"],
            minute=ev["minute"],
            clock=ev["clock"],
            team=team,
            title=title,
            importance=round(importance if importance is not None else IMPORTANCE[kind], 2),
            players=players,
            facts={"clock": ev["clock"], "score": f"{self.s.score['home']}-{self.s.score['away']}",
                   **facts},
            evidence=evidence,
            geometry={"frame": ev.get("frame", {}), "ball": ev.get("ball"), **geometry},
        )
        self.moments.append(m)
        return m

    def _possession_chain(self, possession: int, upto_id: int) -> list[dict[str, Any]]:
        return [e for e in self.events
                if e.get("possession") == possession and e["id"] <= upto_id
                and e["type"] in ("pass", "carry", "take_on", "shot", "interception", "tackle",
                                  "kickoff", "throw_in", "goal_kick", "free_kick", "save")]

    def _team_name(self, team: str | None) -> str:
        return self.s.team_name(team) if team else ""

    # ------------------------------------------------------------- process
    def process(self, ev: dict[str, Any]) -> list[Moment]:
        """Call after state.apply(ev). Returns the moments this event created."""
        self.events.append(ev)
        before = len(self.moments)
        handler = getattr(self, f"_on_{ev['type']}", None)
        if handler:
            handler(ev)
        if len(self.s.pulse) != self._last_pulse_len:
            self._last_pulse_len = len(self.s.pulse)
            self._on_minute(ev)
        return self.moments[before:]

    # ------------------------------------------------------------ handlers
    def _on_goal(self, ev: dict[str, Any]) -> None:
        shot = next(e for e in reversed(self.events) if e["type"] == "shot")
        chain = self._possession_chain(shot["possession"], shot["id"])
        passes = [e for e in chain if e["type"] == "pass"]
        first = chain[0] if chain else shot
        won_high = first["type"] in ("interception", "tackle") and \
            self.s._in_opp_half(first["ball"], ev["team"])
        path = []
        for e in chain:
            if e["type"] in ("pass", "carry"):
                path.append({"from": e["start"], "to": e["end"], "kind": e["type"],
                             "player": e["player"]})
        team = ev["team"]
        scorer = ev["player"]
        facts = {
            "scorer": self.s.name(scorer),
            "assist": self.s.name(ev["assist"]) if ev.get("assist") else None,
            "xg": shot["xg"],
            "shot_speed_kmh": shot["speed_kmh"],
            "shot_distance_m": shot["distance_m"],
            "body_part": shot["body_part"],
            "buildup_passes": len(passes),
            "buildup_seconds": round(shot["t"] - first["t"], 1),
            "possession_won_by": first["type"] if first["type"] in ("interception", "tackle") else None,
            "won_in_opponent_half": won_high,
            "scorer_goals_today": int(self.s.player[scorer]["goals"]),
            "team_xg_total": round(self.s.team[team]["xg"], 2),
            "opponent_players_on_pitch": self.s.men["away" if team == "home" else "home"],
        }
        title = f"{self.s.name(scorer)} scores"
        self._fire("goal", team, title, ev, [scorer] + ([ev["assist"]] if ev.get("assist") else []),
                   facts, [e["id"] for e in chain] + [ev["id"]],
                   {"buildup": path, "shot": {"from": shot["start"], "to": shot["end"]},
                    "shot_frame": shot.get("frame", {})})
        if self.s.player[scorer]["goals"] == 2:
            self._fire("milestone", team, f"Brace for {self.s.name(scorer)}", ev, [scorer],
                       {"player": self.s.name(scorer), "milestone": "second goal of the match",
                        "goals": 2}, [ev["id"]], {})

    def _on_shot(self, ev: dict[str, Any]) -> None:
        team = ev["team"]
        if ev["outcome"] != "goal" and ev["xg"] >= 0.2:
            chain = self._possession_chain(ev["possession"], ev["id"])
            self._fire("big_chance", team,
                       f"Big chance for {self.s.name(ev['player'])}", ev, [ev["player"]],
                       {"shooter": self.s.name(ev["player"]), "xg": ev["xg"],
                        "outcome": ev["outcome"], "shot_distance_m": ev["distance_m"],
                        "shot_speed_kmh": ev["speed_kmh"], "pressured": ev["pressured"],
                        "team_xg_total": round(self.s.team[team]["xg"], 2)},
                       [e["id"] for e in chain],
                       {"shot": {"from": ev["start"], "to": ev["end"]},
                        "buildup": [{"from": e["start"], "to": e["end"], "kind": e["type"],
                                     "player": e["player"]}
                                    for e in chain if e["type"] in ("pass", "carry")]},
                       importance=0.6 + ev["xg"] * 0.5)
        if ev["speed_kmh"] >= 110 and self._ok("rocket_shot", team):
            prev = self.s.records.get("shot_speed_kmh", {}).get("previous")
            self._fire("rocket_shot", team, f"{self.s.name(ev['player'])} shoots at {ev['speed_kmh']:.0f} km/h", ev,
                       [ev["player"]],
                       {"shooter": self.s.name(ev["player"]), "shot_speed_kmh": ev["speed_kmh"],
                        "shot_distance_m": ev["distance_m"], "outcome": ev["outcome"],
                        "previous_fastest_kmh": prev},
                       [ev["id"]], {"shot": {"from": ev["start"], "to": ev["end"]}})

    def _on_card(self, ev: dict[str, Any]) -> None:
        if ev["card"] != "red":
            return
        team = ev["team"]
        other = "away" if team == "home" else "home"
        w = self.s.window()
        self._fire("red_card", team, f"{self.s.name(ev['player'])} sent off", ev, [ev["player"]],
                   {"player": self.s.name(ev["player"]),
                    "second_yellow": ev.get("second_yellow", False),
                    "players_left": self.s.men[team],
                    "minutes_remaining": max(0, 90 - ev["minute"]),
                    "team_possession_last5_pct": round(100 * w[team]["possession"], 1),
                    "opponent_possession_last5_pct": round(100 * w[other]["possession"], 1)},
                   [ev["id"]], {})

    def _on_substitution(self, ev: dict[str, Any]) -> None:
        team = ev["team"]
        off = ev["player_off"]
        self._fire("substitution", team,
                   f"{self.s.name(ev['player'])} on for {self.s.name(off)}", ev,
                   [ev["player"], off],
                   {"player_on": self.s.name(ev["player"]), "player_off": self.s.name(off),
                    "player_off_passes": int(self.s.player[off]["passes"]),
                    "player_off_touches": int(self.s.player[off]["touches"])},
                   [ev["id"]], {})

    def _on_formation_change(self, ev: dict[str, Any]) -> None:
        team = ev["team"]
        self._fire("tactical_shift", team,
                   f"{self._team_name(team)} switch to {ev['to']}", ev, [],
                   {"from_formation": ev["from"], "to_formation": ev["to"]},
                   [ev["id"]], {})

    def _on_pass(self, ev: dict[str, Any]) -> None:
        if ev["outcome"] != "complete":
            return
        rec = self.s.records.get("pass_difficulty", {})
        team = ev["team"]
        if ev["difficulty"] >= 75 and rec.get("event_id") == ev["id"] and ev["t"] > 300 \
                and self._ok("hardest_pass", None):
            # explain *why* it was hard using the same components as the rating
            opp = "away" if team == "home" else "home"
            frame = ev.get("frame", {})
            opp_pos = [tuple(v) for k, v in frame.items() if self.s.player_team.get(k) == opp]
            start, end = tuple(ev["start"]), tuple(ev["end"])
            press_m = min((M.dist(start, o) for o in opp_pos), default=None)
            mark_m = min((M.dist(end, o) for o in opp_pos), default=None)
            self._fire("hardest_pass", team,
                       f"Pass of the match by {self.s.name(ev['player'])}", ev,
                       [ev["player"], ev["to"]],
                       {"passer": self.s.name(ev["player"]), "receiver": self.s.name(ev["to"]),
                        "difficulty": ev["difficulty"], "previous_best": rec.get("previous"),
                        "distance_m": ev["distance_m"], "lines_broken": ev["lines_broken"],
                        "nearest_defender_to_passer_m": round(press_m, 1) if press_m else None,
                        "nearest_defender_to_receiver_m": round(mark_m, 1) if mark_m else None,
                        "ball_speed_kmh": ev["ball_speed_kmh"], "pressured": ev["pressured"]},
                       [ev["id"]], {"pass": {"from": ev["start"], "to": ev["end"]}})
        passes = int(self.s.player[ev["player"]]["passes"])
        P = self.s.player[ev["player"]]
        if passes == 50 and P["passes_complete"] / P["passes"] >= 0.85:
            self._fire("milestone", team, f"50 passes for {self.s.name(ev['player'])}", ev,
                       [ev["player"]],
                       {"player": self.s.name(ev["player"]), "milestone": "50 passes",
                        "passes": 50,
                        "pass_accuracy_pct": round(100 * P["passes_complete"] / P["passes"], 1),
                        "progressive_passes": int(P["progressive_passes"])},
                       [ev["id"]], {})

    def _on_sprint(self, ev: dict[str, Any]) -> None:
        rec = self.s.records.get("top_speed_kmh", {})
        if ev["speed_kmh"] >= 33 and rec.get("event_id") == ev["id"] and ev["t"] > 300 \
                and self._ok("speed_burst", None):
            pos = ev["frame"].get(ev["player"], ev["ball"])
            self._fire("speed_burst", ev["team"], f"{self.s.name(ev['player'])} hits {ev['speed_kmh']} km/h", ev,
                       [ev["player"]],
                       {"player": self.s.name(ev["player"]), "speed_kmh": ev["speed_kmh"],
                        "sprint_distance_m": ev["distance_m"],
                        "previous_match_top_kmh": rec.get("previous"),
                        "player_sprints_today": int(self.s.player[ev["player"]]["sprints"])},
                       [ev["id"]], {"runner": pos})

    # ------------------------------------------------- minute-level patterns
    def _on_minute(self, ev: dict[str, Any]) -> None:
        s = self.s
        if s.t < 8 * 60:
            return
        w = s.window()
        # Press surge: a team's pressures in the last 5 min far above its own average
        for side in ("home", "away"):
            base = s.pressure_baseline(side)
            now = w[side]["pressures"]
            if base and now >= 1.45 * base and now >= base + 6 and self._ok("press_surge", side):
                other = "away" if side == "home" else "home"
                self._fire("press_surge", side, f"{s.team_name(side)} turn up the press", ev, [],
                           {"pressures_last5": now, "pressures_avg_per5": round(base, 1),
                            "ratio": round(now / base, 2),
                            "turnovers_won_last5": w[side]["turnovers_won"],
                            "high_turnovers_last5": w[side]["high_turnovers"],
                            "opponent_pass_count_last5": w[other]["passes"],
                            "possession_last5_pct": round(100 * w[side]["possession"], 1)},
                           [], {"press_zone": _press_zone(ev.get("frame", {}), s, side)})
        # Momentum swing: dominance flips decisively compared with 5 minutes ago
        if len(s.pulse) >= 6:
            now_p, then_p = s.pulse[-1], s.pulse[-6]
            delta = now_p.dominance - then_p.dominance
            if abs(delta) >= 0.45 and (now_p.dominance * then_p.dominance < 0
                                       or abs(now_p.dominance) > 0.35):
                side = "home" if delta > 0 else "away"
                if self._ok("momentum_swing", None):
                    self._last_fired[("momentum_swing", None)] = s.t
                    self._fire("momentum_swing", side, f"Momentum swings to {s.team_name(side)}",
                               ev, [],
                               {"dominance_now": now_p.dominance,
                                "dominance_5min_ago": then_p.dominance,
                                "possession_last5_pct": round(100 * w[side]["possession"], 1),
                                "field_tilt_last5_pct": round(100 * w[side]["field_tilt"], 1),
                                "shots_last5": w[side]["shots"], "xg_last5": w[side]["xg"]},
                               [], {})
        # Chaos spike: tempo jumps into 'chaotic'
        label = s.pulse[-1].label if s.pulse else "contested"
        if label == "chaotic" and self._last_label != "chaotic" and self._ok("chaos_spike", None):
            self._last_fired[("chaos_spike", None)] = s.t
            self._fire("chaos_spike", None, "The game breaks open", ev, [],
                       {"chaos_index": s.pulse[-1].chaos,
                        "turnovers_per_min_last5": w["turnovers_per_min"],
                        "shots_per_min_last5": w["shots_per_min"],
                        "shots_last5_home": w["home"]["shots"],
                        "shots_last5_away": w["away"]["shots"]},
                       [], {})
        self._last_label = label


def _press_zone(frame: dict[str, list[float]], s: MatchState, side: str) -> dict[str, Any]:
    """Bounding box of the pressing team's outfield players (for a shaded zone)."""
    pts = [v for k, v in frame.items() if s.player_team.get(k) == side]
    if not pts:
        return {}
    xs = sorted(p[0] for p in pts)[1:]  # drop the goalkeeper-ish extreme
    ys = [p[1] for p in pts]
    return {"x_min": round(min(xs), 1), "x_max": round(max(xs), 1),
            "y_min": round(min(ys), 1), "y_max": round(max(ys), 1),
            "attack_dir": DIR[side]}


def analyse(events: list[dict[str, Any]]) -> tuple[MatchState, MomentDetector]:
    """Run the whole Interpret + Spot pipeline over a list of events."""
    state = MatchState()
    det = MomentDetector(state)
    for ev in events:
        state.apply(ev)
        det.process(ev)
    return state, det
