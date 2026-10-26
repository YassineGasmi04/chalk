"""Photorealistic portraits for CHALK's fictional players, generated in Microsoft Foundry.

Every player in CHALK is invented, so every portrait is of a person who does not exist:
an image model deployed in your Foundry project draws each one from a text description
(age, look, the club's shirt colour and number). No real players, no real photos, no logos.

    python scripts/generate_portraits.py --dry-run         # print the prompts, no calls
    python scripts/generate_portraits.py                   # all 28 players (skips existing)
    python scripts/generate_portraits.py --only h9 --force # redo one player

Settings: the same CHALK_BASE_URL and CHALK_API_KEY as the crew, plus CHALK_IMAGE_MODEL
(your image deployment's name) in .env. Output: web/portraits/<player id>.webp and a
manifest.json the app reads; players without a portrait keep their illustrated one.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chalk.agents.config import ROOT, _read_dotenv, load_settings  # noqa: E402

OUT = ROOT / "web" / "portraits"
SKIN = ["fair", "light", "light olive", "olive", "medium brown", "brown", "dark brown", "deep brown"]
HAIR = ["short black hair", "a short fade", "a buzz cut", "short curly dark hair", "a shaved head",
        "short brown hair swept back", "dark hair tied in a small bun", "short blond hair",
        "tight black curls", "short wavy auburn hair"]
FACE = ["clean-shaven", "clean-shaven", "light stubble", "a short trimmed beard", "a neat full beard"]
COLOURS = {  # nearest plain colour name for a club colour
    "orange-red": (228, 87, 46), "steel blue": (46, 134, 171), "crimson": (200, 16, 46),
    "navy blue": (20, 40, 90), "sky blue": (100, 180, 230), "royal blue": (30, 70, 200),
    "white": (240, 240, 240), "black": (20, 20, 20), "yellow": (240, 210, 40), "green": (30, 150, 70),
    "claret": (120, 20, 50), "purple": (90, 30, 140),
}


def colour_name(hex_colour: str) -> str:
    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    return min(COLOURS, key=lambda k: sum((x - y) ** 2 for x, y in zip(COLOURS[k], (r, g, b))))


def prompt_for(player: dict, team: dict) -> str:
    """A description of a person who does not exist, the same every time for this player."""
    rnd = random.Random(int(hashlib.sha256(player["pid"].encode()).hexdigest(), 16))
    age = rnd.randint(19, 34)
    keeper = player["position"] == "GK"
    shirt = "bright green goalkeeper" if keeper else colour_name(team["color"])
    return (
        "Photorealistic sports media-day portrait photo of a fictional professional footballer "
        f"who does not exist. A {age}-year-old man with {rnd.choice(SKIN)} skin, {rnd.choice(HAIR)} "
        f"and {rnd.choice(FACE)}. Head and shoulders, centred, facing the camera with a confident, "
        f"neutral expression. He wears a plain {shirt} football shirt with the number "
        f"{player['number']} on the chest. No logos, no badges, no sponsor, no other text. "
        "Plain smooth dark purple studio background, soft key light, sharp focus, 85mm lens."
    )


def roster() -> list[tuple[dict, dict]]:
    first = json.loads((ROOT / "data" / "match_4.jsonl").read_text(encoding="utf-8").splitlines()[0])
    return [(p, first[s]) for s in ("home", "away") for p in first[s]["players"] + first[s]["bench"]]


def save(png: bytes, path: Path) -> None:
    from PIL import Image  # pip install pillow
    im = Image.open(io.BytesIO(png)).convert("RGB")
    side = min(im.size)
    im = im.crop(((im.width - side) // 2, (im.height - side) // 2, (im.width + side) // 2, (im.height + side) // 2))
    im.resize((384, 384), Image.LANCZOS).save(path, "WEBP", quality=82, method=6)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only", help="one player id, e.g. h9")
    ap.add_argument("--force", action="store_true", help="regenerate existing portraits")
    ap.add_argument("--dry-run", action="store_true", help="print the prompts only")
    ap.add_argument("--quality", default="medium", help="image quality (low, medium, high) where supported")
    args = ap.parse_args()

    players = [(p, t) for p, t in roster() if not args.only or p["pid"] == args.only]
    if args.dry_run:
        for p, t in players:
            print(f"{p['pid']:>4}  {prompt_for(p, t)}\n")
        return

    settings = load_settings()
    model = os.environ.get("CHALK_IMAGE_MODEL") or _read_dotenv(ROOT / ".env").get("CHALK_IMAGE_MODEL")
    if not settings.online or not model:
        sys.exit("Set CHALK_BASE_URL, CHALK_API_KEY and CHALK_IMAGE_MODEL (your image deployment's name) in .env.")
    from openai import OpenAI
    client = OpenAI(base_url=settings.base_url, api_key=settings.api_key)
    OUT.mkdir(parents=True, exist_ok=True)
    made, failed = 0, 0
    for p, t in players:
        path = OUT / f"{p['pid']}.webp"
        if path.exists() and not args.force:
            continue
        print(f"{p['pid']:>4}  {p['name']} ... ", end="", flush=True)
        try:
            extra = {"response_format": "b64_json"} if model.lower().startswith("dall-e") else {"quality": args.quality}
            resp = client.images.generate(model=model, prompt=prompt_for(p, t), size="1024x1024", n=1, **extra)
            b64 = resp.data[0].b64_json
            if not b64:
                raise RuntimeError("the model returned no image data")
            save(base64.b64decode(b64), path)
            made += 1
            print("ok")
        except Exception as err:  # keep going: a player without a photo keeps the illustration
            failed += 1
            msg = str(err)
            print(f"FAILED: {msg[:200]}")
            if "DeploymentNotFound" in msg or "404" in msg:
                sys.exit(f"\nNo image deployment named '{model}' at {settings.base_url}. "
                         "Deploy an image generation model in your Foundry project and put its name in CHALK_IMAGE_MODEL.")
    pids = sorted(f.stem for f in OUT.glob("*.webp"))
    (OUT / "manifest.json").write_text(json.dumps({
        "pids": pids, "model": model,
        "note": "AI-generated portraits of fictional people who do not exist",
    }, indent=1), encoding="utf-8")
    print(f"\n{made} new portraits, {failed} failed, {len(pids)} in web/portraits. Reload the app to see them.")


if __name__ == "__main__":
    main()
