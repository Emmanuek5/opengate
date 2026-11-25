import type { AgentUI, Decision, ToolCallInfo } from "../agent";
import type { AgentEvent } from "../ext";
import type { ToolResult } from "../tools";
import { c } from "./theme";

/** `opengate -p "…"`: run one prompt, print the answer to stdout, activity to stderr. */
export class PrintUI implements AgentUI {
  private err = (s: string) => process.stderr.write(s);
  text(d: string) {
    process.stdout.write(d);
  }
  thinking() {}
  toolStart(call: ToolCallInfo) {
    this.err(c.dim(`● ${call.title}\n`));
  }
  toolEnd(call: ToolCallInfo, r: ToolResult) {
    if (r.isError) this.err(c.red(`  ${r.output.split("\n")[0].slice(0, 200)}\n`));
  }
  async ask(call: ToolCallInfo): Promise<Decision> {
    this.err(c.yellow(`  not allowed in ${call.kind === "execute" ? "this mode (use --mode auto)" : "ask mode (use --mode edits or auto)"}\n`));
    return "deny";
  }
  notice(message: string) {
    this.err(c.dim(message + "\n"));
  }
  event(e: AgentEvent) {
    if (e.type === "mcp" && e.status === "failed") this.err(c.yellow(`MCP ${e.server} failed${e.error ? `: ${e.error}` : ""}\n`));
    else if (e.type === "subagent" && e.status !== "running") this.err(c.dim(`● ${e.title} ${e.status}\n`));
  }
}
