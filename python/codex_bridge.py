"""
codex_bridge — call OpenAI Codex from Python using your ChatGPT subscription.

No API key. No third-party packages. Authentication is whatever `codex login`
already stored in ~/.codex/, so this module never sees a credential.

    from codex_bridge import ask, image_prompt_for_article

    print(ask("Summarise this in two lines: ..."))

Drop-in for existing OpenAI code — run the HTTP bridge and repoint the client:

    from openai import OpenAI
    client = OpenAI(base_url="http://127.0.0.1:8765/v1", api_key="unused")
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

__all__ = ["ask", "image_prompt_for_article", "status", "CodexError", "CodexRateLimit", "CodexResult"]

_SAFE_MODEL = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_SANDBOXES = {"read-only", "workspace-write", "danger-full-access"}

DEFAULT_TIMEOUT = 180


class CodexError(RuntimeError):
    """Codex CLI was missing, unauthenticated, or failed to produce output."""


class CodexRateLimit(CodexError):
    """The ChatGPT plan's Codex allowance is exhausted. The message carries the reset time."""


@dataclass
class CodexResult:
    text: str
    returncode: int


def _codex_executable() -> str:
    exe = os.environ.get("CODEX_BIN") or shutil.which("codex")
    if not exe:
        raise CodexError(
            "Codex CLI not found on PATH. Install it with:\n"
            "    npm install -g @openai/codex\n"
            "then authenticate with:\n"
            "    codex login"
        )
    return exe


def ask(
    prompt: str,
    *,
    model: Optional[str] = None,
    sandbox: str = "read-only",
    cwd: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Run one non-interactive Codex turn and return its final message."""
    return run(prompt, model=model, sandbox=sandbox, cwd=cwd, timeout=timeout).text


def run(
    prompt: str,
    *,
    model: Optional[str] = None,
    sandbox: str = "read-only",
    cwd: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> CodexResult:
    if not isinstance(prompt, str) or not prompt.strip():
        raise CodexError("prompt must be a non-empty string")
    if model is not None and not _SAFE_MODEL.match(model):
        raise CodexError(f"Invalid model name: {model!r}")
    if sandbox not in _SANDBOXES:
        raise CodexError(f"Invalid sandbox mode: {sandbox!r}")

    exe = _codex_executable()

    with tempfile.TemporaryDirectory(prefix="codex-bridge-") as tmp:
        out_file = Path(tmp) / "last-message.txt"
        args = [
            exe,
            "exec",
            "--sandbox",
            sandbox,
            "--skip-git-repo-check",
            "--output-last-message",
            str(out_file),
        ]
        if model:
            args += ["--model", model]
        args.append("-")  # prompt arrives on stdin, never as an argv element

        try:
            proc = subprocess.run(
                args,
                input=prompt,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=cwd,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.TimeoutExpired as exc:
            raise CodexError(f"Codex timed out after {timeout}s") from exc

        text = out_file.read_text(encoding="utf-8").strip() if out_file.exists() else ""

    if not text:
        # Codex prints its errors to stdout, not stderr, so search both.
        combined = re.sub(r"\x1b\[[0-9;]*m", "", f"{proc.stderr or ''}\n{proc.stdout or ''}")

        if re.search(r"not logged in|codex login|unauthorized|401", combined, re.I):
            raise CodexError(
                "Codex is not authenticated. Run `codex login` and sign in with your ChatGPT plan."
            )

        limit = re.search(r"You've hit your usage limit[^\n]*", combined, re.I)
        if limit:
            raise CodexRateLimit(f"ChatGPT plan limit reached. {limit.group(0).strip()}")

        first_error = re.search(r"^\s*ERROR:\s*(.+)$", combined, re.I | re.M)
        if first_error:
            raise CodexError(f"Codex error: {first_error.group(1).strip()}")
        raise CodexError(
            f"Codex produced no output (exit {proc.returncode}). {combined.strip()[:500]}"
        )

    return CodexResult(text=text, returncode=proc.returncode)


def status() -> dict:
    """Report whether the CLI is installed and logged in."""
    try:
        exe = _codex_executable()
    except CodexError as exc:
        return {"installed": False, "logged_in": False, "detail": str(exc)}

    proc = subprocess.run(
        [exe, "login", "status"],
        capture_output=True,
        text=True,
        timeout=30,
        encoding="utf-8",
        errors="replace",
    )
    out = f"{proc.stdout}{proc.stderr}".strip()
    return {
        "installed": True,
        "logged_in": proc.returncode == 0 and not re.search(r"not logged in", out, re.I),
        "detail": out[:400],
    }


IMAGE_PROMPT_RULES = """You write prompts for an image generator that will illustrate a news article.

Rules, all mandatory:
- Output ONE prompt, as a single line of plain English. No preamble, no quotes, no explanation, no markdown.
- Describe a concrete, photographable scene - what a press photographer would have shot. Never an abstract concept.
- Never depict real, named individuals. For a story about a specific person, describe the setting instead (the office, the building, the crowd).
- Never depict a violent or humiliating act. Show aftermath, venue, or institutional context.
- Name the correct region explicitly (e.g. "Indian setting") so the model does not default to a Western scene.
- Use "sharp focus, high detail, crisp". Never "shallow depth of field", "bokeh", or "soft focus".
- Ask for a wide 16:9 composition with clear space for a headline overlay.
- End with exactly: absolutely no text, no letters, no words, no signage copy, no watermark, no logo"""


def image_prompt_for_article(article: str, *, style: str = "editorial", **kwargs) -> str:
    """Turn article text (any language) into one image-generation prompt."""
    prompt = (
        f"{IMAGE_PROMPT_RULES}\n\nPreferred style: {style}\n\n"
        f"--- ARTICLE ---\n{article}\n--- END ARTICLE ---\n\nThe prompt:"
    )
    text = ask(prompt, **kwargs)
    text = re.sub(r"^```[a-z]*\s*", "", text, flags=re.I)
    text = re.sub(r"```$", "", text)
    return text.strip().strip('"').strip("'").strip()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Call Codex using your ChatGPT subscription.")
    parser.add_argument("prompt", nargs="?", help="Prompt text. Omit to read stdin.")
    parser.add_argument("--model")
    parser.add_argument("--status", action="store_true", help="Show auth status and exit.")
    parser.add_argument("--image-prompt", action="store_true", help="Treat input as an article.")
    args = parser.parse_args()

    if args.status:
        print(json.dumps(status(), indent=2))
        raise SystemExit(0)

    import sys

    text = args.prompt if args.prompt else sys.stdin.read()
    if not text.strip():
        parser.error("no prompt given")

    try:
        if args.image_prompt:
            print(image_prompt_for_article(text, model=args.model))
        else:
            print(ask(text, model=args.model))
    except CodexError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
