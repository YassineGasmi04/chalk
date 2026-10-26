"""Ask the studio from the terminal (uses the model in .env, or the offline router).

    python scripts/ask_studio.py "How is Mensah-Cole doing?" --minute 30
    python scripts/ask_studio.py "Qui domine ?" --minute 70 --lang fr --persona casual
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chalk.agents.qa import StudioQA  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="Ask the CHALK studio a question about the match")
    ap.add_argument("question")
    ap.add_argument("--minute", type=float, default=None, help="match minute the viewer is watching (default: full time)")
    ap.add_argument("--seed", type=int, default=4)
    ap.add_argument("--lang", default="en", choices=["en", "fr", "ar"])
    ap.add_argument("--persona", default="analyst", choices=["analyst", "casual"])
    a = ap.parse_args()
    qa = StudioQA()
    print(f"engine: {qa.engine}")
    out = asyncio.run(qa.ask(a.question, t=None if a.minute is None else a.minute * 60, seed=a.seed,
                             lang=a.lang, persona=a.persona))
    print(f"\n[{out['clock']}] {out['answer']}\n")
    print("tools:", json.dumps(out["tools"], ensure_ascii=False))
    print("VAR:  ", out["var"]["final"], "|", "; ".join(out["var"].get("issues", [])) or "no issues")
    print("source:", out["source"], f"({out.get('ms', 0)} ms)")


if __name__ == "__main__":
    main()
