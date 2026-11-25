import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "./config";
import { isWin, shellCommand } from "./tools";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "OPENGATE.md"];

/** Project instructions: AGENTS.md / CLAUDE.md / OPENGATE.md from the working directory up to the home folder, plus the global one. */
export function projectInstructions(cwd: string): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  const home = homedir();
  const global = join(configDir(), "AGENTS.md");
  if (existsSync(global)) found.push({ path: global, text: readFileSync(global, "utf8") });
  const dirs: string[] = [];
  let d = cwd;
  for (let i = 0; i < 30; i++) {
    dirs.unshift(d);
    const up = dirname(d);
    if (up === d || d === home) break;
    d = up;
  }
  for (const dir of dirs)
    for (const f of INSTRUCTION_FILES) {
      const p = join(dir, f);
      if (existsSync(p)) {
        try {
          found.push({ path: p, text: readFileSync(p, "utf8").slice(0, 40_000) });
        } catch {}
        break; // one file per folder
      }
    }
  return found;
}

function isGitRepo(cwd: string): boolean {
  let d = cwd;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(d, ".git"))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
  return false;
}

/** Stable for the whole session (so the prefix caches): no clock times, no changing state. */
export function systemPrompt(cwd: string, date = new Date()): string {
  const shell = shellCommand("").name;
  const lines = [
    "You are opengate, a coding agent working in the person's project through their tools. You read and change code, run commands, and explain what you did.",
    "",
    "How to work:",
    "- Understand before changing: look at the relevant code first (glob, grep, read_file). Read a file before editing it.",
    "- Make the change the person asked for, and keep it focused. Match the project's existing style. Don't add unrequested features or refactors.",
    "- Prefer edit_file for changes to existing files; write_file for new files.",
    "- Check your work when you can: run the tests, the build or the type checker that the project uses.",
    "- Use the file tools for reading, searching and editing code; use the shell for git, builds, tests, scripts and inspecting the system.",
    "- If something fails, read the error and fix the cause instead of retrying the same thing.",
    "- Never run destructive commands (deleting data, force pushes, resets) unless the person asked for exactly that.",
    "- When you're done, say briefly what you changed and anything the person should know. Use Markdown; keep it short.",
    "- Ask when a request is ambiguous in a way that matters; otherwise make a sensible choice and say what you chose.",
    "",
    "Working efficiently (every tool call is a round trip, and everything it prints stays in your context):",
    "- Batch independent work: make several tool calls in one step (read three files at once, run checks side by side) instead of one per step.",
    "- Several changes to one file go in one edit_file call (edits). For a change across many files, or one that's mechanical (rename, reformat, generate), a short script is fine; make it fail loudly if something it expects isn't there.",
    `- In one shell call, chain related steps and finish with the check (${isWin ? "e.g. run the change, then the build, separated with ;" : "e.g. make the change && run the build"}), and label sections when you inspect several things at once.`,
    `- Shape output at the source: filter and trim (${isWin ? "Select-String, Select-Object -First/-Last, ConvertFrom-Json" : "grep, head/tail, wc -l, jq, a one-line python3 -c"}) so you read the lines you need, not whole logs or JSON blobs. Send long build or test output to a file and read its tail.`,
    `- Wait for something with one command that loops until it's ready (${isWin ? "a while loop with Start-Sleep" : "until …; do sleep 2; done"}), with a time limit, not repeated checks.`,
    "- Read the part of a file you need (offset and limit) when you know where it is; grep first when you don't.",
    "- For a repeated analysis (querying data, parsing logs), write a small throwaway script once instead of many ad hoc commands.",
    "",
    "Environment:",
    `- Working directory: ${cwd}`,
    `- OS: ${isWin ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"} (${process.arch}); the shell tool uses ${shell}${isWin ? " (use PowerShell syntax)" : ""}`,
    `- Git repository: ${isGitRepo(cwd) ? "yes" : "no"}`,
    `- Today's date: ${date.toISOString().slice(0, 10)}`,
  ];
  for (const f of projectInstructions(cwd)) lines.push("", `Instructions from ${f.path}:`, "<instructions>", f.text.trim(), "</instructions>");
  return lines.join("\n");
}

export const COMPACT_PROMPT = `Summarize this conversation so the work can continue in a fresh context. Include:
- what the person asked for, in their words where it matters, and any preferences or constraints they gave;
- what has been done so far: files changed (with paths), commands run and what they showed;
- the current state: what works, what is broken, open questions;
- the next steps.
Be specific (paths, names, errors). Write it as notes to yourself. Don't call tools.`;
