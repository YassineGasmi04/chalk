"""Pure football metric functions shared by the simulator and the stats layer.

Pitch: 105 x 68 m. Every function takes an `attack_dir` of +1 (attacking
towards x = 105) or -1 (towards x = 0).
"""

from __future__ import annotations

import math

PITCH_L = 105.0
PITCH_W = 68.0
GOAL_HALF_WIDTH = 3.66


def goal_center(attack_dir: int) -> tuple[float, float]:
    return (PITCH_L if attack_dir > 0 else 0.0, PITCH_W / 2)


def dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def distance_to_goal(pos: tuple[float, float], attack_dir: int) -> float:
    return dist(pos, goal_center(attack_dir))


def shot_angle(pos: tuple[float, float], attack_dir: int) -> float:
    """Visible goal mouth angle in radians from the shot location."""
    gx = PITCH_L if attack_dir > 0 else 0.0
    dx = abs(gx - pos[0]) + 1e-6
    y1 = PITCH_W / 2 - GOAL_HALF_WIDTH - pos[1]
    y2 = PITCH_W / 2 + GOAL_HALF_WIDTH - pos[1]
    return abs(math.atan2(y2, dx) - math.atan2(y1, dx))


def expected_goals(pos: tuple[float, float], attack_dir: int, pressured: bool = False,
                   header: bool = False) -> float:
    """Simple logistic xG on distance and angle, tuned to real-world ranges."""
    d = distance_to_goal(pos, attack_dir)
    ang = shot_angle(pos, attack_dir)
    z = -1.1 - 0.11 * d + 1.6 * ang
    if pressured:
        z -= 0.35
    if header:
        z -= 0.6
    xg = 1 / (1 + math.exp(-z))
    return round(min(max(xg, 0.01), 0.85), 3)


def is_progressive(start: tuple[float, float], end: tuple[float, float], attack_dir: int) -> bool:
    """A pass that moves the ball at least 25% closer to goal (common definition)."""
    d0 = distance_to_goal(start, attack_dir)
    d1 = distance_to_goal(end, attack_dir)
    return d1 <= 0.75 * d0 and (end[0] - start[0]) * attack_dir > 5


def in_final_third(pos: tuple[float, float], attack_dir: int) -> bool:
    return pos[0] > 70 if attack_dir > 0 else pos[0] < 35


def pass_difficulty(start: tuple[float, float], end: tuple[float, float], attack_dir: int,
                    passer_pressure_m: float, receiver_marking_m: float,
                    lines_broken: int) -> int:
    """0-100 rating of how hard a pass is to complete.

    Components (all explainable, each shown on screen by the Telestrator):
      distance      longer passes are harder
      forwardness   forward passes are harder than square or back passes
      pressure      a defender close to the passer
      marking       a defender close to the receiver
      lines broken  passes that go past opponent lines
    """
    distance = dist(start, end)
    forward = (end[0] - start[0]) * attack_dir
    score = 0.0
    score += min(distance / 45.0, 1.0) * 30
    score += max(min(forward / 30.0, 1.0), 0.0) * 15
    score += max(0.0, 1 - passer_pressure_m / 6.0) * 20
    score += max(0.0, 1 - receiver_marking_m / 5.0) * 20
    score += min(lines_broken, 3) / 3 * 15
    return int(round(min(score, 100)))


def lines_broken(start: tuple[float, float], end: tuple[float, float], attack_dir: int,
                 opponents: list[tuple[float, float]]) -> int:
    """How many opponent 'lines' (defenders between passer and receiver in x) the pass beats."""
    lo, hi = sorted((start[0], end[0]))
    if (end[0] - start[0]) * attack_dir <= 3:
        return 0
    between = sorted(o[0] for o in opponents if lo < o[0] < hi)
    # Group defenders standing within 6 m of each other in x into one line
    lines = 0
    last = None
    for x in between:
        if last is None or abs(x - last) > 6:
            lines += 1
        last = x
    return lines


def ball_speed_kmh(distance_m: float, air_time_s: float) -> float:
    return round(distance_m / max(air_time_s, 0.05) * 3.6, 1)
