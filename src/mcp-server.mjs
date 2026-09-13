#!/usr/bin/env node
/**
 * MCP stdio server exposing ChatGPT-subscription-backed Codex as tools.
 *
 * Zero dependencies — MCP over stdio is newline-delimited JSON-RPC 2.0, which is
 * small enough that pulling in an SDK would be more code than implementing it.
 *
 * Register with Claude Code:
 *   claude mcp add codex -- node <abs path>/src/mcp-server.mjs
 */

import { runCodex, codexStatus } from "./codex.mjs";

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "codex_ask",
    description:
      "Ask OpenAI Codex (authenticated by your ChatGPT subscription, no API key) a question. " +
      "Use for text reasoning: summarizing, translating, rewriting, drafting, analysis.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The full prompt to send." },
        model: { type: "string", description: "Optional model override, e.g. gpt-5.1-codex-max." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "codex_image_prompt",
    description:
      "Turn a news article (raw text) into a single publication-ready image-generation prompt. " +
      "Returns only the prompt text, ready to pass to an image backend.",
    inputSchema: {
      type: "object",
      properties: {
        article: { type: "string", description: "Article text, any language." },
        style: {
          type: "string",
          description: "editorial | photo | illustration | poster",
          default: "editorial",
        },
      },
      required: ["article"],
    },
  },
];

const IMAGE_PROMPT_RULES = `You write prompts for an image generator that will illustrate a news article.

Rules, all mandatory:
- Output ONE prompt, as a single line of plain English. No preamble, no quotes, no explanation, no markdown.
- Describe a concrete, photographable scene — what a press photographer would have shot. Never an abstract concept.
- Never depict real, named individuals. For a story about a specific person, describe the setting instead (the office, the building, the crowd).
- Never depict a violent or humiliating act. Show aftermath, venue, or institutional context.
- Name the correct region explicitly (e.g. "Indian setting") so the model does not default to a Western scene.
- Use "sharp focus, high detail, crisp". Never "shallow depth of field", "bokeh", or "soft focus".
- Ask for a wide 16:9 composition with clear space for a headline overlay.
- End with exactly: absolutely no text, no letters, no words, no signage copy, no watermark, no logo`;

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolText(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(name, args) {
  if (name === "codex_ask") {
    if (!args?.prompt) return toolText("`prompt` is required.", true);
    const { text } = await runCodex({ prompt: args.prompt, model: args.model });
    return toolText(text);
  }

  if (name === "codex_image_prompt") {
    if (!args?.article) return toolText("`article` is required.", true);
    const style = args.style || "editorial";
    const prompt =
      `${IMAGE_PROMPT_RULES}\n\nPreferred style: ${style}\n\n--- ARTICLE ---\n${args.article}\n--- END ARTICLE ---\n\nThe prompt:`;
    const { text } = await runCodex({ prompt });
    // The model occasionally wraps the line in quotes or a code fence anyway.
    const cleaned = text.replace(/^```[a-z]*\s*/i, "").replace(/```$/, "").replace(/^["']|["']$/g, "").trim();
    return toolText(cleaned);
  }

  return toolText(`Unknown tool: ${name}`, true);
}

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "codex-bridge", version: "1.0.0" },
      });

    case "notifications/initialized":
      return; // notification, no response

    case "ping":
      return reply(id, {});

    case "tools/list":
      return reply(id, { tools: TOOLS });

    case "tools/call": {
      const status = await codexStatus();
      if (!status.installed) {
        return reply(id, toolText("Codex CLI not found. Install: npm install -g @openai/codex", true));
      }
      if (!status.loggedIn) {
        return reply(id, toolText("Codex is not logged in. Run `codex login` and sign in with your ChatGPT plan.", true));
      }
      try {
        return reply(id, await callTool(params?.name, params?.arguments || {}));
      } catch (err) {
        return reply(id, toolText(`Codex error: ${err.message}`, true));
      }
    }

    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = "";
let inFlight = 0;
let stdinClosed = false;

function maybeExit() {
  // Only leave once stdin is done AND every request has been answered —
  // exiting on "end" alone truncates replies when input is piped.
  if (stdinClosed && inFlight === 0) process.exit(0);
}

function track(promise, id) {
  inFlight++;
  promise
    .catch((err) => replyError(id, -32603, err.message))
    .finally(() => {
      inFlight--;
      maybeExit();
    });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore malformed frames rather than killing the server
    }
    track(handle(msg), msg?.id);
  }
});

process.stdin.on("end", () => {
  stdinClosed = true;
  maybeExit();
});
