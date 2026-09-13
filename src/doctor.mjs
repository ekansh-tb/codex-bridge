#!/usr/bin/env node
/** Check that everything the bridge needs is present, and say exactly what to fix. */

import { codexStatus, runCodex } from "./codex.mjs";

const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

console.log("codex-bridge doctor\n");

console.log(`Node ${process.version}`);
if (Number(process.versions.node.split(".")[0]) >= 18) ok("Node 18+");
else bad("Node 18+ required");

const status = await codexStatus();

if (status.installed) ok("codex CLI found on PATH");
else {
  bad("codex CLI not found on PATH");
  console.log("\n  Fix:  npm install -g @openai/codex");
  console.log("  Windows note: the npm global bin may not be on PATH in this shell.");
  console.log("  It lives at %APPDATA%\\npm — reopen your terminal after installing.\n");
  process.exit(1);
}

if (status.loggedIn) ok("logged in with your ChatGPT plan");
else {
  bad(`not logged in — ${status.detail}`);
  console.log("\n  Fix:  codex login");
  console.log("  This opens a browser and signs in with ChatGPT Plus/Pro/Business.");
  console.log("  No API key is involved.\n");
  process.exit(1);
}

process.stdout.write("\nRunning a live test call... ");
try {
  const { text, durationMs } = await runCodex({
    prompt: "Reply with exactly the word: pong",
    timeoutMs: 120_000,
  });
  console.log(`done in ${(durationMs / 1000).toFixed(1)}s`);
  ok(`Codex replied: ${text.slice(0, 80)}`);
  console.log("\nEverything works. Start the HTTP bridge with:  npm run serve");
} catch (err) {
  console.log("failed");
  bad(err.message);
  process.exit(1);
}
