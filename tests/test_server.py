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


def test_ask_endpoint_and_mcp_over_http(monkeypatch):
    monkeypatch.setenv("CHALK_OFFLINE", "1")
    monkeypatch.setattr(server, "_qa", None)
    from fastapi.testclient import TestClient
    with TestClient(server.app) as client:  # runs the lifespan that starts the MCP session manager
        r = client.post("/api/ask", json={"question": "Who scored?", "t": 1800, "lang": "en"}).json()
        assert r["answer"] == "Goals so far: 26' Yaw Mensah-Cole, 29' Yaw Mensah-Cole."
        assert r["var"]["final"] == "verified" and r["tools"][0]["tool"] == "key_moments"
        seed = client.get("/api/new-match").json()["seed"]
        assert 100 <= seed <= 99999
        headers = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
        init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}
        assert client.post("/mcp/", json=init, headers=headers).status_code == 200
        tools = client.post("/mcp/", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=headers).json()
        assert {t["name"] for t in tools["result"]["tools"]} >= {"match_status", "player_stats", "top_players"}


def test_unrecorded_seed_is_explained_live_by_the_offline_crew(monkeypatch):
    monkeypatch.setenv("CHALK_OFFLINE", "1")

    async def run():
        kinds: dict[str, int] = {}
        async for chunk in server._stream(31337, speed=1e9, ai="auto"):
            k = chunk.split("\n", 1)[0][len("event: "):]
            kinds[k] = kinds.get(k, 0) + 1
        return kinds
    kinds = asyncio.run(run())
    assert kinds["insight"] >= 5 and kinds["recap"] == 1 and kinds["end"] == 1
