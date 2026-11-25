import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENGATE_HOME = mkdtempSync(join(tmpdir(), "og-hist-"));
const store = await import("../src/store");
const { renderTranscript } = await import("../src/transcript");
import type { SessionFile } from "../src/store";

const mk = (id: string, cwd: string, extra: Partial<SessionFile> = {}): SessionFile => ({
  version: 1, id, cwd, title: `title ${id}`, model: "m", mode: "ask", effort: "auto", created: Date.now(), updated: Date.now(),
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextUsed: 0, messages: [], ...extra,
});

test("history: all folders, subagents, search, transcripts with nested subagents", async () => {
  store.saveSession(mk("p1", "/a", {
    title: "fix the login bug",
    messages: [
      { role: "user", parts: [{ type: "text", text: "fix the login bug please" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "agent", input: { description: "find auth code", prompt: "x" } }] },
      { role: "user", parts: [{ type: "tool_result", id: "c1", name: "agent", output: "found it in auth.ts\n\n[explore agent · m · 1 step · 1 in / 1 out tokens · session k1]" }] },
      { role: "assistant", parts: [{ type: "text", text: "Fixed." }] },
    ],
  }));
  await Bun.sleep(5);
  store.saveSession(mk("k1", "/a", { parentId: "p1", agentLabel: "explore", title: "find auth code (explore)", messages: [{ role: "user", parts: [{ type: "text", text: "look for verifyToken" }] }] }));
  await Bun.sleep(5);
  store.saveSession(mk("p2", "/b", { title: "write docs" }));

  expect(store.listSessions("/a").map((m) => m.id)).toEqual(["p1"]);
  expect(store.listSessions("/a", 50, { all: true }).map((m) => m.id)).toEqual(["p2", "p1"]);
  expect(store.listSessions("/a", 50, { includeChildren: true }).map((m) => m.id)).toEqual(["k1", "p1"]);
  expect(store.listSessions(undefined, 50, { query: "DOCS" }).map((m) => m.id)).toEqual(["p2"]);
  expect(store.listSessions("/a")[0].messageCount).toBe(4);
  expect(store.listChildren("p1").map((m) => [m.id, m.agentLabel])).toEqual([["k1", "explore"]]);
  expect(store.searchSessions("verifytoken", 10, { all: true }).map((r) => r.meta.id)).toEqual(["k1"]);

  const md = renderTranscript(store.loadSession("p1")!);
  expect(md).toContain("# fix the login bug");
  expect(md).toContain("**You:**");
  expect(md).toContain("## find auth code (explore)");
  expect(md.indexOf("## find auth code")).toBeLessThan(md.indexOf("Fixed."));
  expect(md).toContain("look for verifyToken");
});
