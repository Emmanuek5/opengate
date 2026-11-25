import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { coreWords, isPowerShell, isShell, levels, parseShell, progName, type SimpleCmd, type Word } from "./shell";

/**
 * Built-in hard blocks (denied in every mode unless an allow rule matches) and the fast paths
 * that auto mode allows without asking the guard model. Both work on the parsed command, so
 * quoted text (commit messages, echo) doesn't trigger them, while bash -c "…", $(…), eval,
 * powershell -Command and cmd /c are looked into.
 */

export interface Block {
  id: string;
  reason: string;
}

export const HARD_BLOCKS: { id: string; what: string }[] = [
  { id: "delete-root", what: "recursive delete of /, ~, $HOME, a drive root or a top-level system folder" },
  { id: "disk", what: "mkfs, dd or redirects to a raw disk, format, diskpart, diskutil erase, wipefs" },
  { id: "fork-bomb", what: "fork bombs" },
  { id: "chmod-root", what: "recursive chmod/chown/icacls/takeown on / or another root" },
  { id: "download-exec", what: "piping a download into a shell (curl|sh, wget|bash, iwr|iex, iex (iwr …))" },
  { id: "power", what: "shutdown, reboot, poweroff, halt, Stop-Computer, Restart-Computer" },
  { id: "delete-git", what: "deleting a .git folder" },
  { id: "exfiltrate", what: "sending secrets (~/.ssh, .env, credentials, keys) to curl, wget, nc, Invoke-WebRequest, …" },
  { id: "force-push-main", what: "force-pushing to (or deleting) main or master" },
];

// ---------------- targets ----------------

const HOME_WORDS = new Set([
  "~",
  "$home",
  "${home}",
  "$env:userprofile",
  "${env:userprofile}",
  "%userprofile%",
  "$env:home",
  "$env:homepath",
  "%homepath%",
  "$env:homedrive",
  "%homedrive%",
  "$env:systemdrive",
  "%systemdrive%",
  "$env:systemroot",
  "%systemroot%",
  "%windir%",
  "$env:windir",
  "$env:programfiles",
  "%programfiles%",
]);
const SYS_DIRS = /^\/(bin|boot|dev|etc|home|lib|lib32|lib64|libx32|opt|proc|root|run|sbin|srv|sys|usr|var|system|library|applications|users|private|volumes|snap|mnt|media)$/;
const WIN_SYS = /^[a-z]:\/(windows|users|program files|program files \(x86\)|programdata)$/;

function normTarget(target: string): string {
  let t = target.trim().toLowerCase().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  for (let k = 0; k < 6; k++) {
    const n = t.replace(/\/(\*|\.\*|\.)$/, "/").replace(/(.)\/$/, "$1");
    if (n === t) break;
    t = n;
  }
  return t;
}

const homeNorm = () => normTarget(homedir());

/** What a delete/chmod target would hit if it's a root, a home folder or a system folder. */
export function rootLike(target: string): string | null {
  const t = normTarget(target);
  if (!t) return null;
  if (t === "/") return "the root folder";
  if (HOME_WORDS.has(t) || /^\$\{home(:[^}]*)?\}$/.test(t) || /^~[a-z0-9_.-]+$/.test(t) || t === homeNorm()) return "the home folder";
  if (/^[a-z]:$/.test(t)) return "a whole drive";
  if (/^\/(home|users)\/[^/]+$/.test(t) || /^[a-z]:\/users\/[^/]+$/.test(t)) return "a home folder";
  if (SYS_DIRS.test(t) || WIN_SYS.test(t)) return "a system folder";
  return null;
}

function isGitDir(target: string): boolean {
  const t = normTarget(target);
  const last = t.split("/").pop() ?? "";
  return last === ".git" || last === ".git*";
}

const RAW_DEVICE = /^(\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk|md\d|dm-|mapper\/|root|sr\d|fd\d)|\\\\\.\\physicaldrive|\/\/\.\/physicaldrive|\\\\\.\\[a-z]:)/i;

// ---------------- secrets ----------------

const SECRET_EXEMPT = /\.(pub|example|sample|template|dist|defaults?)$/;
const SECRET_BASENAME =
  /^(\.env(\..+)?|\.envrc|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|\.htpasswd|\.vault-token|credentials(\.json|\.ya?ml|\.toml|\.csv)?|application_default_credentials\.json|service[-_]?account.*\.json|secrets?\.(json|ya?ml|toml|env)|.*\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|asc|gpg)|shadow|gshadow|master\.key)$/;
const SECRET_DIRS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.config\/gcloud|\.password-store)(\/|$)/;

/** Whether a path (or a word holding one, like @.env or file=@~/.ssh/id_rsa) points at a secret. */
export function isSecretPath(word: string): boolean {
  let t = word.trim().replace(/\\/g, "/").toLowerCase();
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//.test(t)) return false; // URLs
  t = t.replace(/^[^=]*=(?=[@<])/, "").replace(/^[@<]+/, "");
  const base = t.replace(/\/+$/, "").split("/").pop() ?? "";
  if (SECRET_EXEMPT.test(base)) return false;
  if (SECRET_DIRS.test(t)) {
    // a few files in these folders are fine to share
    return !/(^|\/)(known_hosts|authorized_keys)$/.test(t);
  }
  if (t === "/etc/shadow" || t === "/etc/gshadow" || t === "/etc/sudoers") return true;
  if (base === "config" && /\.(kube|docker)\//.test(t)) return true;
  return SECRET_BASENAME.test(base);
}

// ---------------- helpers ----------------

const DOWNLOADERS = new Set(["curl", "wget", "fetch", "http", "https", "xh", "aria2c", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "lwp-request", "start-bitstransfer"]);
const DOWNLOAD_WORD = /(downloadstring|downloadfile|downloaddata|net\.webclient|system\.net\.http|invoke-webrequest|invoke-restmethod)/i;
const SENDERS = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "scp", "rsync", "ssh", "http", "https", "xh", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "send-mailmessage", "openssl", "mail", "sendmail", "mutt"]);
const SCRIPT_INTERPRETERS = new Set(["python", "python2", "python3", "perl", "ruby", "node", "php", "bun", "deno", "lua", "rscript", "tclsh"]);
/** values of these options are identity/cert/output files, not data being sent */
const SENDER_SKIP_VALUE = new Set([
  "-o",
  "--output",
  "-O",
  "--output-document",
  "-P",
  "--directory-prefix",
  "-i",
  "--cert",
  "-E",
  "--key",
  "--cacert",
  "--capath",
  "--netrc-file",
  "--certificate",
  "--private-key",
  "--ca-certificate",
  "-outfile",
  "-certificate",
  "-F", // ssh/scp -F config file (curl -F is handled before skipping)
]);

const texts = (ws: Word[]) => ws.map((w) => w.text);
const isFlag = (a: string) => a.startsWith("-") && a.length > 1;

function positional(args: string[]): string[] {
  const out: string[] = [];
  let rest = false;
  for (const a of args) {
    if (!rest && a === "--") rest = true;
    else if (rest || !isFlag(a)) out.push(a);
  }
  return out;
}

/** -r, -rf, -Rf, --recursive, PowerShell -Recurse/-rec, cmd /s */
function recursive(args: string[]): boolean {
  return args.some((a) => {
    if (a === "--recursive" || /^\/s$/i.test(a)) return true;
    const m = /^-([a-z]+)(:\$true)?$/i.exec(a);
    if (!m) return false;
    if (m[1].length <= 3 && /r/i.test(m[1])) return true;
    return m[1].length >= 2 && "recurse".startsWith(m[1].toLowerCase());
  });
}

function splitTargets(args: string[]): string[] {
  return positional(args)
    .filter((a) => !/^\/[a-z]$/i.test(a))
    .flatMap((a) => a.split(","))
    .filter(Boolean);
}

const DELETERS = new Set(["rm", "remove-item", "ri", "del", "erase", "rd", "rmdir", "unlink", "trash", "srm"]);

function isDownloadCmd(c: SimpleCmd): boolean {
  const core = texts(coreWords(c.words));
  return DOWNLOADERS.has(progName(core[0])) || core.some((w) => DOWNLOAD_WORD.test(w));
}

/** reads its program from stdin (sh, bash -s, python, node -, iex …) */
function runsStdin(core: string[]): boolean {
  const p = progName(core[0]);
  const args = core.slice(1);
  if (isShell(p)) return !args.some((a) => /^-[a-z]*c[a-z]*$/i.test(a)) && (positional(args).length === 0 || args.includes("-s") || args.includes("-"));
  if (SCRIPT_INTERPRETERS.has(p)) {
    if (args.some((a) => /^(-c|-e|-m|-p|-r|-E|--eval|--print|run|x|test|exec)$/.test(a))) return false;
    const pos = positional(args);
    return pos.length === 0 || pos[0] === "-";
  }
  if (p === "iex" || p === "invoke-expression") return true;
  if (isPowerShell(p)) return args.some((a) => a === "-") || (args.some((a) => /^-c(ommand)?$/i.test(a)) && args.at(-1) === "-");
  if (p === "cmd") return positional(args).length === 0;
  if (p === "source" || p === ".") return args.length === 0 || args.some((a) => a === "/dev/stdin" || a === "-");
  return false;
}

// ---------------- the checks ----------------

function checkCmd(c: SimpleCmd, cwd: string | undefined): Block | null {
  const core = texts(coreWords(c.words));
  const p = progName(core[0]);
  const args = core.slice(1);
  const lower = args.map((a) => a.toLowerCase());

  for (const r of c.redirects) if (/^[>&]/.test(r.op) && RAW_DEVICE.test(r.target)) return { id: "disk", reason: `writes straight to the disk device ${r.target}` };
  if (!p) return null;

  // deletes
  if (DELETERS.has(p)) {
    const rec = recursive(args) || p === "trash" || p === "srm";
    const targets = splitTargets(args);
    if (rec) {
      for (const t of targets) {
        const what = rootLike(t);
        if (what) return { id: "delete-root", reason: `deletes ${what} (${t}) recursively` };
      }
      if (targets.some(isGitDir)) return { id: "delete-git", reason: "deletes the .git folder (the project's history)" };
    }
  }
  if (p === "find") {
    const idx = args.findIndex((a) => /^[-(!]/.test(a));
    const roots = idx < 0 ? args : args.slice(0, idx);
    const deletes = args.includes("-delete") || args.some((a, k) => /^-(exec|execdir|ok|okdir)$/.test(a) && DELETERS.has(progName(args[k + 1])));
    if (deletes) {
      const r = roots.map(rootLike).find(Boolean);
      if (r) return { id: "delete-root", reason: `deletes files across ${r}` };
      const nameIdx = args.findIndex((a) => /^-(i?name|path)$/.test(a));
      if (nameIdx >= 0 && isGitDir(args[nameIdx + 1] ?? "")) return { id: "delete-git", reason: "deletes .git folders" };
    }
  }

  // disks
  if (/^mkfs(\..+)?$/.test(p) || ["mke2fs", "mkswap", "mkntfs", "newfs", "wipefs", "format-volume", "clear-disk", "format-disk", "initialize-disk", "remove-partition", "diskpart"].includes(p))
    return { id: "disk", reason: `${p} erases disks or partitions` };
  if (p === "dd") {
    const of = args.find((a) => a.toLowerCase().startsWith("of="));
    if (of && RAW_DEVICE.test(of.slice(3))) return { id: "disk", reason: `dd writes straight to the disk device ${of.slice(3)}` };
  }
  if (p === "shred" && args.some((a) => RAW_DEVICE.test(a))) return { id: "disk", reason: "shred wipes a disk device" };
  if (p === "format" && args.some((a) => /^[a-z]:$/i.test(a) || /^\/fs:/i.test(a))) return { id: "disk", reason: "format erases a drive" };
  if (p === "diskutil" && lower.some((a) => /^(erase(disk|volume)|partitiondisk|zerodisk|randomdisk|secureerase|reformat|apfs)$/.test(a)) && !lower.includes("list"))
    return { id: "disk", reason: "diskutil erases or repartitions a disk" };

  // permissions on roots
  if (["chmod", "chown", "chgrp"].includes(p) && args.some((a) => a === "--recursive" || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(a))) {
    const pos = positional(args).slice(1);
    const what = pos.map(rootLike).find(Boolean);
    if (what) return { id: "chmod-root", reason: `${p} -R on ${what}` };
  }
  if (p === "icacls" && lower.includes("/t")) {
    const what = args.filter((a) => !a.startsWith("/")).slice(0, 1).map(rootLike).find(Boolean);
    if (what) return { id: "chmod-root", reason: `icacls /t on ${what}` };
  }
  if (p === "takeown" && lower.includes("/r")) {
    const fi = lower.indexOf("/f");
    const what = fi >= 0 ? rootLike(args[fi + 1] ?? "") : null;
    if (what) return { id: "chmod-root", reason: `takeown /r on ${what}` };
  }

  // power
  if ((p === "shutdown" && !lower.some((a) => a === "-c" || a === "/a")) || ["reboot", "poweroff", "halt", "stop-computer", "restart-computer"].includes(p))
    return { id: "power", reason: `${p} turns the machine off or restarts it` };
  if ((p === "init" || p === "telinit") && ["0", "6"].includes(args[0] ?? "")) return { id: "power", reason: `${p} ${args[0]} turns the machine off or restarts it` };
  if ((p === "systemctl" || p === "loginctl") && lower.some((a) => ["poweroff", "reboot", "halt", "kexec"].includes(a))) return { id: "power", reason: `${p} turns the machine off or restarts it` };

  // git push --force to main/master
  if (p === "git") {
    let k = 0;
    while (k < args.length && args[k].startsWith("-")) k += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[k]) ? 2 : 1;
    if (args[k] === "push") {
      const b = forcePushMain(args.slice(k + 1), cwd);
      if (b) return b;
    }
  }

  // download piped into a shell through process substitution or eval "$(curl …)"
  if (isShell(p) || SCRIPT_INTERPRETERS.has(p) || ["source", ".", "eval", "iex", "invoke-expression"].includes(p) || isPowerShell(p)) {
    const coreW = coreWords(c.words);
    const runsArg =
      ["source", ".", "eval", "iex", "invoke-expression"].includes(p) ||
      coreW.slice(1).some((w, k, all) => w.subs.length && (k === 0 || /^-[a-z]*[ce]$/i.test(all[k - 1]?.text ?? "") || /^(-c|-command|-e|--eval)$/i.test(all[k - 1]?.text ?? "")) && w.subs.some((s) => parseShell(s).cmds.some(isDownloadCmd)));
    const anySubDownload = coreW.some((w) => w.subs.some((s) => parseShell(s).cmds.some(isDownloadCmd)));
    if (runsArg && anySubDownload) return { id: "download-exec", reason: "runs a script straight from the internet" };
  }

  // secrets sent out by a network tool
  if (SENDERS.has(p)) {
    const b = senderLeaks(p, c, args);
    if (b) return b;
  }
  return null;
}

function senderLeaks(p: string, c: SimpleCmd, args: string[]): Block | null {
  const leak = (what: string): Block => ({ id: "exfiltrate", reason: `sends ${what} over the network with ${p}` });
  for (const r of c.redirects) if (r.op.startsWith("<") && r.op !== "<<" && r.op !== "<<-" && isSecretPath(r.target)) return leak(r.target);
  if (p === "ssh") return null; // ssh's own args are hosts and identity files; stdin is checked by the pipeline check
  if (p === "scp" || p === "rsync" || p === "sftp") {
    const pos: string[] = [];
    for (let k = 0; k < args.length; k++) {
      if (["-i", "-F", "-P", "-o", "-e", "--rsh", "-S", "-c", "-l"].includes(args[k])) k++;
      else if (!isFlag(args[k])) pos.push(args[k]);
    }
    const remote = (a: string) => /^([^/\\:]+@)?[^/\\:]{2,}:/.test(a) && !/^[a-z]:[\\/]/i.test(a);
    const sent = pos.slice(0, -1).find((a) => !remote(a) && isSecretPath(a));
    if (sent && pos.length >= 2 && remote(pos[pos.length - 1])) return leak(sent);
    return null;
  }
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if ((SENDER_SKIP_VALUE.has(a) || SENDER_SKIP_VALUE.has(a.toLowerCase())) && !(a === "-F" && p === "curl")) {
      k++;
      continue;
    }
    if (/^--?(output|outfile|cert|key|cacert|output-document)=/i.test(a)) continue;
    if (isSecretPath(a.replace(/^-{1,2}[a-z-]+=/i, ""))) return leak(a.replace(/^.*?[=@<]+/, "") || a);
  }
  for (const w of c.words) for (const s of w.subs) for (const lv of levels(s, 1)) for (const sc of lv.parsed.cmds) if (texts(coreWords(sc.words)).slice(1).some(isSecretPath)) return leak("a secret file");
  return null;
}

function forcePushMain(args: string[], cwd: string | undefined): Block | null {
  if (args.includes("-n") || args.includes("--dry-run")) return null;
  let force = false;
  let del = false;
  let all = false;
  const pos: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes") force = true;
    else if (a === "--delete" || a === "-d") del = true;
    else if (a === "--all" || a === "--mirror" || a === "--branches") all = true;
    else if (/^-[a-zA-Z]+$/.test(a) && a.includes("f")) force = true;
    else if (["-o", "--push-option", "--repo", "--receive-pack", "--exec"].includes(a)) k++;
    else if (!isFlag(a)) pos.push(a);
  }
  const refspecs = pos.slice(1);
  const isMain = (r: string) => /^(refs\/heads\/)?(main|master)$/.test(r);
  for (const r of refspecs) {
    const plus = r.startsWith("+");
    const spec = r.replace(/^\+/, "");
    const dst = spec.includes(":") ? spec.split(":").pop()! : spec;
    const src = spec.includes(":") ? spec.split(":")[0] : spec;
    if (isMain(dst) && (force || plus)) return { id: "force-push-main", reason: `force-pushes to ${dst.replace("refs/heads/", "")}` };
    if (isMain(dst) && (del || (spec.includes(":") && src === ""))) return { id: "force-push-main", reason: `deletes ${dst.replace("refs/heads/", "")} on the remote` };
  }
  if (force && all) return { id: "force-push-main", reason: "force-pushes every branch, main included" };
  if (force && refspecs.length === 0 && cwd) {
    const branch = currentBranch(cwd);
    if (branch === "main" || branch === "master") return { id: "force-push-main", reason: `force-pushes the current branch, ${branch}` };
  }
  return null;
}

/** The checked-out branch, read from .git/HEAD (never runs git). */
function currentBranch(cwd: string): string | null {
  let dir = resolve(cwd);
  for (let k = 0; k < 30; k++) {
    const g = join(dir, ".git");
    try {
      if (existsSync(g)) {
        let head = join(g, "HEAD");
        if (!existsSync(head)) {
          const m = /gitdir:\s*(.+)/.exec(readFileSync(g, "utf8"));
          if (m) head = join(resolve(dir, m[1].trim()), "HEAD");
        }
        const m = /ref:\s*refs\/heads\/(.+)/.exec(readFileSync(head, "utf8"));
        return m ? m[1].trim() : null;
      }
    } catch {
      return null;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const FORK_BOMBS = [
  /(\S+)\s*\(\)\s*\{[^}]*?\1\s*\|\s*\1[^}]*\}/, // :(){ :|:& };:
  /(\S+)\s*\(\)\s*\{[^}]*?\1\s*&\s*\1\s*&?[^}]*\}/, // f(){ f & f & }
  /function\s+(\S+)\s*(\(\))?\s*\{[^}]*?\1\s*\|\s*\1[^}]*\}/,
  /%0\s*\|\s*%0/,
  /fork\s+while\s+fork/,
  /while\s*\(?\s*(true|1)\s*\)?\s*:?\s*\{?\s*os\.fork\s*\(\s*\)/i,
  /while\s*\(\s*\$true\s*\)\s*\{\s*(start-process|start|saps)\s+(powershell|pwsh|cmd)/i,
];

/** Whether a command hits a built-in hard block, and why. */
export function hardBlock(command: string, cwd?: string): Block | null {
  const lv = levels(command);
  for (const { script, parsed } of lv) {
    if (FORK_BOMBS.some((re) => re.test(script))) return { id: "fork-bomb", reason: "a fork bomb (starts processes until the machine hangs)" };
    for (const c of parsed.cmds) {
      const b = checkCmd(c, cwd);
      if (b) return b;
    }
    // pipelines: download | shell, secret | network tool
    const pipes = new Map<number, SimpleCmd[]>();
    for (const c of parsed.cmds) pipes.set(c.pipe, [...(pipes.get(c.pipe) ?? []), c]);
    for (const p of pipes.values()) {
      if (p.length < 2) continue;
      for (let i = 0; i < p.length; i++) {
        const core = texts(coreWords(p[i].words));
        const prog = progName(core[0]);
        const before = p.slice(0, i);
        if (i > 0 && runsStdin(core) && before.some(isDownloadCmd)) return { id: "download-exec", reason: "pipes a download straight into a shell" };
        if (i > 0 && SENDERS.has(prog) && before.some((b) => texts(coreWords(b.words)).slice(1).some(isSecretPath) || b.redirects.some((r) => r.op === "<" && isSecretPath(r.target))))
          return { id: "exfiltrate", reason: `pipes a secret file into ${prog}` };
      }
    }
    // statements: PowerShell's iex (iwr …) / [scriptblock]::Create((irm …)) / -Body (Get-Content .env)
    const stmts = new Map<number, SimpleCmd[]>();
    for (const c of parsed.cmds) stmts.set(c.stmt, [...(stmts.get(c.stmt) ?? []), c]);
    for (const s of stmts.values()) {
      if (s.length < 2) continue;
      const progs = s.map((c) => progName(texts(coreWords(c.words))[0]));
      const runner = progs.some((p) => p === "iex" || p === "invoke-expression") || s.some((c) => c.words.some((w) => /\[scriptblock\]::create/i.test(w.text)));
      if (runner && s.some(isDownloadCmd)) return { id: "download-exec", reason: "runs a script straight from the internet (Invoke-Expression on a download)" };
      const sender = progs.find((p) => ["iwr", "irm", "invoke-webrequest", "invoke-restmethod", "send-mailmessage"].includes(p));
      if (sender && s.some((c) => ["get-content", "gc", "cat", "type", "[io.file]::readallbytes", "[io.file]::readalltext"].includes(progName(c.words[0]?.text)) && texts(c.words).slice(1).some(isSecretPath)))
        return { id: "exfiltrate", reason: `sends a secret file over the network with ${sender}` };
    }
  }
  return null;
}

// ---------------- fast paths ----------------

const SAFE_SCRIPT = /^(test|tests|lint|build|typecheck|type-check|check|tsc|test:[\w:-]+|lint:[\w:-]+|build:[\w:-]+|check:[\w:-]+)$/;
const VERSIONED = new Set(["node", "bun", "npm", "pnpm", "yarn", "deno", "python", "python3", "pip", "pip3", "go", "cargo", "rustc", "git", "tsc", "java", "ruby", "dotnet", "gcc", "clang", "make", "uv"]);
const GIT_RO = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep", "cat-file", "ls-tree", "whatchanged", "count-objects", "version", "merge-base", "name-rev", "show-ref", "check-ignore"]);
const PS_RO = new Set(["get-childitem", "gci", "get-content", "gc", "get-location", "gl", "test-path", "get-item", "gi", "resolve-path", "select-string", "sls", "write-output", "get-command", "gcm", "get-filehash", "measure-object"]);

function gitReadOnly(args: string[]): boolean {
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) {
    if (args[k] === "-C") k += 2;
    else if (args[k] === "--no-pager") k++;
    else return false; // -c, --exec-path, --git-dir … can run other programs
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  if (rest.some((a) => a.startsWith("--output") || a === "--ext-diff" || a.startsWith("--exec"))) return false;
  if (GIT_RO.has(sub)) return true;
  if (sub === "branch") {
    if (rest.some((a) => /^(-[dDmMcCfu]|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description|--track|--no-track)$/.test(a))) return false;
    const pos = rest.filter((a) => !a.startsWith("-"));
    return pos.length === 0 || rest.some((a) => /^(--list|-l|--contains|--no-contains|--merged|--no-merged|--points-at)$/.test(a));
  }
  if (sub === "tag") return rest.length === 0 || rest.every((a) => a.startsWith("-") && /^(-l|--list|-n\d*|--contains|--sort=.*|--points-at)$/.test(a));
  if (sub === "remote") return rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose"));
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
  if (sub === "config") return rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a)) && !rest.some((a) => /^(--add|--unset|--unset-all|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(a));
  if (sub === "reflog") return rest.length === 0 || rest[0] === "show";
  return false;
}

/** Why a shell command is clearly read-only or routine (auto mode runs it without asking), or null. */
export function safeCommand(command: string): string | null {
  const c = command.trim();
  if (!c || /[;&|<>`\n\r(){}]/.test(c) || c.includes("$(")) return null;
  const { cmds } = parseShell(c);
  if (cmds.length !== 1 || cmds[0].redirects.length) return null;
  const words = cmds[0].words.map((w) => w.text);
  const first = words[0];
  if (!first || /[\\/]/.test(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return null;
  const p = first.toLowerCase().replace(/\.exe$/, "");
  const args = words.slice(1);
  if (args.some(isSecretPath)) return null;
  const sub = args[0];
  const ok = "read-only or routine command";

  if (["ls", "dir", "pwd", "cat", "head", "tail", "wc", "stat", "which", "where", "type", "echo", "du", "df", "whoami", "uname", "realpath", "basename", "dirname", "nproc", "grep", "egrep", "fgrep", "diff", "cmp"].includes(p)) return ok;
  if (PS_RO.has(p)) return ok;
  if (p === "tree") return args.includes("-o") ? null : ok;
  if (p === "rg") return args.some((a) => a.startsWith("--pre")) ? null : ok;
  if (p === "find") return args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a)) ? null : ok;
  if (p === "git") return gitReadOnly(args) ? ok : null;
  if (VERSIONED.has(p) && args.length === 1 && /^(--version|-v|-V|version)$/.test(args[0])) return ok;
  const noEmit = args.some((a) => /^--?noEmit$/i.test(a));
  if (p === "tsc") return noEmit ? ok : null;
  if (p === "npx" || p === "bunx" || p === "pnpx") return sub === "tsc" && noEmit ? ok : null;
  if (p === "bun") {
    if (sub === "test") return ok;
    if (sub === "run" && SAFE_SCRIPT.test(args[1] ?? "")) return ok;
    if (sub && SAFE_SCRIPT.test(sub)) return ok;
    if (sub === "x" && args[1] === "tsc" && noEmit) return ok;
    return null;
  }
  if (p === "npm" || p === "pnpm" || p === "yarn") {
    if (sub === "test" || sub === "t") return ok;
    if ((sub === "run" || sub === "run-script") && SAFE_SCRIPT.test(args[1] ?? "")) return ok;
    if (p !== "npm" && sub && SAFE_SCRIPT.test(sub)) return ok;
    if (p === "pnpm" && sub === "exec" && args[1] === "tsc" && noEmit) return ok;
    return null;
  }
  if (p === "cargo") {
    if (["check", "test", "build", "clippy", "doc", "tree", "metadata"].includes(sub ?? "")) return ok;
    if (sub === "fmt" && args.includes("--check")) return ok;
    return null;
  }
  if (p === "go") return ["test", "vet", "build", "list", "env", "version"].includes(sub ?? "") ? ok : null;
  if (p === "pytest" || p === "py.test") return ok;
  if ((p === "python" || p === "python3" || p === "py") && sub === "-m" && ["pytest", "unittest", "mypy", "ruff", "pyright"].includes(args[1] ?? "")) {
    if (args[1] === "ruff" && args.includes("--fix")) return null;
    return ok;
  }
  if (["mypy", "pyright"].includes(p)) return ok;
  if (p === "ruff") return sub === "check" && !args.includes("--fix") ? ok : null;
  if (p === "make") return args.length === 1 && ["test", "check", "lint", "build"].includes(sub ?? "") ? ok : null;
  if (p === "dotnet") return ["test", "build"].includes(sub ?? "") ? ok : null;
  return null;
}

/** Edits to non-secret files inside the project (and outside .git) are routine. */
export function safeEdit(paths: string[], cwd: string): string | null {
  if (!paths.length) return null;
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    root = resolve(cwd);
  }
  for (const p of paths) {
    const abs = resolve(cwd, p);
    if (!inside(abs, resolve(cwd))) return null;
    const rel = relative(resolve(cwd), abs).replace(/\\/g, "/");
    if (rel.split("/").some((seg) => seg.toLowerCase() === ".git")) return null;
    if (isSecretPath(rel) || isSecretPath(abs)) return null;
    // follow symlinks: the nearest existing ancestor must also be inside the project
    let probe = abs;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    try {
      if (!inside(realpathSync(probe), root)) return null;
    } catch {
      return null;
    }
  }
  return "edit inside the project";
}

function inside(p: string, root: string): boolean {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}
