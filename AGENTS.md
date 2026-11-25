# Working on opengate

- Runtime is Bun (>= 1.3). `bun install`, `bun test`, `bun run typecheck`, `bun scripts/build.ts`.
- Layout:
  - `src/agent.ts`: the session loop (model turn → permission → tools → repeat), compaction.
  - `src/llm/`: one adapter per wire format (Anthropic Messages, OpenAI Responses, Chat Completions). Each converts the shared `Msg` history and streams text and thinking.
  - `src/tools.ts`: the agent's tools and their permission rules.
  - `src/acp.ts`: the ACP front end (`opengate acp`).
  - `src/tui.ts`: the terminal front end. `src/cli.ts` / `src/cli-args.ts`: commands and flags.
  - `src/store.ts`, `src/config.ts`: sessions and settings on disk.
- Keep both front ends working: a change to the engine should show up in the terminal and over ACP.
- Assistant turns keep the provider's own output (`Msg.native`) and send it back unchanged to the same model; don't edit past messages (it breaks prompt caching and preserved thinking).
- In ACP mode nothing may write to stdout except the protocol; log to stderr.
- Must work on Windows: no shell-specific paths, PowerShell for the shell tool, keep CRLF files intact.
- Tests use a scripted fake model (`test/opengate.test.ts`); add a test for behaviour changes.

## Extension points (src/ext.ts)

Features live in their own modules under `src/` and plug into the engine through `src/ext.ts`. Import the module once from `src/features.ts`, which `cli.ts` and `acp.ts` both import. Don't edit `agent.ts` or the front ends for a feature unless a hook is genuinely missing; if you add one, keep it small and generic.

- `registerToolProvider({ name, tools(session) })`: extra tools for a session, offered from the next prompt on. A `Tool` (src/tools.ts) has `asks(mode)`. Read-only tools return false; tools that change things return true for "ask", and those go through the permission flow. `parallel: true` lets neighbouring calls from the same turn run at once.
- `registerPromptSection({ name, order, render(session) })`: text appended to the system prompt at the start of each prompt. Keep it short and stable, since it is part of the cached prefix.
- `registerCommand({ name, description, args, run({ session, args, print, ui }) })`: slash commands, in the terminal and over ACP.
- `registerSessionHook({ name, start(session), dispose(session) })`: per-session setup and teardown (e.g. connecting MCP servers). `session.runtime` (a Map) holds per-session state; nothing in it is saved.
- `registerPermissionPolicy({ name, decide({ session, call, tool, diff }) })`: returns allow / ask / deny / null.
  - "deny" from any policy wins in every mode.
  - In "auto" mode a call runs only if a policy allows it and none asks.
  - "ask" / "edits" use the tools' own `asks(mode)`.
  - "yolo" never asks.
- `ui.event?.({ type, ... })`: extra events for front ends (see `AgentEvent` in ext.ts). Front ends ignore unknown types.
- Tools get `ctx.session` (the Session: `gateway`, `cfg`, `data`, `runtime`), `ctx.ui` and `ctx.callId`.
- Over ACP, the MCP servers the client sent are in `session.runtime.get("acp.mcpServers")`.

Modes: `ask` (asks before edits and commands), `edits` (edits freely, asks before commands), `auto` (the permission policies decide; the safety guard asks about risky actions and blocks dangerous ones), `yolo` (never asks; deny rules still apply).
