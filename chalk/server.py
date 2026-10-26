"""CHALK live server.

Streams a synthetic match as it happens and runs the whole pipeline live:

    Ingest       events are released on the match clock (speed-up optional)
    Interpret    MatchState updates on every event
    Spot         MomentDetector flags moments the instant they happen
    Explain      the studio crew (Microsoft Agent Framework) runs on each aired moment;
                 recorded outputs are replayed when available, so a demo costs nothing
    Render       the browser receives events, moments, pulse points and insight cards
                 over Server-Sent Events and draws them

Viewers can also ask the studio a question (POST /api/ask): a Q&A agent answers through the
CHALK MCP server, pinned to the minute they are watching, and VAR checks every number. The
same MCP server is mounted at /mcp for any MCP client (GitHub Copilot in VS Code, ...).

Run locally:
    uvicorn chalk.server:app --port 8000
Then open http://localhost:8000/ (or /web/?live=1).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import random
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field

from .agents.config import ROOT, load_settings
from .agents.crew import Crew
from .agents.export import card_to_json, recap_to_json
from .agents.producer import LiveProducer, build_cards, build_recap_card, context_at
from .agents.qa import StudioQA
from .mcp_server import build_server
from .sim.engine import MatchSimulator
from .stats.moments import MomentDetector
from .stats.state import MatchState

DATA = ROOT / "data"
log = logging.getLogger("chalk.server")
ON_AIR_DELAY_S = 3.0
MAX_SPEED = 60.0

# The match data MCP server over streamable HTTP (whole match, demo seed). Public read-only
# data, so the Host check is relaxed for cloud hosting.
MCP = build_server(int(os.environ.get("CHALK_SEED", "4")))
MCP_APP = MCP.streamable_http_app(streamable_http_path="/", stateless_http=True, json_response=True,
                                  transport_security=TransportSecuritySettings(
                                      enable_dns_rebinding_protection=False))


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    async with MCP_APP.router.lifespan_context(MCP_APP):
        yield


app = FastAPI(title="CHALK live", description="The AI pundit that draws on the pitch.", lifespan=lifespan)
_qa: StudioQA | None = None


def studio_qa() -> StudioQA:
    global _qa
    if _qa is None:
        _qa = StudioQA()
    return _qa


def _load_events(seed: int) -> list[dict[str, Any]]:
    path = DATA / f"match_{seed}.jsonl"
    if path.exists():
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return MatchSimulator(seed=seed).run()


def _recorded(seed: int) -> dict[str, Any] | None:
    path = DATA / f"match_{seed}_insights.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def _sse(kind: str, data: Any) -> str:
    return f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


@app.get("/api/health")
def health() -> dict[str, Any]:
    s = load_settings()
    return {"ok": True, "engine": s.describe(), "live_ai": os.environ.get("CHALK_LIVE_AI", "1") != "0",
            "features": ["live", "ask", "mcp", "new_match"]}


@app.get("/api/live")
async def live(seed: int = 4, speed: float = Query(10.0, gt=0, le=MAX_SPEED),
               ai: str = Query("auto", pattern="^(auto|live|recorded)$")) -> StreamingResponse:
    """The match as a live feed. ai=live runs the crew on each moment as it happens
    (using recorded answers where it has them), ai=recorded replays the stored cards,
    auto picks live when a model is configured."""
    return StreamingResponse(_stream(seed, speed, ai), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _stream(seed: int, speed: float, ai: str) -> AsyncIterator[str]:
    events = _load_events(seed)
    recorded = _recorded(seed)
    settings = load_settings()
    live_ai = (ai == "live" or (ai == "auto" and settings.online)) and os.environ.get("CHALK_LIVE_AI", "1") != "0"
    if not live_ai and recorded is None and ai != "recorded":
        # a match nobody has recorded (a new seed): the offline crew explains it live, for free
        settings, live_ai = load_settings(force_offline=True), True
    crew = Crew(settings) if live_ai else None
    rec_cards = {c["moment_id"]: c for c in (recorded or {}).get("cards", [])}
    engine = (recorded or {}).get("engine", {}) if not crew else {
        "provider": settings.provider, "model": settings.model,
        "framework": "Microsoft Agent Framework (agent_framework.Agent + Workflow)"}

    state = MatchState()
    det = MomentDetector(state)
    producer = LiveProducer()
    queued: list[dict[str, Any]] = []  # insight cards waiting for their on-air time
    tasks: set[asyncio.Task] = set()
    ready: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def explain(card: Any) -> None:
        out = await crew.run_moment(card)  # type: ignore[union-attr]
        crew.cache.save()  # type: ignore[union-attr]
        await ready.put(card_to_json(out))

    yield _sse("hello", {"seed": seed, "speed": speed, "mode": "live AI" if crew else "recorded",
                         "engine": engine, "personas": ["analyst", "casual"], "languages": ["en", "fr", "ar"]})
    t_wall0 = time.perf_counter()
    pulse_sent = 0
    try:
        for ev in events:
            due = ev["t"] / speed - (time.perf_counter() - t_wall0)
            if due > 0:
                await asyncio.sleep(due)
            state.apply(ev)
            new = det.process(ev)
            yield _sse("event", ev)
            for m in new:
                md = m.to_dict()
                yield _sse("moment", md)
                if not crew:
                    if m.id in rec_cards:  # recorded cards were already chosen by the producer
                        queued.append(rec_cards[m.id])
                    continue
                if producer.wants(md):
                    card = build_cards([events[0]], [md], {m.id: context_at(state, det, m)})[0]
                    task = asyncio.create_task(explain(card))
                    tasks.add(task)
                    task.add_done_callback(tasks.discard)
            if len(state.pulse) > pulse_sent:
                for p in state.pulse[pulse_sent:]:
                    yield _sse("pulse", asdict(p))
                pulse_sent = len(state.pulse)
            while not ready.empty():  # live insights: on air as soon as the crew is done
                c = ready.get_nowait()
                c["on_air_t"] = max(c["on_air_t"], ev["t"] + 1.0)
                yield _sse("insight", c)
            for c in [c for c in queued if c["on_air_t"] <= ev["t"] + ON_AIR_DELAY_S]:
                queued.remove(c)
                yield _sse("insight", c)
        if tasks:
            await asyncio.wait(set(tasks), timeout=60)
            while not ready.empty():
                yield _sse("insight", ready.get_nowait())
        for c in queued:
            yield _sse("insight", c)
        if crew:
            recap = await crew.run_moment(build_recap_card(events, state, [m.to_dict() for m in det.moments]))
            crew.cache.save()
            yield _sse("recap", recap_to_json(recap))
        elif recorded and recorded.get("recap"):
            yield _sse("recap", recorded["recap"])
        yield _sse("end", {"final_score": state.score})
    finally:
        for t in tasks:
            t.cancel()


class Question(BaseModel):
    question: str = Field(..., max_length=400)
    t: float | None = Field(None, ge=0, description="match time the viewer is watching, in seconds")
    seed: int = Field(4, ge=0, le=99999)
    lang: str = "en"
    persona: str = "analyst"


@app.post("/api/ask")
async def ask(q: Question) -> JSONResponse:
    """Ask the studio. Answers only from the match up to t, checked by VAR."""
    try:
        qa = studio_qa()
        out = await qa.ask(q.question, t=q.t, seed=q.seed, lang=q.lang, persona=q.persona)
    except Exception as err:  # never leave a viewer without an answer
        log.exception("ask failed")
        qa = StudioQA(load_settings(force_offline=True))
        out = await qa.ask(q.question, t=q.t, seed=q.seed, lang=q.lang, persona=q.persona)
        out["var"] = {**out["var"], "final": "fallback", "issues": [f"server error: {type(err).__name__}: {err}"[:240]]}
    out["engine"] = qa.engine
    out["session"] = dict(qa.stats)
    return JSONResponse(out)


@app.get("/api/new-match")
def new_match() -> dict[str, Any]:
    """A fresh seed: a match nobody has seen, simulated and explained live."""
    seed = random.randint(100, 99999)
    ev = MatchSimulator(seed=seed).run()[0]
    return {"seed": seed, "home": ev["home"]["name"], "away": ev["away"]["name"]}


@app.get("/api/match/{seed}/insights")
def insights(seed: int) -> JSONResponse:
    return JSONResponse(_recorded(seed) or {"cards": []})


@app.get("/")
def root() -> RedirectResponse:
    return RedirectResponse("/web/")


app.mount("/mcp", MCP_APP, name="mcp")
app.mount("/web", StaticFiles(directory=ROOT / "web", html=True), name="web")
app.mount("/data", StaticFiles(directory=DATA), name="data")
