"""Match data as of any moment: the single source of truth behind CHALK's tools.

Every query takes a time cutoff and only sees events up to it, so a viewer who is
watching the 30th minute can never be told what happens in the 80th. Used by the
MCP server (chalk/mcp_server.py) and by the Studio Q&A agent.
"""

from __future__ import annotations

import difflib
import json
import unicodedata
from functools import lru_cache
from typing import Any

from .agents.config import ROOT
from .sim.engine import MatchSimulator
from .stats.moments import MomentDetector
from .stats.state import MatchState

DATA = ROOT / "data"
STATS = ("goals", "shots", "xg", "passes", "pass_accuracy_pct", "key_passes", "tackles", "interceptions",
         "pressures", "top_speed_kmh", "sprints", "touches", "assists", "progressive_passes")


@lru_cache(maxsize=8)
def _events(seed: int) -> tuple[dict[str, Any], ...]:
    path = DATA / f"match_{seed}.jsonl"
    if path.exists():
        return tuple(json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
    return tuple(MatchSimulator(seed=seed).run())


@lru_cache(maxsize=8)
def _insights(seed: int) -> dict[str, Any]:
    path = DATA / f"match_{seed}_insights.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"cards": []}


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c))


class MatchView:
    """The match up to a cutoff time (seconds since kick-off)."""

    def __init__(self, seed: int = 4, cutoff_t: float | None = None):
        self.seed = seed
        events = _events(seed)
        self.end_t = events[-1]["t"]
        self.cutoff = self.end_t if cutoff_t is None else max(0.0, min(float(cutoff_t), self.end_t))
        self.state = MatchState()
        self.det = MomentDetector(self.state)
        for ev in events:
            if ev["t"] > self.cutoff:
                break
            self.state.apply(ev)
            self.det.process(ev)
        self.start = events[0]
        self.names = {"home": self.start["home"]["name"], "away": self.start["away"]["name"]}

    # ---------------------------------------------------------------- helpers
    def _team_key(self, team: str | None) -> str | None:
        if not team:
            return None
        t = _fold(team)
        for side, name in self.names.items():
            if t in (side, _fold(name), _fold(self.start[side]["short"])) or t in _fold(name):
                return side
        return None

    def find_player(self, query: str) -> str | None:
        """Find a player by name, surname, shirt number ('9') or 'Ashvale 9'."""
        q = _fold(str(query)).strip()
        if not q:
            return None
        side = None
        for s, name in self.names.items():
            for token in (_fold(name), _fold(name.split()[0]), _fold(self.start[s]["short"])):
                if token in q:
                    side, q = s, q.replace(token, "").strip()
        digits = "".join(ch for ch in q if ch.isdigit())
        candidates = [(pid, self.state.names[pid]) for pid in self.state.names
                      if side is None or self.state.player_team.get(pid) == side]
        if digits:
            num = int(digits)
            hits = [pid for pid, _ in candidates
                    if any(p["pid"] == pid and p["number"] == num
                           for s2 in ("home", "away") for p in self.start[s2]["players"] + self.start[s2]["bench"])]
            if len(hits) == 1 or (hits and side):
                return hits[0]
        best, score = None, 0.0
        for pid, name in candidates:
            n = _fold(name)
            s = 1.0 if q == n or q == n.split()[-1] else difflib.SequenceMatcher(None, q, n).ratio()
            if q and q in n:
                s = max(s, 0.9)
            if s > score:
                best, score = pid, s
        return best if score >= 0.55 else None

    # ------------------------------------------------------------------ tools
    def match_status(self) -> dict[str, Any]:
        s = self.state
        pulse = s.pulse[-1] if s.pulse else None
        dom = pulse.dominance if pulse else 0.0
        on_top = "neither team" if abs(dom) < 0.15 else self.names["home" if dom > 0 else "away"]
        h, a = s.score["home"], s.score["away"]
        return {
            "clock": s.clock if s.last_event else "0'",
            "score": f"{self.names['home']} {h}-{a} {self.names['away']}",
            "leading_team": "level" if h == a else self.names["home" if h > a else "away"],
            "players_on_pitch": {self.names[k]: s.men[k] for k in ("home", "away")},
            "team_on_top_last_5_minutes": on_top,
            "tempo_last_5_minutes": pulse.label if pulse else "not enough data yet",
            "latest_moments": [f"{m.clock} {m.title}" for m in self.det.moments[-4:]],
            "match_over": self.cutoff >= self.end_t,
        }

    def team_stats(self, team: str | None = None) -> dict[str, Any]:
        sides = [self._team_key(team)] if self._team_key(team) else ["home", "away"]
        return {"clock": self.state.clock,
                "teams": {self.names[s]: self.state.team_summary(s) for s in sides}}

    def player_stats(self, player: str) -> dict[str, Any]:
        pid = self.find_player(player)
        if not pid:
            return {"error": f"no player matches '{player}'",
                    "players": sorted(self.state.names[p] for p in self.state.names)}
        out = self.state.player_summary(pid)
        out.pop("id", None)
        out["team"] = self.names[out["team"]]
        pos = next(p for s in ("home", "away") for p in self.start[s]["players"] + self.start[s]["bench"]
                   if p["pid"] == pid)
        out.update({"position": pos["position"], "shirt_number": pos["number"], "clock": self.state.clock})
        return out

    def top_players(self, stat: str = "goals", team: str | None = None, limit: int = 3) -> dict[str, Any]:
        stat = stat if stat in STATS else "goals"
        side = self._team_key(team)
        rows = []
        for pid in self.state.names:
            if side and self.state.player_team.get(pid) != side:
                continue
            ps = self.state.player_summary(pid)
            if not ps["touches"] or ps[stat] in (None, 0):
                continue
            if stat == "pass_accuracy_pct" and ps["passes"] < 20:
                continue
            rows.append({"player": ps["name"], "team": self.names[ps["team"]], stat: ps[stat]})
        rows.sort(key=lambda r: -r[stat])
        return {"clock": self.state.clock, "stat": stat, "leaders": rows[:max(1, min(limit, 10))]}

    def key_moments(self, kind: str | None = None, limit: int = 10) -> dict[str, Any]:
        ms = [m for m in self.det.moments if not kind or m.type == kind or kind in m.type]
        return {"clock": self.state.clock,
                "moments": [{"id": m.id, "clock": m.clock, "type": m.type, "title": m.title,
                             "team": self.names.get(m.team or "", None)} for m in ms[-max(1, min(limit, 40)):]]}

    def moment_details(self, moment: str) -> dict[str, Any]:
        """A moment by id ('m006') or minute ("26'"), with the crew's aired analysis if any."""
        q = str(moment).strip().rstrip("'")
        pick = next((m for m in self.det.moments if m.id == moment or m.clock.rstrip("'") == q), None)
        if pick is None:
            return {"error": f"no moment '{moment}' up to {self.state.clock}"}
        out = {"id": pick.id, "clock": pick.clock, "type": pick.type, "title": pick.title,
               "team": self.names.get(pick.team or "", None), "facts": pick.facts}
        card = next((c for c in _insights(self.seed).get("cards", [])
                     if c["moment_id"] == pick.id and c.get("on_air_t", 1e9) <= self.cutoff), None)
        if card:
            out["studio_analysis"] = {"headline": card.get("headline"), "story": card.get("story"),
                                      "var_verdict": (card.get("var") or {}).get("final")}
        return out

    def match_flow(self, last_minutes: int = 30) -> dict[str, Any]:
        """Who was on top, five minutes at a time."""
        pts = [p for p in self.state.pulse if p.t >= self.cutoff - last_minutes * 60]
        chunks = []
        for i in range(0, len(pts), 5):
            grp = pts[i:i + 5]
            if not grp:
                continue
            dom = sum(p.dominance for p in grp) / len(grp)
            chunks.append({
                "minutes": f"{grp[0].minute}'" if grp[0].minute == grp[-1].minute else f"{grp[0].minute}'-{grp[-1].minute}'",
                "on_top": "neither team" if abs(dom) < 0.15 else self.names["home" if dom > 0 else "away"],
                "tempo": max(("controlled", "contested", "chaotic"), key=lambda l: sum(p.label == l for p in grp)),
            })
        return {"clock": self.state.clock, "flow": chunks}


TOOL_DOCS = {
    "match_status": "Score, clock, who has more players, which team is on top over the last 5 minutes and the latest key moments.",
    "team_stats": "Team statistics so far (possession, shots, shots on target, xG, passes, pass accuracy, pressures, tackles, interceptions, PPDA, cards, formation). Optional team name.",
    "player_stats": "One player's statistics so far. Accepts a name, a surname or a shirt number with the club (e.g. 'Mensah-Cole' or 'Ashvale 9').",
    "top_players": f"Leaderboard for one stat so far. stat is one of: {', '.join(STATS)}. Optional team, limit.",
    "key_moments": "The key moments so far (goals, red cards, press surges, momentum swings...). Optional kind filter such as 'goal' or 'red_card'.",
    "moment_details": "Facts behind one moment, by id (m006) or minute (26'), plus the studio's verified analysis if it has aired.",
    "match_flow": "Who was on top, five minutes at a time, over the last N minutes.",
}
