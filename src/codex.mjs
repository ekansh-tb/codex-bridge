/**
 * Core wrapper around the Codex CLI.
 *
 * Auth model: none of this handles credentials. `codex login` performs an OAuth
 * browser flow against your ChatGPT plan and stores the result in ~/.codex/.
 * Every call here reuses that session, so there is no API key anywhere in this
 * codebase and nothing to leak.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, delimiter } from "node:path";

const IS_WIN = process.platform === "win32";

/**
 * Resolve how to invoke Codex.
 *
 * The npm package's bin is a plain Node script, so when we can find it we spawn
 * it with our own node binary: no shell, and it works even when the npm global
 * bin directory is missing from PATH (common on Windows until the terminal is
 * reopened). Falling back to the PATH lookup keeps non-npm installs working.
 */
let cachedInvocation;

function resolveCodex() {
  if (cachedInvocation) return cachedInvocation;

  const override = process.env.CODEX_BIN;
  if (override && existsSync(override)) {
    cachedInvocation = override.endsWith(".js")
      ? { cmd: process.execPath, prefix: [override], shell: false }
      : { cmd: override, prefix: [], shell: false };
    return cachedInvocation;
  }

  const roots = [];
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
  if (process.env.npm_config_prefix) {
    roots.push(join(process.env.npm_config_prefix, "node_modules"));
    roots.push(join(process.env.npm_config_prefix, "lib", "node_modules"));
  }
  roots.push(
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    join(homedir(), ".npm-global", "lib", "node_modules"),
    join(homedir(), "AppData", "Roaming", "npm", "node_modules")
  );
  // Also probe next to any `codex` shim already on PATH.
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir) roots.push(join(dir, "node_modules"));
  }

  for (const root of roots) {
    const entry = join(root, "@openai", "codex", "bin", "codex.js");
    if (existsSync(entry)) {
      cachedInvocation = { cmd: process.execPath, prefix: [entry], shell: false };
      return cachedInvocation;
    }
  }

  // Last resort: whatever `codex` is on PATH. On Windows that is a .cmd shim,
  // which Node will only run through a shell.
  cachedInvocation = { cmd: "codex", prefix: [], shell: IS_WIN };
  return cachedInvocation;
}

// The prompt travels over stdin, never as an argv element, so article text
// cannot break out into the shell. Everything that DOES reach argv is
// validated against a strict allowlist below.
const SAFE_MODEL = /^[A-Za-z0-9._-]{1,64}$/;
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

export class CodexError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.name = "CodexError";
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Run a single non-interactive Codex turn and return its final message.
 *
 * @param {object} opts
 * @param {string} opts.prompt        The full prompt (sent via stdin).
 * @param {string} [opts.model]       e.g. "gpt-5.1-codex-max". Omit to use the configured default.
 * @param {string} [opts.sandbox]     read-only (default) | workspace-write | danger-full-access
 * @param {string} [opts.cwd]         Working directory for the agent.
 * @param {number} [opts.timeoutMs]   Default 180000.
 * @returns {Promise<{text: string, durationMs: number}>}
 */
export async function runCodex({
  prompt,
  model,
  sandbox = "read-only",
  cwd = process.cwd(),
  timeoutMs = 180_000,
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new CodexError("prompt must be a non-empty string");
  }
  if (model !== undefined && !SAFE_MODEL.test(model)) {
    throw new CodexError(`Invalid model name: ${JSON.stringify(model)}`);
  }
  if (!SANDBOX_MODES.has(sandbox)) {
    throw new CodexError(`Invalid sandbox mode: ${JSON.stringify(sandbox)}`);
  }

  const dir = await mkdtemp(join(tmpdir(), "codex-bridge-"));
  const outFile = join(dir, "last-message.txt");
  const started = Date.now();

  try {
    const args = [
      "exec",
      "--sandbox", sandbox,
      "--skip-git-repo-check",
      "--output-last-message", outFile,
    ];
    if (model) args.push("--model", model);
    args.push("-"); // read the prompt from stdin

    const { stdout, stderr, code } = await spawnCodex(args, prompt, cwd, timeoutMs);

    let text = "";
    try {
      text = (await readFile(outFile, "utf8")).trim();
    } catch {
      /* file absent — handled below */
    }

    if (!text) {
      // Codex prints its errors to stdout, not stderr, so search both.
      const combined = `${stderr}\n${stdout}`.replace(/\x1b\[[0-9;]*m/g, "");

      if (/not logged in|please run .*codex login|unauthorized|401/i.test(combined)) {
        throw new CodexError(
          "Codex is not authenticated. Run `codex login` and sign in with your ChatGPT plan.",
          { code, stderr: combined }
        );
      }

      const limit = combined.match(/You've hit your usage limit[^\n]*/i);
      if (limit) {
        const err = new CodexError(
          `ChatGPT plan limit reached. ${limit[0].trim()}`,
          { code, stderr: combined }
        );
        err.rateLimited = true;
        throw err;
      }

      const firstError = combined.match(/^\s*ERROR:\s*(.+)$/im);
      throw new CodexError(
        firstError
          ? `Codex error: ${firstError[1].trim()}`
          : `Codex produced no output (exit ${code}). ${combined.trim().slice(0, 500)}`,
        { code, stderr: combined }
      );
    }

    return { text, durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnCodex(args, stdinData, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const { cmd, prefix, shell } = resolveCodex();
      child = spawn(cmd, [...prefix, ...args], {
        cwd,
        // Only true in the PATH-shim fallback on Windows. Safe regardless: the
        // prompt travels over stdin and every argv value is allowlist-validated.
        shell,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return reject(new CodexError(`Failed to start codex: ${err.message}`));
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new CodexError(`Codex timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint =
        err.code === "ENOENT"
          ? "Codex CLI not found on PATH. Install it with: npm install -g @openai/codex"
          : err.message;
      reject(new CodexError(hint));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    child.stdin.on("error", () => {});
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

/** Check whether the CLI is installed and logged in. */
export async function codexStatus() {
  try {
    const { stdout, stderr, code } = await spawnCodex(["login", "status"], "", process.cwd(), 20_000);
    const out = `${stdout}${stderr}`.trim();
    return {
      installed: true,
      loggedIn: code === 0 && !/not logged in/i.test(out),
      detail: out.slice(0, 400),
    };
  } catch (err) {
    return { installed: false, loggedIn: false, detail: err.message };
  }
}

/** Flatten OpenAI-style chat messages into one prompt for `codex exec`. */
export function messagesToPrompt(messages) {
  const parts = [];
  for (const m of messages) {
    const content = Array.isArray(m.content)
      ? m.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("")
      : String(m.content ?? "");
    if (!content.trim()) continue;
    if (m.role === "system") parts.push(`[System instructions]\n${content}`);
    else if (m.role === "assistant") parts.push(`[Assistant]\n${content}`);
    else parts.push(`[User]\n${content}`);
  }
  return parts.join("\n\n");
}
