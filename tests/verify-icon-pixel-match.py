#!/usr/bin/env python3
"""Verify pixel equivalence between FFXIV Collect icon assets and Lodestone icons.

This mirrors the client-side Canvas SHA-256 comparison for two known public
collection items. It does not execute remote content.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import requests
from PIL import Image

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; EorzeaCollectionLedger/4.0)", "Accept-Language": "ja,en;q=0.8"}


def fetch(url: str) -> bytes:
    response = requests.get(url, headers=HEADERS, timeout=45)
    response.raise_for_status()
    return response.content


def standard_png(icon_url: str) -> str:
    parsed = urlparse(icon_url)
    query = parse_qs(parsed.query)
    path = query["path"][0].replace("_hr1.tex", ".tex")
    return f"https://v2.xivapi.com/api/asset?{urlencode({'format': 'png', 'path': path})}"


def pixel_hash(url: str) -> str:
    image = Image.open(io.BytesIO(fetch(url))).convert("RGBA")
    if image.size != (40, 40):
        image = image.resize((40, 40))
    canvas = Image.new("RGBA", (16, 16), (0, 0, 0, 255))
    image = image.resize((16, 16))
    canvas.alpha_composite(image)
    luminance = [(r * 299 + g * 587 + b * 114) / 1000 for r, g, b, _ in canvas.getdata()]
    mean = sum(luminance) / len(luminance)
    return "".join(format(sum((1 if luminance[i + bit] >= mean else 0) << (3 - bit) for bit in range(4)), "x") for i in range(0, len(luminance), 4))


def main() -> int:
    character_id = sys.argv[1] if len(sys.argv) > 1 else "25961161"
    masters = {}
    for kind in ("mounts", "minions"):
        masters[kind] = requests.get(f"https://ffxivcollect.com/api/{kind}?language=ja", timeout=45).json()["results"]
    pages = {
        "mounts": f"https://jp.finalfantasyxiv.com/lodestone/character/{character_id}/mount/",
        "minions": f"https://jp.finalfantasyxiv.com/lodestone/character/{character_id}/minion/",
    }
    expected = {"mounts": "マイチョコボ", "minions": "チョコチョコボ"}
    outcome = {}
    for kind in ("mounts", "minions"):
        record = next(x for x in masters[kind] if x["name"] == expected[kind])
        html = fetch(pages[kind]).decode("utf-8", "replace")
        icon = re.search(r'https://lds-img\.finalfantasyxiv\.com/itemicon/[^?" ]+', html).group(0)
        master_url = standard_png(record["icon"])
        left, right = pixel_hash(master_url), pixel_hash(icon)
        distance = sum((int(a, 16) ^ int(b, 16)).bit_count() for a, b in zip(left, right))
        assert distance <= 4, f"{kind} visual-signature distance is too high: {distance}; master={master_url} lodestone={icon}"
        outcome[kind] = {"name": record["name"], "master_signature": left, "lodestone_signature": right, "distance": distance}
    print(json.dumps(outcome, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
