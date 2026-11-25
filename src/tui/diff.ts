import type { Diff } from "../tools";

export interface DiffRow {
  kind: "ctx" | "add" | "del" | "gap";
  /** line number in the old file (del) or the new file (add, ctx) */
  no?: number;
  text: string;
}

export interface DiffView {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** rows left out because of `max` */
  hidden: number;
}

const split = (t: string) => {
  const l = t.replace(/\r\n/g, "\n").split("\n");
  if (l.length > 1 && l[l.length - 1] === "") l.pop();
  return l;
};

type Op = { k: "eq" | "add" | "del"; a?: number; b?: number };

/** Line ops for the changed middle; an LCS when small enough, else remove-all/add-all. */
function middleOps(a: string[], b: string[], as: number, ae: number, bs: number, be: number): Op[] {
  const n = ae - as;
  const m = be - bs;
  if (n === 0) return Array.from({ length: m }, (_, j) => ({ k: "add" as const, b: bs + j }));
  if (m === 0) return Array.from({ length: n }, (_, i) => ({ k: "del" as const, a: as + i }));
  if (n * m > 400_000) return [...Array.from({ length: n }, (_, i) => ({ k: "del" as const, a: as + i })), ...Array.from({ length: m }, (_, j) => ({ k: "add" as const, b: bs + j }))];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[as + i] === b[bs + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[as + i] === b[bs + j]) {
      ops.push({ k: "eq", a: as + i, b: bs + j });
      i++;
      j++;
    } else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) ops.push({ k: "del", a: as + i++ });
    else ops.push({ k: "add", b: bs + j++ });
  }
  return ops;
}

/** A unified diff of an edit with line numbers and `context` lines around each change. */
export function diffView(d: Diff, max = 40, context = 2): DiffView {
  const b = split(d.newText);
  if (d.oldText === null) {
    const rows = b.slice(0, max).map((text, i) => ({ kind: "add" as const, no: i + 1, text }));
    return { rows, added: b.length, removed: 0, hidden: Math.max(b.length - max, 0) };
  }
  const a = split(d.oldText);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const ops: Op[] = [];
  for (let i = Math.max(0, s - context); i < s; i++) ops.push({ k: "eq", a: i, b: i });
  ops.push(...middleOps(a, b, s, ea, s, eb));
  for (let i = 0; i < context && ea + i < a.length; i++) ops.push({ k: "eq", a: ea + i, b: eb + i });

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  // Collapse long runs of unchanged lines inside the change to `context` on each side.
  for (let i = 0; i < ops.length; ) {
    if (ops[i].k !== "eq") {
      const o = ops[i++];
      if (o.k === "add") {
        added++;
        rows.push({ kind: "add", no: o.b! + 1, text: b[o.b!] });
      } else {
        removed++;
        rows.push({ kind: "del", no: o.a! + 1, text: a[o.a!] });
      }
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].k === "eq") j++;
    const run = ops.slice(i, j);
    const head = i === 0 ? 0 : context;
    const tail = j === ops.length ? 0 : context;
    if (run.length > head + tail + 1 && i !== 0 && j !== ops.length) {
      for (const o of run.slice(0, head)) rows.push({ kind: "ctx", no: o.b! + 1, text: a[o.a!] });
      rows.push({ kind: "gap", text: `${run.length - head - tail} unchanged lines` });
      for (const o of run.slice(run.length - tail)) rows.push({ kind: "ctx", no: o.b! + 1, text: a[o.a!] });
    } else for (const o of run) rows.push({ kind: "ctx", no: o.b! + 1, text: a[o.a!] });
    i = j;
  }
  const hidden = Math.max(rows.length - max, 0);
  return { rows: rows.slice(0, max), added, removed, hidden };
}
