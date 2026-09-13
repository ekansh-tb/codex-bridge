#!/usr/bin/env node
/** One-off prompt runner. Reads the prompt from argv or stdin, prints the reply. */

import { runCodex, CodexError } from "./codex.mjs";

const args = process.argv.slice(2);
let model;
const modelIdx = args.indexOf("--model");
if (modelIdx !== -1) {
  model = args[modelIdx + 1];
  args.splice(modelIdx, 2);
}

const inline = args.join(" ").trim();

const prompt = inline || (await readStdin());
if (!prompt.trim()) {
  console.error('Usage: codex-cli "your prompt"   |   echo "prompt" | codex-cli');
  process.exit(1);
}

try {
  const { text } = await runCodex({ prompt, model });
  console.log(text);
} catch (err) {
  console.error(err instanceof CodexError ? err.message : String(err));
  process.exit(err?.rateLimited ? 429 : 1);
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}
