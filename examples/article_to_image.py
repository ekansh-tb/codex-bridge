"""
End-to-end: news article URL -> ChatGPT-subscription reasoning -> generated image.

The split that makes this work without any API key:
  - Codex (your ChatGPT plan) reads the article and writes the image prompt.
  - The image backend only rasterises that prompt.

Usage:
    python article_to_image.py https://primetime24.in/mr/story/<slug>/
"""

import json
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from codex_bridge import CodexError, image_prompt_for_article, status  # noqa: E402

# The renderer built earlier; adjust if you moved it.
NEWSIMG = Path(__file__).resolve().parents[2] / "article-image-plugin" / "scripts" / "newsimg.mjs"


def fetch_article_text(url: str) -> str:
    """Pull the article's own text via the renderer's --describe mode."""
    proc = subprocess.run(
        ["node", str(NEWSIMG), "--url", url, "--describe", "--json"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise SystemExit(f"Could not read the article: {proc.stderr.strip()}")

    meta = json.loads(proc.stdout)["article"]
    text = f"{meta.get('title', '')}\n\n{meta.get('description', '')}".strip()
    if not text:
        raise SystemExit("Article had no title or description — is the URL live?")
    return text


def render(prompt: str, out: Path) -> None:
    proc = subprocess.run(
        ["node", str(NEWSIMG), "--prompt", prompt, "--size", "1200x675", "--out", str(out)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise SystemExit(f"Image generation failed: {proc.stderr.strip()}")
    print(proc.stdout.strip())


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    url = sys.argv[1]

    auth = status()
    if not auth["logged_in"]:
        raise SystemExit("Codex is not logged in. Run: codex login")

    print(f"Reading {url} ...")
    article = fetch_article_text(url)
    print(f"  {article.splitlines()[0][:90]}")

    print("Asking Codex for an image prompt ...")
    try:
        prompt = image_prompt_for_article(article)
    except CodexError as exc:
        raise SystemExit(f"Codex failed: {exc}")
    print(f"  {prompt[:160]}...")

    slug = url.rstrip("/").split("/")[-1][:60] or "article"
    out = Path("output") / f"{slug}.jpg"
    print("Generating image ...")
    render(prompt, out)


if __name__ == "__main__":
    main()
