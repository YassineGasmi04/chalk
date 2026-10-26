"""The live server streams the whole pipeline: events, pulse, moments, insights, recap."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chalk import server  # noqa: E402


def collect(ai: str) -> dict[str, list]:
    async def run():
        out: dict[str, list] = {}
        async for chunk in server._stream(4, speed=1e9, ai=ai):  # no waiting in tests
            kind, data = chunk.split("\n", 1)
            out.setdefault(kind[len("event: "):], []).append(json.loads(data[len("data: "):].strip()))
        return out
    return asyncio.run(run())


def test_live_stream_runs_the_crew_on_moments_as_they_happen(monkeypatch):
    monkeypatch.setenv("CHALK_OFFLINE", "1")  # never call a real model from tests
    out = collect("live")  # forced live with no model configured: the offline crew runs live
    assert out["hello"][0]["mode"] == "live AI"
    assert len(out["event"]) > 2000 and len(out["pulse"]) > 80 and len(out["moment"]) > 30
    goals = [c for c in out["insight"] if c["type"] == "goal"]
    assert len(goals) == 5 and all(c["var"]["final"] == "verified" for c in out["insight"])
    # an insight never airs before its moment
    assert all(c["on_air_t"] >= c["t"] for c in out["insight"])
    assert out["recap"][0]["player_of_the_match"] == "h9"
    assert out["end"][0]["final_score"] == {"home": 3, "away": 2}


def test_health():
    assert server.health()["ok"] is True
