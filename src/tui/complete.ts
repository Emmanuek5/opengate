import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fuzzy match: every query character in order. Higher is better; null when it doesn't match.
 * Rewards consecutive runs, matches at word/path-segment starts and in the file name.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const base = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\")) + 1;
  // A plain substring is always the best kind of match.
  const sub = t.indexOf(q);
  if (sub >= 0) return 1000 - sub - t.length * 0.5 + (sub >= base ? 300 : 0) + (sub === base || sub === 0 ? 200 : 0);
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
      run = 0;
    }
    if (found < 0) return null;
    const prev = found > 0 ? t[found - 1] : "/";
    if ("/\\-_. ".includes(prev)) score += 8;
    if (found >= base) score += 3;
    run++;
    score += run * 2;
    ti++;
  }
  return score - t.length * 0.2;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (t: T) => string, limit = 50): T[] {
  if (!query) return items.slice(0, limit);
  const scored: { item: T; s: number }[] = [];
  for (const item of items) {
    const s = fuzzyScore(query, text(item));
    if (s !== null) scored.push({ item, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.item);
}

export interface Token {
  kind: "slash" | "mention";
  query: string;
  /** the token's range in the text (including the / or @) */
  start: number;
  end: number;
}

/** The completable token at the cursor, if any: "/cmd" at the start, or "@path" anywhere. */
export function tokenAt(text: string, cursor: number): Token | null {
  if (text.startsWith("/") && !text.startsWith("//")) {
    const sp = text.search(/\s/);
    const end = sp < 0 ? text.length : sp;
    if (cursor <= end && cursor > 0) return { kind: "slash", query: text.slice(1, end), start: 0, end };
  }
  let s = cursor;
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  if (text[s] !== "@") return null;
  let e = cursor;
  while (e < text.length && !/\s/.test(text[e])) e++;
  return { kind: "mention", query: text.slice(s + 1, cursor), start: s, end: e };
}

// ---------------- files for @ mentions ----------------

const SKIP = new Set([".git", "node_modules", ".hg", ".svn", "dist", "build", ".next", "target", ".venv", "venv", "__pycache__", ".cache", ".turbo", "coverage"]);
const MAX_FILES = 20_000;

function gitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((res) => {
    let out = "";
    let done = false;
    const finish = (v: string[] | null) => {
      if (!done) {
        done = true;
        res(v);
      }
    };
    try {
      const p = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      p.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        if (out.length > 8_000_000) p.kill();
      });
      p.on("error", () => finish(null));
      p.on("close", (code) => finish(code === 0 ? out.split("\n").filter(Boolean).slice(0, MAX_FILES) : null));
      setTimeout(() => {
        p.kill();
        finish(null);
      }, 5000);
    } catch {
      finish(null);
    }
  });
}

/** Files under `root`, skipping vendored/build folders; async and bounded so a huge folder never stalls the UI. */
export async function walkFiles(root: string, max = MAX_FILES, budgetMs = 1500, maxDepth = 12): Promise<string[]> {
  const out: string[] = [];
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  const end = Date.now() + budgetMs;
  while (queue.length && out.length < max && Date.now() < end) {
    const { rel, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP.has(d.name) && !d.name.startsWith(".") && depth < maxDepth) queue.push({ rel: p, depth: depth + 1 });
      } else if (d.isFile()) out.push(p);
      if (out.length >= max) break;
    }
  }
  return out.sort();
}

/** Files (and their folders) under the working folder, from git or a walk; loaded lazily, refreshable. */
export class FileIndex {
  private list: string[] | null = null;
  private shallow: string[] = [];
  private loading: Promise<void> | null = null;
  constructor(public cwd: string) {}

  get ready() {
    return this.list !== null;
  }

  load(force = false): Promise<void> {
    if (this.loading && !force) return this.loading;
    this.loading = (async () => {
      const files = (await gitFiles(this.cwd)) ?? (await walkFiles(this.cwd));
      const dirs = new Set<string>();
      for (const f of files) {
        const parts = f.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
      }
      this.list = [...dirs, ...files.map((f) => f.replace(/\\/g, "/"))];
      this.shallow = [...this.list].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, 50);
    })();
    return this.loading;
  }

  search(query: string, limit = 8): string[] {
    if (!this.list) return [];
    if (!query) {
      // Shallow things first when nothing is typed yet.
      return this.shallow.slice(0, limit);
    }
    return fuzzyFilter(this.list, query, (x) => x, limit);
  }
}
