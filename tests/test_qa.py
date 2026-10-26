"""Ask the studio: match data tools, the MCP server and the Q&A agent's VAR."""

import asyncio
import sys

from agent_framework import BaseChatClient, ChatResponse, Content, FunctionInvocationLayer, MCPStdioTool, Message

from chalk.agents.config import Settings, load_settings
from chalk.agents.qa import StudioQA, check_answer, offline_answer
from chalk.matchdata import MatchView


class ScriptedModel(FunctionInvocationLayer, BaseChatClient):
    """A fake model: calls the tools it is told to, then says the scripted answers in turn."""

    def __init__(self, calls, answers, **kw):
        super().__init__(**kw)
        self.calls, self.answers, self.turn, self.seen = calls, list(answers), 0, []

    async def _respond(self, messages):
        last = messages[-1]
        if last.role != "tool":  # a fresh question (or a retry): call the tools first
            return ChatResponse(messages=Message("assistant", [
                Content.from_function_call(call_id=f"c{self.turn}{i}", name=n, arguments=a)
                for i, (n, a) in enumerate(self.calls)]))
        self.seen.append([c.result for c in last.contents if c.type == "function_result"])
        self.turn += 1
        return ChatResponse(messages=Message("assistant", [self.answers.pop(0)]))

    def _inner_get_response(self, *, messages, stream, options, **kwargs):
        return self._respond(list(messages))


ONLINE = Settings(provider="foundry", base_url="https://example.invalid/openai/v1/", api_key="x", model="test-model")


def test_matchview_never_spoils():
    v = MatchView(4, 30 * 60)
    st = v.match_status()
    assert "2-0" in st["score"] and not st["match_over"]
    assert v.key_moments("red_card")["moments"] == []
    assert v.player_stats("Ashvale 9")["name"] == "Yaw Mensah-Cole"
    assert v.find_player("lorne") == "a9" and v.find_player("Kestrel 9") == "a9"
    full = MatchView(4)
    assert "3-2" in full.match_status()["score"] and full.match_status()["match_over"]


def test_mcp_server_lists_and_runs_tools():
    async def go():
        async with MCPStdioTool(name="chalk", command=sys.executable, load_prompts=False,
                                args=["-m", "chalk.mcp_server", "--seed", "4", "--cutoff", "1800"]) as mcp:
            names = sorted(f.name for f in mcp.functions)
            fn = next(f for f in mcp.functions if f.name == "match_status")
            return names, await fn.invoke()
    names, res = asyncio.run(go())
    assert names == sorted(["match_status", "team_stats", "player_stats", "top_players", "key_moments",
                            "moment_details", "match_flow"])
    assert "2-0" in str(res[0].text if isinstance(res, list) else res)


def test_offline_answers_in_three_languages(tmp_path):
    qa = StudioQA(load_settings(force_offline=True), cache_path=tmp_path / "qa.json")
    en = asyncio.run(qa.ask("How is Mensah-Cole doing?", t=1800))
    assert "2 goals" in en["answer"] and en["focus"] == "h9" and en["tools"][0]["tool"] == "player_stats"
    fr = asyncio.run(qa.ask("Qui a la possession ?", t=1800, lang="fr"))
    assert "possession" in fr["answer"] and "%" in fr["answer"]
    ar = asyncio.run(qa.ask("من سجل الأهداف؟", t=1800, lang="ar"))
    assert "الأهداف" in ar["answer"] and "Mensah-Cole" in ar["answer"]
    assert asyncio.run(qa.ask("any red cards?", t=1800))["answer"] == "No red cards so far."


def test_offline_answers_pass_their_own_var():
    v = MatchView(4, 3000)
    for q in ["score?", "who is the fastest", "shots", "best player", "who scored", "Kestrel 9", "on top?"]:
        out = offline_answer(v, q)
        results = [getattr(v, c["tool"])(**c["args"]) for c in out["tools"]]
        assert check_answer(out["answer"], results, q, v.state.clock, "en", len(out["tools"])) == [], q


def test_model_answer_verified_through_mcp(tmp_path):
    model = ScriptedModel([("player_stats", {"player": "Ashvale 9"})],
                          ["Mensah-Cole already has 2 goals from 5 shots."])
    qa = StudioQA(ONLINE, client=model, cache_path=tmp_path / "qa.json")
    out = asyncio.run(qa.ask("How is their number 9 doing?", t=1800))
    assert out["var"]["final"] == "verified" and out["source"] == "model"
    assert out["tools"] == [{"tool": "player_stats", "args": {"player": "Ashvale 9"}}]
    assert out["focus"] == "h9"
    assert "Mensah-Cole" in str(model.seen[0])  # the result really came from the MCP server
    again = asyncio.run(qa.ask("How is their number 9 doing?", t=1810))  # same minute: recorded
    assert again["source"] == "recorded" and again["answer"] == out["answer"]


def test_var_overturns_an_invented_number_then_accepts_the_retry(tmp_path):
    model = ScriptedModel([("team_stats", {})],
                          ["Ashvale have had 71% of the ball.", "Ashvale have had 56.8% of the ball."])
    qa = StudioQA(ONLINE, client=model, cache_path=tmp_path / "qa.json")
    out = asyncio.run(qa.ask("Who has more of the ball?", t=1800))
    assert out["var"]["final"] == "verified" and out["var"]["attempts"] == 2
    assert any("71" in i for i in out["var"]["issues"])
    assert "56.8" in out["answer"]


def test_two_overturns_fall_back_to_the_rulebook_answer(tmp_path):
    model = ScriptedModel([("match_status", {})], ["It's 4-0.", "Still 4-0, h9 is on fire."])
    qa = StudioQA(ONLINE, client=model, cache_path=tmp_path / "qa.json")
    out = asyncio.run(qa.ask("What's the score?", t=1800))
    assert out["var"]["final"] == "fallback" and out["source"] == "rules"
    assert "2-0" in out["answer"] and "4-0" not in out["answer"]
    assert any("player id" in i for i in out["var"]["issues"])


def test_model_path_also_works_over_stdio(tmp_path, monkeypatch):
    monkeypatch.setenv("CHALK_QA_MCP", "stdio")  # the MCP server as a subprocess, like an external client
    model = ScriptedModel([("top_players", {"stat": "top_speed_kmh", "limit": 1})],
                          ["Nico Varga has been the quickest so far, at 33.9 km/h."])
    qa = StudioQA(ONLINE, client=model, cache_path=tmp_path / "qa.json")
    out = asyncio.run(qa.ask("Who is the fastest?", t=1800))
    assert out["var"]["final"] == "verified" and "Varga" in str(model.seen[0])
