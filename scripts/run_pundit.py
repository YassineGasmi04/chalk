"""Run CHALK's virtual studio crew over a match.

Usage:
    python scripts/run_pundit.py              # uses the model in .env, or the offline crew
    python scripts/run_pundit.py --offline    # force the rule-based crew (no model calls)
    python scripts/run_pundit.py --max-cards 6

Writes:
    data/match_<seed>_insights.json   one verified, personalized insight card per aired moment
    data/match_<seed>_overlay.json    timed, machine-readable overlay cues for a broadcast renderer
    data/cache/agent_calls.json       recorded model outputs (replays cost nothing)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chalk.agents.config import load_settings  # noqa: E402
from chalk.agents.crew import LANGUAGES, PERSONAS, ROLES, Card, Crew  # noqa: E402
from chalk.agents.producer import build_cards, replay_with_context, select_moments  # noqa: E402
from chalk.sim.engine import MatchSimulator  # noqa: E402

ON_AIR_DELAY_S = 3.0  # broadcast delay between the event and the graphic


def load_events(seed: int) -> list[dict]:
    path = ROOT / "data" / f"match_{seed}.jsonl"
    if path.exists():
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return MatchSimulator(seed=seed).run()


def card_to_json(c: Card) -> dict:
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
        "fallbacks": c.fallbacks, "trace": c.trace, "facts": m["facts"],
    }


def overlay_feed(cards: list[dict], match_id: str) -> dict:
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


async def main_async(args: argparse.Namespace) -> None:
    settings = load_settings(force_offline=args.offline)
    events = load_events(args.seed)
    _, moments, contexts = replay_with_context(events)
    chosen = select_moments(moments, args.max_cards)
    cards = build_cards(events, chosen, contexts)
    crew = Crew(settings)
    print(f"CHALK studio crew: {settings.describe()}")
    print(f"{len(moments)} moments spotted, {len(cards)} going on air\n")

    t0 = time.perf_counter()
    done = 0

    async def run(card: Card) -> Card:
        nonlocal done
        out = await crew.run_moment(card)
        done += 1
        v = out.var.get("final", "?")
        mark = {"verified": "VAR ok", "fallback": "VAR fallback", "rulebook-only": "rules only (judge down)"}.get(v, v)
        print(f"  [{done:2d}/{len(cards)}] {out.moment['clock']:>6}  {out.moment['title'][:44]:<44} {mark}")
        crew.cache.save()
        return out

    results = await asyncio.gather(*(run(c) for c in cards))
    elapsed = time.perf_counter() - t0
    crew.cache.save()

    out_cards = [card_to_json(c) for c in sorted(results, key=lambda c: c.moment["t"])]
    match_id = events[0]["match_id"]
    insights = {
        "match_id": match_id,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "engine": {"provider": settings.provider, "model": settings.model,
                   "framework": "Microsoft Agent Framework (agent_framework.Agent + Workflow)"},
        "crew": [{"id": r, "name": n, "role": d} for r, (n, _, d) in ROLES.items()],
        "personas": PERSONAS, "languages": LANGUAGES,
        "stats": {**crew.stats, "cards": len(out_cards), "seconds": round(elapsed, 1)},
        "cards": out_cards,
    }
    stem = ROOT / "data" / f"match_{args.seed}"
    Path(f"{stem}_insights.json").write_text(json.dumps(insights, ensure_ascii=False, indent=1), encoding="utf-8")
    Path(f"{stem}_overlay.json").write_text(json.dumps(overlay_feed(out_cards, match_id), ensure_ascii=False,
                                                       indent=1), encoding="utf-8")
    s = crew.stats
    print(f"\n{len(out_cards)} cards in {elapsed:.1f}s | model calls {s['calls']}, recorded {s['cached']}, "
          f"VAR overturned {s['overturned']}, fallbacks {s['fallbacks']}, "
          f"drawings rejected {s['drawings_rejected']}, captions repaired {s['captions_repaired']}")
    print(f"wrote {stem}_insights.json and {stem}_overlay.json")
    if crew.errors:
        print("\n" + "!" * 72)
        print("WARNING: some model calls failed, so rule-based pundits stood in for them:")
        for model, err in crew.errors.items():
            print(f"  deployment '{model}': {err}")
        print("Check the deployment names in .env match Foundry exactly, then run:")
        print("  python scripts/check_models.py")
        print("!" * 72)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=4)
    ap.add_argument("--offline", action="store_true", help="use the rule-based crew, no model calls")
    ap.add_argument("--max-cards", type=int, default=18)
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()
