"""Check that every model deployment in .env answers, in a few seconds.

Usage:
    python scripts/check_models.py
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from agent_framework import Agent  # noqa: E402

from chalk.agents.config import load_settings  # noqa: E402
from chalk.agents.crew import make_online_client  # noqa: E402


async def ping(settings, model: str, who: str) -> bool:
    agent = Agent(make_online_client(settings, model), "Reply with the JSON object {\"ok\": true}.", name="Check")
    t0 = time.perf_counter()
    try:
        resp = await agent.run("ping", options={"response_format": {"type": "json_object"}, "temperature": 0})
        ok = '"ok"' in (resp.text or "")
        print(f"  {'OK ' if ok else '?? '} {who:<28} deployment '{model}'  ({time.perf_counter() - t0:.1f}s)")
        return ok
    except Exception as err:  # noqa: BLE001
        msg = str(err)
        hint = ""
        if "DeploymentNotFound" in msg or "404" in msg:
            hint = "  -> no deployment with this name. Check the name in Foundry, or remove the line from .env"
        elif "401" in msg or "Unauthorized" in msg or "Access denied" in msg:
            hint = "  -> the key is wrong. Copy the API key again from the Foundry home page"
        elif "429" in msg:
            hint = "  -> rate limited. Wait a minute or lower CHALK_MAX_CONCURRENCY"
        print(f"  FAIL {who:<28} deployment '{model}'\n       {msg[:220]}{hint}")
        return False


async def main() -> None:
    s = load_settings()
    if not s.online:
        print("No model configured (.env has no CHALK_BASE_URL / CHALK_API_KEY): CHALK will use the offline crew.")
        return
    print(f"Checking {s.describe()}")
    ok = await ping(s, s.model, "Analyst/Telestrator/Personalizer")
    if s.var_model:
        ok = await ping(s, s.var_model, "VAR judge") and ok
    print("\nAll good: run  python scripts/run_pundit.py" if ok else "\nFix the line marked FAIL in .env, then run this check again.")


if __name__ == "__main__":
    asyncio.run(main())
