import { Box, Static, Text, useApp, useStdin, useWindowSize } from "ink";
import { memo, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { MODES, VERSION } from "../config";
import { cursorPos, type Ed } from "./editor";
import { decodeKey } from "./keys";
import { parseMarkdown, tableLines, textWidth, type MdBlock } from "./markdown";
import { diffView, type DiffView } from "./diff";
import { commandLine } from "./format";
import type { Controller, Item, PickerRow, Popup, SubView, ToolView } from "./controller";
import { colorLevel, fmtDuration, fmtK, G, gradientLines, MODE_STYLE, P, st, tilde } from "./theme";

// ---------------- small pieces ----------------

/** A frame counter that ticks while `active` (spinners, elapsed time). */
function useTicker(active: boolean, ms = 100): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return n;
}

const spin = (frame: number) => G.spinner[frame % G.spinner.length];

const LETTERS: Record<string, string[]> = {
  o: ["▄▀▀▄", "█  █", " ▀▀ "],
  p: ["█▀▀▄", "█▄▄▀", "█   "],
  e: ["█▀▀▀", "█▀▀ ", "▀▀▀▀"],
  n: ["█▄ █", "█ ▀█", "▀  ▀"],
  g: ["▄▀▀▀", "█ ▀█", " ▀▀ "],
  a: ["▄▀▀▄", "█▀▀█", "▀  ▀"],
  t: ["▀█▀", " █ ", " ▀ "],
};
export const LOGO = [0, 1, 2].map((r) => [..."opengate"].map((ch) => LETTERS[ch][r]).join(" "));

// ---------------- markdown ----------------

function Block({ b, width }: { b: MdBlock; width: number }): ReactNode {
  switch (b.t) {
    case "blank":
      return <Text> </Text>;
    case "p":
      return <Text>{b.text}</Text>;
    case "h":
      return (
        <Text bold color={b.level === 1 ? P.teal : b.level === 2 ? P.cyan : undefined} underline={b.level === 1}>
          {b.text}
        </Text>
      );
    case "li":
      return (
        <Box paddingLeft={b.indent * 2}>
          <Box flexShrink={0} width={textWidth(b.bullet) + 1}>
            <Text color={P.teal}>{b.bullet}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text>{b.text}</Text>
          </Box>
        </Box>
      );
    case "quote":
      return (
        <Box>
          <Box flexShrink={0} width={2}>
            <Text color={P.border}>│</Text>
          </Box>
          <Text italic color={P.gray}>
            {b.text}
          </Text>
        </Box>
      );
    case "hr":
      return <Text color={P.border}>{"─".repeat(Math.max(4, Math.min(width - 4, 60)))}</Text>;
    case "code":
      return (
        <Box flexDirection="column" borderStyle="single" borderColor={P.border} borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1}>
          {b.lang ? <Text color={P.dim}>{b.lang}</Text> : null}
          {b.lines.map((l, i) => (
            <Text key={i}>{l || " "}</Text>
          ))}
        </Box>
      );
    case "table":
      return (
        <Box flexDirection="column">
          {tableLines(b.rows, b.header).map((l, i) => (
            <Text key={i} wrap="truncate-end">
              {l}
            </Text>
          ))}
        </Box>
      );
  }
}

export const Markdown = memo(function Markdown({ text, width }: { text: string; width: number }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <Block key={i} b={b} width={width} />
      ))}
    </Box>
  );
});

function Gutter({ mark, color, children }: { mark: string; color: string; children: ReactNode }) {
  return (
    <Box>
      <Box flexShrink={0} width={2}>
        <Text color={color}>{mark}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

// ---------------- diffs ----------------

export function DiffBlock({ view }: { view: DiffView }) {
  const w = String(Math.max(1, ...view.rows.map((r) => r.no ?? 0))).length;
  const truecolor = colorLevel() === 3;
  return (
    <Box flexDirection="column">
      {view.rows.map((r, i) => {
        if (r.kind === "gap")
          return (
            <Text key={i} color={P.dim}>
              {" ".repeat(w)} ⋮ {r.text}
            </Text>
          );
        const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
        const color = r.kind === "add" ? P.addFg : r.kind === "del" ? P.delFg : undefined;
        const bgc = truecolor ? (r.kind === "add" ? P.addBg : r.kind === "del" ? P.delBg : undefined) : undefined;
        return (
          <Text key={i} wrap="truncate-end">
            <Text color={P.dim}>{String(r.no ?? "").padStart(w)} </Text>
            <Text color={color} backgroundColor={bgc} dimColor={r.kind === "ctx"}>
              {sign} {r.text.replace(/\t/g, "  ") || " "}
            </Text>
          </Text>
        );
      })}
      {view.hidden ? <Text color={P.dim}>{" ".repeat(w)} … {view.hidden} more lines (ctrl+o to expand)</Text> : null}
    </Box>
  );
}

// ---------------- tool rows ----------------

function SubRow({ s, last, frame }: { s: SubView; last: boolean; frame: number }) {
  const icon = s.status === "running" ? spin(frame) : s.status === "done" ? G.ok : s.status === "cancelled" ? "–" : G.fail;
  const color = s.status === "running" ? P.amber : s.status === "done" ? P.green : s.status === "cancelled" ? P.gray : P.red;
  return (
    <Text wrap="truncate-end">
      <Text color={P.border}>{last ? G.last : G.branch} </Text>
      <Text color={color}>{icon} </Text>
      <Text>{s.title}</Text>
      {s.model ? <Text color={P.dim}> ({s.model})</Text> : null}
      {s.activity ? <Text color={P.gray}> · {s.activity}</Text> : s.status !== "running" ? <Text color={P.dim}> · {s.status}</Text> : null}
    </Text>
  );
}

export function ToolRow({ t, frame = 0 }: { t: ToolView; frame?: number }) {
  const running = t.status === "running";
  const icon = running ? spin(frame) : t.status === "done" ? G.dot : G.dot;
  const color = running ? P.amber : t.status === "done" ? P.green : P.red;
  const cmd = commandLine(t.call);
  const dur = t.ended && t.started ? t.ended - t.started : running ? Date.now() - t.started : 0;
  const s = t.summary;
  const denied = t.decision === "deny";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={color}>{icon} </Text>
        <Text bold>{t.call.title}</Text>
        {dur >= 1000 ? <Text color={P.dim}> · {fmtDuration(dur)}</Text> : null}
      </Text>
      {cmd ? (
        <Box paddingLeft={2}>
          <Text color={P.gray} wrap="truncate-end">
            $ {cmd.split("\n")[0]}
            {cmd.includes("\n") ? " …" : ""}
          </Text>
        </Box>
      ) : null}
      {t.subs.length ? (
        <Box flexDirection="column" paddingLeft={2}>
          {t.subs.map((x, i) => (
            <SubRow key={x.id} s={x} last={i === t.subs.length - 1} frame={frame} />
          ))}
        </Box>
      ) : null}
      {s && (s.lines.length || denied) ? (
        <Box paddingLeft={2}>
          <Box flexShrink={0} width={3}>
            <Text color={P.dim}>{G.result}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            {denied ? (
              <Text color={P.red}>Denied</Text>
            ) : (
              s.lines.map((l, i) => (
                <Text key={i} color={s.error ? P.red : P.gray} wrap="truncate-end">
                  {l || " "}
                </Text>
              ))
            )}
            {!denied && s.hidden > 0 ? <Text color={P.dim}>… +{s.hidden} lines (ctrl+o to expand)</Text> : null}
            {!denied && s.diff ? (
              <>
                <Text color={P.dim}>
                  <Text color={P.addFg}>+{s.diff.added}</Text> <Text color={P.delFg}>-{s.diff.removed}</Text>
                </Text>
                <DiffBlock view={s.diff} />
              </>
            ) : null}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

// ---------------- static items ----------------

function Header({ ctl, cols }: { ctl: Controller; cols: number }) {
  const s = ctl.s.data;
  const wide = cols >= 46;
  const logo = gradientLines(LOGO);
  const mode = MODE_STYLE[s.mode];
  const label = (t: string) => <Text color={P.dim}>{t.padEnd(7)}</Text>;
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={P.border} paddingX={2} alignSelf="flex-start">
        {wide ? (
          <Box flexDirection="column" marginBottom={1}>
            {logo.map((l, i) => (
              <Text key={i}>
                {l}
                {i === 2 ? <Text color={P.dim}>{"  v" + VERSION}</Text> : null}
              </Text>
            ))}
          </Box>
        ) : (
          <Text>
            {gradientLines(["opengate"])[0]} <Text color={P.dim}>v{VERSION}</Text>
          </Text>
        )}
        <Text>
          {label("model")}
          <Text bold>{s.model}</Text>
        </Text>
        <Text>
          {label("mode")}
          <Text color={mode.color}>{mode.label}</Text>
          <Text color={P.dim}> · effort </Text>
          <Text>{s.effort}</Text>
        </Text>
        <Text>
          {label("cwd")}
          <Text>{tilde(s.cwd)}</Text>
        </Text>
      </Box>
      <Text color={P.dim}>
        {"  "}/ commands · @ files · ! shell · shift+tab mode · esc interrupt · /help
      </Text>
    </Box>
  );
}

const ICONS: Record<string, string> = { ok: G.ok, fail: G.fail, info: G.info };

export const ItemView = memo(function ItemView({ item, ctl, cols }: { item: Item; ctl: Controller; cols: number }): ReactNode {
  switch (item.kind) {
    case "header":
      return <Header ctl={ctl} cols={cols} />;
    case "user":
      return (
        <Box marginTop={1}>
          <Gutter mark={G.arrow} color={P.teal}>
            <Text color={P.gray}>{item.text}</Text>
          </Gutter>
        </Box>
      );
    case "md":
      return (
        <Box marginTop={1}>
          <Gutter mark={item.first ? G.dot : " "} color={P.teal}>
            <Markdown text={item.text} width={cols - 2} />
          </Gutter>
        </Box>
      );
    case "thinking": {
      const lines = item.text.split("\n").filter((l) => l.trim());
      const shown = lines.slice(-3);
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={P.dim} italic>
            {G.think} Thought{item.ms >= 1000 ? ` for ${fmtDuration(item.ms)}` : ""}
          </Text>
          <Box paddingLeft={2} flexDirection="column">
            {lines.length > shown.length ? <Text color={P.dim}>… {lines.length - shown.length} earlier lines (ctrl+o to expand)</Text> : null}
            {shown.map((l, i) => (
              <Text key={i} color={P.dim} italic wrap="truncate-end">
                {l}
              </Text>
            ))}
          </Box>
        </Box>
      );
    }
    case "tool":
      return <ToolRow t={item.tool} />;
    case "notice":
      return (
        <Box marginTop={1}>
          <Text color={item.level === "error" ? P.red : item.level === "warn" ? P.amber : P.gray}>
            {item.level === "error" ? `${G.fail} ` : item.level === "warn" ? "! " : ""}
            {item.text}
          </Text>
        </Box>
      );
    case "event":
      return (
        <Box marginTop={1}>
          <Text color={P.dim}>
            <Text color={item.color}>{ICONS[item.icon] ?? item.icon}</Text> {item.text}
          </Text>
        </Box>
      );
    case "shell":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={P.pink} bold>
              !{" "}
            </Text>
            <Text bold>{item.command}</Text>
            <Text color={P.dim}> · {fmtDuration(item.ms)}</Text>
            {item.code ? <Text color={P.red}> · exit {item.code}</Text> : null}
          </Text>
          {item.output ? (
            <Box paddingLeft={2} flexDirection="column">
              {item.hidden ? <Text color={P.dim}>… {item.hidden} earlier lines (ctrl+o to expand)</Text> : null}
              <Text color={P.gray}>{item.output}</Text>
            </Box>
          ) : null}
        </Box>
      );
    case "print":
      return (
        <Box marginTop={1}>
          <Text>{item.text}</Text>
        </Box>
      );
    case "expanded":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={P.dim}>── {item.title} ──</Text>
          {item.diff ? <DiffBlock view={diffView(item.diff, 100_000)} /> : <Text color={P.gray}>{item.text}</Text>}
        </Box>
      );
    case "done":
      return (
        <Box marginTop={1}>
          <Text color={P.dim}>
            {G.think} {item.text}
          </Text>
        </Box>
      );
    case "help": {
      const w = Math.min(34, Math.max(...item.rows.map((r) => r[0].length), ...item.keys.map((k) => k[0].length)) + 2);
      const row = ([a, b]: [string, string], i: number, color: string) => (
        <Box key={i}>
          <Box width={w} flexShrink={0}>
            <Text color={color}>{a}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text color={P.gray}>{b}</Text>
          </Box>
        </Box>
      );
      return (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Commands</Text>
          {item.rows.map((r, i) => row(r, i, P.teal))}
          <Text> </Text>
          <Text bold>Keys</Text>
          {item.keys.map((r, i) => row(r, i, P.sky))}
        </Box>
      );
    }
  }
});

// ---------------- live area ----------------

/** The tail of streaming text that fits `budget` rows; reopens a code fence cut off above. */
export function clipTail(text: string, budget: number, cols: number): { text: string; clipped: boolean } {
  const lines = text.replace(/\n+$/, "").split("\n");
  const w = Math.max(cols - 4, 10);
  let used = 0;
  let i = lines.length;
  while (i > 0) {
    const h = Math.max(1, Math.ceil(textWidth(lines[i - 1]) / w));
    if (used + h > budget) break;
    used += h;
    i--;
  }
  if (i === 0) return { text, clipped: false };
  let fence: string | null = null;
  let opener = "";
  for (let j = 0; j < i; j++) {
    const m = /^\s*(`{3,}|~{3,})/.exec(lines[j]);
    if (!m) continue;
    if (fence && lines[j].trim().startsWith(fence)) fence = null;
    else if (!fence) {
      fence = m[1];
      opener = lines[j];
    }
  }
  return { text: (fence ? opener + "\n" : "") + lines.slice(i).join("\n"), clipped: true };
}

function Live({ ctl, cols, rows, frame }: { ctl: Controller; cols: number; rows: number; frame: number }) {
  const inputLines = ctl.ed.text.split("\n").length;
  // Many parallel calls: show a few rows and a count, so the live area always fits the screen.
  const maxTools = Math.max(2, Math.floor((rows - 14) / 4));
  const tools = ctl.tools.length > maxTools ? ctl.tools.slice(0, maxTools - 1) : ctl.tools;
  const more = ctl.tools.length - tools.length;
  const budget = Math.max(3, rows - 9 - inputLines - tools.length * 3 - (more ? 2 : 0) - ctl.queue.length - (ctl.thinkingBuf ? 4 : 0));
  const live = ctl.liveText.trim() ? clipTail(ctl.liveText, budget, cols) : null;
  const thinking = ctl.thinkingBuf
    .split("\n")
    .filter((l) => l.trim())
    .slice(-3);
  return (
    <Box flexDirection="column">
      {ctl.thinkingBuf ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={P.dim} italic>
            {G.think} Thinking…
          </Text>
          <Box paddingLeft={2} flexDirection="column">
            {thinking.map((l, i) => (
              <Text key={i} color={P.dim} italic wrap="truncate-end">
                {l}
              </Text>
            ))}
          </Box>
        </Box>
      ) : null}
      {live ? (
        <Box marginTop={1} flexDirection="column">
          {live.clipped ? <Text color={P.dim}>  ⋮</Text> : null}
          <Gutter mark={ctl.liveFirst ? G.dot : " "} color={P.teal}>
            <Markdown text={live.text} width={cols - 2} />
          </Gutter>
        </Box>
      ) : null}
      {tools.map((t) => (
        <ToolRow key={t.call.id} t={t} frame={frame} />
      ))}
      {more ? (
        <Box marginTop={1}>
          <Text color={P.amber}>
            {spin(frame)} <Text color={P.gray}>+{more} more running</Text>
          </Text>
        </Box>
      ) : null}
      {ctl.subs.length ? (
        <Box marginTop={1} flexDirection="column">
          {ctl.subs.map((x, i) => (
            <SubRow key={x.id} s={x} last={i === ctl.subs.length - 1} frame={frame} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

// ---------------- input, popup, pickers, prompt ----------------

/** The editor's lines with the cursor drawn as an inverse cell. */
export function inputLines(ed: Ed, placeholder: string, showCursor = true): string[] {
  if (!ed.text) return [(showCursor ? st.inverse(placeholder[0] ?? " ") : "") + st.dim(showCursor ? placeholder.slice(1) : placeholder)];
  const { line, col } = cursorPos(ed);
  return ed.text.split("\n").map((l, i) => {
    if (i !== line || !showCursor) return l;
    const cp = l.codePointAt(col);
    const ch = cp === undefined ? " " : String.fromCodePoint(cp);
    return l.slice(0, col) + st.inverse(ch) + l.slice(col + (cp === undefined ? 0 : ch.length));
  });
}

function InputBox({ ctl }: { ctl: Controller }) {
  const t = ctl.ed.text;
  const shell = t.startsWith("!");
  const cmd = t.startsWith("/");
  const placeholder = ctl.busy ? "Type to queue a message…" : "Ask anything · / commands · @ files · ! shell";
  const lines = inputLines(ctl.ed, placeholder);
  const accent = shell ? P.pink : cmd ? P.indigo : P.teal;
  return (
    <Box borderStyle="round" borderColor={shell ? P.pink : P.border} paddingX={1} flexDirection="column">
      {lines.map((l, i) => (
        <Box key={i}>
          <Box flexShrink={0} width={2}>
            <Text color={accent} bold>
              {i === 0 ? G.arrow : " "}
            </Text>
          </Box>
          <Text>{l}</Text>
        </Box>
      ))}
    </Box>
  );
}

function PopupView({ p }: { p: Popup }) {
  const w = Math.min(34, Math.max(...p.items.map((i) => i.label.length)) + 1);
  return (
    <Box flexDirection="column" paddingX={1}>
      {p.items.map((it, i) => {
        const on = i === p.sel;
        return (
          <Box key={it.value}>
            <Box width={2} flexShrink={0}>
              <Text color={P.teal}>{on ? G.arrow : " "}</Text>
            </Box>
            <Box width={w} flexShrink={0} marginRight={2}>
              <Text color={on ? P.teal : it.dir ? P.sky : undefined} bold={on} wrap="truncate-end">
                {it.label}
              </Text>
            </Box>
            {it.detail ? (
              <Text color={on ? P.gray : P.dim} wrap="truncate-end">
                {it.detail}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function PickerView({ ctl, rows: termRows }: { ctl: Controller; rows: number }) {
  const p = ctl.picker!;
  const rows = ctl.pickerRows();
  const size = Math.max(4, Math.min(12, termRows - 10));
  const sel = Math.min(p.sel, Math.max(rows.length - 1, 0));
  const start = Math.max(0, Math.min(sel - Math.floor(size / 2), rows.length - size));
  const shown = rows.slice(start, start + size);
  const out: ReactNode[] = [];
  let group: string | undefined;
  shown.forEach((r: PickerRow, i) => {
    if (r.group && r.group !== group) out.push(<Text key={`g${i}`} color={P.dim} bold>{r.group}</Text>);
    group = r.group;
    const on = start + i === sel;
    out.push(
      <Box key={r.value}>
        <Box flexShrink={0}>
          <Text color={P.teal}>{on ? `${G.arrow} ` : "  "}</Text>
          {r.indent ? <Text color={P.border}>{"  ".repeat(r.indent - 1)}{G.last} </Text> : null}
        </Box>
        <Box flexShrink={1}>
          <Text color={on ? P.teal : undefined} bold={on} wrap="truncate-end">
            {r.label}
          </Text>
        </Box>
        <Box flexShrink={0}>
          {r.current ? <Text color={P.green}> {G.ok}</Text> : null}
          {r.detail ? <Text color={P.dim}>  {r.detail}</Text> : null}
        </Box>
      </Box>,
    );
  });
  return (
    <Box borderStyle="round" borderColor={P.teal} paddingX={1} flexDirection="column">
      <Text>
        <Text bold>{p.title}</Text>
        <Text color={P.dim}>{"  "}</Text>
        {p.filter ? <Text color={P.teal}>{p.filter}</Text> : <Text color={P.dim}>type to filter</Text>}
      </Text>
      {p.loading ? <Text color={P.gray}>Loading…</Text> : null}
      {p.error ? <Text color={P.red}>{p.error}</Text> : null}
      {!p.loading && !rows.length && !p.error ? <Text color={P.gray}>Nothing matches.</Text> : null}
      {out}
      <Text color={P.dim}>
        {rows.length > size ? `${sel + 1}/${rows.length} · ` : ""}↑↓ move · enter choose{p.footer ? ` · ${p.footer}` : ""} · esc cancel
      </Text>
    </Box>
  );
}

function TranscriptView({ ctl }: { ctl: Controller }) {
  const t = ctl.transcript!;
  const h = ctl.transcriptHeight();
  const shown = t.lines.slice(t.offset, t.offset + h);
  const end = Math.min(t.offset + h, t.lines.length);
  return (
    <Box borderStyle="round" borderColor={P.indigo} paddingX={1} flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={P.indigo}>
          Transcript
        </Text>
        <Text color={P.dim}> · read-only</Text>
      </Text>
      {shown.map((l, i) => (
        <Text key={t.offset + i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
      <Text color={P.dim}>
        {t.offset + 1}-{end} of {t.lines.length} · ↑↓ pgup/pgdn scroll · enter resume · esc back
      </Text>
    </Box>
  );
}

function AskView({ ctl, rows }: { ctl: Controller; rows: number }) {
  const a = ctl.pending!;
  const call = a.call;
  const view = a.diff ? diffView(a.diff, Math.max(6, rows - 16)) : null;
  const what = call.kind === "execute" ? "run this command" : call.kind === "edit" ? "make this edit" : `use ${call.name}`;
  const opts = ["Yes, allow once", `Yes, and don't ask again for ${call.name} this session`, "No, and tell the agent what to do differently"];
  return (
    <Box borderStyle="round" borderColor={P.amber} paddingX={1} flexDirection="column" marginTop={1}>
      <Text>
        <Text color={P.amber} bold>
          Allow {what}?
        </Text>
        <Text color={P.dim}> · {call.title}</Text>
      </Text>
      {call.reason ? (
        <Box marginTop={1}>
          <Text color={P.orange} bold>
            ! {call.reason}
          </Text>
        </Box>
      ) : null}
      {call.kind === "execute" && call.input?.command ? (
        <Box marginTop={1} paddingLeft={1}>
          <Text color={P.amber}>$ {String(call.input.command)}</Text>
        </Box>
      ) : null}
      {view ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={P.dim}>
            {a.diff!.path} · <Text color={P.addFg}>+{view.added}</Text> <Text color={P.delFg}>-{view.removed}</Text>
          </Text>
          <DiffBlock view={view} />
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {opts.map((o, i) => (
          <Text key={i} color={i === a.sel ? P.teal : undefined} bold={i === a.sel}>
            {i === a.sel ? `${G.arrow} ` : "  "}
            {i + 1}. {o}
          </Text>
        ))}
      </Box>
      <Text color={P.dim}>↑↓ or 1-3 · enter confirm · esc deny</Text>
    </Box>
  );
}

function ctxBar(pct: number, cells = 8) {
  const n = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * cells);
  return G.bar[0].repeat(n) + G.bar[1].repeat(cells - n);
}

function StatusBar({ ctl, frame }: { ctl: Controller; frame: number }) {
  const s = ctl.s;
  const d = s.data;
  const mode = MODE_STYLE[d.mode];
  const pct = s.contextSize ? Math.round((d.contextUsed / s.contextSize) * 100) : 0;
  const pctColor = pct >= 85 ? P.red : pct >= 60 ? P.amber : P.green;
  const u = d.usage;
  const sep = <Text color={P.border}> · </Text>;
  if (ctl.hint)
    return (
      <Box paddingX={1}>
        <Text color={P.amber}>{ctl.hint}</Text>
      </Box>
    );
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text color={P.gray}>{d.model}</Text>
        {sep}
        <Text color={mode.color}>{mode.label}</Text>
        {sep}
        <Text color={P.dim}>effort </Text>
        <Text color={P.gray}>{d.effort}</Text>
        {sep}
        <Text color={pctColor}>{ctxBar(pct)}</Text>
        <Text color={P.gray}> {pct}%</Text>
        {sep}
        <Text color={P.gray}>{fmtK(u.input + u.cacheRead + u.cacheWrite)}</Text>
        <Text color={P.dim}> in </Text>
        <Text color={P.gray}>{fmtK(u.cacheRead)}</Text>
        <Text color={P.dim}> cached </Text>
        <Text color={P.gray}>{fmtK(u.output)}</Text>
        <Text color={P.dim}> out</Text>
      </Text>
      {ctl.busy ? (
        <Text>
          <Text color={P.teal}>{spin(frame)} </Text>
          <Text color={P.gray}>{fmtDuration(Date.now() - ctl.turnStart)}</Text>
        </Text>
      ) : (
        <Text color={P.dim}>{MODES.length ? "shift+tab mode" : ""}</Text>
      )}
    </Box>
  );
}

function Working({ ctl, frame }: { ctl: Controller; frame: number }) {
  const act = ctl.activity || "Working";
  const glow = gradientLines([act + "…"])[0];
  return (
    <Box marginTop={1} paddingX={1}>
      <Text wrap="truncate-end">
        <Text color={P.teal}>{spin(frame)} </Text>
        {glow}
        <Text color={P.dim}>
          {" "}
          ({fmtDuration(Date.now() - ctl.turnStart)} · esc to interrupt)
        </Text>
      </Text>
    </Box>
  );
}

function Queue({ ctl }: { ctl: Controller }) {
  if (!ctl.queue.length) return null;
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {ctl.queue.map((q, i) => (
        <Text key={i} color={P.gray} wrap="truncate-end">
          <Text color={P.dim}>{G.queue} queued </Text>
          {q.replace(/\s+/g, " ")}
        </Text>
      ))}
    </Box>
  );
}

// ---------------- the app ----------------

export function App({ ctl }: { ctl: Controller }) {
  useSyncExternalStore(ctl.subscribe, ctl.getVersion);
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const stdin = useStdin() as unknown as {
    setRawMode(v: boolean): void;
    setBracketedPasteMode?(v: boolean): void;
    isRawModeSupported: boolean;
    internal_eventEmitter: { on(e: string, f: (s: string) => void): void; removeListener(e: string, f: (s: string) => void): void };
  };

  useEffect(() => {
    ctl.onExit = () => {
      ctl.changed(true);
      setTimeout(() => exit(), 30);
    };
    const em = stdin.internal_eventEmitter;
    const onInput = (s: string) => {
      const k = decodeKey(s);
      if (k) ctl.key(k);
    };
    const onPaste = (s: string) => ctl.paste(s);
    if (stdin.isRawModeSupported) stdin.setRawMode(true);
    stdin.setBracketedPasteMode?.(true);
    em.on("input", onInput);
    em.on("paste", onPaste);
    return () => {
      em.removeListener("input", onInput);
      em.removeListener("paste", onPaste);
      stdin.setBracketedPasteMode?.(false);
      if (stdin.isRawModeSupported) stdin.setRawMode(false);
    };
  }, []);

  const animating = ctl.busy || ctl.tools.length > 0 || !!ctl.picker?.loading;
  const frame = useTicker(animating, 90);
  const cols = columns || 100;
  const popup = ctl.popup();

  return (
    <>
      <Static items={ctl.items}>{(item) => <ItemView key={item.id} item={item} ctl={ctl} cols={cols} />}</Static>
      {ctl.exiting ? null : ctl.transcript && !ctl.pending ? (
        <TranscriptView ctl={ctl} />
      ) : (
        <Box flexDirection="column" width={cols}>
          <Live ctl={ctl} cols={cols} rows={rows || 30} frame={frame} />
          <Queue ctl={ctl} />
          {ctl.busy && !ctl.pending ? <Working ctl={ctl} frame={frame} /> : null}
          {ctl.pending ? <AskView ctl={ctl} rows={rows || 30} /> : ctl.transcript ? <TranscriptView ctl={ctl} /> : ctl.picker ? <PickerView ctl={ctl} rows={rows || 30} /> : <InputBox ctl={ctl} />}
          {popup ? <PopupView p={popup} /> : ctl.transcript ? null : <StatusBar ctl={ctl} frame={frame} />}
        </Box>
      )}
    </>
  );
}
