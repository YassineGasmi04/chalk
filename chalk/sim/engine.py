"""Seeded synthetic football match simulator.

Produces a football-realistic event stream (passes, carries, take-ons,
pressures, tackles, interceptions, shots, saves, fouls, cards, substitutions,
formation changes) with a 22-player position snapshot on every event.

Storylines come from a *script* of tactical beats (e.g. "home team starts a
high press at 15'"). Coaching intentions are NOT written into the event
stream: the analysis layer has to discover them from the data, and the
script is kept separately as ground truth for testing.

Coordinates: 105 x 68 m pitch. Home always attacks towards x = 105 and away
towards x = 0 (directions are normalised, so sides do not swap at half time).
"""

from __future__ import annotations

import copy
import math
import random
from dataclasses import dataclass
from typing import Any, Iterator

from ..stats import metrics as M
from .teams import FORMATIONS, Player, Team, default_teams

FIRST_HALF_S = 45 * 60
ATTACKING_ROLES = {"ST", "LW", "RW", "CAM", "RAM", "LAM"}

# Default storyline used for the demo match. Ground truth for the detectors.
DEFAULT_SCRIPT: list[dict[str, Any]] = [
    {"at": 15, "kind": "tactic", "team": "home", "press": 0.9, "line_height": 0.75,
     "label": "Ashvale switch on a high press"},
    {"at": 24, "kind": "force_goal", "team": "home", "label": "Press pays off"},
    {"at": 30, "kind": "tactic", "team": "home", "press": 0.45, "line_height": 0.55,
     "label": "Ashvale drop back to a mid block"},
    {"at": 30, "kind": "tactic", "team": "away", "directness": 0.8, "line_height": 0.3,
     "label": "Kestrel go low block + direct counters"},
    {"at": 38, "kind": "force_goal", "team": "away", "label": "Counter-attack equaliser"},
    {"at": 46, "kind": "tactic", "team": "away", "directness": 0.55, "line_height": 0.45,
     "label": "Kestrel back to normal shape"},
    {"at": 61, "kind": "sub", "team": "away", "off": "a8", "on": "a19",
     "label": "Nkemelu on for Ferreira-Lind"},
    {"at": 65, "kind": "formation", "team": "away", "to": "4-2-3-1",
     "label": "Kestrel switch to 4-2-3-1"},
    {"at": 65, "kind": "tactic", "team": "away", "press": 0.75,
     "label": "Kestrel press higher on the right"},
    {"at": 70, "kind": "force_goal", "team": "away", "label": "Kestrel take the lead"},
    {"at": 76, "kind": "red_card", "team": "away", "label": "Kestrel down to ten"},
    {"at": 77, "kind": "sub", "team": "home", "off": "h6", "on": "h17",
     "label": "El Mansouri on to chase the game"},
    {"at": 72, "kind": "sub", "team": "away", "off": "a11", "on": "a18",
     "label": "Ferraz on for Moreau-Vance, like for like"},
    {"at": 78, "kind": "tactic", "team": "home", "press": 0.8, "directness": 0.55,
     "label": "Ashvale throw everything forward"},
    {"at": 82, "kind": "formation", "team": "home", "to": "4-4-2",
     "label": "Ashvale go two up front"},
    {"at": 83, "kind": "sub", "team": "away", "off": "a7", "on": "a16",
     "label": "Aalto on to protect the lead"},
    {"at": 87, "kind": "sub", "team": "home", "off": "h11", "on": "h19",
     "label": "Strand on for Dufay, fresh legs"},
    {"at": 86, "kind": "force_goal", "team": "home", "label": "Late equaliser"},
]


@dataclass
class _OnPitch:
    player: Player
    role: str
    anchor: tuple[float, float]  # attacking-right frame
    pos: tuple[float, float]  # absolute
    yellow: int = 0
    active: bool = True


class MatchSimulator:
    def __init__(self, seed: int = 7, home: Team | None = None, away: Team | None = None,
                 script: list[dict[str, Any]] | None = None, match_id: str | None = None):
        self.seed = seed
        self.rng = random.Random(seed)
        if home is None or away is None:
            home, away = default_teams()
        self.teams = {"home": copy.deepcopy(home), "away": copy.deepcopy(away)}
        self.script = sorted(copy.deepcopy(script if script is not None else DEFAULT_SCRIPT),
                             key=lambda b: b["at"])
        self.match_id = match_id or f"synthetic-{seed}"
        self.dir = {"home": 1, "away": -1}
        self.events: list[dict[str, Any]] = []
        self.score = {"home": 0, "away": 0}
        self.t = 0.0  # monotonic seconds since kick-off (both halves)
        self.period = 1
        self.period_start_t = 0.0
        self.possession_id = 0
        self.pending_goal: dict[str, bool] = {"home": False, "away": False}
        self.pending_red: dict[str, bool] = {"home": False, "away": False}
        self.on_pitch: dict[str, list[_OnPitch]] = {}
        for k, team in self.teams.items():
            shape = FORMATIONS[team.formation]
            self.on_pitch[k] = [
                _OnPitch(player=p, role=shape[i][0], anchor=(shape[i][1], shape[i][2]),
                         pos=(0.0, 0.0))
                for i, p in enumerate(team.starters)
            ]
        self.ball = (52.5, 34.0)
        self.carrier: _OnPitch | None = None
        self.attacking: str = "home"

    # ------------------------------------------------------------------ helpers
    def _reg_minute(self) -> float:
        """Regulation minute (0-90) used for script timing; frozen in stoppage."""
        el = (self.t - self.period_start_t) / 60
        return min(el, 45.0) + (0 if self.period == 1 else 45.0)

    def _clock(self) -> tuple[int, str]:
        el = (self.t - self.period_start_t) / 60
        base = 0 if self.period == 1 else 45
        if el < 45:
            m = base + int(el) + 1
            return m, f"{m}'"
        extra = int(el - 45) + 1
        return base + 45, f"{base + 45}+{extra}'"

    def _active(self, team: str) -> list[_OnPitch]:
        return [p for p in self.on_pitch[team] if p.active]

    def _other(self, team: str) -> str:
        return "away" if team == "home" else "home"

    def _team_of(self, op: _OnPitch) -> str:
        return "home" if op in self.on_pitch["home"] else "away"

    def _find(self, pid: str) -> _OnPitch | None:
        for team in ("home", "away"):
            for op in self.on_pitch[team]:
                if op.player.pid == pid:
                    return op
        return None

    def _gk(self, team: str) -> _OnPitch:
        return next(p for p in self._active(team) if p.role == "GK")

    def _nearest(self, team: str, point: tuple[float, float],
                 exclude_gk: bool = False) -> tuple[_OnPitch, float]:
        best, bd = None, 1e9
        for op in self._active(team):
            if exclude_gk and op.role == "GK":
                continue
            d = M.dist(op.pos, point)
            if d < bd:
                best, bd = op, d
        assert best is not None
        return best, bd

    # --------------------------------------------------------------- positions
    def _update_positions(self, snap: bool = False) -> None:
        bx, by = self.ball
        for team in ("home", "away"):
            t = self.teams[team]
            d = self.dir[team]
            in_poss = team == self.attacking
            rel_bx = bx if d > 0 else M.PITCH_L - bx
            rel_by = by if d > 0 else M.PITCH_W - by
            shift = (rel_bx - 52.5) * 0.55 + (t.line_height - 0.5) * 16
            shift += 9 if in_poss else -3 + (t.press - 0.45) * 18
            n_active = len(self._active(team))
            for op in self._active(team):
                ax, ay = op.anchor
                if op.role == "GK":
                    tx = 4 + max(0.0, (rel_bx - 30) * 0.12)
                    ty = 34 + (rel_by - 34) * 0.15
                else:
                    tx = ax + shift
                    if in_poss and op.role in ATTACKING_ROLES:
                        # forwards attack the box when the ball reaches the final third
                        tx += max(0.0, rel_bx - 55) * 0.5
                    spread = 1.0 if in_poss else 0.82
                    if n_active < 11 and not in_poss:
                        tx -= 3  # down to ten men: sit a bit deeper
                    ty = 34 + (ay - 34) * spread + (rel_by - 34) * 0.3
                    tx += self.rng.gauss(0, 1.6)
                    ty += self.rng.gauss(0, 1.6)
                tx = min(max(tx, 1.0), 104.0)
                ty = min(max(ty, 1.0), 67.0)
                target = (tx, ty) if d > 0 else (M.PITCH_L - tx, M.PITCH_W - ty)
                if snap or op.pos == (0.0, 0.0):
                    op.pos = target
                else:
                    op.pos = (op.pos[0] * 0.45 + target[0] * 0.55,
                              op.pos[1] * 0.45 + target[1] * 0.55)
        if self.carrier is not None:
            self.carrier.pos = self.ball

    def _snapshot(self) -> dict[str, list[float]]:
        out = {}
        for team in ("home", "away"):
            for op in self._active(team):
                out[op.player.pid] = [round(op.pos[0], 1), round(op.pos[1], 1)]
        return out

    # ------------------------------------------------------------------ events
    def _emit(self, etype: str, team: str | None = None, player: str | None = None,
              **data: Any) -> dict[str, Any]:
        minute, clock = self._clock()
        ev: dict[str, Any] = {
            "id": len(self.events),
            "match_id": self.match_id,
            "t": round(self.t, 1),
            "period": self.period,
            "minute": minute,
            "clock": clock,
            "type": etype,
        }
        if team is not None:
            ev["team"] = team
        if player is not None:
            ev["player"] = player
        ev["possession"] = self.possession_id
        ev["score"] = dict(self.score)
        ev.update(data)
        ev["ball"] = [round(self.ball[0], 1), round(self.ball[1], 1)]
        ev["frame"] = self._snapshot()
        self.events.append(ev)
        return ev

    def _advance(self, seconds: float) -> None:
        self.t += max(seconds, 0.3)

    def _change_possession(self, new_carrier: _OnPitch) -> None:
        self.carrier = new_carrier
        self.attacking = self._team_of(new_carrier)
        self.possession_id += 1
        self.ball = new_carrier.pos

    # ------------------------------------------------------------------ script
    def _apply_script(self) -> None:
        now = self._reg_minute()
        while self.script and self.script[0]["at"] <= now:
            beat = self.script.pop(0)
            kind = beat["kind"]
            team = beat.get("team")
            t = self.teams[team] if team else None
            if kind == "tactic" and t is not None:
                for k in ("press", "directness", "line_height"):
                    if k in beat:
                        setattr(t, k, beat[k])
            elif kind == "force_goal" and team:
                self.pending_goal[team] = True
            elif kind == "red_card" and team:
                self.pending_red[team] = True
            elif kind == "sub" and t is not None:
                self._substitute(team, beat["off"], beat["on"])
            elif kind == "formation" and t is not None:
                old = t.formation
                t.formation = beat["to"]
                shape = FORMATIONS[t.formation]
                for i, op in enumerate(self.on_pitch[team]):
                    op.role, op.anchor = shape[i][0], (shape[i][1], shape[i][2])
                self._emit("formation_change", team=team, **{"from": old, "to": t.formation})

    def _substitute(self, team: str, off_pid: str, on_pid: str) -> None:
        t = self.teams[team]
        for i, op in enumerate(self.on_pitch[team]):
            if op.player.pid == off_pid and op.active:
                new_p = next(p for p in t.bench if p.pid == on_pid)
                was_carrier = self.carrier is op
                self.on_pitch[team][i] = _OnPitch(player=new_p, role=op.role, anchor=op.anchor,
                                                  pos=op.pos)
                if was_carrier:
                    self.carrier = self.on_pitch[team][i]
                self._advance(25)
                self._emit("substitution", team=team, player=on_pid, player_off=off_pid)
                return

    # -------------------------------------------------------------- kick-offs
    def _kickoff(self, team: str) -> None:
        self.ball = (52.5, 34.0)
        self.attacking = team
        self._update_positions(snap=True)
        st = next((p for p in self._active(team) if p.role in ("ST", "CAM")),
                  self._active(team)[-1])
        self.carrier = st
        st.pos = self.ball
        self.possession_id += 1
        self._emit("kickoff", team=team, player=st.player.pid)

    # ----------------------------------------------------------------- actions
    def _try_pressure(self) -> tuple[bool, float, bool]:
        """Opponent may close down the carrier. Returns (pressured, dist, turnover)."""
        c = self.carrier
        assert c is not None
        team = self.attacking
        opp = self._other(team)
        presser, dn = self._nearest(opp, self.ball, exclude_gk=True)
        press = self.teams[opp].press
        # Pressing is stronger high up the pitch for a high-pressing team
        rel_x = self.ball[0] if self.dir[team] > 0 else M.PITCH_L - self.ball[0]
        zone_boost = 1.0 + (press - 0.45) * (1.6 if rel_x < 50 else 0.6)
        p = press * zone_boost * max(0.0, 1 - dn / 14) + 0.06
        if self.rng.random() > min(p, 0.92):
            return False, dn, False
        # presser closes the gap
        ang = math.atan2(self.ball[1] - presser.pos[1], self.ball[0] - presser.pos[0])
        close = self.rng.uniform(1.0, 2.8)
        presser.pos = (self.ball[0] - math.cos(ang) * close, self.ball[1] - math.sin(ang) * close)
        self._advance(self.rng.uniform(0.6, 1.4))
        self._emit("pressure", team=opp, player=presser.player.pid, on=c.player.pid,
                   distance_m=round(close, 1))
        # Fouls (and scripted red cards) happen out of pressure duels
        foul_p = 0.05 + (0.55 if self.pending_red[opp] and rel_x > 35 else 0)
        if self.rng.random() < foul_p:
            self._foul(presser, c)
            return True, close, False
        # Tackle attempt
        tackle_p = 0.08 + presser.player.defending * 0.12 + (press - 0.45) * 0.15
        if self.rng.random() < tackle_p:
            self._advance(self.rng.uniform(0.5, 1.2))
            self._emit("tackle", team=opp, player=presser.player.pid, on=c.player.pid, won=True)
            self._change_possession(presser)
            return True, close, True
        return True, close, False

    def _foul(self, fouler: _OnPitch, fouled: _OnPitch) -> None:
        opp = self._team_of(fouler)
        self._advance(self.rng.uniform(1, 2))
        self._emit("foul", team=opp, player=fouler.player.pid, on=fouled.player.pid)
        card = None
        if self.pending_red[opp]:
            card, self.pending_red[opp] = "red", False
        elif self.rng.random() < 0.12:
            fouler.yellow += 1
            card = "red" if fouler.yellow >= 2 else "yellow"
        if card:
            self._advance(self.rng.uniform(20, 45))
            self._emit("card", team=opp, player=fouler.player.pid, card=card,
                       second_yellow=card == "red" and fouler.yellow >= 2)
            if card == "red":
                fouler.active = False
        self._advance(self.rng.uniform(12, 25))
        self._emit("free_kick", team=self._team_of(fouled), player=fouled.player.pid)

    def _choose_target(self, pressured: bool) -> tuple[_OnPitch, tuple[float, float], bool]:
        c = self.carrier
        assert c is not None
        team = self.attacking
        t = self.teams[team]
        d = self.dir[team]
        long_ball = self.rng.random() < t.directness * (0.22 if pressured else 0.12)
        best: list[tuple[float, _OnPitch]] = []
        for op in self._active(team):
            if op is c:
                continue
            dd = M.dist(op.pos, self.ball)
            fwd = (op.pos[0] - self.ball[0]) * d
            if long_ball:
                w = max(fwd, 0) ** 1.5 * (1 if dd < 55 else 0.1)
            else:
                w = math.exp(-((dd - 16) / 13) ** 2) * (1 + max(fwd, 0) / 22 * (0.5 + t.directness))
                if fwd < -5:
                    w *= 0.75
            if op.role == "GK":
                w *= 0.4 if pressured else 0.08
            best.append((w + 1e-6, op))
        total = sum(w for w, _ in best)
        r = self.rng.random() * total
        acc = 0.0
        target = best[-1][1]
        for w, op in best:
            acc += w
            if acc >= r:
                target = op
                break
        run = self.rng.uniform(1, 6 if not long_ball else 10)
        # receivers rarely collect the ball right on the goal line
        end = (min(max(target.pos[0] + run * d, 4), 100.5),
               min(max(target.pos[1] + self.rng.gauss(0, 2.5), 1), 67))
        return target, end, long_ball

    def _pass(self, pressured: bool, pressure_m: float) -> None:
        c = self.carrier
        assert c is not None
        team = self.attacking
        opp = self._other(team)
        d = self.dir[team]
        target, end, long_ball = self._choose_target(pressured)
        start = self.ball
        opp_pos = [o.pos for o in self._active(opp)]
        marker, marking_m = self._nearest(opp, end)
        lb = M.lines_broken(start, end, d, opp_pos)
        diff = M.pass_difficulty(start, end, d, pressure_m if pressured else 12.0, marking_m, lb)
        p_ok = 0.985 - diff / 100 * 0.6 + (c.player.passing - 0.7) * 0.2
        p_ok = min(max(p_ok, 0.22), 0.985)
        distance = M.dist(start, end)
        lofted = long_ball or distance > 32
        speed_ms = self.rng.uniform(17, 24) if lofted else self.rng.uniform(11, 17)
        air = distance / speed_ms
        success = self.rng.random() < p_ok
        common = dict(
            start=[round(start[0], 1), round(start[1], 1)],
            end=[round(end[0], 1), round(end[1], 1)],
            distance_m=round(distance, 1),
            difficulty=diff,
            lines_broken=lb,
            pressured=pressured,
            lofted=lofted,
            progressive=M.is_progressive(start, end, d),
            ball_speed_kmh=round(speed_ms * 3.6, 1),
        )
        if success:
            self.ball = end
            target.pos = end
            self._advance(air + self.rng.uniform(1.2, 2.8))
            self._emit("pass", team=team, player=c.player.pid, to=target.player.pid,
                       outcome="complete", **common)
            # Through balls trigger a sprint from the receiver
            if lb >= 2 and common["progressive"] and self.rng.random() < 0.6:
                self._sprint(target)
            self.carrier = target
            return
        # Failed pass: intercepted or out of play
        self._advance(air + self.rng.uniform(0.3, 1.0))
        if self.rng.random() < 0.78:
            interceptor, _ = self._nearest(opp, end)
            self.ball = end
            self._emit("pass", team=team, player=c.player.pid, to=target.player.pid,
                       outcome="intercepted", **common)
            interceptor.pos = end
            self._emit("interception", team=opp, player=interceptor.player.pid)
            self._change_possession(interceptor)
        else:
            ox = min(max(end[0], 0.5), 104.5)
            oy = 0.0 if end[1] < 34 else 68.0
            self.ball = (ox, oy)
            self._emit("pass", team=team, player=c.player.pid, to=target.player.pid,
                       outcome="out", **common)
            self._advance(self.rng.uniform(8, 18))
            taker, _ = self._nearest(opp, self.ball, exclude_gk=True)
            taker.pos = self.ball
            self._change_possession(taker)
            self._emit("throw_in", team=opp, player=taker.player.pid)

    def _sprint(self, op: _OnPitch) -> None:
        top = 27.0 + op.player.pace * 7.5 + self.rng.gauss(0, 0.9)
        self._emit("sprint", team=self._team_of(op), player=op.player.pid,
                   speed_kmh=round(min(top, 36.5), 1),
                   distance_m=round(self.rng.uniform(12, 35), 1))

    def _carry(self) -> None:
        c = self.carrier
        assert c is not None
        team = self.attacking
        opp = self._other(team)
        d = self.dir[team]
        start = self.ball
        length = self.rng.uniform(4, 16)
        ang = self.rng.gauss(0, 0.45)
        end = (min(max(start[0] + math.cos(ang) * length * d, 1), 104),
               min(max(start[1] + math.sin(ang) * length, 1), 67))
        defender, dd = self._nearest(opp, end, exclude_gk=True)
        secs = length / self.rng.uniform(4.5, 7.5)
        if dd < 3.5:
            # take-on
            p_win = 0.45 + c.player.pace * 0.25 - defender.player.defending * 0.25
            won = self.rng.random() < p_win
            self._advance(secs)
            self._emit("take_on", team=team, player=c.player.pid, against=defender.player.pid,
                       won=won, start=[round(start[0], 1), round(start[1], 1)])
            if not won:
                self._emit("tackle", team=opp, player=defender.player.pid, on=c.player.pid,
                           won=True)
                self._change_possession(defender)
                return
        self.ball = end
        c.pos = end
        self._advance(secs)
        speed = length / secs * 3.6
        self._emit("carry", team=team, player=c.player.pid,
                   start=[round(start[0], 1), round(start[1], 1)],
                   end=[round(end[0], 1), round(end[1], 1)],
                   distance_m=round(length, 1), speed_kmh=round(speed, 1))
        if length > 11 and self.rng.random() < 0.35 + c.player.pace * 0.3:
            self._sprint(c)

    def _shoot(self, pressured: bool) -> None:
        c = self.carrier
        assert c is not None
        team = self.attacking
        opp = self._other(team)
        d = self.dir[team]
        pos = self.ball
        header = self.rng.random() < 0.12 and M.distance_to_goal(pos, d) < 14
        xg = M.expected_goals(pos, d, pressured, header)
        dg = M.distance_to_goal(pos, d)
        speed = 62 + self.rng.random() * 40 + c.player.finishing * 14 - (25 if header else 0)
        speed = round(min(max(speed + dg * 0.25, 40), 128), 1)
        p_goal = min(xg * (0.55 + c.player.finishing * 0.55), 0.9)
        if self.pending_goal[team]:
            outcome = "goal"
            self.pending_goal[team] = False
        else:
            r = self.rng.random()
            if r < p_goal:
                outcome = "goal"
            else:
                r2 = self.rng.random()
                outcome = "saved" if r2 < 0.34 else "blocked" if r2 < 0.56 else "off_target"
        prev = self.events[-1] if self.events else None
        assist = None
        if prev and prev["type"] == "pass" and prev.get("to") == c.player.pid \
                and prev.get("outcome") == "complete":
            assist = prev["player"]
        self._advance(self.rng.uniform(0.8, 1.6))
        gx = M.PITCH_L if d > 0 else 0.0
        end_y = 34 + self.rng.uniform(-3.4, 3.4) if outcome in ("goal", "saved") else \
            34 + self.rng.choice([-1, 1]) * self.rng.uniform(4, 12)
        self._emit("shot", team=team, player=c.player.pid, outcome=outcome,
                   xg=xg, speed_kmh=speed, distance_m=round(dg, 1),
                   body_part="head" if header else "foot", pressured=pressured,
                   assist=assist, start=[round(pos[0], 1), round(pos[1], 1)],
                   end=[gx, round(end_y, 1)])
        if outcome == "goal":
            self.score[team] += 1
            self.ball = (gx, end_y)
            self._emit("goal", team=team, player=c.player.pid, assist=assist, xg=xg)
            self._advance(self.rng.uniform(55, 75))
            self._kickoff(opp)
        elif outcome == "saved":
            gk = self._gk(opp)
            self.ball = gk.pos
            self._emit("save", team=opp, player=gk.player.pid, xg_faced=xg)
            self._change_possession(gk)
            self._advance(self.rng.uniform(4, 9))
        elif outcome == "blocked":
            blocker, _ = self._nearest(opp, pos, exclude_gk=True)
            self._emit("block", team=opp, player=blocker.player.pid)
            self._change_possession(blocker)
        else:
            self._advance(self.rng.uniform(15, 30))
            gk = self._gk(opp)
            self.ball = gk.pos
            self._change_possession(gk)
            self._emit("goal_kick", team=opp, player=gk.player.pid)

    def _step(self) -> None:
        c = self.carrier
        assert c is not None
        team = self.attacking
        d = self.dir[team]
        self._update_positions()
        pressured, pdist, lost = self._try_pressure()
        if lost or self.carrier is not c:
            return
        dg = M.distance_to_goal(self.ball, d)
        ang = M.shot_angle(self.ball, d)
        p_shot = 0.0
        if dg < 30 and c.role != "GK":
            p_shot = 0.085 + (30 - dg) / 30 * 0.07 * min(ang / 0.5, 1.5)
            if pressured:
                p_shot *= 0.75
        if self.pending_goal[team]:
            # scripted goals must still come from a genuine close-range chance
            if dg < 16:
                p_shot = 0.85
            else:
                p_shot = 0.0
        r = self.rng.random()
        if r < p_shot:
            self._shoot(pressured)
        elif r < p_shot + 0.17 + (0.08 if not pressured else -0.05) + \
                (0.25 if self.pending_goal[team] and dg < 45 else 0):
            self._carry()
        else:
            self._pass(pressured, pdist)

    # --------------------------------------------------------------------- run
    def stream(self) -> Iterator[dict[str, Any]]:
        """Yield events one at a time (as a live feed would)."""
        home, away = self.teams["home"], self.teams["away"]
        start = self._emit(
            "match_start",
            home={"name": home.name, "short": home.short, "color": home.color,
                  "formation": home.formation,
                  "players": [vars(p) for p in home.starters],
                  "bench": [vars(p) for p in home.bench],
                  "manager": vars(home.manager) if home.manager else None, "max_subs": home.max_subs},
            away={"name": away.name, "short": away.short, "color": away.color,
                  "formation": away.formation,
                  "players": [vars(p) for p in away.starters],
                  "bench": [vars(p) for p in away.bench],
                  "manager": vars(away.manager) if away.manager else None, "max_subs": away.max_subs},
            venue="Thornfield Park (fictional)",
            weather="light rain, 11°C",
            seed=self.seed,
            synthetic=True,
        )
        yield start
        sent = 1
        stoppage = {1: self.rng.randint(1, 4), 2: self.rng.randint(3, 6)}
        for period in (1, 2):
            self.period = period
            if period == 2:
                self.period_start_t = self.t
            self._kickoff("home" if period == 1 else "away")
            end_at = self.period_start_t + (45 + stoppage[period]) * 60
            while self.t < end_at:
                self._apply_script()
                self._step()
                while sent < len(self.events):
                    yield self.events[sent]
                    sent += 1
            self._emit("period_end", added_minutes=stoppage[period])
            while sent < len(self.events):
                yield self.events[sent]
                sent += 1
        self._emit("match_end", final_score=dict(self.score))
        yield self.events[-1]

    def run(self) -> list[dict[str, Any]]:
        return list(self.stream())


def simulate_match(seed: int = 7, script: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    return MatchSimulator(seed=seed, script=script).run()
