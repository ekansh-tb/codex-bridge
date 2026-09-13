# Deploying codex-bridge

Two distinct scenarios. Pick the right one — they have very different licensing
implications.

## Read this before distributing

**Each person authenticates with their own ChatGPT account.** That is the supported
model: you ship the tool, each developer runs `codex login` and spends their own plan's
allowance. Distributing the tool to your team this way is fine.

**Do not run one shared ChatGPT account as a backend for the team or for production
traffic.** ChatGPT plans are individual-use subscriptions for interactive work, not API
capacity for an application. Serving your news portal's users through one personal
subscription would breach OpenAI's terms and risks the account being suspended. If you
need a backend for production, that is what the platform API (pay-as-you-go key) is for.

Rule of thumb: this is a **developer tool**, not application infrastructure.

Also note the quota is per account — installing on five machines under one login does not
give five allowances, it shares one.

---

## 1. Team distribution (each dev, own account)

### Push it somewhere

```bash
cd codex-bridge
git init && git add -A
git commit -m "codex-bridge: ChatGPT-subscription LLM access"
git remote add origin git@github.com:<your-org>/codex-bridge.git
git push -u origin main
```

### As a Claude Code plugin

Each teammate runs:

```
/plugin marketplace add <your-org>/codex-bridge
/plugin install codex-bridge
```

That registers the Codex MCP tools (`codex_ask`, `codex_image_prompt`) automatically via
`.mcp.json` — no manual MCP config per person.

Then, once each:

```bash
npm install -g @openai/codex
codex login
```

### As a global CLI

```bash
npm install -g git+https://github.com/<your-org>/codex-bridge.git
codex-bridge          # starts the OpenAI-compatible server
codex-bridge-mcp      # MCP stdio server
```

### Verify

```bash
npm run doctor
```

---

## 2. Dev server (headless Linux)

### Install

```bash
# Node 18+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo npm install -g @openai/codex
git clone https://github.com/<your-org>/codex-bridge.git /opt/codex-bridge
```

### Authenticate without a browser

The server has no browser, so use the device flow:

```bash
codex login --device-auth
```

It prints a short code and a URL. Open that URL on your laptop, enter the code, done.
Credentials land in `~/.codex/auth.json` for the user that ran the command — note that,
because the systemd unit below must run as the same user.

> Copying `~/.codex/auth.json` from your laptop also works, but treat that file as a
> credential: `chmod 600`, never commit it, and remember it identifies *you*.

### Run as a service

`/etc/systemd/system/codex-bridge.service`:

```ini
[Unit]
Description=codex-bridge (OpenAI-compatible endpoint over ChatGPT subscription)
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/codex-bridge
Environment=BRIDGE_HOST=127.0.0.1
Environment=BRIDGE_PORT=8765
Environment=BRIDGE_TOKEN=<generate a long random string>
Environment=BRIDGE_SANDBOX=read-only
ExecStart=/usr/bin/node /opt/codex-bridge/src/openai-server.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-bridge
curl http://127.0.0.1:8765/health
```

### Keep it on loopback

This process can execute a coding agent on the host. Do not bind it to `0.0.0.0`. If
another machine must reach it, tunnel over SSH rather than opening a port:

```bash
ssh -N -L 8765:127.0.0.1:8765 deploy@devserver
```

Set `BRIDGE_TOKEN` regardless — it stops other local users on a shared box from using it.

### Point your Python service at it

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8765/v1",
    api_key="unused",                       # ignored; auth is the codex session
    default_headers={"Authorization": "Bearer <BRIDGE_TOKEN>"},
)
```

---

## Operational notes

- **Rate limits surface as HTTP 429** with the reset time in the message. Handle it;
  do not retry in a tight loop.
- **Latency is seconds, not milliseconds** — Codex spawns a process and runs an agent
  turn. Queue bulk work; do not call it inline on a web request.
- **Concurrency**: each request spawns a `codex exec` process. Put a worker limit in front
  of it if you plan to fan out.
- **Upgrades**: `sudo npm update -g @openai/codex`, then `npm run doctor`.
