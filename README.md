# codex-bridge

Use your **ChatGPT subscription** as an LLM backend from anywhere — no API key.

Authentication is entirely `codex login` (OAuth browser flow against your ChatGPT
Plus/Pro/Business plan). This codebase never sees a credential, and there is no key to
rotate or leak.

Three surfaces over one core:

| Surface | For | Entry point |
|---|---|---|
| **OpenAI-compatible HTTP API** | Any existing Python/JS code that speaks OpenAI | `npm run serve` |
| **MCP server** | Claude Code, Cursor, any MCP client | `src/mcp-server.mjs` |
| **Python module** | Direct calls, zero dependencies | `python/codex_bridge.py` |

Zero runtime dependencies. Node 18+.

---

## What this can and cannot do

**Can:** any text/reasoning task — summarize, translate, rewrite, classify, extract,
draft, write image prompts. Backed by your subscription, billed as part of it.

**Cannot: generate images.** The ChatGPT subscription entitlement that Codex uses covers
coding/reasoning models only. Image generation (`gpt-image-1`) is sold exclusively through
the pay-as-you-go platform API. Nothing can bridge that gap — a tool claiming to generate
images from a ChatGPT subscription would have to drive the ChatGPT web session with your
cookies, which breaks OpenAI's terms and risks the account. Not worth it, and not built
here.

So for article images the work splits cleanly:

```
article ──► Codex (your subscription) ──► image prompt ──► image backend ──► picture
            the reasoning: free to you                     the pixels
```

---

## Setup

```bash
npm install -g @openai/codex   # already installed
codex login                    # opens a browser, sign in with ChatGPT
npm run doctor                 # verifies install + login + makes a live test call
```

`codex login` is interactive and must be run by you. On Windows the npm global bin
(`%APPDATA%\npm`) may not be on PATH until you reopen the terminal — the bridge works
around this by locating the package directly, but the `codex login` command itself needs
PATH, so reopen your terminal if the shell cannot find `codex`.

---

## 1. Drop-in for existing Python services

Start the bridge:

```bash
npm run serve        # http://127.0.0.1:8765/v1
```

Any code already written against OpenAI works unchanged — just repoint it:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8765/v1", api_key="unused")

resp = client.chat.completions.create(
    model="codex",
    messages=[{"role": "user", "content": "Summarise this article in two lines: ..."}],
)
print(resp.choices[0].message.content)
```

`api_key` is required by the SDK but ignored by the bridge — the real auth is your
`codex login` session.

Endpoints: `POST /v1/chat/completions`, `GET /v1/models`, `GET /health`.

| Env var | Default | Purpose |
|---|---|---|
| `BRIDGE_PORT` | `8765` | Listen port |
| `BRIDGE_HOST` | `127.0.0.1` | Keep on loopback |
| `BRIDGE_TOKEN` | *(unset)* | Require `Authorization: Bearer <token>` |
| `BRIDGE_MODEL` | *(unset)* | Default model override |
| `BRIDGE_SANDBOX` | `read-only` | Codex filesystem permissions |
| `BRIDGE_TIMEOUT_MS` | `180000` | Per-request timeout |

**Streaming caveat:** `stream: true` is accepted and returns valid SSE so streaming
clients work, but Codex returns a completed turn — the text arrives in one chunk rather
than token by token.

**Security:** this process can run a coding agent on your machine. It binds to loopback
by default; keep it there, and set `BRIDGE_TOKEN` if other users share the box.

## 2. No server — call it directly from Python

```python
from codex_bridge import ask, image_prompt_for_article

print(ask("Translate to English: ..."))
print(image_prompt_for_article(marathi_article_text))
```

Also a CLI:

```bash
python python/codex_bridge.py --status
python python/codex_bridge.py "Write three headline options for: ..."
cat article.txt | python python/codex_bridge.py --image-prompt
```

> Python is not currently installed on this machine (`python` resolves to the Microsoft
> Store stub). Install from python.org or `winget install Python.Python.3.12` to use this
> surface. The HTTP and MCP surfaces work without it.

## 3. MCP server

```bash
claude mcp add codex -- node "C:/Users/ShubhamAgarwal/Desktop/testImage/codex-bridge/src/mcp-server.mjs"
```

For Cursor / other clients, in `mcp.json`:

```json
{
  "mcpServers": {
    "codex": {
      "command": "node",
      "args": ["C:/Users/ShubhamAgarwal/Desktop/testImage/codex-bridge/src/mcp-server.mjs"]
    }
  }
}
```

Tools: `codex_ask`, `codex_image_prompt`.

---

## End-to-end: article → image

```bash
python examples/article_to_image.py https://primetime24.in/mr/story/<slug>/
```

Codex reads the article and writes the prompt; `article-image-plugin/scripts/newsimg.mjs`
renders it. Editorial guardrails are enforced in the prompt template: no text in the
image, no generated likenesses of real named people, no depiction of the violent act.

## Layout

```
src/codex.mjs           core CLI wrapper (prompt over stdin, allowlisted argv)
src/openai-server.mjs   OpenAI-compatible HTTP endpoint
src/mcp-server.mjs      MCP stdio server
src/doctor.mjs          setup diagnostics
python/codex_bridge.py  stdlib-only Python client + CLI
examples/               article → image pipeline
```
