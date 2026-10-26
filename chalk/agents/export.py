"""Turn crew results into the files a broadcast renderer consumes."""

from __future__ import annotations

from typing import Any

from .crew import Card

ON_AIR_DELAY_S = 3.0  # broadcast delay between the event and the graphic


def card_to_json(c: Card) -> dict[str, Any]:
    m = c.moment
    a = c.analysis or {}
    on_air = round(m["t"] + ON_AIR_DELAY_S, 1)
    duration = round(7.0 + 1.2 * len(c.drawings), 1)
    return {
        "moment_id": m["id"], "type": m["type"], "team": m["team"], "clock": m["clock"],
        "t": m["t"], "on_air_t": on_air, "duration_s": duration, "title": m["title"],
        "importance": m["importance"],
        "headline": a.get("headline"), "story": a.get("story"), "claims": a.get("claims", []),
        "focus_players": a.get("focus_players", []), "drawings": c.drawings, "variants": c.variants,
        "var": {k: c.var.get(k) for k in ("verdict", "final", "history", "drawing_issues", "caption_issues")
                if c.var.get(k) is not None},
        "fallbacks": c.fallbacks, "trace": c.trace, "facts": c.facts,  # the full sheet VAR checked
    }


def overlay_feed(cards: list[dict[str, Any]], match_id: str) -> dict[str, Any]:
    cues = []
    for c in cards:
        start, end = c["on_air_t"], round(c["on_air_t"] + c["duration_s"], 1)
        cues.append({"cue_id": f"{c['moment_id']}-caption", "layer": "caption", "start_t": start, "end_t": end,
                     "moment_id": c["moment_id"], "headline": c["headline"], "variants": c["variants"]})
        for i, d in enumerate(c["drawings"]):
            cues.append({"cue_id": f"{c['moment_id']}-draw-{i + 1}", "layer": "telestration",
                         "start_t": round(start + 0.9 * i, 1), "end_t": end,
                         "moment_id": c["moment_id"], "shape": d})
    return {"schema": "chalk.overlay/1", "match_id": match_id, "coordinate_system":
            {"units": "metres", "pitch": [105, 68], "x": "home attacks towards 105", "y": "0 far touchline, 68 near"},
            "time": "seconds since kick-off (match clock t)", "cues": cues}


def recap_to_json(c: Card) -> dict[str, Any]:
    return {**card_to_json(c), "turning_point": (c.analysis or {}).get("turning_point")
            or c.facts.get("turning_point_clock"), "player_of_the_match": c.facts.get("potm_id")}
