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
