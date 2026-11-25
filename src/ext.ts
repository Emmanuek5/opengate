import type { AgentUI, Session } from "./agent";
import type { Tool } from "./tools";

/**
 * Extension points. Features (memory, skills, MCP, subagents, …) live in their own modules and
 * plug in here; the engine and both front ends only talk to these registries.
 *
 * Register from a module's top level and import that module once from src/features.ts.
 */

/** Extra tools for a session. Called at the start of every prompt; keep it cheap (cache inside). */
export interface ToolProvider {
  name: string;
  tools(session: Session): Tool[] | Promise<Tool[]>;
}

/**
 * A block of text appended to the system prompt. Rendered at the start of each prompt, so keep
 * the output stable between prompts (it is part of the cached prefix) and short.
 */
export interface PromptSection {
  name: string;
  /** lower first; built-in instructions come before every section */
  order?: number;
  render(session: Session): string | null | Promise<string | null>;
}

export interface CommandIO {
  session: Session;
  /** everything after the command name, trimmed */
  args: string;
  /** show text to the person (terminal: printed; ACP: sent as an agent message) */
  print(text: string): void;
  ui: AgentUI;
}

/** A slash command available in the terminal and over ACP (`/name args`). */
export interface Command {
  name: string;
  description: string;
  /** hint for the argument, e.g. "[name]" */
  args?: string;
  run(io: CommandIO): void | Promise<void>;
}

/** Session lifecycle: start runs once before the first prompt (connect servers, load state). */
export interface SessionHook {
  name: string;
  start?(session: Session): void | Promise<void>;
  dispose?(session: Session): void | Promise<void>;
}

const toolProviders: ToolProvider[] = [];
const promptSections: PromptSection[] = [];
const commands = new Map<string, Command>();
const sessionHooks: SessionHook[] = [];

export function registerToolProvider(p: ToolProvider): void {
  toolProviders.push(p);
}
export function registerPromptSection(s: PromptSection): void {
  promptSections.push(s);
  promptSections.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
export function registerCommand(c: Command): void {
  commands.set(c.name, c);
}
export function registerSessionHook(h: SessionHook): void {
  sessionHooks.push(h);
}

export const getToolProviders = (): readonly ToolProvider[] => toolProviders;
export const getPromptSections = (): readonly PromptSection[] => promptSections;
export const getCommands = (): Command[] => [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
export const getCommand = (name: string): Command | undefined => commands.get(name);
export const getSessionHooks = (): readonly SessionHook[] => sessionHooks;

/**
 * Events beyond text and tool calls, for front ends that want to show more. Unknown types must be
 * ignored by front ends. Known types:
 * - { type: "subagent", id, parentCallId, status: "running" | "done" | "failed" | "cancelled", title, model, activity? }
 * - { type: "memory", action: "saved" | "updated" | "deleted", scope: "project" | "global", name }
 * - { type: "skill", action: "loaded", name }
 * - { type: "mcp", server, status: "connected" | "failed" | "closed", tools?, error? }
 * - { type: "guard", status: "checking", tool, title }: the safety model is reviewing an action
 */
export type AgentEvent = { type: string; [key: string]: unknown };

// ---------------- permissions ----------------

export interface PermissionRequest {
  session: Session;
  call: import("./agent").ToolCallInfo;
  tool: Tool;
  /** what an edit would change, when the tool can tell */
  diff: import("./tools").Diff | null;
  /** aborted when the person stops the turn */
  signal?: AbortSignal;
  /** the front end, e.g. to show that a check is running */
  ui?: AgentUI;
}

export interface PermissionVerdict {
  decision: "allow" | "ask" | "deny";
  /** shown to the person (ask) or the model (deny) */
  reason?: string;
  /** who decided, e.g. "rule", "guard" */
  by?: string;
}

/**
 * Decides whether a tool call that changes things may run. Policies are asked for every such call
 * in every mode; return null for no opinion. A "deny" from any policy wins in every mode (deny
 * rules). In "auto" mode the call runs only if a policy allows it and none asks; otherwise the
 * person is asked. In "ask"/"edits" modes only "deny" matters; in "yolo" mode only "deny" matters.
 */
export interface PermissionPolicy {
  name: string;
  decide(req: PermissionRequest): Promise<PermissionVerdict | null> | PermissionVerdict | null;
}

const permissionPolicies: PermissionPolicy[] = [];
export function registerPermissionPolicy(p: PermissionPolicy): void {
  permissionPolicies.push(p);
}
export const getPermissionPolicies = (): readonly PermissionPolicy[] => permissionPolicies;
