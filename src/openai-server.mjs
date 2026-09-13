#!/usr/bin/env node
/**
 * An OpenAI-compatible HTTP endpoint backed by your ChatGPT subscription.
 *
 * The point of speaking the OpenAI wire format is that existing code does not
 * need to know this exists: point any OpenAI SDK at the base URL and it works,
 * authenticated by `codex login` rather than by an API key.
 *
 *   from openai import OpenAI
 *   client = OpenAI(base_url="http://127.0.0.1:8765/v1", api_key="unused")
 *
 * Binds to loopback only. This process can run a coding agent on your machine,
 * so do not expose it to a network you do not control.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { runCodex, codexStatus, messagesToPrompt, CodexError } from "./codex.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const TOKEN = process.env.BRIDGE_TOKEN || "";
const DEFAULT_MODEL = process.env.BRIDGE_MODEL || "";
const MAX_BODY = 10 * 1024 * 1024;

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendError(res, status, message, type = "invalid_request_error") {
  send(res, status, { error: { message, type } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Rough token estimate — Codex does not report usage, and callers expect the field. */
const estimateTokens = (s) => Math.ceil((s || "").length / 4);

function authorized(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || "";
  const provided = header.replace(/^Bearer\s+/i, "").trim();
  return provided === TOKEN;
}

async function handleChatCompletions(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendError(res, 400, "Request body is not valid JSON");
  }

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return sendError(res, 400, "`messages` must be a non-empty array");
  }

  const prompt = messagesToPrompt(messages);
  if (!prompt.trim()) return sendError(res, 400, "`messages` contained no usable content");

  const requested = payload.model && payload.model !== "codex" ? payload.model : DEFAULT_MODEL;
  const model = requested || undefined;

  const result = await runCodex({
    prompt,
    model,
    sandbox: process.env.BRIDGE_SANDBOX || "read-only",
    timeoutMs: Number(process.env.BRIDGE_TIMEOUT_MS || 180_000),
  });

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = {
    prompt_tokens: estimateTokens(prompt),
    completion_tokens: estimateTokens(result.text),
    total_tokens: estimateTokens(prompt) + estimateTokens(result.text),
  };

  if (payload.stream) {
    // Codex returns a completed turn, not a token stream. The SSE framing is
    // real so streaming clients work unmodified, but the text arrives at once.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const base = { id, object: "chat.completion.chunk", created, model: payload.model || "codex" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  send(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: payload.model || "codex",
    choices: [
      { index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" },
    ],
    usage,
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (path === "/health" || path === "/") {
      const status = await codexStatus();
      return send(res, status.loggedIn ? 200 : 503, {
        ok: status.loggedIn,
        codex: status,
        hint: status.loggedIn ? undefined : "Run `codex login` to authenticate with your ChatGPT plan.",
      });
    }

    if (!authorized(req)) return sendError(res, 401, "Invalid bridge token", "authentication_error");

    if (path === "/v1/models" && req.method === "GET") {
      return send(res, 200, {
        object: "list",
        data: [{ id: "codex", object: "model", created: 0, owned_by: "openai-codex-cli" }],
      });
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      const body = await readBody(req);
      return await handleChatCompletions(req, res, body);
    }

    return sendError(res, 404, `No route for ${req.method} ${path}`);
  } catch (err) {
    if (err instanceof CodexError) {
      if (err.rateLimited) {
        return sendError(res, 429, err.message, "rate_limit_error");
      }
      const unauth = /not authenticated|codex login/i.test(err.message);
      return sendError(res, unauth ? 401 : 502, err.message, unauth ? "authentication_error" : "api_error");
    }
    return sendError(res, 500, err?.message || "Internal error", "api_error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`codex-bridge listening on http://${HOST}:${PORT}`);
  console.log(`  base_url for OpenAI SDKs:  http://${HOST}:${PORT}/v1`);
  console.log(`  auth: ChatGPT subscription via \`codex login\` (no API key)`);
  if (!TOKEN) console.log("  note: BRIDGE_TOKEN unset — any local process can call this.");
  codexStatus().then((s) => {
    if (!s.installed) console.warn("  WARNING: codex CLI not found on PATH.");
    else if (!s.loggedIn) console.warn("  WARNING: not logged in. Run `codex login`.");
  });
});
