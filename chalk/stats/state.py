"""Interpret stage: turn the raw event stream into football statistics.

`MatchState.apply(event)` is called once per event, in order, exactly as a
live feed would deliver them. Everything here is deterministic code: the AI
agents never compute numbers, they only read the facts produced here.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from . import metrics as M

DIR = {"home": 1, "away": -1}
ON_BALL = {"pass", "carry", "take_on", "shot", "kickoff", "throw_in", "goal_kick", "free_kick"}
TURNOVER_TYPES = {"interception", "tackle"}
WINDOW_S = 300  # rolling window for "right now" stats


def _team_blank() -> dict[str, float]:
    return defaultdict(float)


def _player_blank() -> dict[str, float]:
    return defaultdict(float)


@dataclass
class PulsePoint:
    minute: int
    t: float
    dominance: float  # -1 (away on top) .. +1 (home on top)
    chaos: float  # 1.0 = this match's normal tempo
    label: str  # controlled | contested | chaotic


@dataclass
class MatchState:
    meta: dict[str, Any] = field(default_factory=dict)
    names: dict[str, str] = field(default_factory=dict)  # pid -> full name
    short: dict[str, str] = field(default_factory=dict)
    player_team: dict[str, str] = field(default_factory=dict)
    team: dict[str, dict[str, float]] = field(
        default_factory=lambda: {"home": _team_blank(), "away": _team_blank()})
    player: dict[str, dict[str, float]] = field(default_factory=lambda: defaultdict(_player_blank))
    score: dict[str, int] = field(default_factory=lambda: {"home": 0, "away": 0})
    formation: dict[str, str] = field(default_factory=dict)
    men: dict[str, int] = field(default_factory=lambda: {"home": 11, "away": 11})
    t: float = 0.0
    minute: int = 0
    clock: str = "0'"
    in_possession: str | None = None
    last_event: dict[str, Any] | None = None
    recent: list[dict[str, Any]] = field(default_factory=list)  # light copies, rolling
    pulse: list[PulsePoint] = field(default_factory=list)
    records: dict[str, Any] = field(default_factory=dict)  # match records so far
    _chaos_samples: list[float] = field(default_factory=list)
    _pressure_by_5: dict[str, list[int]] = field(
        default_factory=lambda: {"home": [], "away": []})

    # ------------------------------------------------------------- utilities
    def name(self, pid: str | None) -> str:
        return self.names.get(pid or "", pid or "?")

    def team_name(self, team: str) -> str:
        return self.meta.get(team, {}).get("name", team)

    # ----------------------------------------------------------------- apply
    def apply(self, ev: dict[str, Any]) -> None:
        etype = ev["type"]
        if etype == "match_start":
            self._start(ev)
        dt = max(0.0, ev["t"] - self.t)
        if self.in_possession and etype not in ("goal", "period_end"):
            self.team[self.in_possession]["possession_s"] += dt
        self.t, self.minute, self.clock = ev["t"], ev["minute"], ev["clock"]
        team, pid = ev.get("team"), ev.get("player")
        T = self.team.get(team) if team else None
        P = self.player[pid] if pid else None

        if etype in ON_BALL and team:
            self.in_possession = team
            if P is not None:
                P["touches"] += 1

        if etype == "pass" and T is not None and P is not None:
            self._pass(ev, T, P)
        elif etype == "carry" and P is not None:
            P["carry_m"] += ev["distance_m"]
        elif etype == "sprint" and P is not None:
            P["sprints"] += 1
            if ev["speed_kmh"] > P["top_speed_kmh"]:
                P["top_speed_kmh"] = ev["speed_kmh"]
            self._record_max("top_speed_kmh", ev["speed_kmh"], ev)
        elif etype == "shot" and T is not None and P is not None:
            T["shots"] += 1
            T["xg"] += ev["xg"]
            P["shots"] += 1
            P["xg"] += ev["xg"]
            if ev["outcome"] in ("goal", "saved"):
                T["shots_on_target"] += 1
                P["shots_on_target"] += 1
            if ev["xg"] >= 0.2:
                T["big_chances"] += 1
            P["max_shot_speed_kmh"] = max(P["max_shot_speed_kmh"], ev["speed_kmh"])
            self._record_max("shot_speed_kmh", ev["speed_kmh"], ev)
            if ev.get("assist"):
                self.player[ev["assist"]]["key_passes"] += 1
        elif etype == "goal" and T is not None and P is not None:
            self.score[team] += 1
            T["goals"] += 1
            P["goals"] += 1
            if ev.get("assist"):
                self.player[ev["assist"]]["assists"] += 1
        elif etype in ("tackle", "interception") and T is not None and P is not None:
            key = "tackles" if etype == "tackle" else "interceptions"
            T[key] += 1
            P[key] += 1
            T["turnovers_won"] += 1
            other = "away" if team == "home" else "home"
            self.team[other]["turnovers_lost"] += 1
            if self._in_opp_half(ev["ball"], team):
                T["high_turnovers"] += 1
            if self._in_ppda_zone(ev["ball"], team):
                T["ppda_def_actions"] += 1
        elif etype == "pressure" and T is not None and P is not None:
            T["pressures"] += 1
            P["pressures"] += 1
        elif etype == "foul" and T is not None and P is not None:
            T["fouls"] += 1
            P["fouls"] += 1
            if self._in_ppda_zone(ev["ball"], team):
                T["ppda_def_actions"] += 1
        elif etype == "card" and T is not None and P is not None:
            T[ev["card"]] += 1
            P[ev["card"]] += 1
            if ev["card"] == "red":
                self.men[team] -= 1
        elif etype == "save" and T is not None and P is not None:
            P["saves"] += 1
            T["saves"] += 1
        elif etype == "substitution":
            T["subs"] += 1
        elif etype == "formation_change":
            self.formation[team] = ev["to"]
        elif etype == "take_on" and P is not None:
            P["take_ons"] += 1
            P["take_ons_won"] += 1 if ev["won"] else 0

        light = {k: ev[k] for k in ("id", "t", "minute", "type", "team", "player", "outcome",
                                    "xg", "ball", "difficulty", "possession") if k in ev}
        self.recent.append(light)
        while self.recent and self.recent[0]["t"] < self.t - 2 * WINDOW_S:
            self.recent.pop(0)
        self.last_event = ev
        self._maybe_pulse()

    def _start(self, ev: dict[str, Any]) -> None:
        for side in ("home", "away"):
            info = ev[side]
            self.meta[side] = {"name": info["name"], "short": info["short"],
                               "color": info["color"]}
            self.formation[side] = info["formation"]
            for p in info["players"] + info["bench"]:
                self.names[p["pid"]] = p["name"]
                self.short[p["pid"]] = p["short"]
                self.player_team[p["pid"]] = side
        self.meta["venue"] = ev.get("venue")
        self.meta["match_id"] = ev.get("match_id")

    def _pass(self, ev: dict[str, Any], T: dict[str, float], P: dict[str, float]) -> None:
        team = ev["team"]
        T["passes"] += 1
        P["passes"] += 1
        P["pass_m"] += ev["distance_m"]
        other = "away" if team == "home" else "home"
        # PPDA: passes the opponent allows us in our build-up zone (their pressing zone)
        if self._in_ppda_zone(ev["start"], other):
            T["passes_in_own_buildup"] += 1
        if ev["outcome"] == "complete":
            T["passes_complete"] += 1
            P["passes_complete"] += 1
            if ev["progressive"]:
                T["progressive_passes"] += 1
                P["progressive_passes"] += 1
            if M.in_final_third(tuple(ev["end"]), DIR[team]):
                T["final_third_passes"] += 1
            if ev["difficulty"] > P["hardest_pass"]:
                P["hardest_pass"] = ev["difficulty"]
            self._record_max("pass_difficulty", ev["difficulty"], ev)
            self._record_max("pass_distance_m", ev["distance_m"], ev)
        else:
            T["turnovers_lost"] += 0  # counted when the opponent's interception arrives
        if ev["outcome"] == "out":
            T["turnovers_lost"] += 1

    def _record_max(self, key: str, value: float, ev: dict[str, Any], P_key: Any = None) -> None:
        cur = self.records.get(key)
        if cur is None or value > cur["value"]:
            self.records[key] = {"value": value, "player": ev.get("player"),
                                 "team": ev.get("team"), "minute": ev["minute"],
                                 "event_id": ev["id"], "previous": cur["value"] if cur else None}

    @staticmethod
    def _in_opp_half(ball: list[float], team: str) -> bool:
        return ball[0] > 52.5 if DIR[team] > 0 else ball[0] < 52.5

    @staticmethod
    def _in_ppda_zone(ball: list[float], team: str) -> bool:
        """Defensive actions by `team` in the opponent's first 60% of the pitch."""
        return ball[0] > 42 if DIR[team] > 0 else ball[0] < 63

    # ---------------------------------------------------------------- windows
    def window(self, seconds: float = WINDOW_S, end_t: float | None = None) -> dict[str, Any]:
        end_t = self.t if end_t is None else end_t
        start = end_t - seconds
        evs = [e for e in self.recent if start < e["t"] <= end_t]
        out: dict[str, Any] = {}
        poss = {"home": 0.0, "away": 0.0}
        last_t, last_team = None, None
        for e in evs:
            if last_t is not None and last_team:
                poss[last_team] += e["t"] - last_t
            if e["type"] in ON_BALL and e.get("team"):
                last_team = e["team"]
            last_t = e["t"]
        total_poss = sum(poss.values()) or 1.0
        for side in ("home", "away"):
            mine = [e for e in evs if e.get("team") == side]
            passes = [e for e in mine if e["type"] == "pass"]
            ft = [e for e in passes if e.get("outcome") == "complete"
                  and M.in_final_third(tuple(e["ball"]), DIR[side])]
            out[side] = {
                "possession": round(poss[side] / total_poss, 3),
                "passes": len(passes),
                "final_third_passes": len(ft),
                "shots": sum(e["type"] == "shot" for e in mine),
                "xg": round(sum(e.get("xg", 0) for e in mine if e["type"] == "shot"), 2),
                "pressures": sum(e["type"] == "pressure" for e in mine),
                "turnovers_won": sum(e["type"] in TURNOVER_TYPES for e in mine),
                "high_turnovers": sum(e["type"] in TURNOVER_TYPES
                                      and self._in_opp_half(e["ball"], side) for e in mine),
                "fouls": sum(e["type"] == "foul" for e in mine),
            }
        ft_total = out["home"]["final_third_passes"] + out["away"]["final_third_passes"]
        for side in ("home", "away"):
            out[side]["field_tilt"] = round(out[side]["final_third_passes"] / ft_total, 3) \
                if ft_total else 0.5
        minutes = max(seconds / 60, 1e-6)
        turnovers = sum(e["type"] in TURNOVER_TYPES or (e["type"] == "pass"
                                                        and e.get("outcome") == "out")
                        for e in evs)
        out["turnovers_per_min"] = round(turnovers / minutes, 2)
        out["shots_per_min"] = round(sum(e["type"] == "shot" for e in evs) / minutes, 2)
        return out

    def ppda(self, side: str) -> float | None:
        other = "away" if side == "home" else "home"
        acts = self.team[side]["ppda_def_actions"]
        if acts == 0:
            return None
        return round(self.team[other]["passes_in_own_buildup"] / acts, 1)

    # ------------------------------------------------------------ match pulse
    def _maybe_pulse(self) -> None:
        if self.last_event is None or self.last_event["type"] == "match_start":
            return
        minute_mark = int(self.t // 60)
        if self.pulse and int(self.pulse[-1].t // 60) == minute_mark:
            return
        if self.t < 120:
            return
        w = self.window()
        poss_h = w["home"]["possession"]
        tilt_h = w["home"]["field_tilt"]
        dominance = round(0.5 * (poss_h * 2 - 1) + 0.5 * (tilt_h * 2 - 1), 3)
        raw = w["turnovers_per_min"] + 2 * w["shots_per_min"]
        self._chaos_samples.append(raw)
        baseline = statistics.median(self._chaos_samples) if len(self._chaos_samples) >= 5 else 2.2
        chaos = round(raw / baseline, 2) if baseline else 1.0
        label = "chaotic" if chaos >= 1.3 else "controlled" if chaos <= 0.75 else "contested"
        self.pulse.append(PulsePoint(minute=self.minute, t=self.t, dominance=dominance,
                                     chaos=chaos, label=label))
        if minute_mark % 5 == 0:
            for side in ("home", "away"):
                self._pressure_by_5[side].append(w[side]["pressures"])

    def pressure_baseline(self, side: str) -> float | None:
        samples = self._pressure_by_5[side]
        if len(samples) < 2:
            return None
        return statistics.mean(samples)

    # ------------------------------------------------------------- summaries
    def team_summary(self, side: str) -> dict[str, Any]:
        T = self.team[side]
        total_poss = self.team["home"]["possession_s"] + self.team["away"]["possession_s"]
        return {
            "name": self.team_name(side),
            "goals": self.score[side],
            "possession_pct": round(100 * T["possession_s"] / total_poss, 1) if total_poss else 50.0,
            "passes": int(T["passes"]),
            "pass_accuracy_pct": round(100 * T["passes_complete"] / T["passes"], 1)
            if T["passes"] else 0.0,
            "progressive_passes": int(T["progressive_passes"]),
            "shots": int(T["shots"]),
            "shots_on_target": int(T["shots_on_target"]),
            "xg": round(T["xg"], 2),
            "big_chances": int(T["big_chances"]),
            "pressures": int(T["pressures"]),
            "tackles": int(T["tackles"]),
            "interceptions": int(T["interceptions"]),
            "high_turnovers": int(T["high_turnovers"]),
            "ppda": self.ppda(side),
            "fouls": int(T["fouls"]),
            "yellow_cards": int(T["yellow"]),
            "red_cards": int(T["red"]),
            "players_on_pitch": self.men[side],
            "formation": self.formation.get(side),
        }

    def player_summary(self, pid: str) -> dict[str, Any]:
        P = self.player[pid]
        passes = int(P["passes"])
        return {
            "id": pid,
            "name": self.name(pid),
            "team": self.player_team.get(pid),
            "touches": int(P["touches"]),
            "passes": passes,
            "pass_accuracy_pct": round(100 * P["passes_complete"] / passes, 1) if passes else None,
            "progressive_passes": int(P["progressive_passes"]),
            "key_passes": int(P["key_passes"]),
            "hardest_pass_difficulty": int(P["hardest_pass"]),
            "shots": int(P["shots"]),
            "xg": round(P["xg"], 2),
            "goals": int(P["goals"]),
            "assists": int(P["assists"]),
            "tackles": int(P["tackles"]),
            "interceptions": int(P["interceptions"]),
            "pressures": int(P["pressures"]),
            "sprints": int(P["sprints"]),
            "top_speed_kmh": round(P["top_speed_kmh"], 1),
            "max_shot_speed_kmh": round(P["max_shot_speed_kmh"], 1),
        }

    def snapshot(self) -> dict[str, Any]:
        """Everything a renderer or agent needs about the match right now."""
        return {
            "clock": self.clock,
            "minute": self.minute,
            "score": dict(self.score),
            "teams": {s: self.team_summary(s) for s in ("home", "away")},
            "pulse": vars(self.pulse[-1]) if self.pulse else None,
            "records": self.records,
        }
