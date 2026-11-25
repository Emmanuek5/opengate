/**
 * A small, forgiving shell lexer for the safety guard. It understands enough of POSIX shells,
 * PowerShell and cmd.exe to find the commands a line would run: separators (; && || & | newline),
 * redirects, quotes, $(…) / `…` / <(…) substitutions, here-docs, and wrappers that run a string
 * (bash -c, eval, powershell -Command, cmd /c, Invoke-Expression). It never executes anything.
 */

export interface Word {
  text: string;
  /** commands inside $(…), `…` or <(…) within this word */
  subs: string[];
}

export interface Redirect {
  op: string;
  target: string;
}

export interface SimpleCmd {
  /** the source text, whitespace collapsed */
  raw: string;
  words: Word[];
  redirects: Redirect[];
  /** text fed on stdin by a here-doc or here-string */
  stdin?: string;
  /** commands joined by | share a pipeline id */
  pipe: number;
  /** commands not split by ; && || & or a newline share a statement id */
  stmt: number;
}

export interface Parsed {
  cmds: SimpleCmd[];
  /** every substitution found, anywhere */
  subs: string[];
}

export const norm = (s: string) => s.trim().replace(/\s+/g, " ");

/** Read from just after an opening "(" to its matching ")"; quotes are skipped. */
function readBalanced(src: string, start: number): { inner: string; end: number } {
  let depth = 1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j < 0 ? src.length : j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      i = j;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { inner: src.slice(start, i), end: i };
  }
  return { inner: src.slice(start), end: src.length };
}

const WORD_END = /[\s;&|<>()]/;

export function parseShell(src: string): Parsed {
  const cmds: SimpleCmd[] = [];
  const subs: string[] = [];
  let stmt = 0;
  let pipe = 0;
  let start = 0;
  const fresh = (): SimpleCmd => ({ raw: "", words: [], redirects: [], pipe, stmt });
  let cur = fresh();
  let word: Word | null = null;
  let pendingRedirect: string | null = null;
  const heredocs: { cmd: SimpleCmd; delim: string }[] = [];

  const w = () => (word ??= { text: "", subs: [] });
  const endWord = () => {
    if (!word) return;
    if (pendingRedirect) {
      if (pendingRedirect === "<<" || pendingRedirect === "<<-") heredocs.push({ cmd: cur, delim: word.text });
      else if (pendingRedirect === "<<<") cur.stdin = word.text;
      cur.redirects.push({ op: pendingRedirect, target: word.text });
      pendingRedirect = null;
    } else cur.words.push(word);
    word = null;
  };
  const endCmd = (at: number, next: number, kind: "pipe" | "stmt" | "group") => {
    endWord();
    pendingRedirect = null;
    if (cur.words.length || cur.redirects.length) {
      cur.raw = norm(src.slice(start, at));
      cur.pipe = pipe;
      cur.stmt = stmt;
      cmds.push(cur);
    }
    if (kind === "stmt") {
      stmt++;
      pipe++;
    }
    cur = fresh();
    start = next;
  };
  const sub = (inner: string) => {
    w().subs.push(inner);
    subs.push(inner);
  };

  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else w().text += c;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === "\\" && n === '"') {
        // POSIX \" escapes; a PowerShell path like "C:\" ends the string instead.
        const after = src[i + 2];
        if (after === undefined || /[\s;|&)]/.test(after)) {
          w().text += "\\";
          inDouble = false;
        } else w().text += '"';
        i++;
      } else if (c === "\\" && n !== undefined && "\\$`".includes(n)) {
        w().text += n;
        i++;
      } else if (c === "$" && n === "(") {
        const b = readBalanced(src, i + 2);
        sub(b.inner);
        w().text += `$(${b.inner})`;
        i = b.end;
      } else if (c === "`") {
        const j = src.indexOf("`", i + 1);
        if (j < 0) w().text += c;
        else {
          sub(src.slice(i + 1, j));
          w().text += src.slice(i, j + 1);
          i = j;
        }
      } else w().text += c;
      continue;
    }
    // unquoted
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "\n" || c === "\r" || c === ";") {
      endCmd(i, i + 1, "stmt");
      if (c !== ";" && heredocs.length) {
        // here-doc bodies follow the line that opened them
        let j = c === "\r" && n === "\n" ? i + 2 : i + 1;
        while (heredocs.length) {
          const h = heredocs.shift()!;
          const body: string[] = [];
          while (j < src.length) {
            let e = src.indexOf("\n", j);
            if (e < 0) e = src.length;
            const line = src.slice(j, e).replace(/\r$/, "");
            j = e + 1;
            if (line.trim() === h.delim) break;
            body.push(line);
          }
          h.cmd.stdin = body.join("\n");
        }
        i = j - 1;
        start = j;
      }
      continue;
    }
    if (c === "#" && !word) {
      const e = src.indexOf("\n", i);
      i = (e < 0 ? src.length : e) - 1;
      continue;
    }
    if (c === "'") {
      w();
      inSingle = true;
      continue;
    }
    if (c === '"') {
      w();
      inDouble = true;
      continue;
    }
    if (c === "\\") {
      if (n === "\n") i++;
      else if (n !== undefined && "\"'\\$`;&|<>() ".includes(n) && !(n === " " && /^[a-z]:$/i.test((word as Word | null)?.text ?? ""))) {
        w().text += n;
        i++;
      } else w().text += c;
      continue;
    }
    if (c === "$" && n === "(") {
      const b = readBalanced(src, i + 2);
      sub(b.inner);
      w().text += `$(${b.inner})`;
      i = b.end;
      continue;
    }
    if (c === "$" && n === "{") {
      const e = src.indexOf("}", i);
      const j = e < 0 ? src.length - 1 : e;
      w().text += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      if (j < 0) w().text += c;
      else {
        sub(src.slice(i + 1, j));
        w().text += src.slice(i, j + 1);
        i = j;
      }
      continue;
    }
    if ((c === "<" || c === ">") && n === "(") {
      const b = readBalanced(src, i + 2);
      sub(b.inner);
      w().text += `${c}(${b.inner})`;
      i = b.end;
      continue;
    }
    if (c === "|") {
      if (n === "|") {
        endCmd(i, i + 2, "stmt");
        i++;
      } else {
        endCmd(i, i + (n === "&" ? 2 : 1), "pipe");
        if (n === "&") i++;
      }
      continue;
    }
    if (c === "&") {
      if (n === "&") {
        endCmd(i, i + 2, "stmt");
        i++;
        continue;
      }
      if (n !== ">") {
        endCmd(i, i + 1, "stmt");
        continue;
      }
    }
    if (c === "(" || c === ")") {
      endCmd(i, i + 1, "group");
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && n === ">")) {
      // a word of digits right before is a file descriptor (2>), not an argument
      if (word && /^\d+$/.test((word as Word).text) && !WORD_END.test(src[i - 1] ?? " ")) word = null;
      else endWord();
      let op = c;
      let j = i + 1;
      while (j < src.length && /[<>&|-]/.test(src[j]) && op.length < 3) {
        if (src[j] === "-" && op !== "<<") break;
        op += src[j++];
      }
      if (op.endsWith("&") && /[\d-]/.test(src[j] ?? "")) {
        cur.redirects.push({ op, target: src[j] });
        i = j;
        continue;
      }
      pendingRedirect = op;
      i = j - 1;
      continue;
    }
    w().text += c;
  }
  endCmd(src.length, src.length, "stmt");
  return { cmds, subs };
}

/** Program name: last path segment, lower case, without .exe/.com/.cmd/.bat. */
export function progName(w: string | undefined): string {
  if (!w) return "";
  return (w.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|com|cmd|bat)$/, "");
}

const KEYWORDS = new Set(["{", "}", "!", "if", "then", "do", "else", "elif", "while", "until", "time", "{}"]);
/** wrappers that run the rest of the line as a command, and which of their options take a value */
const WRAPPERS: Record<string, { valued: string[]; positional?: number }> = {
  sudo: { valued: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"] },
  doas: { valued: ["-u", "-C"] },
  env: { valued: ["-u", "-C", "--unset", "--chdir"] },
  nohup: { valued: [] },
  command: { valued: [] },
  builtin: { valued: [] },
  exec: { valued: ["-a"] },
  nice: { valued: ["-n", "--adjustment"] },
  ionice: { valued: ["-c", "-n", "-p", "--class", "--classdata"] },
  timeout: { valued: ["-s", "-k", "--signal", "--kill-after"], positional: 1 },
  stdbuf: { valued: ["-i", "-o", "-e"] },
  xargs: { valued: ["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"] },
  chroot: { valued: [], positional: 1 },
  busybox: { valued: [] },
  watch: { valued: ["-n", "--interval", "-d"] },
  caffeinate: { valued: ["-t", "-w"] },
  unbuffer: { valued: [] },
  strace: { valued: ["-o", "-e", "-p", "-s"] },
};

/** The words of the command that actually runs, with sudo/env/nohup/VAR=x etc. stripped. */
export function coreWords(words: Word[]): Word[] {
  let ws = words;
  for (let guard = 0; ws.length && guard < 12; guard++) {
    const t = ws[0].text;
    if (KEYWORDS.has(t)) {
      ws = ws.slice(1);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      ws = ws.slice(1);
      continue;
    }
    const spec = WRAPPERS[progName(t)];
    if (!spec) break;
    let k = 1;
    let positional = spec.positional ?? 0;
    while (k < ws.length) {
      const a = ws[k].text;
      if (a === "--") {
        k++;
        break;
      }
      if (a.startsWith("-") && a.length > 1) {
        k += spec.valued.includes(a) ? 2 : 1;
        continue;
      }
      if (progName(t) === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        k++;
        continue;
      }
      if (positional > 0) {
        positional--;
        k++;
        continue;
      }
      break;
    }
    ws = ws.slice(k);
  }
  return ws;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh", "csh", "tcsh", "yash"]);
export const isShell = (p: string) => SHELLS.has(p);
export const isPowerShell = (p: string) => p === "powershell" || p === "pwsh";

/** Strings this command runs as commands of their own (bash -c "…", eval, cmd /c, …). */
export function nestedScripts(cmd: SimpleCmd): string[] {
  const out: string[] = [];
  for (const w of cmd.words) out.push(...w.subs);
  const core = coreWords(cmd.words);
  const p = progName(core[0]?.text);
  const rest = core.slice(1).map((w) => w.text);
  if (isShell(p) || p === "su") {
    const ci = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a) || a === "--command");
    if (ci >= 0 && rest[ci + 1] !== undefined) out.push(rest[ci + 1]);
    else if (cmd.stdin !== undefined && !rest.some((a) => !a.startsWith("-"))) out.push(cmd.stdin);
  } else if (p === "eval" || p === "iex" || p === "invoke-expression") {
    if (rest.length) out.push(rest.join(" "));
  } else if (isPowerShell(p)) {
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k].toLowerCase();
      if (/^[-/]e(c|n|nc|nco|ncod|ncode|ncoded|ncodedc|ncodedco|ncodedcom|ncodedcomm|ncodedcomma|ncodedcomman|ncodedcommand)?$/.test(a) && rest[k + 1]) {
        try {
          out.push(Buffer.from(rest[k + 1], "base64").toString("utf16le"));
        } catch {}
        break;
      }
      if (/^[-/]c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(a)) {
        if (rest.length > k + 1) out.push(rest.slice(k + 1).join(" "));
        break;
      }
    }
    if (cmd.stdin !== undefined) out.push(cmd.stdin);
  } else if (p === "cmd") {
    const ci = rest.findIndex((a) => /^\/[ck]$/i.test(a));
    if (ci >= 0 && rest.length > ci + 1) out.push(rest.slice(ci + 1).join(" "));
  }
  return out;
}

export interface Level {
  script: string;
  parsed: Parsed;
  depth: number;
}

/** The command and every script nested inside it, each parsed. */
export function levels(command: string, maxDepth = 4): Level[] {
  const out: Level[] = [];
  const queue: { script: string; depth: number }[] = [{ script: command, depth: 0 }];
  while (queue.length && out.length < 40) {
    const { script, depth } = queue.shift()!;
    const parsed = parseShell(script);
    out.push({ script, parsed, depth });
    if (depth >= maxDepth) continue;
    for (const c of parsed.cmds) for (const s of nestedScripts(c)) if (s.trim()) queue.push({ script: s, depth: depth + 1 });
  }
  return out;
}
