"""VAR rulebook: deterministic checks every agent output must pass.

The model-based VAR judge only sees work that has already passed these rules,
so the expensive judgement is spent on reasoning, never on arithmetic.
"""

from __future__ import annotations

import math
import re
from typing import Any

NUM_RE = re.compile(r"(?<![A-Za-z])(\d+(?:[.,]\d+)?)")
# context the facts never contain: forbidden as stated fact
UNSUPPORTED = [
    "record", "all-time", "all time", "season", "history",
    "ever ", "league table", "injur", "title race", "relegation",
]
PITCH_X = (-2.0, 107.0)
PITCH_Y = (-2.0, 70.0)
GROUNDING_RADIUS_M = 3.5


# ------------------------------------------------------------------- numbers
def allowed_numbers(facts: dict[str, Any], extra: list[Any] | None = None) -> set[float]:
    """Every number a caption may contain, with sensible roundings."""
    vals: set[float] = set()

    def add(v: Any) -> None:
        if isinstance(v, bool) or v is None:
            return
        if isinstance(v, (int, float)):
            f = float(v)
            for r in (f, round(f), round(f, 1), round(f, 2), math.floor(f), math.ceil(f)):
                vals.add(round(float(r), 2))
            if 0 < f < 1:  # a share may be spoken as a percentage
                vals.add(round(f * 100))
                vals.add(round(f * 100, 1))
            if 1 < f <= 100:  # and a percentage as a share (48.9% -> 0.489)
                vals.add(round(f / 100, 3))
                vals.add(round(f / 100, 2))
        elif isinstance(v, str):
            for m in NUM_RE.findall(v):
                vals.add(round(float(m.replace(",", ".")), 2))
        elif isinstance(v, (list, tuple)):
            for x in v:
                add(x)
        elif isinstance(v, dict):
            for x in v.values():
                add(x)

    add(list(facts.values()))
    for e in extra or []:
        add(e)
    return vals


def check_numbers(text: str, allowed: set[float]) -> list[str]:
    issues = []
    for m in NUM_RE.findall(text or ""):
        f = float(m.replace(",", "."))
        if round(f, 3) in allowed:
            continue
        v = round(f, 2)
        if v not in allowed:
            issues.append(f"number {m} is not on the fact sheet")
    return issues


KEY_LEAK_RE = re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b")


def check_language(text: str) -> list[str]:
    low = (text or "").lower()
    issues = [f"unsupported context: '{w.strip()}'" for w in UNSUPPORTED if w in low]
    leaks = KEY_LEAK_RE.findall(text or "")
    if leaks:
        issues.append(f"internal data names in the text {sorted(set(leaks))[:3]}; say it in plain words")
    return issues


# ----------------------------------------------------------------- analysis
ALIASES = {"team": "team_name", "opponent": "opponent_name", "minute": "clock", "time": "clock"}
# fields of the moment itself, which the Analyst also sees
META_KEYS = {"title", "type", "headline", "players", "score", "clock"}


def resolve_key(key: str, facts: dict[str, Any]) -> bool:
    """A cited key is valid if it names a fact, tolerating harmless variations
    (possession_pct -> home_possession_pct, chaos -> pulse_chaos, teams.home.xg -> home_xg)."""
    k = str(key).strip().lower().replace(".", "_").replace("-", "_")
    for prefix in ("facts_", "context_", "teams_"):
        if k.startswith(prefix):
            k = k[len(prefix):]
    k = ALIASES.get(k, k)
    if k in facts or k in META_KEYS:
        return True
    if len(k) < 4:  # "pct", "xg"... too generic to match by suffix
        return False
    return any(f.endswith("_" + k) or f.startswith(k + "_") for f in facts)


def check_analysis(analysis: dict[str, Any], facts: dict[str, Any], players: dict[str, Any],
                   extra_numbers: list[Any]) -> list[str]:
    issues: list[str] = []
    if not isinstance(analysis, dict):
        return ["analysis is not a JSON object"]
    for key in ("headline", "story", "claims"):
        if not analysis.get(key):
            issues.append(f"missing '{key}'")
    allowed = allowed_numbers(facts, extra_numbers)
    texts = [analysis.get("headline", ""), analysis.get("story", "")]
    texts += [c.get("text", "") for c in analysis.get("claims", []) if isinstance(c, dict)]
    for t in texts:
        issues += check_numbers(t, allowed)
        issues += check_language(t)
    for c in analysis.get("claims", []):
        if not isinstance(c, dict):
            issues.append("claim is not an object")
            continue
        keys = c.get("fact_keys") or []
        unknown = [k for k in keys if not resolve_key(k, facts)]
        if not keys:
            issues.append(f"claim cites no facts: '{c.get('text', '')[:50]}'")
        if unknown:
            issues.append(f"claim cites unknown facts {unknown}")
    for pid in analysis.get("focus_players", []) or []:
        if pid not in players:
            issues.append(f"unknown player id {pid}")
    if len((analysis.get("story") or "").split()) > 75:
        issues.append("story is longer than 75 words")
    return sorted(set(issues))


# ----------------------------------------------------------------- drawings
def grounding_points(geometry: dict[str, Any]) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for key in ("frame", "shot_frame"):
        for v in (geometry.get(key) or {}).values():
            pts.append((v[0], v[1]))
    if geometry.get("ball"):
        pts.append(tuple(geometry["ball"]))
    for seg in geometry.get("buildup", []) or []:
        pts += [tuple(seg["from"]), tuple(seg["to"])]
    for key in ("shot", "pass"):
        g = geometry.get(key)
        if g:
            pts += [tuple(g["from"]), tuple(g["to"])]
    if geometry.get("runner"):
        pts.append(tuple(geometry["runner"]))
    z = geometry.get("press_zone") or {}
    if z.get("x_min") is not None:
        pts += [(z["x_min"], z["y_min"]), (z["x_max"], z["y_min"]),
                (z["x_max"], z["y_max"]), (z["x_min"], z["y_max"])]
    return pts


def _near(p: Any, ground: list[tuple[float, float]]) -> bool:
    try:
        x, y = float(p[0]), float(p[1])
    except (TypeError, ValueError, IndexError):
        return False
    if not (PITCH_X[0] <= x <= PITCH_X[1] and PITCH_Y[0] <= y <= PITCH_Y[1]):
        return False
    return any(math.hypot(x - gx, y - gy) <= GROUNDING_RADIUS_M for gx, gy in ground)


def check_drawing(d: dict[str, Any], geometry: dict[str, Any],
                  ground: list[tuple[float, float]]) -> list[str]:
    frame = geometry.get("frame") or {}
    t = d.get("type")
    if t == "arrow":
        if not (_near(d.get("from"), ground) and _near(d.get("to"), ground)):
            return ["arrow is not anchored to real positions"]
        if d.get("style") not in ("pass", "run", "shot", "carry"):
            return [f"arrow style '{d.get('style')}' is unknown"]
    elif t == "circle":
        if d.get("player") not in frame:
            return [f"circle on player '{d.get('player')}' who is not in the frame"]
    elif t == "link":
        ps = d.get("players") or []
        if len(ps) != 2 or any(p not in frame for p in ps):
            return [f"link between unknown players {ps}"]
    elif t == "zone":
        pts = d.get("points") or []
        if not (3 <= len(pts) <= 8) or not all(_near(p, ground) for p in pts):
            return ["zone corners are not anchored to real positions"]
    else:
        return [f"unknown drawing type '{t}'"]
    label = d.get("label") or ""
    if len(label.split()) > 5:
        return ["label longer than 5 words"]
    return []


def filter_drawings(drawings: Any, geometry: dict[str, Any],
                    allowed: set[float]) -> tuple[list[dict[str, Any]], list[str]]:
    """Keep only grounded drawings; return (kept, issues)."""
    if not isinstance(drawings, list):
        return [], ["drawings is not a list"]
    ground = grounding_points(geometry)
    # labels may number the steps of a move ("Pass 1") or name shirt numbers
    allowed = allowed | {float(n) for n in range(1, 12)}
    kept, issues = [], []
    for d in drawings[:6]:
        if not isinstance(d, dict):
            issues.append("drawing is not an object")
            continue
        problems = check_drawing(d, geometry, ground)
        problems += check_numbers(d.get("label", ""), allowed)
        if problems:
            issues += problems
        else:
            kept.append(d)
    return kept, issues


# ---------------------------------------------------------------- captions
def check_variants(variants: Any, allowed: set[float], personas: list[str],
                   languages: list[str]) -> dict[tuple[str, str], list[str]]:
    """Problems per (persona, language); a missing caption is a problem too."""
    out: dict[tuple[str, str], list[str]] = {}
    for p in personas:
        for lang in languages:
            v = (((variants or {}).get(p) or {}).get(lang)) if isinstance(variants, dict) else None
            caption = v.get("caption") if isinstance(v, dict) else None
            if not caption:
                out[(p, lang)] = ["missing caption"]
                continue
            probs = check_numbers(caption, allowed) + check_numbers(v.get("tag", ""), allowed)
            if lang == "en":
                probs += check_language(caption)
            elif KEY_LEAK_RE.search(caption):
                probs.append("internal data names in the caption")
            if len(caption.split()) > 40:
                probs.append("caption longer than 40 words")
            if probs:
                out[(p, lang)] = probs
    return out
