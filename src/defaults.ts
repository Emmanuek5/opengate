import { defaultModel, loadConfig, projectKey, projectRoot, setDefaultModel } from "./config";
import { registerCommand, type CommandIO } from "./ext";

/**
 * Default models. A session's model is set with /model (or the client's picker); these set what
 * new sessions start with: for the folder's project, or everywhere.
 *
 *   /default-model                 show the defaults
 *   /default-model project [model] this project's default (no model: the session's current one)
 *   /default-model global [model]  the default everywhere else
 *   /default-model project none    clear the project's default
 */
export async function defaultModelCommand(io: CommandIO): Promise<void> {
  const [scopeWord, ...rest] = io.args.split(/\s+/).filter(Boolean);
  const cwd = io.session.data.cwd;
  const cfg = loadConfig();
  if (!scopeWord) {
    const project = cfg.projects?.[projectKey(cwd)]?.model;
    io.print(
      [
        `This session:  ${io.session.data.model}`,
        `This project:  ${project ?? "(none, uses the global default)"}  · ${projectRoot(cwd)}`,
        `Global:        ${cfg.model ?? "(none)"}`,
        `New sessions here start with: ${defaultModel(cfg, cwd) ?? "the gateway's first good model"}`,
        "",
        "Set with /default-model project [model] or /default-model global [model] (no model: this session's).",
      ].join("\n"),
    );
    return;
  }
  const scope = /^(global|default|all|everywhere)$/i.test(scopeWord) ? "global" : /^(project|here|folder|repo)$/i.test(scopeWord) ? "project" : null;
  if (!scope) {
    io.print("Usage: /default-model [project|global] [model|none]");
    return;
  }
  const arg = rest.join(" ").trim();
  if (/^(none|clear|unset|-)$/i.test(arg)) {
    const where = setDefaultModel(scope, null, cwd);
    io.print(scope === "project" ? `Cleared the default model for ${where}.` : "Cleared the global default model.");
    return;
  }
  let model = arg || io.session.data.model;
  if (arg && io.session.gateway.models) {
    try {
      const ids = (await io.session.gateway.models()).map((m) => m.id);
      const exact = ids.find((m) => m === arg) ?? ids.find((m) => !m.includes("/") && (m === `claude-${arg}` || m.endsWith(arg)));
      const hits = exact ? [exact] : ids.filter((m) => m.toLowerCase().includes(arg.toLowerCase()));
      if (ids.length && hits.length !== 1) {
        io.print(hits.length ? `Several models match "${arg}": ${hits.slice(0, 12).join(", ")}. Be more specific.` : `No model matches "${arg}". See /model.`);
        return;
      }
      if (hits[0]) model = hits[0];
    } catch {}
  }
  const where = setDefaultModel(scope, model, cwd);
  io.print(`Default model for ${where}: ${model}. New sessions${scope === "project" ? " in this project" : ""} start with it; this session keeps ${io.session.data.model} (change it with /model).`);
}

registerCommand({ name: "default-model", args: "[project|global] [model]", description: "Set the model new sessions start with, for this project or everywhere", run: defaultModelCommand });
