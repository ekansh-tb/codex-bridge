---
name: codex-bridge
description: Delegate a text/reasoning task to OpenAI Codex using the user's own ChatGPT subscription (no API key) — via MCP tools, the local OpenAI-compatible endpoint, or the CLI. Use when the user wants a second model's opinion, wants to offload bulk text work, or asks to "use my ChatGPT/Codex subscription".
---

# codex-bridge

Runs prompts through the Codex CLI, authenticated by the user's ChatGPT plan. No API key
is involved anywhere.

## Before using

Check auth first — every failure mode below is a setup problem, not a prompt problem:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/doctor.mjs"
```

| Symptom | Fix |
|---|---|
| `codex CLI not found` | `npm install -g @openai/codex` |
| `not logged in` | `codex login` (interactive; headless servers use `codex login --device-auth`) |
| `ChatGPT plan limit reached` | The account's allowance is exhausted — the message names the reset time. Free-tier accounts hit this almost immediately; Plus/Pro is needed for real use. Report it and stop; do not retry in a loop. |

## Three ways to call it

**MCP tools** (registered automatically by this plugin): `codex_ask`, `codex_image_prompt`.

**One-off from the shell:**

```bash
echo "your prompt" | node "${CLAUDE_PLUGIN_ROOT}/src/codex-cli.mjs"
```

**As an OpenAI endpoint**, when the user's own code needs to call it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/openai-server.mjs"   # http://127.0.0.1:8765/v1
```

## What it cannot do

**Image generation.** The ChatGPT subscription entitlement covers coding/reasoning models
only; `gpt-image-1` is platform-API-only. If the user asks for subscription-backed image
generation, say plainly that it does not exist rather than looking for a workaround — the
only "bridge" would be driving the ChatGPT web session with their cookies, which violates
OpenAI's terms and risks the account.

For images, use Codex to write the *prompt*, then a separate image backend to render it.

## Sandbox

Calls default to `--sandbox read-only`, so Codex cannot modify files. Only raise that
(`BRIDGE_SANDBOX=workspace-write`) if the user explicitly wants Codex editing code.
