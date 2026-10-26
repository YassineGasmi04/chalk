"""Model provider settings, read from the environment or a .env file.

CHALK talks to any OpenAI-compatible chat endpoint through Microsoft Agent
Framework. The recommended setup is a model deployed in Microsoft Foundry:

    CHALK_BASE_URL=https://<your-resource>.openai.azure.com/openai/v1/
    CHALK_API_KEY=<key from the Foundry portal>
    CHALK_MODEL=<your deployment name, e.g. gpt-4.1-mini>

With no key configured, CHALK runs its offline crew: the same agents and
workflow, backed by deterministic rule-based pundits instead of a model.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.strip().strip('"').strip("'")
        if " #" in val:
            val = val.split(" #", 1)[0].strip()
        values[key.strip()] = val
    return values


@dataclass(frozen=True)
class Settings:
    provider: str  # "foundry" | "openai-compatible" | "offline"
    base_url: str | None
    api_key: str | None
    model: str
    max_concurrency: int = 3
    var_model: str | None = None  # optional stronger deployment just for the VAR judge

    @property
    def online(self) -> bool:
        return self.provider != "offline"

    def describe(self) -> str:
        if not self.online:
            return "offline crew (rule-based pundits, no model calls)"
        host = (self.base_url or "").split("/")[2] if self.base_url else "?"
        judge = f", VAR judge on {self.var_model}" if self.var_model else ""
        return f"{self.provider}: {self.model} at {host}{judge}"


def load_settings(env_file: Path | None = None, force_offline: bool = False) -> Settings:
    file_vals = _read_dotenv(env_file or ROOT / ".env")
    get = lambda k, d=None: os.environ.get(k) or file_vals.get(k) or d  # noqa: E731
    base_url = get("CHALK_BASE_URL")
    api_key = get("CHALK_API_KEY")
    model = get("CHALK_MODEL", "gpt-4.1-mini")
    conc = int(get("CHALK_MAX_CONCURRENCY", "3"))
    var_model = get("CHALK_VAR_MODEL") or None
    force_offline = force_offline or os.environ.get("CHALK_OFFLINE") == "1"
    if force_offline or not (base_url and api_key):
        return Settings("offline", None, None, "offline", conc)
    if not base_url.endswith("/"):
        base_url += "/"
    provider = "foundry" if ("azure.com" in base_url or "azure-api" in base_url) else "openai-compatible"
    return Settings(provider, base_url, api_key, model, conc, var_model)
