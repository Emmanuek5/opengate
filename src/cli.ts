#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Session } from "./agent";
import { pickModel, runAcp } from "./acp";
import { configPath, EFFORTS, loadConfig, MODES, normalizeUrl, saveConfig, VERSION, type Config, type Mode } from "./config";
import { Gateway, groupModels } from "./gateway";
import { listSessions, loadSession } from "./store";
import { ago, c, PrintUI, Tui } from "./tui";
import { parseArgs, type Args } from "./cli-args";

const HELP = `${c.bold("opengate")} ${VERSION} — a coding agent for your AI gateway

Usage:
  opengate [prompt]              interactive session in this folder
  opengate -p "prompt"           run one prompt and print the answer
  opengate acp                   serve ACP on stdin/stdout (T3 Code, Zed, JetBrains…)
  opengate login                 connect to a gateway (asks for the URL and your key)
  opengate logout                forget the saved key
  opengate models [filter]       list the models your key can use
  opengate sessions              recent sessions in this folder

Options:
  -m, --model <id>               model for this session
      --mode <ask|edits|auto>    when to ask before edits and commands (default: ask)
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

async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) return line.trim();
  return "";
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
  if (a.keyStdin) key = (await Bun.stdin.text()).trim();
  if (!key) key = await askSecret("API key: ");
  if (!key) throw new Error("a key is needed");
  const gw = new Gateway(url, key);
  process.stdout.write(c.dim("Checking…\n"));
  const models = await gw.models(true);
  const model = cur.model && models.some((m) => m.id === cur.model) ? cur.model : pickModel(models);
  saveConfig({ url, key, model });
  console.log(`${c.green("✓")} Connected to ${url}: ${models.length} models available. Default model: ${c.bold(model)}`);
  console.log(c.dim(`Saved to ${configPath()} (only readable by you). Change the model with --model or /model.`));
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
  if (a.cmd === "acp") return runAcp();
  if (a.cmd === "login") return login(a);
  if (a.cmd === "logout") {
    saveConfig({ key: undefined });
    return void console.log("Key removed.");
  }

  const cwd = resolve(a.cwd ?? process.cwd());
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`no such folder: ${cwd}`);

  if (a.cmd === "sessions") {
    const list = listSessions(cwd, 30);
    if (!list.length) return void console.log("No sessions in this folder yet.");
    for (const m of list) console.log(`${c.dim(m.id)}  ${(m.title ?? "(untitled)").slice(0, 60).padEnd(60)}  ${c.dim(`${ago(m.updated)} · ${m.model}`)}`);
    return;
  }

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
    if (!model) model = pickModel(await gw.models().catch(() => []));
    session = Session.create(gw, cfg, { cwd, model, mode: a.mode, effort: a.effort });
  }
  if (a.mode) session.setMode(a.mode);
  if (a.effort) session.setEffort(a.effort);

  if (a.print !== undefined) {
    const text = a.print === "-" ? await Bun.stdin.text() : a.print;
    const ac = () => session.cancel();
    process.on("SIGINT", ac);
    const stop = await session.prompt([{ type: "text", text }], new PrintUI());
    process.stdout.write("\n");
    process.exit(stop === "end_turn" ? 0 : 1);
  }

  await new Tui({ cfg, gateway: gw, session, initialPrompt: a.rest.join(" ") || undefined }).run();
}

main().catch((e) => {
  console.error(`opengate: ${(e as Error).message}`);
  process.exit(1);
});
