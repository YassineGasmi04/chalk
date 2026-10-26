"""CHALK match data as an MCP server (Model Context Protocol).

Any MCP client (the CHALK Studio Q&A agent, GitHub Copilot in VS Code, Claude
Desktop...) can ask about the match through these tools. A server can be pinned
to a time cutoff, so an agent answering a viewer at the 30th minute only sees the
first 30 minutes.

Run over stdio (what the Studio Q&A agent does, one process per question):
    python -m chalk.mcp_server --seed 4 --cutoff 1800
The live web server also mounts it over streamable HTTP at /mcp (full match).
"""

from __future__ import annotations

import argparse
import os
from typing import Any

from mcp.server.mcpserver import MCPServer

from .matchdata import TOOL_DOCS, MatchView

INSTRUCTIONS = (
    "Tools for one synthetic football match (fictional clubs and players). Every number comes "
    "from the match data computed by code. Times are match minutes; results only cover the match "
    "up to this server's cutoff."
)


def build_server(seed: int = 4, cutoff_t: float | None = None) -> MCPServer:
    mcp = MCPServer(name="chalk-match", title="CHALK match data", instructions=INSTRUCTIONS, version="1.0")

    def view() -> MatchView:
        return MatchView(seed, cutoff_t)

    @mcp.tool(description=TOOL_DOCS["match_status"])
    def match_status() -> dict[str, Any]:
        return view().match_status()

    @mcp.tool(description=TOOL_DOCS["team_stats"])
    def team_stats(team: str | None = None) -> dict[str, Any]:
        return view().team_stats(team)

    @mcp.tool(description=TOOL_DOCS["player_stats"])
    def player_stats(player: str) -> dict[str, Any]:
        return view().player_stats(player)

    @mcp.tool(description=TOOL_DOCS["top_players"])
    def top_players(stat: str = "goals", team: str | None = None, limit: int = 3) -> dict[str, Any]:
        return view().top_players(stat, team, limit)

    @mcp.tool(description=TOOL_DOCS["key_moments"])
    def key_moments(kind: str | None = None, limit: int = 10) -> dict[str, Any]:
        return view().key_moments(kind, limit)

    @mcp.tool(description=TOOL_DOCS["moment_details"])
    def moment_details(moment: str) -> dict[str, Any]:
        return view().moment_details(moment)

    @mcp.tool(description=TOOL_DOCS["match_flow"])
    def match_flow(last_minutes: int = 30) -> dict[str, Any]:
        return view().match_flow(last_minutes)

    return mcp


def main() -> None:
    ap = argparse.ArgumentParser(description="CHALK match data MCP server (stdio)")
    ap.add_argument("--seed", type=int, default=int(os.environ.get("CHALK_SEED", "4")))
    ap.add_argument("--cutoff", type=float, default=None, help="seconds since kick-off; default: whole match")
    args = ap.parse_args()
    build_server(args.seed, args.cutoff).run("stdio")


if __name__ == "__main__":
    main()
