// Drive `opengate acp` like an editor would: initialize, new session, a prompt with a permission
// request, list and load. Usage: bun scripts/acp-smoke.ts <project dir> [model]
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const cwd = process.argv[2] ?? process.cwd();
const model = process.argv[3];
const child = spawn("bun", [new URL("../src/cli.ts", import.meta.url).pathname, "acp"], { stdio: ["pipe", "pipe", "inherit"] });
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>);

const seen: Record<string, number> = {};
let text = "";
const app = acp
  .client({ name: "acp-smoke" })
  .onRequest("session/request_permission", ({ params }) => {
    console.log(`  permission asked: ${params.toolCall.title} [${params.options.map((o) => o.optionId).join(", ")}]${params.toolCall.content?.length ? " (with diff)" : ""}`);
    return { outcome: { outcome: "selected", optionId: "once" } };
  })
  .onNotification("session/update", ({ params }) => {
    const u = params.update;
    seen[u.sessionUpdate] = (seen[u.sessionUpdate] ?? 0) + 1;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text += u.content.text;
    if (u.sessionUpdate === "tool_call") console.log(`  tool: ${u.title} (${u.kind})`);
    if (u.sessionUpdate === "tool_call_update" && u.status) console.log(`  tool ${u.status}${u.content?.some((c) => c.type === "diff") ? " with diff" : ""}`);
    if (u.sessionUpdate === "usage_update") console.log(`  usage: ${u.used} / ${u.size}`);
    if (u.sessionUpdate === "session_info_update") console.log(`  title: ${u.title}`);
  });

await app.connectWith(stream, async (agent) => {
  const init = await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  console.log("initialize:", init.agentInfo?.name, init.agentInfo?.version, "loadSession:", init.agentCapabilities?.loadSession, "auth:", init.authMethods?.length ?? 0);
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  const modelOpt = s.configOptions?.find((o) => o.id === "model") as any;
  const count = (modelOpt?.options ?? []).reduce((n: number, g: any) => n + (g.options?.length ?? 1), 0);
  console.log("session:", s.sessionId, "model:", modelOpt?.currentValue, `(${count} in picker)`, "mode:", s.modes?.currentModeId);
  if (model) await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: model });
  const r = await agent.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "calc.py has a bug in add(). Read it and fix it with edit_file. Reply with one short sentence." }] });
  console.log("stop:", r.stopReason, "| answer:", text.trim());
  console.log("updates:", JSON.stringify(seen));
  const list = await agent.request("session/list", { cwd });
  console.log("session/list:", list.sessions.length, "sessions; first:", list.sessions[0]?.title);
  for (const k of Object.keys(seen)) delete seen[k];
  await agent.request("session/load", { sessionId: s.sessionId, cwd, mcpServers: [] });
  console.log("session/load replayed:", JSON.stringify(seen));
});
child.kill();
process.exit(0);
