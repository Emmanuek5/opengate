// A tiny stdio MCP server for test/mcp.test.ts. Run with: bun test/fixtures/mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.argv.includes("--crash")) {
  console.error("fixture: crashing on purpose");
  process.exit(3);
}

const server = new McpServer({ name: "fixture", version: "1.0.0" }, { instructions: "FIXTURE-INSTRUCTIONS" });

server.registerTool(
  "echo",
  { description: "Echo the text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

server.registerTool(
  "write_note",
  { description: "Pretend to write a note", inputSchema: { note: z.string() } },
  async ({ note }) => ({
    content: [
      { type: "text", text: `saved ${note}` },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "resource", resource: { uri: "note://1", mimeType: "text/plain", text: "note body" } },
    ],
  }),
);

server.registerTool("broken", { description: "Always fails" }, async () => ({ content: [{ type: "text", text: "it broke" }], isError: true }));

await server.connect(new StdioServerTransport());
