import { EFFORTS, MODES, type Mode } from "./config";

export interface Args {
  cmd: string | null;
  rest: string[];
  model?: string;
  mode?: Mode;
  effort?: string;
  print?: string;
  cont?: boolean;
  resume?: string | true;
  cwd?: string;
  url?: string;
  key?: string;
  keyStdin?: boolean;
  /** sessions: every folder */
  all?: boolean;
  /** sessions: include subagent sessions */
  subagents?: boolean;
  /** sessions export: md or json */
  format?: "md" | "json";
  /** sessions show/export: include the model's thinking */
  thinking?: boolean;
  /** update: only report whether a newer version exists */
  check?: boolean;
  /** update: reinstall even if already on the latest */
  force?: boolean;
}

export const COMMANDS = new Set(["acp", "login", "logout", "models", "sessions", "update", "help", "version"]);

export function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === "-h" || x === "--help") a.cmd = "help";
    else if (x === "-v" || x === "--version") a.cmd = "version";
    else if (x === "-m" || x === "--model") a.model = val();
    else if (x === "--mode") {
      const m = val();
      if (!MODES.some((mm) => mm.id === m)) throw new Error(`--mode must be one of ${MODES.map((mm) => mm.id).join(", ")}`);
      a.mode = m as Mode;
    } else if (x === "--effort") {
      const e = val();
      if (!(EFFORTS as readonly string[]).includes(e)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
      a.effort = e;
    } else if (x === "-p" || x === "--print") a.print = val();
    else if (x === "-c" || x === "--continue") a.cont = true;
    else if (x === "-r" || x === "--resume") a.resume = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true;
    else if (x === "-C" || x === "--cwd") a.cwd = val();
    else if (x === "--url") a.url = val();
    else if (x === "--key") a.key = val();
    else if (x === "--key-stdin") a.keyStdin = true;
    else if (x === "--all" || x === "-a") a.all = true;
    else if (x === "--subagents") a.subagents = true;
    else if (x === "--thinking") a.thinking = true;
    else if (x === "--check") a.check = true;
    else if (x === "--force") a.force = true;
    else if (x === "--format") {
      const f = val();
      if (f !== "md" && f !== "json") throw new Error("--format must be md or json");
      a.format = f;
    }
    else if (x.startsWith("-") && x !== "-") throw new Error(`unknown option ${x}`);
    else if (!a.cmd && !a.rest.length && COMMANDS.has(x)) a.cmd = x;
    else a.rest.push(x);
  }
  return a;
}

