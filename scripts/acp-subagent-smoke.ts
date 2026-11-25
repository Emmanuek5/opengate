// Drive `opengate acp` like an editor: a Claude session hands an edit to a subagent on another
// model, so the subagent's permission request must reach the client. Prints the client's view.
// usage: bun scripts/acp-subagent-smoke.ts <project dir> [model]
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const cwd = process.argv[2] ?? process.cwd();
const model = process.argv[3] ?? "claude-sonnet-5-5";
const child = spawn("bun", [new URL("../src/cli.ts", import.meta.url).pathname, "acp"], { stdio: ["pipe", "pipe", "inherit"] });
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>);

const known = new Set<string>();
const log: string[] = [];
let text = "";
const app = acp
  .client({ name: "subagent-smoke" })
  .onRequest("session/request_permission", ({ params }) => {
    log.push(`PERMISSION for ${params.toolCall.toolCallId} (${known.has(params.toolCall.toolCallId) ? "announced first" : "NOT ANNOUNCED"}): ${params.toolCall.title}`);
    return { outcome: { outcome: "selected", optionId: "once" } };
  })
  .onNotification("session/update", ({ params }) => {
    const u = params.update;
    if (u.sessionUpdate === "tool_call") {
      known.add(u.toolCallId);
      log.push(`tool_call ${u.toolCallId.includes("/") ? "(from subagent) " : ""}${u.title}`);
    }
    if (u.sessionUpdate === "tool_call_update" && u.status === "in_progress" && u.content?.[0]?.type === "content") {
      const t = (u.content[0] as any).content?.text ?? "";
      if (t.startsWith("Subagent")) log.push(`progress: ${t.split("\n").slice(-1)[0]}`);
    }
    if (u.sessionUpdate === "tool_call_update" && (u.status === "completed" || u.status === "failed")) log.push(`  ${u.status} ${u.toolCallId.includes("/") ? "(subagent call)" : ""}`);
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text += u.content.text;
  });

await app.connectWith(stream, async (agent) => {
  await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "subagent-smoke", version: "0" }, clientCapabilities: {} });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: model });
  const r = await agent.request("session/prompt", {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: "Use the agent tool to start ONE general subagent on an OpenAI GPT model (pick its exact id from the list in the tool description) and have it fix the bug in add() in calc.py with edit_file. Don't edit the file yourself. Then tell me in one sentence which model the subagent used." }],
  });
  for (const l of log) console.log(l);
  console.log("stop:", r.stopReason, "| answer:", text.trim());
});
child.kill();
process.exit(0);
