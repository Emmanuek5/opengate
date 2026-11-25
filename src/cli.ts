#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Session } from "./agent";
import { configPath, EFFORTS, loadConfig, normalizeUrl, saveConfig, VERSION, type Config } from "./config";
import { ago, c } from "./tui/theme";
import { parseArgs, type Args } from "./cli-args";

// The engine, the ACP server, the Ink UI and the feature modules (MCP, …) are loaded only when
// needed, so `--version` and `--help` answer at once.
const pickModel = async (models: Parameters<typeof import("./acp").pickModel>[0]) => (await import("./acp")).pickModel(models);

const HELP = `${c.bold("opengate")} ${VERSION} — a coding agent for your AI gateway

Usage:
  opengate [prompt]              interactive session in this folder
  opengate -p "prompt"           run one prompt and print the answer
  opengate acp                   serve ACP on stdin/stdout (T3 Code, Zed, JetBrains…)
  opengate login                 connect to a gateway (asks for the URL and your key)
           [--url <url>] [--key-stdin]   or give the URL, and pipe the key in on stdin
  opengate logout                forget the saved key
  opengate models [filter]       list the models your key can use
  opengate sessions [query]      sessions in this folder (--all: every folder, --subagents: include subagents)
  opengate sessions search <text>       search inside transcripts (--all for every folder)
  opengate sessions show <id>           print a session's transcript, with its subagents (--thinking)
  opengate sessions export <id>         save-ready transcript (--format md|json)

Options:
  -m, --model <id>               model for this session
      --mode <ask|edits|auto|yolo>  ask: ask first · edits: auto-edit · auto: safety model decides · yolo: never ask
      --effort <level>           ${EFFORTS.join(", ")}
  -c, --continue                 continue the latest session in this folder
  -r, --resume [id]              continue a session (latest if no id)
  -C, --cwd <dir>                work in another folder
  -v, --version
  -h, --help

Settings: ${configPath()}
Environment: OPENGATE_URL, OPENGATE_KEY, OPENGATE_MODEL override the saved settings.
`;

// ---------------- prompts on the terminal ----------------

// Node streams and readline, not Bun's stdin shortcuts: on Windows those can let the process
// exit before a piped read finishes.
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Everything piped in on stdin. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Read a secret without echoing it. */
async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);
  process.stdout.write(question);
  return new Promise((res, rej) => {
    let s = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return res(s.trim());
        }
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          return rej(new Error("cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") {
          if (s) {
            s = s.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (ch >= " ") {
          s += ch;
          process.stdout.write("•");
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function login(a: Args) {
  const cur = loadConfig();
  let url = a.url ?? (await ask(`Gateway URL${cur.url ? ` [${cur.url}]` : ""}: `)) ?? "";
  if (!url && cur.url) url = cur.url;
  if (!url) throw new Error("a gateway URL is needed, e.g. https://gateway.example.com:8317");
  url = normalizeUrl(url);
  let key = a.key ?? "";
  if (a.keyStdin) key = (await readStdin()).trim();
  if (!key) key = await askSecret("API key: ");
  if (!key) throw new Error("a key is needed");
  const { Gateway } = await import("./gateway");
  const gw = new Gateway(url, key);
  process.stdout.write(c.dim("Checking…\n"));
  const models = await gw.models(true);
  const model = cur.model && models.some((m) => m.id === cur.model) ? cur.model : await pickModel(models);
  saveConfig({ url, key, model });
  console.log(`${c.green("✓")} Connected to ${url}: ${models.length} models available. Default model: ${c.bold(model)}`);
  console.log(c.dim(`Saved to ${configPath()} (only readable by you). Change the model with --model or /model.`));
}

async function sessionsCommand(a: Args, cwd: string) {
  const store = await import("./store");
  const [sub, ...rest] = a.rest;
  const row = (m: import("./store").SessionMeta, indent = "") =>
    `${indent}${c.dim(m.id)}  ${(m.title ?? "(untitled)").slice(0, 56 - indent.length).padEnd(56 - indent.length)}  ${c.dim(`${ago(m.updated)} · ${m.model} · ${m.messageCount ?? 0} msgs${a.all ? ` · ${m.cwd}` : ""}`)}`;
  if (sub === "show" || sub === "export") {
    const id = rest[0];
    if (!id) throw new Error(`usage: opengate sessions ${sub} <id>`);
    const s = store.loadSession(id);
    if (!s) throw new Error(`no session ${id}`);
    if (sub === "export" && a.format === "json") {
      const children = store.listChildren(id).map((m) => store.loadSession(m.id)).filter(Boolean);
      return void process.stdout.write(JSON.stringify({ session: s, subagents: children }, null, 2) + "\n");
    }
    const { renderTranscript } = await import("./transcript");
    return void process.stdout.write(renderTranscript(s, { thinking: !!a.thinking, maxToolOutput: sub === "export" ? 0 : 2000 }));
  }
  if (sub === "search") {
    const text = rest.join(" ");
    if (!text) throw new Error("usage: opengate sessions search <text>");
    const hits = store.searchSessions(text, 30, { all: a.all, cwd });
    if (!hits.length) return void console.log(`Nothing found for "${text}"${a.all ? "" : " in this folder (try --all)"}.`);
    for (const h of hits) console.log(`${row(h.meta)}\n    ${c.dim("…" + h.snippet + "…")}`);
    return;
  }
  const query = a.rest.join(" ");
  const list = store.listSessions(cwd, 40, { all: a.all, query: query || undefined });
  if (!list.length) return void console.log(query ? `No sessions match "${query}".` : `No sessions in ${a.all ? "any folder" : "this folder"} yet.`);
  for (const m of list) {
    console.log(row(m));
    if (a.subagents) for (const k of store.listChildren(m.id)) console.log(row(k, "  ↳ "));
  }
  console.log(c.dim(`\nResume with: opengate -r <id> · read with: opengate sessions show <id>`));
}

async function main() {
  let a: Args;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`opengate: ${(e as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (a.cmd === "help") return void process.stdout.write(HELP);
  if (a.cmd === "version") return void console.log(VERSION);
  if (a.cmd === "acp") return (await import("./acp")).runAcp();
  if (a.cmd === "login") return login(a);
  if (a.cmd === "logout") {
    saveConfig({ key: undefined });
    return void console.log("Key removed.");
  }

  const cwd = resolve(a.cwd ?? process.cwd());
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`no such folder: ${cwd}`);

  const { listSessions, loadSession } = await import("./store");
  if (a.cmd === "sessions") return sessionsCommand(a, cwd);

  const [{ Session }, { Gateway, groupModels }] = await Promise.all([import("./agent"), import("./gateway"), import("./features")]);
  const cfg: Config = loadConfig();
  if (!cfg.url || !cfg.key) {
    console.error(`opengate isn't connected to a gateway yet. Run ${c.bold("opengate login")} first.`);
    process.exit(1);
  }
  const gw = new Gateway(cfg.url, cfg.key);

  if (a.cmd === "models") {
    const filter = a.rest.join(" ").toLowerCase();
    const list = (await gw.models(true)).filter((m) => !filter || m.id.toLowerCase().includes(filter));
    for (const g of groupModels(list)) {
      console.log(c.bold(g.group));
      for (const m of g.models) console.log(`  ${m === cfg.model ? c.green(m + "  (default)") : m}`);
    }
    return;
  }

  // Pick or restore the session.
  let session: Session;
  const resumeId = a.resume === true || a.cont ? listSessions(cwd, 1)[0]?.id : a.resume;
  if (resumeId) {
    const f = loadSession(resumeId);
    if (!f) throw new Error(a.resume === true || a.cont ? "no session to continue in this folder" : `no session ${resumeId}`);
    session = new Session(f, gw, cfg);
    if (a.model) session.setModel(a.model);
  } else {
    let model = a.model ?? cfg.model;
    if (!model) model = await pickModel(await gw.models().catch(() => []));
    session = Session.create(gw, cfg, { cwd, model, mode: a.mode, effort: a.effort });
  }
  if (a.mode) session.setMode(a.mode);
  if (a.effort) session.setEffort(a.effort);

  if (a.print !== undefined) {
    const text = a.print === "-" ? await readStdin() : a.print;
    const ac = () => session.cancel();
    process.on("SIGINT", ac);
    const { PrintUI } = await import("./tui/print");
    const stop = await session.prompt([{ type: "text", text }], new PrintUI());
    process.stdout.write("\n");
    process.exit(stop === "end_turn" ? 0 : 1);
  }

  const { Tui } = await import("./tui");
  await new Tui({ cfg, gateway: gw, session, initialPrompt: a.rest.join(" ") || undefined }).run();
  // MCP servers or other features may hold the event loop open.
  process.exit(0);
}

main().catch((e) => {
  console.error(`opengate: ${(e as Error).message}`);
  process.exit(1);
});
