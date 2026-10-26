"""Generate a synthetic match and its analysis.

Usage:
    python scripts/generate_match.py            # demo match (seed 4)
    python scripts/generate_match.py --seed 11  # any other match

Writes to data/:
    match_<seed>.jsonl          the event stream, one JSON object per line
    match_<seed>_moments.json   moments found by the Spotter (no AI)
    match_<seed>_truth.json     the storyline script, kept as ground truth
    match_<seed>_summary.json   final team and player stats + match pulse
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chalk.sim.engine import DEFAULT_SCRIPT, MatchSimulator  # noqa: E402
from chalk.stats.moments import analyse  # noqa: E402

DEMO_SEED = 4


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=DEMO_SEED)
    ap.add_argument("--out", type=Path, default=ROOT / "data")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    events = MatchSimulator(seed=args.seed).run()
    state, det = analyse(events)
    stem = args.out / f"match_{args.seed}"

    with open(f"{stem}.jsonl", "w", encoding="utf-8") as f:
        for ev in events:
            f.write(json.dumps(ev, ensure_ascii=False, separators=(",", ":")) + "\n")
    Path(f"{stem}_moments.json").write_text(
        json.dumps([m.to_dict() for m in det.moments], ensure_ascii=False, indent=1),
        encoding="utf-8")
    Path(f"{stem}_truth.json").write_text(json.dumps(DEFAULT_SCRIPT, indent=1), encoding="utf-8")
    summary = {
        "match_id": state.meta.get("match_id"),
        "final_score": state.score,
        "teams": {s: state.team_summary(s) for s in ("home", "away")},
        "players": {pid: state.player_summary(pid) for pid in state.names
                    if state.player[pid]["touches"] > 0},
        "pulse": [asdict(p) for p in state.pulse],
        "records": state.records,
    }
    Path(f"{stem}_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1),
                                            encoding="utf-8")

    h, a = state.team_summary("home"), state.team_summary("away")
    print(f"{h['name']} {state.score['home']} - {state.score['away']} {a['name']}")
    print(f"events: {len(events)}  moments: {len(det.moments)}")
    print(f"shots {h['shots']}-{a['shots']}  xG {h['xg']}-{a['xg']}  "
          f"possession {h['possession_pct']}%-{a['possession_pct']}%")
    print(f"wrote {stem}.jsonl and friends")


if __name__ == "__main__":
    main()
